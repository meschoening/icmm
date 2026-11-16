"""The Platform settings in the runs database, and `platform.json`, their copy (ADR-0009).

The database holds the authoritative revision. `<data folder>/platform.json` is replaced
atomically after each save and repaired from the database when the agent starts, so a save cut
short between the commit and the file never leaves a stale copy behind for long.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path

from icmm.db import RunsDb, append_change, now
from icmm.durable import fsync_folder
from icmm.scheduler import WARN_S
from icmm.wire.errors import Issue, Severity
from icmm.wire.handshake import Scheduler
from icmm.wire.platform import (
    LocalJobDefaults,
    PlatformSettings,
    SavedPlatformSettings,
    SlurmJobDefaults,
)

PROJECTION = "platform.json"
TOPIC = "platform_settings"


MAX_CPUS_PER_START = 1024
MAX_RUNNING_STARTS = 10_000
MAX_MEMORY_PER_START_MB = 4 * 1024 * 1024
MAX_TIME_LIMIT_MIN = 365 * 24 * 60
MIN_TIME_LIMIT_PER_START_MIN = WARN_S // 60 + 1
"""A minute past the warning: a start's job is warned `WARN_S` before its limit, so a shorter
limit warns it as it begins (#323). Settings saved shorter still load, and are refused only at
their next save (#325)."""
MAX_CHECK_EVERY_S = 3600

_SLURM_NAME = re.compile(r"[A-Za-z0-9_.-]{1,64}")
"""An account or partition: narrower than SLURM's own names, so none can break a job script."""
_NODE = re.compile(r"[A-Za-z0-9_.\-\[\]]{1,253}")
"""A node, or a range of them in SLURM's form (`amd128-[2201-2204]`)."""
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def check(settings: PlatformSettings, scheduler: Scheduler) -> list[Issue]:
    """Every issue with `settings` on a host whose scheduler is `scheduler`."""
    issues = [
        *_folder_issues(["settings", "output_folder"], settings.output_folder, "Output folder"),
        *_job_default_issues(settings.job_defaults),
    ]
    if settings.job_defaults.type != scheduler.value:
        message = (
            "This platform runs its jobs through SLURM, so they need SLURM's job settings."
            if scheduler is Scheduler.SLURM
            else "This platform has no SLURM, so its jobs run as processes on it."
        )
        issues.insert(0, _issue(["type"], message))
    return issues


def _job_default_issues(jobs: SlurmJobDefaults | LocalJobDefaults) -> list[Issue]:
    issues = [
        *_range(["cpus_per_start"], jobs.cpus_per_start, 1, MAX_CPUS_PER_START, "CPUs per start"),
        *_range(
            ["max_running_starts"],
            jobs.max_running_starts,
            1,
            MAX_RUNNING_STARTS,
            "Max running starts",
        ),
    ]
    if isinstance(jobs, LocalJobDefaults):
        return issues
    for field, value in (("account", jobs.account), ("partition", jobs.partition)):
        if value is not None and not _SLURM_NAME.fullmatch(value):
            issues.append(
                _issue([field], "Use letters, digits, ., - and _ only, at most 64 of them.")
            )
    issues += _range(
        ["memory_per_start_mb"],
        jobs.memory_per_start_mb,
        1,
        MAX_MEMORY_PER_START_MB,
        "Memory per start",
        unit=" MB",
    )
    issues += _range(
        ["time_limit_per_start_min"],
        jobs.time_limit_per_start_min,
        MIN_TIME_LIMIT_PER_START_MIN,
        MAX_TIME_LIMIT_MIN,
        "Time limit per start",
        unit=" minutes",
    )
    issues += _range(
        ["run_coordinator_time_limit_min"],
        jobs.run_coordinator_time_limit_min,
        1,
        MAX_TIME_LIMIT_MIN,
        "Run coordinator time limit",
        unit=" minutes",
    )
    issues += _range(
        ["check_for_results_every_s"],
        jobs.check_for_results_every_s,
        1,
        MAX_CHECK_EVERY_S,
        "Check for results every",
        unit=" seconds",
    )
    for i, node in enumerate(jobs.excluded_nodes):
        if not _NODE.fullmatch(node):
            issues.append(
                _issue(
                    ["excluded_nodes", str(i)],
                    "Name one node, or a range such as amd128-[2201-2204], without spaces.",
                )
            )
    if jobs.container is not None:
        issues += _folder_issues(
            ["settings", "job_defaults", "container", "image"],
            jobs.container.image,
            "The container image",
        )
    return issues


def _range(
    field: list[str], value: int, low: int, high: int, label: str, *, unit: str = ""
) -> list[Issue]:
    if low <= value <= high:
        return []
    return [_issue(field, f"{label} must be from {low:,} to {high:,}{unit}.")]


def _folder_issues(path: list[str], value: str, label: str) -> list[Issue]:
    if not value.strip():
        return [Issue(path=path, message=f"{label} needs a path.", severity=Severity.ERROR)]
    if _CONTROL.search(value):
        return [_error(path, f"{label} can't hold a line break or a tab.")]
    if not (value.startswith("~") or _absolute(value)):
        return [_error(path, f"{label} needs a full path, starting with / or ~ (your home).")]
    return []


def _absolute(value: str) -> bool:
    """Absolute on the platform, whichever OS the agent runs on: `/…`, or `C:\\…` on Windows."""
    return value.startswith("/") or bool(re.match(r"[A-Za-z]:[\\/]", value))


def _issue(field: list[str], message: str) -> Issue:
    return _error(["settings", "job_defaults", *field], message)


def _error(path: list[str], message: str) -> Issue:
    return Issue(path=path, message=message, severity=Severity.ERROR)


class UnreadableSettingsError(Exception):
    """The stored settings don't fit this engine's model: saved by another version, or damaged."""


class StaleRevisionError(Exception):
    """The settings were saved elsewhere since the revision the edit started from."""

    def __init__(self, current: int | None) -> None:
        super().__init__(f"current revision {current}")
        self.current = current


def read(conn: sqlite3.Connection) -> SavedPlatformSettings | None:
    row = conn.execute("SELECT revision, settings FROM platform_settings WHERE id = 1").fetchone()
    if row is None:
        return None
    try:
        settings = PlatformSettings.model_validate_json(row[1])
    except ValueError as e:  # pydantic's ValidationError, without importing it here
        raise UnreadableSettingsError(str(e)) from e
    return SavedPlatformSettings(revision=row[0], settings=settings)


def save(
    conn: sqlite3.Connection, settings: PlatformSettings, expected_revision: int | None
) -> SavedPlatformSettings:
    """Saves over `expected_revision`, in the caller's write transaction, with its change row."""
    current = read(conn)
    current_revision = current.revision if current else None
    if current_revision != expected_revision:
        raise StaleRevisionError(current_revision)
    revision = (current_revision or 0) + 1
    conn.execute(
        "INSERT INTO platform_settings (id, revision, settings, saved_at) VALUES (1, ?, ?, ?) "
        "ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, "
        "settings = excluded.settings, saved_at = excluded.saved_at",
        (revision, settings.model_dump_json(), now()),
    )
    append_change(conn, TOPIC)
    return SavedPlatformSettings(revision=revision, settings=settings)


def write_projection(data_folder: Path, saved: SavedPlatformSettings) -> None:
    """Replaces `platform.json` with `saved`, flushed to disk before it takes the name."""
    text = json.dumps(saved.model_dump(mode="json"), indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=f".{PROJECTION}.", suffix=".tmp", dir=data_folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, data_folder / PROJECTION)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    fsync_folder(data_folder)


def repair_projection(data_folder: Path, db: RunsDb) -> None:
    """Rewrites `platform.json` from the current database settings under its write lock.

    With nothing saved, a `platform.json` is left alone: the database never takes one as
    current. The lock serializes repairs across processes and prevents a save between the
    authoritative read and replacement, so an older writer cannot publish after a newer one.
    """
    with db.write() as conn:
        saved = read(conn)
        if saved is None:
            return
        try:
            held = SavedPlatformSettings.model_validate_json(
                (data_folder / PROJECTION).read_bytes()
            )
        except (OSError, ValueError):
            held = None
        if held != saved:
            write_projection(data_folder, saved)
