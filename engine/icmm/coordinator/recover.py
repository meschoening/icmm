"""Relaunching This computer's runs whose **Coordinator** is gone (ADR-0019).

No scheduler restarts a coordinator here when it crashes, is killed, or goes down with the
computer, so the agent's lifecycle dispatcher, every pass, and `icmm recover`, each time ICMM
opens, look at every run in flight and its latest generation:

- every run is left alone while a newer engine is taking them over (`icmm.hand_over`): a
  generation of this engine would refuse it;
- one canceling is left to `icmm cleanup`, which ends it canceled (`icmm.cleanup`);
- one launched or claimed by no process yet is left alone: generation 1's hand-off, and a
  Resume's, is the dispatcher's;
- one whose process still runs, the one that claimed it, else the one launched, is left alone;
- if that generation and the two before it made no progress, the run fails, with the last one's
  log (generations before its latest Resume don't count): its tasks are canceled first, then
  what was out is ended, its starts left unfinished. From a generation's second sweep, a worker
  still running, a wait for slots that running starts or live earlier runs hold, or a hold for
  space is progress here (`LocalScheduler._tick`), so restarts never fail a healthy run;
- else the next generation is launched, inside the write transaction that records it, so the
  record and the process come together and the new coordinator's claim waits for the commit. A
  launch the computer refuses, as for a run whose engine is no longer installed, fails the run in
  its words; one it can't make yet is made next pass.

Each re-checks the run in its transaction, so two relaunchers at once launch one generation.
Failing a run is a coordinator's work everywhere else (ADR-0019); here no coordinator is left to
do it, so the relauncher does, in the write transaction that checks no generation has claimed or
been launched since it read the run.
"""

from __future__ import annotations

import sqlite3
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path

from icmm import cleanup, hand_over, platform_settings, run_store
from icmm.coordinator import files
from icmm.coordinator.sweep import STALLED_GENERATIONS, fail_unfinished
from icmm.db import (
    FILE_NAME,
    HandOverPendingError,
    NewerSchemaError,
    RunsDb,
    append_change,
    feed_id,
    now,
)
from icmm.scheduler import CoordinatorLaunch, RefusedError, SchedulerUnavailableError
from icmm.scheduler.local import LocalScheduler
from icmm.wire.run import FailureCause, RunFailure


@dataclass(frozen=True)
class _InFlight:
    """A run in flight, as its latest generation left it."""

    id: int
    claimed: int
    """The generation that claimed it last; 0 for none."""
    output_folder: str
    engine: str | None
    latest: int
    """Its latest generation, launched or claimed."""
    process: str | None
    stalled: bool
    """Whether the latest generation and the two before it made no progress."""


