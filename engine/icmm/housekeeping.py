"""Daily housekeeping (ADR-0020): what nothing can reach any more, removed by `icmm cleanup`.

The agent starts a cleanup when housekeeping is due, at most once a day, and the cleanup that
claims it does it first. It removes only:

- **abandoned save stages**: a dataset revision's `.staging` folder a day old, cut short as it was
  written (a config's are its repair's, `icmm.agent.configs.repair`);
- **unpublished dataset revisions**: a revision folder that's neither published nor intended by a
  save still unfinished, which lost its save's race or whose save failed, so no reader can reach
  it (ADR-0009);
- **requests finished 30 days ago**, but for those a run or a save's record still names;
  unfinished ones are never pruned (ADR-0009);
- **change rows a day old**: a desktop further behind resubscribes and reads everything again;
- **engines** no queued, held, running, failed or canceled run can use, no start still out runs
  from, no agent has served from and that wasn't installed in the last day; never the one cleanup
  runs from. A failed or canceled run can't use one below the floor: it resumes on a newer one.

Superseded dataset revisions stay (ADR-0014). On a cluster it runs on the login node and does
only file and database I/O (ADR-0013): one query per step, each delete in short transactions.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import sys
import traceback
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

from icmm.db import NewerSchemaError, RunsDb
from icmm.db import iso as _iso

EVERY = timedelta(days=1)
REQUESTS_KEPT = timedelta(days=30)
CHANGES_KEPT = timedelta(days=1)
STAGES_KEPT = timedelta(days=1)
"""A stage younger than this may be a save's under way."""
ENGINES_KEPT = timedelta(days=1)
"""An engine an agent served from, or that was installed, this recently stays."""
BATCH = 5000
"""Rows each delete transaction removes at most, so none holds the write lock long on NFS."""
RECORD = "housekept_at"
"""The `meta` key holding when housekeeping last began."""

_REVISION = re.compile(r"r(\d+)")
_STAGE = re.compile(r"\.r\d+-[0-9a-f]+\.staging")


def due(db: RunsDb, at: datetime) -> bool:
    """Whether a day has passed since housekeeping last began, at `at`: one indexed read."""
    row = db.connection().execute("SELECT value FROM meta WHERE key = ?", (RECORD,)).fetchone()
    return row is None or row[0] <= _iso(at - EVERY)


def claim(db: RunsDb, at: datetime) -> bool:
    """Records housekeeping as begun at `at`, while it's due; whether this cleanup does it."""
    with db.write() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (RECORD,)).fetchone()
        if row is not None and row[0] > _iso(at - EVERY):
            return False
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE "
            "SET value = excluded.value",
            (RECORD, _iso(at)),
        )
    return True


