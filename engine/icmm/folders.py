"""The folder checks and free space (ADR-0014), read from the folder's mount.

On a SLURM platform the runs database is opened by the agent on the login node and by each
run's owner job on a compute node, so the Data folder needs file locks that hold across
machines, and both folders must be on storage the compute nodes share. The checks read the
kernel's mount table: they test how a filesystem locks, not its name. A platform without SLURM
opens the database on one machine and takes any folder.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from icmm.wire.errors import DataFolderProblem
from icmm.wire.handshake import Scheduler

MOUNTINFO = "/proc/self/mountinfo"
BEEGFS_CONF = "/etc/beegfs/beegfs-client.conf"
QUOTA_TIMEOUT_S = 10.0

NODE_LOCAL = frozenset(
    {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "tmpfs", "ramfs", "vfat", "exfat"}
)
"""Filesystems on a machine's own disk or memory, which no other node sees."""


class Role(StrEnum):
    DATA = "data"
    OUTPUT = "output"


SUGGESTED = {Role.DATA: "icmm", Role.OUTPUT: "icmm/output"}
"""The folder in the home folder each role suggests, when it passes the check."""


@dataclass(frozen=True)
class Refusal:
    """Why a folder can't hold a role's folder on this platform."""

    folder: str
    """As the user wrote it."""
    role: Role
    problem: DataFolderProblem
    """`unshared` or `locks`."""
    storage: str
    """The mount point the folder is on."""
    fstype: str
    suggestion: str | None
    """A folder in the home folder that passes the same check (`~/icmm`); `None` if none
    does."""

    @property
    def sentence(self) -> str:
        """What's wrong and what to choose instead, in plain words: the reader needn't know what
        a file lock or a node is (Max, 2026-10-01)."""
        named = "a Data folder" if self.role is Role.DATA else "an Output folder"
        such_as = "" if self.suggestion is None else f", such as {self.suggestion}"
        admins = "your cluster’s admins can say which."
        if self.problem is DataFolderProblem.LOCKS:
            return (
                f"{self.folder} is on {self.storage}, where ICMM can’t keep its run records "
                "safe: several of the cluster’s computers save there at once, and that storage "
                f"can’t make them take turns. Choose {named} on other storage{such_as}; {admins}"
            )
        return (
            f"{self.folder} is on {self.storage}, which the cluster’s computers that run your "
            f"fits can’t reach. Choose {named} on storage they share{such_as}; {admins}"
        )

    @property
    def details(self) -> str:
        return f"{self.folder} · {self.storage} · {self.fstype}"


@dataclass(frozen=True)
class Mount:
    point: str
    fstype: str
    source: str
    options: dict[str, str]
    """Mount and filesystem options together; a flag's value is `""`."""


def refusal(
    path: str,
    role: Role,
    scheduler: Scheduler,
    *,
    mountinfo: str | None,
    read_text: Callable[[str], str],
    written: str,
    suggested: str,
) -> Refusal | None:
    """Why `path` (absolute, links resolved; `written` as the user wrote it) can't hold `role`'s
    folder, or `None` if it can. A refusal suggests the role's folder in the home folder, at
    `suggested` (absolute, links resolved), only when that one passes and isn't `path` itself.

    `mountinfo` is the kernel's mount table, `None` where the host has none to read.
    """
    if scheduler is not Scheduler.SLURM or mountinfo is None:
        return None
    found = _problem(path, role, mountinfo=mountinfo, read_text=read_text)
    if found is None:
        return None
    problem, mount = found
    passes = (
        suggested != path
        and _problem(suggested, role, mountinfo=mountinfo, read_text=read_text) is None
    )
    return Refusal(
        folder=written,
        role=role,
        problem=problem,
        storage=mount.point,
        fstype=mount.fstype,
        suggestion=f"~/{SUGGESTED[role]}" if passes else None,
    )


def _problem(
    path: str, role: Role, *, mountinfo: str, read_text: Callable[[str], str]
) -> tuple[DataFolderProblem, Mount] | None:
    mount = mount_of(path, mountinfo)
    if mount is None:
        return None
    if mount.fstype in NODE_LOCAL:
        return DataFolderProblem.UNSHARED, mount
    if role is Role.DATA and _locks_stay_local(mount, read_text):
        return DataFolderProblem.LOCKS, mount
    return None


def free_space(path: str, *, mountinfo: str | None, quota: str | None, disk_free: int) -> int:
    """The smaller of `disk_free` and the user's quota left on `path`'s filesystem, in bytes.

    `quota` is what `quota -w` printed; a filesystem it doesn't list has no quota.
    """
    mount = mount_of(path, mountinfo) if mountinfo else None
    left = _quota_left(mount.source, quota) if mount and quota else None
    return disk_free if left is None else min(disk_free, left)


