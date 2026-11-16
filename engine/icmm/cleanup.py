"""`icmm cleanup` (ADR-0020): a short detached process the agent starts, for what no run's
**Coordinator** is left to do. On a cluster it runs on the login node, doing only file and
database I/O and asking the scheduler (ADR-0013).

It finishes two lifecycle requests (ADR-0009):

- **Delete run.** The agent records a run's tombstone, so it has left every list. Cleanup then
  cancels every job of it the runs database names, launched or only recorded, and waits until the
  scheduler says none is waiting or running; only then removes the run's folder in its Output
  folder, and last, in one transaction, its rows and its request's success. Each step is safe to
  repeat, so a crash on either side of the removal is finished by the next pass.
- **Cancel run, with no live coordinator.** A run canceling whose claiming coordinator no longer
  runs (or that none has claimed: its first coordinating job still waits) is claimed by cleanup as
  its next generation, so a waiting successor can't take it up, and swept as a coordinator would
  sweep it: its tasks canceled, its running starts' best so far kept, and the run ended canceled.
  Its waiting coordinating jobs are canceled too. A cancel a live coordinator carries is its own.

And once a day, the first pass of the cleanup that claims it does the daily housekeeping
(`icmm.housekeeping`).

It goes on while it has work it can do, a pass every `CHECK_S`, and exits once it has none, or
after `GIVE_UP_AFTER_S` without headway (a scheduler that doesn't answer): the next agent pass
starts another while work is left. Two at once are safe: the generation fence lets one carry a
cancel, and each delete step can be repeated. The agent starts one only while the last one it
knows of has ended (`ensure`).
"""

from __future__ import annotations

import contextlib
import json
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from icmm import hand_over, housekeeping, processes, run_store
from icmm.db import FILE_NAME, HandOverPendingError, NewerSchemaError, RunsDb, feed_id

if TYPE_CHECKING:
    from icmm.coordinator.sweep import Coordinator
    from icmm.scheduler import Scheduler
    from icmm.topology import Lists

CHECK_S = 5.0
"""How often it looks again while work is left."""
GIVE_UP_AFTER_S = 600.0
"""How long it goes on without headway before it exits, leaving the work to the next one."""
LOG = "cleanup.log"
"""Its output, in the Data folder."""
_RECORD = "cleanup"
"""The `meta` key naming the last cleanup process started, as `<host>:<process>`."""


def work(conn: sqlite3.Connection) -> tuple[list[int], list[int]]:
    """The runs deleted whose rows are still here, and the runs in flight canceling: one query
    over two small indexes."""
    rows = conn.execute(
        "SELECT id, 0 FROM runs INDEXED BY runs_deleted WHERE deleted_at IS NOT NULL "
        "UNION ALL SELECT id, 1 FROM runs INDEXED BY runs_canceling "
        "WHERE canceling_since IS NOT NULL AND end_seq IS NULL AND deleted_at IS NULL ORDER BY 2, 1"
    ).fetchall()
    return [run for run, kind in rows if not kind], [run for run, kind in rows if kind]


def carried(conn: sqlite3.Connection, scheduler: Scheduler, run: int) -> bool | None:
    """Whether a live coordinator carries the run: the one that claimed it last still runs;
    `None` where the scheduler can't say yet."""
    row = conn.execute(
        "SELECT c.claimed_by FROM runs r JOIN coordinators c ON c.run_id = r.id "
        "AND c.generation = r.generation WHERE r.id = ?",
        (run,),
    ).fetchone()
    if row is None or row[0] is None:
        return False
    return scheduler.alive(row[0])


def needed(conn: sqlite3.Connection, scheduler: Scheduler) -> bool:
    """Whether there's work for cleanup: a run deleted, or one canceling that no live
    coordinator carries. A scheduler that can't say leaves it for the next look."""
    from icmm.scheduler import SchedulerUnavailableError

    deleted, canceling = work(conn)
    if deleted:
        return True
    for run in canceling:
        try:
            if carried(conn, scheduler, run) is False:
                return True
        except SchedulerUnavailableError:
            continue
    return False