def relaunch(db: RunsDb, data_folder: Path, scheduler: LocalScheduler) -> list[int]:
    """One pass over the runs in flight; answers the runs relaunched."""
    conn = db.connection()
    if hand_over.requested(conn, db.known):
        return []
    feed = feed_id(conn)
    runs = [
        _InFlight(*row)
        for row in conn.execute(
            "SELECT r.id, r.generation, r.output_folder, r.engine, c.generation, "
            "COALESCE(c.claimed_by, c.job_id), (SELECT COUNT(*) FROM coordinators s "
            "WHERE s.run_id = r.id AND s.generation > c.generation - ? AND s.progressed = 0 "
            "AND s.generation >= COALESCE(r.resumed_generation, 0)) >= ? "
            "FROM runs r INDEXED BY runs_in_flight JOIN coordinators c ON c.run_id = r.id "
            "AND c.generation = (SELECT MAX(generation) FROM coordinators WHERE run_id = r.id) "
            "WHERE r.end_seq IS NULL AND r.deleted_at IS NULL AND r.canceling_since IS NULL "
            "ORDER BY r.id",
            (STALLED_GENERATIONS, STALLED_GENERATIONS),
        ).fetchall()
    ]
    relaunched: list[int] = []
    for run in runs:
        try:
            if _relaunch(db, data_folder, scheduler, run, feed):
                relaunched.append(run.id)
        except Exception:
            # One run's trouble never keeps the others waiting: it's asked again next pass.
            print(f"run #{run.id} couldn't be relaunched:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
    return relaunched


def main(data_folder: str) -> int:
    """`icmm recover`: one pass, as ICMM opens, then `icmm cleanup` where it has work. A Data
    folder never set up is left as it is, and one this engine is below the floor of, or whose
    floor an agent is to raise, too (ADR-0020)."""
    from icmm import scheduler as schedulers

    folder = Path(data_folder).expanduser()
    if not (folder / FILE_NAME).exists():
        return 0
    scheduler = schedulers.for_host(folder)
    if not isinstance(scheduler, LocalScheduler):
        return 0
    db = RunsDb(folder)
    try:
        for run in relaunch(db, folder, scheduler):
            print(f"relaunched run #{run}", file=sys.stderr)
        # A run deleted, or canceling with its coordinator gone, as the computer restarted.
        if cleanup.needed(db.connection(), scheduler):
            cleanup.ensure(db, launch=lambda: cleanup.launch_process(folder))
    except (NewerSchemaError, HandOverPendingError) as e:
        return hand_over.stop(e)
    finally:
        db.close()
        scheduler.close()
    return 0


def _relaunch(
    db: RunsDb, data_folder: Path, scheduler: LocalScheduler, run: _InFlight, feed: str
) -> bool:
    """The run's next generation, unless its latest one runs or hasn't launched yet, or the run
    fails instead; whether it launched one."""
    if run.process is None or scheduler.alive(run.process):
        return False
    # Gone without recording its end, if it was killed: This computer keeps no exit code.
    with db.write() as conn:
        run_store.coordinator_ended(conn, run.id, run.latest, None, own=False)
    folder = files.run_folder(run.output_folder, run.id, feed)
    if run.stalled:
        detail = files.tail(files.coordinator_log(folder, run.latest))
        _fail(db, scheduler, run, FailureCause.COORDINATOR, detail)
        return False
    return _launch(db, data_folder, scheduler, run, folder, feed)


def _launch(
    db: RunsDb,
    data_folder: Path,
    scheduler: LocalScheduler,
    run: _InFlight,
    folder: Path,
    feed: str,
) -> bool:
    """Launches the run's next generation; whether it did."""
    generation = run.latest + 1
    try:
        with db.write() as conn:
            saved = platform_settings.read(conn)
            if _moved(conn, run) or saved is None:
                return False
            identity = files.identity(feed, run.id, "c", generation)
            conn.execute(
                "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
                (run.id, generation, identity),
            )
            job_id = scheduler.launch_coordinator(
                CoordinatorLaunch(
                    data_folder=data_folder,
                    run=run.id,
                    generation=generation,
                    identity=identity,
                    log=files.coordinator_log(folder, generation),
                    engine=run.engine,
                    job_defaults=saved.settings.job_defaults,
                )
            )
            launched = now()
            conn.execute(
                "UPDATE coordinators SET job_id = ?, launched_at = ? "
                "WHERE run_id = ? AND generation = ?",
                (job_id, launched, run.id, generation),
            )
            # Runs says it's running again since then, once its starts run again (#236).
            conn.execute("UPDATE runs SET relaunched_at = ? WHERE id = ?", (launched, run.id))
            append_change(conn, run_store.TOPIC, str(run.id))
    except RefusedError as e:
        _fail(db, scheduler, run, FailureCause.REFUSED, str(e) or None)
        return False
    except SchedulerUnavailableError as e:
        print(f"run #{run.id}'s coordinator can't be relaunched yet: {e}", file=sys.stderr)
        return False
    return True


def _fail(
    db: RunsDb,
    scheduler: LocalScheduler,
    run: _InFlight,
    cause: FailureCause,
    detail: str | None,
) -> None:
    """Cancels every task the run has out, then fails it, unless it has moved on meanwhile; left
    for the next pass if its tasks can't be canceled yet."""
    out = (
        db.connection()
        .execute(
            "SELECT identity, job_id FROM arrays INDEXED BY arrays_out "
            "WHERE run_id = ? AND ended_at IS NULL ORDER BY number",
            (run.id,),
        )
        .fetchall()
    )
    try:
        job_ids: list[str] = []
        for identity, job_id in out:
            job_ids += [job_id] if job_id is not None else scheduler.find(identity)
        if job_ids:
            scheduler.cancel(job_ids, waiting_only=False)
    except SchedulerUnavailableError as e:
        print(f"run #{run.id}'s tasks can't be canceled yet: {e}", file=sys.stderr)
        return
    with db.write() as conn:
        if not _moved(conn, run):
            fail_unfinished(conn, run.id, RunFailure(cause=cause, detail=detail, failed_starts=[]))


def _moved(conn: sqlite3.Connection, run: _InFlight) -> bool:
    """Whether the run has ended, or a generation has claimed or been launched, since it was
    read."""
    claimed, ended, latest = conn.execute(
        "SELECT generation, end_seq IS NOT NULL OR deleted_at IS NOT NULL, "
        "(SELECT MAX(generation) FROM coordinators WHERE run_id = runs.id) FROM runs WHERE id = ?",
        (run.id,),
    ).fetchone()
    return bool(ended) or (claimed, latest) != (run.claimed, run.latest)
