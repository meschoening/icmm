"""Making a file system change durable before the runs database publishes it (ADR-0009)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def replace_file(source: Path, target: Path) -> None:
    """Renames `source` over `target` atomically, the rename durable once this returns where
    `fsync_folder` can't make it so: on Windows, it's written through."""
    if os.name != "nt":
        os.replace(source, target)
        return
    import ctypes  # Windows only: its MoveFileExW, with MOVEFILE_WRITE_THROUGH.

    replace_existing, write_through = 0x1, 0x8
    move = ctypes.windll.kernel32.MoveFileExW  # type: ignore[attr-defined]
    if not move(str(source), str(target), replace_existing | write_through):
        raise ctypes.WinError()  # type: ignore[attr-defined]


def fsync_folder(folder: Path) -> None:
    """Makes the entries of `folder` durable: a rename into it, or a file made in it. Windows
    can't open a folder, and its renames are already durable."""
    if os.name == "nt":
        return
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def file_stamp(st: os.stat_result) -> str:
    """A file's identity and size and when it last changed, to tell when it was replaced or
    changed since: cheaper than reading it, from one listing of its folder."""
    return f"{st.st_ino}:{st.st_size}:{st.st_mtime_ns}"


def write_whole(path: Path, data: bytes, *, durable: bool = True) -> None:
    """Writes `path` whole: through a file of its own beside it, closed, then renamed over it, so
    a reader on any host sees all of it or none, and two writers never share a part file.
    `durable` flushes it to disk first, and the rename after."""
    fd, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    part = Path(name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            if durable:
                f.flush()
                os.fsync(f.fileno())
        replace_file(part, path)
        if durable:
            fsync_folder(path.parent)
    finally:
        part.unlink(missing_ok=True)