def mount_of(path: str, mountinfo: str) -> Mount | None:
    """The mount `path` sits on: the one with the longest mount point above it, and of mounts
    stacked on one point the last, which is on top."""
    best: Mount | None = None
    for mount in _mounts(mountinfo):
        point = mount.point.rstrip("/")
        if (path == mount.point or path.startswith(point + "/")) and (
            best is None or len(mount.point) >= len(best.point)
        ):
            best = mount
    return best


def _mounts(mountinfo: str) -> list[Mount]:
    """Each line: `id parent dev root point options [optional…] - fstype source super`."""
    mounts = []
    for line in mountinfo.splitlines():
        fields = line.split()
        if "-" not in fields[6:]:
            continue
        dash = fields.index("-", 6)
        if len(fields) < dash + 3:
            continue
        options = _options(fields[5]) | _options(fields[dash + 3] if len(fields) > dash + 3 else "")
        mounts.append(
            Mount(
                point=_unescape(fields[4]),
                fstype=fields[dash + 1],
                source=_unescape(fields[dash + 2]),
                options=options,
            )
        )
    return mounts


def _options(text: str) -> dict[str, str]:
    return dict((o.partition("=")[0], o.partition("=")[2]) for o in text.split(",") if o)


def _unescape(text: str) -> str:
    """The kernel writes space, tab, newline and backslash in a path as octal escapes."""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), text)


def _locks_stay_local(mount: Mount, read_text: Callable[[str], str]) -> bool:
    options = mount.options
    if mount.fstype in ("nfs", "nfs4"):
        # SQLite locks with fcntl, which `local_lock=flock` still sends to the server.
        return "nolock" in options or options.get("local_lock") in ("posix", "all")
    if mount.fstype == "lustre":
        return "flock" not in options  # Lustre refuses locks unless mounted `flock`
    if mount.fstype in ("beegfs", "fhgfs"):
        try:
            conf = read_text(options.get("cfgFile") or BEEGFS_CONF)
        except OSError:
            conf = ""  # Taken at BeeGFS's default: locks on one machine.
        found = re.search(r"^\s*tuneUseGlobalFileLocks\s*=\s*(\w+)", conf, re.MULTILINE)
        return not (found and found.group(1).lower() == "true")
    return False


def _quota_left(source: str, quota: str) -> int | None:
    """Bytes left under the lower of the soft and hard block limits; `None` with neither."""
    for line in quota.splitlines():
        fields = line.split()
        if len(fields) < 4 or fields[0] != source:
            continue
        try:
            used, soft, hard = (int(f.rstrip("*")) for f in fields[1:4])
        except ValueError:
            return None
        limits = [limit for limit in (soft, hard) if limit > 0]
        return max(0, min(limits) - used) * 1024 if limits else None
    return None


# --- on this host ------------------------------------------------------------------------------


def check_folder(folder: str, role: Role, scheduler: Scheduler) -> Refusal | None:
    """Why `folder`, as the user wrote it, can't hold `role`'s folder on this host."""
    return refusal(
        _resolved(folder),
        role,
        scheduler,
        mountinfo=_read(MOUNTINFO),
        read_text=lambda p: Path(p).read_text(encoding="utf-8", errors="replace"),
        written=folder,
        # Its links resolved, as the folder's are: a link back into refused storage fails too.
        suggested=_resolved(f"~/{SUGGESTED[role]}"),
    )


def folder_space(folder: str) -> int | None:
    """Free bytes for `folder` on this host; `None` if its disk can't be read."""
    path = _resolved(folder)
    try:
        disk_free = shutil.disk_usage(_existing(Path(path))).free
    except OSError:
        return None
    return free_space(path, mountinfo=_read(MOUNTINFO), quota=_quota(), disk_free=disk_free)


def _resolved(folder: str) -> str:
    """`folder` made absolute with its links resolved, as far as it exists yet."""
    path = Path(os.path.expanduser(folder)).absolute()
    existing = _existing(path)
    return str(Path(os.path.realpath(existing)) / path.relative_to(existing))


def _existing(path: Path) -> Path:
    while not path.exists() and path.parent != path:
        path = path.parent
    return path


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _quota() -> str | None:
    """What `quota -w` prints for the user, where Linux has it; one bounded command."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        done = subprocess.run(
            ["quota", "-w"], capture_output=True, text=True, timeout=QUOTA_TIMEOUT_S, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    # `quota` exits 1 when the user is over a limit, and still prints the table.
    return done.stdout or None


def from_home(path: str) -> str:
    """`path` with a leading home folder written `~/`, its separators `/` as the desktop writes
    them; on Windows the comparison ignores case, as the file system does."""
    home = os.path.expanduser("~").rstrip("/" + os.sep)
    if not home:
        return path
    if os.path.normcase(path) == os.path.normcase(home):
        return "~"
    head = os.path.normcase(path[: len(home) + 1])
    if head in {os.path.normcase(home + "/"), os.path.normcase(home + os.sep)}:
        return "~/" + path[len(home) + 1 :].replace(os.sep, "/")
    return path
