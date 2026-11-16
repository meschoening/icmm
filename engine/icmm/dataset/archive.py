"""A dataset file: one `.zip` of a revision's files, which Export saves and Import reads (#147).

Export packs a revision's stored files byte for byte, in whatever format they were saved
(ADR-0003), into a new file that replaces the chosen one only once it's written in full. Import
reads a file in memory and never unpacks it to disk: only the manifest and the CSVs it names are
read, each within a size, then the revision is checked like any save. The file's name and id
aren't the new dataset's, so their issues don't stop an import: the user names it, and the agent
makes its id.
"""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

from icmm.dataset.checks import DatasetError, Issue, validate_dataset
from icmm.dataset.files import MANIFEST, NewerFormatError, bytes_digest, load_revision
from icmm.dataset.model import DATASET_NAME, FORMAT, Dataset

MAX_FILE_BYTES = 50_000_000
"""More than a dataset file can hold: 32 protocols of 1,000 points pack into about 1 MB."""
MAX_ENTRIES = 1_000
MAX_ENTRY_BYTES = 8 * 2**20
"""The most any one file inside may unpack to; a full protocol's CSV is about 80 kB."""

_PLACEHOLDER_ID = "0000000000"
_PLACEHOLDER_NAME = "imported"
_DATASET_NAME = re.compile(DATASET_NAME)
_IGNORED = re.compile(r"(^|/)(__MACOSX/|\.DS_Store$)")
"""What macOS's Compress adds beside a folder's files."""
_UNSAFE = re.compile(r"(\x00|^/|\\|:|(^|/)\.{0,2}(/|$))")
"""A name that isn't a plain path down from the archive's top: with a NUL, absolute, with a
drive or a backslash, or with an empty, `.` or `..` part. Such files are never read. It's
matched against the name as the archive spells it (`ZipInfo.orig_filename`): `zipfile` cuts a
read name at its NUL, and on Windows turns its backslashes into slashes."""

type Problem = Literal["not_dataset", "damaged", "invalid", "newer"]


class FileProblem(Exception):
    """Why a file can't be imported, with the raw words for its last line."""

    def __init__(
        self,
        problem: Problem,
        detail: str,
        *,
        issues: list[Issue] | None = None,
        format: int | None = None,
        name: str | None = None,
        protocol_names: list[str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.problem: Problem = problem
        self.detail = detail
        self.issues = issues or []
        """With `invalid`, every issue the checks found, at its path in the dataset."""
        self.format = format
        """The format the file's manifest names, when it names one."""
        self.name = name
        """The dataset's name in the file, when it has one."""
        self.protocol_names = protocol_names or []
        """Each protocol's name in the file, which `issues` count by; empty for an unnamed one."""


@dataclass(frozen=True)
class Imported:
    dataset: Dataset
    """The file's dataset, under a placeholder id, and a placeholder name when its own isn't one
    a dataset can have."""
    name: str | None
    """The dataset's name in the file; `None` when it isn't one a dataset can have."""
    format: int
    files: dict[str, bytes] = field(repr=False)


def pack(files: Mapping[str, bytes]) -> bytes:
    """A dataset file of `files`: `dataset.json` first, then the CSVs in the order given, each
    deflated and dated now."""
    if MANIFEST not in files:
        raise ValueError(f"no {MANIFEST} to pack")
    buffer = io.BytesIO()
    stamp = datetime.now().timetuple()[:6]
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in [MANIFEST, *(n for n in files if n != MANIFEST)]:
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])
    return buffer.getvalue()