def housekeep(db: RunsDb, data_folder: Path, *, engine: str | None, at: datetime) -> None:
    """Every step, each going on past what it can't remove yet, and past a step that fails, as
    on a database busy past its timeout: the next day's tries again."""
    steps: list[Callable[[], None]] = [
        lambda: _datasets(db, data_folder, at),
        lambda: _requests(db, at),
        lambda: _changes(db, at),
        lambda: _engines(db, data_folder, engine, at),
    ]
    for step in steps:
        try:
            step()
        except NewerSchemaError:
            raise
        except Exception:
            print("a housekeeping step stopped:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)


def _datasets(db: RunsDb, data_folder: Path, at: datetime) -> None:
    """Each dataset's abandoned stages and unpublished revisions. Its folder is listed before
    the database is read, so a revision staged after its save was recorded is found intended or
    published."""
    from icmm.dataset.store import FOLDER

    root = data_folder / FOLDER
    try:
        datasets = [d for d in root.iterdir() if d.is_dir()]
    except FileNotFoundError:
        return
    old = (at - STAGES_KEPT).timestamp()
    for dataset in datasets:
        try:
            entries = list(dataset.iterdir())
        except OSError as e:
            print(f"housekeeping can't list {dataset}: {e}", file=sys.stderr)
            continue
        revisions = {int(m[1]): e for e in entries if (m := _REVISION.fullmatch(e.name))}
        reachable = {
            revision
            for (revision,) in db.connection().execute(
                "SELECT revision FROM dataset_revisions WHERE dataset_id = ? "
                "UNION SELECT revision FROM dataset_intents WHERE dataset_id = ?",
                (dataset.name, dataset.name),
            )
        }
        garbage = [path for revision, path in revisions.items() if revision not in reachable]
        garbage += [e for e in entries if _STAGE.fullmatch(e.name) and _changed(e) < old]
        for path in garbage:
            _remove(path)


def _requests(db: RunsDb, at: datetime) -> None:
    """The requests finished `REQUESTS_KEPT` ago, along their index, but those a run, a config's
    write or a dataset's save still names."""
    cutoff = _iso(at - REQUESTS_KEPT)
    while True:
        with db.write() as conn:
            gone = conn.execute(
                "DELETE FROM requests WHERE request_key IN (SELECT q.request_key FROM requests q "
                "INDEXED BY requests_finished WHERE q.finished_at IS NOT NULL "
                "AND q.finished_at < ? AND q.status IN ('succeeded', 'failed') "
                "AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.request_key = q.request_key) "
                "AND NOT EXISTS (SELECT 1 FROM config_claims c "
                "WHERE c.request_key = q.request_key) "
                "AND NOT EXISTS (SELECT 1 FROM dataset_intents d "
                "WHERE d.request_key = q.request_key) LIMIT ?)",
                (cutoff, BATCH),
            ).rowcount
        if gone < BATCH:
            return


def _changes(db: RunsDb, at: datetime) -> None:
    """The change rows `CHANGES_KEPT` old: those before the first younger one, which walks only
    the rows it removes, as seqs follow time. The feed's latest seq is kept apart from its rows,
    so the next change still takes the next one."""
    cutoff = _iso(at - CHANGES_KEPT)
    row = (
        db.connection()
        .execute("SELECT seq FROM changes WHERE at >= ? ORDER BY seq LIMIT 1", (cutoff,))
        .fetchone()
    )
    before = (
        row[0]
        if row is not None
        else db.connection().execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM changes").fetchone()[0]
    )
    while True:
        with db.write() as conn:
            gone = conn.execute(
                "DELETE FROM changes WHERE seq IN (SELECT seq FROM changes WHERE seq < ? "
                "ORDER BY seq LIMIT ?)",
                (before, BATCH),
            ).rowcount
        if gone < BATCH:
            return


def _engines(db: RunsDb, data_folder: Path, engine: str | None, at: datetime) -> None:
    """The engines installed in the Data folder that nothing keeps: no run that can still go on
    fits on it (one below the floor can't), no agent has served from it in `ENGINES_KEPT`, it
    wasn't installed in that time, and cleanup doesn't run from it. Each is moved aside first,
    so it stops being an install at once (ADR-0002), and a removal cut short leaves a
    `.staging-` folder the desktop's next install clears."""
    from icmm import engines
    from icmm.bundle import MANIFEST

    root = data_folder / "engine"
    try:
        installs = [e for e in root.iterdir() if (e / MANIFEST).is_file()]
    except FileNotFoundError:
        return
    conn = db.connection()
    cutoff = at - ENGINES_KEPT
    kept = {
        key
        for key, ended in conn.execute(
            "SELECT DISTINCT engine, end_seq IS NOT NULL FROM runs WHERE engine IS NOT NULL "
            "AND deleted_at IS NULL AND state != 'completed'"
        )
        if not ended or not engines.below_floor(conn, key)
    }
    kept |= {
        key
        for (key,) in conn.execute(
            "SELECT DISTINCT engine FROM start_tries INDEXED BY start_tries_out "
            "WHERE ended_at IS NULL AND engine IS NOT NULL"
        )
    }
    kept |= {
        key
        for (key,) in conn.execute("SELECT key FROM engines WHERE served_at > ?", (_iso(cutoff),))
    }
    for install in installs:
        key = install.name
        if key == engine or key in kept or _changed(install) > cutoff.timestamp():
            continue
        aside = root / f".staging-removed-{secrets.token_hex(4)}"
        try:
            os.rename(install, aside)
        except OSError as e:
            print(f"housekeeping can't remove engine {key} yet: {e}", file=sys.stderr)
            continue
        _remove(aside)


def _changed(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return float("inf")


def _remove(path: Path) -> None:
    try:
        shutil.rmtree(path, onexc=_gone_already)
    except OSError as e:
        print(f"housekeeping can't remove {path} yet: {e}", file=sys.stderr)


def _gone_already(function: object, path: str, error: BaseException) -> None:
    if not isinstance(error, FileNotFoundError):
        raise error