def ensure(
    db: RunsDb,
    *,
    launch: Callable[[], str],
    alive: Callable[[str], bool] | None = None,
) -> bool:
    """Starts a cleanup with `launch`, which answers its identity, unless the last one started
    still runs; records it. Whether it started one."""
    running = alive or _alive
    (recorded,) = (
        db.connection()
        .execute("SELECT (SELECT value FROM meta WHERE key = ?)", (_RECORD,))
        .fetchone()
    )
    if recorded is not None and running(recorded):
        return False
    identity = launch()
    with db.write() as conn:
        _record(conn, identity)
    return True


def launch_process(data_folder: Path) -> str:
    """Starts `icmm cleanup` detached, from this engine, its output in the Data folder's
    `cleanup.log`; answers its identity."""
    popen = processes.launch_detached(
        [sys.executable, "-I", "-m", "icmm", "cleanup", "--data-folder", str(data_folder)],
        log=data_folder / LOG,
        cwd=data_folder,
    )
    _launched[:] = [p for p in _launched if p.poll() is None]  # reaps those that exited
    _launched.append(popen)
    return f"{socket.gethostname()}:{processes.identity(popen.pid) or f'{popen.pid}@'}"


_launched: list[subprocess.Popen[bytes]] = []
"""The cleanups this process started, kept so the agent reaps each once it exits."""