def write_file(path: Path, files: Mapping[str, bytes], *, expected_digest: str) -> None:
    """Writes `files` as a dataset file at `path`, replacing what's there only once the new file
    is on disk; `ValueError` if they aren't the files `expected_digest` was taken of, and the
    OS's `OSError` if it can't write there."""
    if bytes_digest(files) != expected_digest:
        raise ValueError("the files to export aren't the revision's files")
    data = pack(files)
    staging = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
    try:
        with open(staging, "xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def read_file(path: Path) -> Imported:
    """The dataset in the dataset file at `path`, checked like any save but for its name and
    id; `FileProblem` when it can't be imported, and `OSError` when the file can't be read."""
    shown = path.name
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size > MAX_FILE_BYTES:
            raise FileProblem("not_dataset", f"{shown} · {size:,} bytes, more than a dataset holds")
        data = f.read(MAX_FILE_BYTES + 1)
    return read_bytes(data, shown)


def read_bytes(data: bytes, shown: str) -> Imported:
    """The dataset in the dataset file `data`, named `shown` in the raw words."""
    archive, entries = _entries(data, shown)
    files: dict[str, bytes] = {}
    try:
        raw, issues = load_revision(lambda name: _read(archive, entries, name, shown), files)
    except NewerFormatError:
        format = _format_of(files)
        raise FileProblem(
            "newer",
            f"{shown} · dataset format {format} · this ICMM reads up to format {FORMAT}",
            format=format,
        ) from None
    except DatasetError as error:
        if MANIFEST not in files:
            raise FileProblem("not_dataset", f"{shown} · no {MANIFEST} inside") from None
        raise _invalid(shown, error.issues, _format_of(files), None, []) from None
    name = raw.get("name")
    own = name if isinstance(name, str) and _DATASET_NAME.fullmatch(name) else None
    raw = {**raw, "id": _PLACEHOLDER_ID, "name": own or _PLACEHOLDER_NAME}
    issues = [i for i in issues or validate_dataset(raw) if i.path[:1] not in (("id",), ("name",))]
    if issues:
        raise _invalid(shown, issues, raw["format"], own, _protocol_names(raw))
    return Imported(Dataset.model_validate(raw), own, raw["format"], files)


def _entries(data: bytes, shown: str) -> tuple[zipfile.ZipFile, dict[str, zipfile.ZipInfo]]:
    """The archive's files under the folder holding its manifest, by their names there: its
    top, or the one folder the archive holds."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, ValueError, OSError) as e:
        raise FileProblem("damaged", f"{shown} · not a zip archive: {e}") from None
    if len(infos) > MAX_ENTRIES:
        raise FileProblem("not_dataset", f"{shown} · {len(infos):,} files inside")
    infos = [i for i in infos if not _UNSAFE.search(i.orig_filename.rstrip("/"))]
    files = [i for i in infos if not i.orig_filename.endswith("/")]
    names = [i.orig_filename for i in files if not _IGNORED.search(i.orig_filename)]
    tops = {n.split("/", 1)[0] for n in names if "/" in n}
    prefix = ""
    if MANIFEST not in names and len(tops) == 1 and not any("/" not in n for n in names):
        prefix = f"{tops.pop()}/"
    entries: dict[str, zipfile.ZipInfo] = {}
    for info in files:
        raw = info.orig_filename
        if not raw.startswith(prefix):
            continue
        name = raw[len(prefix) :]
        if "/" in name or _IGNORED.search(raw):
            continue
        if name in entries:
            raise FileProblem("damaged", f"{shown} · two files named {name} inside")
        entries[name] = info
    if MANIFEST not in entries:
        raise FileProblem("not_dataset", f"{shown} · no {MANIFEST} inside")
    return archive, entries


def _read(
    archive: zipfile.ZipFile, entries: dict[str, zipfile.ZipInfo], name: str, shown: str
) -> bytes:
    """The file `name` in the archive, unpacked within `MAX_ENTRY_BYTES`; `FileNotFoundError`
    when it has none."""
    info = entries.get(name)
    if info is None:
        raise FileNotFoundError(name)
    if info.flag_bits & 0x1:
        raise FileProblem("damaged", f"{shown} · {name} is encrypted")
    if info.file_size > MAX_ENTRY_BYTES:
        raise FileProblem("damaged", f"{shown} · {name} unpacks to {info.file_size:,} bytes")
    try:
        with archive.open(info) as f:
            data = f.read(MAX_ENTRY_BYTES + 1)
    except (zipfile.BadZipFile, NotImplementedError, EOFError, ValueError, OSError) as e:
        raise FileProblem("damaged", f"{shown} · {name}: {e}") from None
    if len(data) > MAX_ENTRY_BYTES:
        raise FileProblem("damaged", f"{shown} · {name} unpacks to more than it says")
    return data


def _format_of(files: Mapping[str, bytes]) -> int | None:
    try:
        version = json.loads(files[MANIFEST].decode("utf-8")).get("format")
    except (KeyError, ValueError, AttributeError):
        return None
    return version if type(version) is int else None


def _protocol_names(raw: dict[str, object]) -> list[str]:
    protocols = raw.get("protocols")
    return [
        p["name"] if isinstance(p, dict) and isinstance(p.get("name"), str) else ""
        for p in (protocols if isinstance(protocols, list) else [])
    ]


def _invalid(
    shown: str, issues: list[Issue], format: int | None, name: str | None, names: list[str]
) -> FileProblem:
    problems = f"{len(issues)} problem" + ("" if len(issues) == 1 else "s")
    at = f" · dataset format {format}" if format is not None else ""
    return FileProblem(
        "invalid",
        f"{shown}{at} · {problems}",
        issues=issues,
        format=format,
        name=name,
        protocol_names=names,
    )
