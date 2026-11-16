"""Processes on This computer, each named by its id and its start time, so a recycled id never
passes for a process that has ended (ADR-0019): `identity` names one, `alive` asks whether it still
runs, `terminate` stops it. A zombie, ended but not yet reaped, is not alive.

A **Coordinator** is launched detached (`launch_detached`) to outlive whatever started it: quitting
ICMM, a crash or a closed terminal. Its workers (`Workers`) are plain children, except on Windows,
where they share a job object that ends them with the Coordinator, however it ends.
"""

from __future__ import annotations

import io
import os
import signal
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path


def _parse_proc_stat(text: bytes, boot: str) -> tuple[str, bool]:
    """A Linux `/proc/<pid>/stat` as (start token, zombie). Its command name in parentheses may
    hold spaces and parentheses, so fields count from the last `)`: the state, then the start
    time in clock ticks since boot, which a boot id makes unique across boots."""
    fields = text.rpartition(b")")[2].split()
    return f"{boot}.{int(fields[19])}", fields[0] in (b"Z", b"X")


if sys.platform == "darwin":
    import ctypes
    import struct

    _libc = ctypes.CDLL(None, use_errno=True)
    _libc.sysctl.restype = ctypes.c_int
    _libc.sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]

    _KINFO_PROC_SIZE = 648  # sizeof(struct kinfo_proc), the same on arm64 and x86-64
    _SZOMB = 5

    def _probe(pid: int) -> tuple[str, bool] | None:
        """(start token, zombie) of process `pid`, or None if none has this id."""
        if pid <= 0:
            return None
        # CTL_KERN, KERN_PROC, KERN_PROC_PID
        mib = (ctypes.c_int * 4)(1, 14, 1, pid)
        buf = ctypes.create_string_buffer(_KINFO_PROC_SIZE)
        size = ctypes.c_size_t(_KINFO_PROC_SIZE)
        if _libc.sysctl(mib, 4, buf, ctypes.byref(size), None, 0) != 0 or size.value == 0:
            return None
        # kinfo_proc.kp_proc: p_starttime (a timeval) first, p_stat a byte at offset 36.
        (sec,) = struct.unpack_from("=q", buf, 0)
        (usec,) = struct.unpack_from("=i", buf, 8)
        return f"{sec}.{usec:06d}", buf.raw[36] == _SZOMB

elif sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.GetProcessTimes.restype = wintypes.BOOL
    _kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    _kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    _kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _PROCESS_SET_QUOTA, _PROCESS_TERMINATE = 0x0100, 0x0001
    _STILL_ACTIVE = 259
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9  # JobObjectExtendedLimitInformation

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IoCounters(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_uint64)
            for name in (
                "ReadOperationCount",
                "WriteOperationCount",
                "OtherOperationCount",
                "ReadTransferCount",
                "WriteTransferCount",
                "OtherTransferCount",
            )
        ]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    def _probe(pid: int) -> tuple[str, bool] | None:
        """(start token, zombie) of process `pid`, or None if none has this id. A process that
        has ended but is still held open by another has an exit code: it counts as a zombie."""
        if pid <= 0:
            return None
        handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None
        try:
            created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
            code = wintypes.DWORD()
            if not _kernel32.GetProcessTimes(
                handle,
                ctypes.byref(created),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ) or not _kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return None
            start = created.dwHighDateTime << 32 | created.dwLowDateTime
            return str(start), code.value != _STILL_ACTIVE
        finally:
            _kernel32.CloseHandle(handle)

    def _new_kill_on_close_job() -> int:
        """A job object that ends every process in it once its last handle closes, which
        happens when the process holding it ends, however it ends."""
        job = _kernel32.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _kernel32.SetInformationJobObject(
            job,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            _kernel32.CloseHandle(job)
            raise error
        return job

    def _assign_to_job(job: int, pid: int) -> None:
        handle = _kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not _kernel32.AssignProcessToJobObject(job, handle):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _kernel32.CloseHandle(handle)

else:
    import functools

    @functools.cache
    def _boot() -> str:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()[:8]

    def _probe(pid: int) -> tuple[str, bool] | None:
        """(start token, zombie) of process `pid`, or None if none has this id."""
        if pid <= 0:
            return None
        try:
            text = Path(f"/proc/{pid}/stat").read_bytes()
        except OSError:
            return None
        return _parse_proc_stat(text, _boot())


def identity(pid: int) -> str | None:
    """`<pid>@<start>` of the process with this id, a zombie too; None if none has it."""
    probed = _probe(pid)
    return None if probed is None else f"{pid}@{probed[0]}"


def me() -> str:
    """This process's identity."""
    named = identity(os.getpid())
    assert named is not None
    return named


def alive(named: str) -> bool:
    """Whether the process `named` still runs: the same id, started at the same time, and not a
    zombie. A malformed name isn't alive."""
    pid, _, start = named.rpartition("@")
    if not start or not pid.isascii() or not pid.isdecimal() or int(pid) >= 2**31:
        return False
    probed = _probe(int(pid))
    return probed is not None and probed[0] == start and not probed[1]


def terminate(named: str) -> None:
    """Asks the process `named` to end (SIGTERM; TerminateProcess on Windows), if it runs."""
    if not alive(named):
        return
    try:
        os.kill(int(named.rpartition("@")[0]), signal.SIGTERM)
    except OSError:
        if alive(named):
            raise


def _append_to(path: Path) -> io.BufferedWriter:
    """`path` opened to append to, its folder made."""
    path.parent.mkdir(parents=True, exist_ok=True)
    return open(path, "ab")


def launch_detached(argv: Sequence[str], *, log: Path, cwd: Path) -> subprocess.Popen[bytes]:
    """Starts `argv` to outlive this process and the session or console it started from, its
    output appended to `log`. It keeps no input."""
    with _append_to(log) as out:

        def start(flags: int = 0) -> subprocess.Popen[bytes]:
            return subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                cwd=cwd,
                start_new_session=sys.platform != "win32",
                creationflags=flags,
            )

        if sys.platform != "win32":
            return start()
        detached = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            # Out of this process's job, if its job allows it, so closing the job doesn't end it.
            return start(detached | subprocess.CREATE_BREAKAWAY_FROM_JOB)
        except OSError as error:
            if getattr(error, "winerror", None) != 5:  # ERROR_ACCESS_DENIED: the job forbids it
                raise
            out.write(
                b"This computer's coordinator stays in its launcher's job object: Windows refused "
                b"to let it break away (winerror 5).\n"
            )
            out.flush()
            return start(detached)


class Workers:
    """Where a **Coordinator** starts its workers: plain children, their output appended to a
    file each. On Windows they share one job object, made on the first, that ends them with the
    Coordinator however it ends; elsewhere a Coordinator that dies leaves its workers to its
    successor."""

    def __init__(self) -> None:
        self._job: int | None = None

    def spawn(self, argv: Sequence[str], *, out: Path, cwd: Path) -> subprocess.Popen[bytes]:
        """Starts `argv`, its output appended to `out`. It keeps no input."""
        with _append_to(out) as file:
            child = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=file,
                stderr=subprocess.STDOUT,
                cwd=cwd,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        if sys.platform == "win32":
            try:
                if self._job is None:
                    self._job = _new_kill_on_close_job()
                _assign_to_job(self._job, child.pid)
            except OSError:
                child.kill()
                child.wait()
                raise
        return child