class Cleanup:
    """One cleanup process's work on a Data folder, a pass at a time."""

    def __init__(
        self,
        db: RunsDb,
        data_folder: Path,
        scheduler: Callable[[], Scheduler | None],
        *,
        lists: Lists | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        engine: str | None = None,
    ) -> None:
        """`scheduler` makes the platform's scheduler: one to look and delete with, and one
        for each run it carries as a coordinator. `wall_clock` is now in UTC, against which a
        deleted run's end and housekeeping's ages are told. `engine` is the key of the engine
        it runs from, which housekeeping keeps."""
        self.db = db
        self.engine = engine
        self.data_folder = data_folder
        self._make = scheduler
        self._scheduler: Scheduler | None = None
        self.lists = lists
        self.clock = clock
        self.wall_clock = wall_clock
        self._carrying: dict[int, tuple[Coordinator, Scheduler]] = {}
        """The runs canceling it has claimed, each with its coordinator's own scheduler."""

    def run_pass(self) -> tuple[bool, bool]:
        """One pass over the work: whether any is left for a later pass, and whether this one
        made headway."""
        from icmm.scheduler import SchedulerUnavailableError

        conn = self.db.connection()
        if hand_over.requested(conn, self.db.known):
            return False, False  # a newer engine's cleanup carries on once its agent has the runs
        at = self.wall_clock()
        if housekeeping.due(self.db, at) and housekeeping.claim(self.db, at):
            housekeeping.housekeep(self.db, self.data_folder, engine=self.engine, at=at)
        scheduler = self._scheduler_now()
        if scheduler is None:
            return False, False
        deleted, canceling = work(conn)
        left = headway = False
        for run in canceling:
            try:
                if run not in self._carrying:
                    if carried(conn, scheduler, run) is not False or not self._take_up(run):
                        continue
                    headway = True
                swept = self._carrying[run][0].sweep()
            except SchedulerUnavailableError:
                left = True
                continue
            except NewerSchemaError:
                raise
            except Exception:
                # One run's trouble never keeps the others waiting: it's tried again next pass.
                print(f"run #{run}'s cancel couldn't be carried out yet:", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                left = True
                continue
            if swept == "going":
                left = True
            else:
                c, its = self._carrying.pop(run)
                c.close()
                _close(its)
                headway = True
        for run in deleted:
            if self._delete(scheduler, run):
                headway = True
            else:
                left = True
        return left, headway

    def close(self) -> None:
        for c, its in self._carrying.values():
            c.close()
            _close(its)
        self._carrying.clear()
        _close(self._scheduler)
        self.db.close()

    # Canceling.

    def _take_up(self, run: int) -> bool:
        """Claims a run canceling as its next generation, then cancels the coordinating jobs
        still waiting for it; whether it claimed it."""
        from icmm.coordinator.sweep import Coordinator
        from icmm.scheduler import SchedulerUnavailableError

        conn = self.db.connection()
        generation, waiting = conn.execute(
            "SELECT (SELECT COALESCE(MAX(generation), 0) + 1 FROM coordinators WHERE run_id = ?), "
            "(SELECT json_group_array(job_id) FROM coordinators c JOIN runs r ON r.id = c.run_id "
            "WHERE c.run_id = ? AND c.generation > r.generation AND c.job_id IS NOT NULL)",
            (run, run),
        ).fetchone()
        scheduler = self._make()
        if scheduler is None:
            return False
        claimed = Coordinator.claim(
            self.data_folder,
            run,
            generation,
            scheduler=scheduler,
            lists=self.lists,
            clock=self.clock,
        )
        if claimed is None:
            _close(scheduler)
            return False
        self._carrying[run] = (claimed, scheduler)
        jobs = json.loads(waiting)
        if jobs:
            with contextlib.suppress(SchedulerUnavailableError):
                scheduler.cancel(jobs, waiting_only=True)
        return True

    # Deleting.

    def _delete(self, scheduler: Scheduler, run: int) -> bool:
        """Cancels the run's jobs, then once none is waiting or running removes its folder,
        then its rows; whether it's gone. Left for a later pass where the scheduler can't say,
        a job hasn't ended yet, or the folder can't be removed yet."""
        from icmm.coordinator import files
        from icmm.scheduler import SchedulerUnavailableError

        conn = self.db.connection()
        row = conn.execute(
            "SELECT output_folder, ended_at FROM runs WHERE id = ? AND deleted_at IS NOT NULL",
            (run,),
        ).fetchone()
        if row is None:
            return True
        # The jobs that may still be live: its last claimer's and the coordinating jobs queued
        # after it, and each array with a task its coordinator never saw end: one still out, or
        # ended uncollected as the run failed with its tasks canceled. The rest ended before the
        # run did, and a long-ended job's id may no longer be the scheduler's to ask about.
        launched = [
            job
            for (job,) in conn.execute(
                "SELECT c.job_id FROM coordinators c JOIN runs r ON r.id = c.run_id "
                "WHERE c.run_id = ? AND c.generation >= r.generation AND c.job_id IS NOT NULL "
                "UNION SELECT a.job_id FROM arrays a JOIN start_tries t ON t.run_id = a.run_id "
                "AND t.array = a.number WHERE a.run_id = ? AND a.job_id IS NOT NULL "
                "AND (a.ended_at IS NULL OR (t.cause IS NULL AND t.end_reason IS NULL))",
                (run, run),
            )
        ]
        recorded = [
            identity
            for (identity,) in conn.execute(
                "SELECT identity FROM coordinators WHERE run_id = ? AND job_id IS NULL "
                "UNION ALL SELECT identity FROM arrays WHERE run_id = ? AND job_id IS NULL",
                (run, run),
            )
        ]
        try:
            jobs = list(dict.fromkeys(launched + [j for i in recorded for j in scheduler.find(i)]))
            if jobs:
                scheduler.cancel(jobs, waiting_only=False)
                if not _all_ended(scheduler, jobs, settled=_settled(row[1], self.wall_clock())):
                    return False
        except SchedulerUnavailableError:
            return False
        folder = files.run_folder(row[0], run, feed_id(conn))
        try:
            remove(folder)
        except OSError as e:
            print(f"run #{run}'s folder {folder} can't be removed yet: {e}", file=sys.stderr)
            return False
        with self.db.write() as w:
            forget(w, run)
        return True

    def _scheduler_now(self) -> Scheduler | None:
        if self._scheduler is None:
            self._scheduler = self._make()
        return self._scheduler


SETTLED_S = 3600.0
"""How long after a run ended a job of it the scheduler can no longer place counts as ended: by
then any worker its cancel stopped has long since written its last file."""


def _settled(ended_at: str | None, now: datetime) -> bool:
    """Whether the run ended at least `SETTLED_S` before `now`."""
    if ended_at is None:
        return False
    ended = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
    return (now - ended).total_seconds() >= SETTLED_S


def _all_ended(scheduler: Scheduler, jobs: list[str], *, settled: bool) -> bool:
    """Whether every job's tasks have ended, as the scheduler says. A job whose state it can't
    place now (SLURM's queue has dropped it and accounting doesn't answer) is unknown, never
    ended, until the run's end has `settled`; a job that isn't the scheduler's kind (This
    computer's coordinators are processes) is asked whether it still runs."""
    states = scheduler.tasks(jobs)
    for job in jobs:
        tasks = states.get(job)
        if tasks is None:
            alive = scheduler.alive(job)
            if alive or (alive is None and not settled):
                return False
        elif not tasks:
            if not settled:
                return False
        elif any(t.status != "ended" for t in tasks.values()):
            return False
    return True


def remove(folder: Path) -> None:
    """Removes a run's folder and everything in it; one already gone is fine."""
    shutil.rmtree(folder, onexc=_gone_already)


def forget(conn: sqlite3.Connection, run: int) -> None:
    """Removes a deleted run's rows, and records its Delete run succeeded, in the caller's write
    transaction; a run not deleted, or already forgotten, is left as it is."""
    if (
        conn.execute(
            "SELECT 1 FROM runs WHERE id = ? AND deleted_at IS NOT NULL", (run,)
        ).fetchone()
        is None
    ):
        return
    run_store.finish_requests(conn, "delete_run", run)
    conn.execute(
        "DELETE FROM local_tasks WHERE job_id IN (SELECT id FROM local_jobs WHERE run_id = ?)",
        (run,),
    )
    for table in (
        "local_jobs",
        "start_tries",
        "starts",
        "arrays",
        "topologies",
        "coordinators",
        "run_timings",
        "run_stretches",
    ):
        conn.execute(f"DELETE FROM {table} WHERE run_id = ?", (run,))
    conn.execute("DELETE FROM runs WHERE id = ?", (run,))


def main(
    data_folder: str,
    *,
    scheduler: Callable[[Path], Scheduler | None] | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    engine: str | None = None,
) -> int:
    """`icmm cleanup`: passes until no work is left, or none has made headway for a while, or a
    newer engine takes the runs over (ADR-0020). A Data folder never set up is left as it is.
    `engine` is the engine it runs from, by default this interpreter's bundle."""
    from icmm import bundle
    from icmm import scheduler as schedulers

    folder = Path(data_folder).expanduser()
    if not (folder / FILE_NAME).exists():
        return 0
    make = scheduler or schedulers.for_host
    db = RunsDb(folder)
    try:
        with db.write() as conn:
            _record(conn, f"{socket.gethostname()}:{processes.me()}")
    except (NewerSchemaError, HandOverPendingError) as e:
        db.close()
        return hand_over.stop(e)
    cleanup = Cleanup(
        db,
        folder,
        lambda: make(folder),
        clock=clock,
        wall_clock=wall_clock,
        engine=engine or bundle.own_bundle_key(),
    )
    try:
        last = clock()
        while True:
            left, headway = cleanup.run_pass()
            if headway:
                last = clock()
            if not left or clock() - last >= GIVE_UP_AFTER_S:
                return 0
            sleep(CHECK_S)
    except NewerSchemaError as e:
        return hand_over.stop(e)  # the floor rose past it meanwhile
    finally:
        cleanup.close()


def _record(conn: sqlite3.Connection, identity: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE "
        "SET value = excluded.value",
        (_RECORD, identity),
    )


def _alive(recorded: str) -> bool:
    """Whether the cleanup recorded as `<host>:<process>` still runs: only on its own host can
    that be seen, so on another it reads as gone, and a second one starts, which is safe."""
    host, _, process = recorded.partition(":")
    return host == socket.gethostname() and processes.alive(process)


def _gone_already(function: object, path: str, error: BaseException) -> None:
    if not isinstance(error, FileNotFoundError):
        raise error


def _close(scheduler: object) -> None:
    close = getattr(scheduler, "close", None)
    if close is not None:
        close()
