"""The lifecycle dispatcher (ADR-0009): the agent's thread that hands each accepted run to its first
**Coordinator**, through the scheduler (ADR-0019).

Submit records a run accepted and answers at once. This thread, on every agent connected to the
platform, finds the runs not yet handed off and launches generation 1 of each one's coordinator.
Each launch is recorded with its identity before it's made, so a launch whose reply was lost is
found again rather than repeated; two agents launching the same generation at once cost a job,
since only one coordinator claims it. Once the launch is recorded, or a coordinator has claimed
the run, its request has succeeded. A run whose coordinator the scheduler refuses fails, in the
scheduler's words, and so does one whose coordinating job waits on a hold that never clears, its
job canceled. Until a coordinator claims it, the run shows held while the cluster holds its
coordinating job, in the scheduler's words, else queued: one squeue and one sacct at most every
15 s, while a run waits for a coordinator to claim it. Once one has claimed, each generation
queues its own successor (`icmm.coordinator.sweep`). A run's latest coordinating job that ends
before it claims, with no live generation left to queue another, is launched again as the next
generation, up to the third since the last claim, after which the run's tasks are canceled and it
fails as its coordinating job kept failing. On This computer, where no scheduler
restarts a coordinator, each pass then relaunches every run whose coordinator is gone
(`icmm.coordinator.recover`).

It also records the engine the agent serves from, as it starts and hourly, and starts `icmm
cleanup` for the daily housekeeping when a day has passed since it last began (ADR-0020). While a
newer engine takes the runs over (`icmm.hand_over`), it does nothing more: any coordinator it
launched would refuse them.

It starts once `hello` has checked the Data folder, never opening the runs database before, and
only reads and writes it and makes the run's folder: one indexed query every few seconds and one
more every 15 s, within the login node's budget (ADR-0013). On This computer it also relaunches
runs whose coordinator is gone: a second query, and launching processes.
"""

from __future__ import annotations

import sys
import threading
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from icmm.db import RunsDb, append_change, feed_id, now

if TYPE_CHECKING:
    import sqlite3

    from icmm.scheduler import Scheduler
    from icmm.wire.run import FailureCause

POLL_S = 2.0
WAITING_CHECK_S = 15.0
"""How often the runs no coordinator has claimed yet are looked for, and their coordinating jobs
asked about."""
SERVED_EVERY_S = 3600.0
"""How often an agent records that it still serves from its engine, which housekeeping keeps
while one has in the last day."""


class Dispatcher:
    """A feed that pushes nothing: it starts and stops with the session."""

    def __init__(
        self,
        db: RunsDb,
        data_folder: Path,
        *,
        scheduler: Callable[[], Scheduler | None],
        interval_s: float = POLL_S,
        clock: Callable[[], float] = time.monotonic,
        cleanup: Callable[[], str] | None = None,
        cleanup_alive: Callable[[str], bool] | None = None,
        engine: str | None = None,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        """`scheduler` makes the platform's scheduler, once, the first time a pass needs it: on
        SLURM a run to hand off or a coordinating job to ask about, on This computer any pass;
        `None` where this engine can't drive it. `cleanup` starts `icmm cleanup` and answers its
        identity, and `cleanup_alive` says whether one still runs (`icmm.cleanup.ensure`).
        `engine` is the key of the engine bundle the agent runs from; `None` from a checkout,
        which isn't recorded. `wall_clock` is now in UTC."""
        self.db = db
        self.engine = engine
        self._wall_clock = wall_clock
        self._served_at: float | None = None
        self.data_folder = data_folder
        self._make: Callable[[], Scheduler | None] | None = scheduler
        self._scheduler: Scheduler | None = None
        self._on_this_computer: bool | None = None
        self.interval_s = interval_s
        self._clock = clock
        # The first check waits as long, so an agent just connected answers the desktop's reads
        # first; the runs show the last agent's judgment till then.
        self._checked_at = clock()
        self._cleanup_checked_at = clock()
        self._clean_now = threading.Event()
        self._cleanup = cleanup
        self._cleanup_alive = cleanup_alive
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._active = threading.Event()
        self.thread = threading.Thread(target=self._run, name="lifecycle")

    def start(self, push: object) -> None:
        self.thread.start()

    def close(self, deadline: float) -> None:
        self._stop.set()
        self._wake.set()
        if self.thread.is_alive():
            self.thread.join(max(0.0, deadline - time.monotonic()))

    def activate(self, _: object = None) -> None:
        """`hello`'s `on_sent`: the Data folder passed its checks, so dispatching may begin."""
        self._active.set()
        self._wake.set()

    def wake(self, _: object = None) -> None:
        """Dispatches now rather than at the next poll: after a submit's reply."""
        self._wake.set()

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                if self._active.is_set():
                    try:
                        self.dispatch()
                    except Exception:
                        traceback.print_exc(file=sys.stderr)
                self._wake.wait(self.interval_s)
                self._wake.clear()
        finally:
            if self._active.is_set():
                self.db.close()
                close = getattr(self._scheduler, "close", None)
                if close is not None:
                    close()  # This computer's scheduler keeps its own connection

    def dispatch(self) -> None:
        """One pass: every run whose submit or Resume hasn't been handed off, then every run
        whose first coordinating job still waits, then on This computer every run whose
        coordinator is gone."""
        from icmm import hand_over

        if hand_over.requested(self.db.connection(), self.db.known):
            return
        runs = (
            self.db.connection()
            .execute(
                "SELECT r.id, q.request_key, q.method FROM requests q "
                "INDEXED BY requests_unfinished JOIN runs r ON (q.method = 'submit_run' "
                "AND r.request_key = q.request_key) OR (q.method = 'resume_run' "
                "AND r.id = json_extract(q.params, '$.id')) "
                "WHERE q.method IN ('submit_run', 'resume_run') "
                "AND q.status IN ('accepted', 'acting', 'reconciliation_required') ORDER BY r.id"
            )
            .fetchall()
        )
        self._serve()
        if runs and (scheduler := self._scheduler_now()) is not None:
            for run, key, method in runs:
                self._hand_off(scheduler, run, key, resumed=method == "resume_run")
        self._judge_waiting()
        self._relaunch()
        self._clean()

    def clean_soon(self, _: object = None) -> None:
        """Looks for `icmm cleanup`'s work now rather than at the next check: after a cancel's
        or a delete's reply."""
        self._clean_now.set()
        self._wake.set()

    def _serve(self) -> None:
        """Records the engine this agent serves from, as it starts dispatching and hourly."""
        from icmm import engines

        if self.engine is None:
            return
        if self._served_at is not None and self._clock() - self._served_at < SERVED_EVERY_S:
            return
        with self.db.write() as conn:
            engines.served(conn, self.engine, self.db.known, self._wall_clock())
        self._served_at = self._clock()

    def _clean(self) -> None:
        """Starts `icmm cleanup` while it has work and none runs: a run deleted, one canceling
        that no live coordinator carries, or the daily housekeeping due. One query every
        `WAITING_CHECK_S`, or at once after a cancel or a delete; on SLURM, finding whether a
        coordinator carries a run asks the scheduler (ADR-0020)."""
        from icmm import cleanup, housekeeping

        if not self._clean_now.is_set():
            if self._clock() - self._cleanup_checked_at < WAITING_CHECK_S:
                return
        self._clean_now.clear()
        self._cleanup_checked_at = self._clock()
        deleted, canceling = cleanup.work(self.db.connection())
        due = housekeeping.due(self.db, self._wall_clock())
        if not deleted and not canceling and not due:
            return
        if not deleted and not due:
            scheduler = self._scheduler_now()
            if scheduler is None or not cleanup.needed(self.db.connection(), scheduler):
                return
        cleanup.ensure(
            self.db,
            launch=self._cleanup or (lambda: cleanup.launch_process(self.data_folder)),
            alive=self._cleanup_alive,
        )

    def _scheduler_now(self) -> Scheduler | None:
        """The platform's scheduler, made the first time a pass needs it: once, even if there's
        none, since finding none scans PATH."""
        if self._make is not None:
            self._scheduler, self._make = self._make(), None
        return self._scheduler

    def _relaunch(self) -> None:
        """On This computer, every run whose coordinator is gone, as its next generation. SLURM's
        scheduler isn't made for it: making that takes a command on the login node."""
        if self._on_this_computer is None:
            from icmm.scheduler import SchedulerKind, detect

            self._on_this_computer = detect() is SchedulerKind.LOCAL
        if not self._on_this_computer:
            return
        from icmm.scheduler.local import LocalScheduler

        scheduler = self._scheduler_now()
        if isinstance(scheduler, LocalScheduler):
            from icmm.coordinator.recover import relaunch

            relaunch(self.db, self.data_folder, scheduler)

    def _hand_off(self, scheduler: Scheduler, run: int, key: str, *, resumed: bool) -> None:
        """Launches the generation a submit (generation 1) or a Resume (the one it recorded)
        hands the run to, recorded with its identity first, so one whose reply was lost is found
        rather than sent twice (ADR-0009). Its request has succeeded once the launch is recorded,
        a coordinator has claimed the run, or the run is gone, ended or canceling, when no
        coordinator is needed: `icmm cleanup` ends a canceling run no coordinator carries."""
        from icmm import platform_settings
        from icmm.agent import requests
        from icmm.coordinator import files
        from icmm.scheduler import (
            CoordinatorLaunch,
            RefusedError,
            SchedulerUnavailableError,
        )

        with self.db.write() as conn:
            number, generation, gone, output_folder, engine, identity, job_id = conn.execute(
                "SELECT r.n, r.generation, r.end_seq IS NOT NULL OR r.deleted_at IS NOT NULL "
                "OR r.canceling_since IS NOT NULL, r.output_folder, r.engine, c.identity, "
                "c.job_id FROM (SELECT *, CASE WHEN ? THEN resumed_generation ELSE 1 END AS n "
                "FROM runs WHERE id = ?) r "
                "LEFT JOIN coordinators c ON c.run_id = r.id AND c.generation = r.n",
                (resumed, run),
            ).fetchone()
            if gone or generation >= number or job_id is not None:
                requests.mark(conn, key, "succeeded")
                return
            feed = feed_id(conn)
            tried = identity is not None
            if not tried:
                identity = files.identity(feed, run, "c", number)
                conn.execute(
                    "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
                    (run, number, identity),
                )
            conn.execute(
                "UPDATE requests SET status = 'acting' WHERE request_key = ? "
                "AND status = 'accepted'",
                (key,),
            )
            saved = platform_settings.read(conn)
        if saved is None:
            return
        if tried:
            try:
                found = scheduler.find(identity)
            except SchedulerUnavailableError:
                with self.db.write() as conn:
                    requests.mark(conn, key, "reconciliation_required")
                return
            if found:
                self._launched(run, key, number, found[0])
                return
        folder = files.run_folder(output_folder, run, feed)
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            # Its storage may be away for now: the run waits for it, asked again next pass.
            print(f"run #{run}'s folder can't be made yet: {e}", file=sys.stderr)
            return
        try:
            job_id = scheduler.launch_coordinator(
                CoordinatorLaunch(
                    data_folder=self.data_folder,
                    run=run,
                    generation=number,
                    identity=identity,
                    log=files.coordinator_log(folder, number),
                    engine=engine,
                    job_defaults=saved.settings.job_defaults,
                )
            )
        except RefusedError as e:
            self._refused(run, key, number, str(e) or None)
            return
        except SchedulerUnavailableError:
            return
        self._launched(run, key, number, job_id)

    def _judge_waiting(self) -> None:
        """Each run handed off that no coordinator has claimed shows held while its coordinating
        job is, in the scheduler's words, else queued; a job running changes nothing, as its
        coordinator judges the run once it claims it. A latest coordinating job that ended
        unclaimed is launched again (`_ended_unclaimed`): for a run no generation has claimed,
        and for a claimed one once its claiming generation's job has ended too, since a live
        claimer queues its own successor again."""
        from icmm import platform_settings, run_store
        from icmm.scheduler import SchedulerUnavailableError
        from icmm.wire.platform import SlurmJobDefaults

        # The whole check waits its turn, not only the ask: nothing waits most of the time.
        if self._clock() - self._checked_at < WAITING_CHECK_S:
            return
        self._checked_at = self._clock()
        conn = self.db.connection()
        # Each run's latest coordinating job, unclaimed: generation 1's, one launched again after
        # it, or a claimed run's successor; with the claiming generation's job, if any.
        rows = conn.execute(
            "SELECT r.id, c.generation, c.identity, c.job_id, r.state, r.hold, r.hold_reason, "
            "r.queued_reason, r.held_since, r.generation, COALESCE(k.job_id, k.claimed_by), "
            "MAX(r.generation, COALESCE(r.resumed_generation, 1) - 1) "
            "FROM runs r INDEXED BY runs_in_flight JOIN coordinators c "
            "ON c.run_id = r.id AND c.generation = (SELECT MAX(generation) FROM coordinators "
            "WHERE run_id = r.id) LEFT JOIN coordinators k ON k.run_id = r.id "
            "AND k.generation = r.generation WHERE r.end_seq IS NULL AND r.deleted_at IS NULL "
            "AND r.canceling_since IS NULL "
            "AND c.generation > r.generation "
            "AND (c.job_id IS NOT NULL OR c.generation > 1) ORDER BY r.id"
        ).fetchall()
        if not rows:
            return
        saved = platform_settings.read(conn)
        # Only a cluster holds a coordinating job: This computer's starts at once.
        if saved is None or not isinstance(saved.settings.job_defaults, SlurmJobDefaults):
            return
        scheduler = self._scheduler_now()
        if scheduler is None:
            return
        waiting = []
        counted: dict[int, int] = {}
        for run, number, identity, job_id, *shown, claimed, claimer, since in rows:
            counted[run] = since
            if job_id is None and not claimed:
                self._launch_first(scheduler, run, 0, number, identity)
            elif not claimed or claimer is not None:
                waiting.append((run, number, identity, job_id, *shown, claimed, claimer))
        if not waiting:
            return
        asked = {j for _, _, _, job_id, *_, claimer in waiting for j in (job_id, claimer) if j}
        try:
            states = scheduler.tasks(sorted(asked))
        except SchedulerUnavailableError:
            return

        def ended(job_id: str | None) -> bool:
            task = states.get(job_id or "", {}).get(0)
            return task is not None and task.status == "ended"

        def exit_code(job_id: str | None) -> int | None:
            task = states.get(job_id or "", {}).get(0)
            return None if task is None else task.exit_code

        judged: list[tuple[str, str | None, str | None, str | None, str | None, int]] = []
        for run, number, identity, job_id, *shown, claimed, claimer in waiting:
            state, hold, reason, queued, since = shown
            if claimed:
                # Only once the claimer's job has ended: a live one queues its successor itself.
                if not ended(claimer):
                    continue
                # It may have been killed before it could record its end (#289).
                self._coordinator_ended(run, claimed, exit_code(claimer))
                if job_id is None:
                    self._launch_first(scheduler, run, claimed, number, identity)
                elif ended(job_id):
                    self._coordinator_ended(run, number, exit_code(job_id))
                    self._ended_unclaimed(scheduler, run, claimed, number, counted[run])
                continue
            task = states.get(job_id, {}).get(0)
            if task is not None and task.status == "ended":
                self._coordinator_ended(run, number, task.exit_code)
                self._ended_unclaimed(scheduler, run, 0, number, counted[run])
                continue
            if task is None or task.status != "waiting":
                continue
            if task.refused is not None:
                self._refused_waiting(scheduler, run, number, job_id, task.refused)
                continue
            judged_reason = task.held or None
            judged_hold = None if judged_reason is None else "scheduler"
            judged_state = "queued" if judged_reason is None else "held"
            judged_queued = task.queued if judged_reason is None else None
            shown = (judged_state, judged_hold, judged_reason, judged_queued)
            if shown != (state, hold, reason, queued):
                if judged_hold != hold:
                    since = None if judged_hold is None else now()
                judged.append((*shown, since, run))
        if not judged:
            return
        with self.db.write() as conn:
            for state, hold, reason, queued, since, run in judged:
                # Fenced: a coordinator that claimed the run since judges it from its tasks.
                updated = conn.execute(
                    "UPDATE runs SET state = ?, hold = ?, hold_reason = ?, queued_reason = ?, "
                    "held_since = ?, state_since = CASE WHEN state = ? THEN state_since "
                    "ELSE ? END WHERE id = ? AND generation = 0 AND end_seq IS NULL",
                    (state, hold, reason, queued, since, state, now(), run),
                ).rowcount
                if updated:
                    append_change(conn, run_store.TOPIC, str(run))

    def _coordinator_ended(self, run: int, generation: int, exit_code: int | None) -> None:
        """Records that a coordinating job SLURM says has ended did, with its exit code, unless
        it recorded that itself."""
        from icmm import run_store

        with self.db.write() as conn:
            run_store.coordinator_ended(conn, run, generation, exit_code, own=False)

    def _ended_unclaimed(
        self, scheduler: Scheduler, run: int, claimed: int, number: int, since: int
    ) -> None:
        """A run's latest coordinating job ended without claiming it, canceled while it waited
        or crashed as it began, with no generation (`claimed` 0) or only an ended one before it:
        the next generation goes out, unless this was the third launched since generation
        `since`, the claimer or the one before the run's latest Resume, when the run fails as
        its coordinating job kept failing, with the last one's log (ADR-0019)."""
        from icmm.coordinator import files
        from icmm.coordinator.sweep import STALLED_GENERATIONS
        from icmm.wire.run import FailureCause

        if number - since < STALLED_GENERATIONS:
            with self.db.write() as conn:
                if not _unclaimed(conn, run, claimed, number):
                    return
                identity = files.identity(feed_id(conn), run, "c", number + 1)
                conn.execute(
                    "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
                    (run, number + 1, identity),
                )
            self._launch_first(scheduler, run, claimed, number + 1, identity)
            return
        conn = self.db.connection()
        (output_folder,) = conn.execute(
            "SELECT output_folder FROM runs WHERE id = ?", (run,)
        ).fetchone()
        folder = files.run_folder(output_folder, run, feed_id(conn))
        detail = files.tail(files.coordinator_log(folder, number))
        self._fail_unclaimed(scheduler, run, claimed, number, FailureCause.COORDINATOR, detail)

    def _launch_first(
        self, scheduler: Scheduler, run: int, claimed: int, number: int, identity: str
    ) -> None:
        """Launches generation `number`, recorded with its identity, waiting behind nothing,
        while generation `claimed` (0 for none) is the last to have claimed the run: one found
        by its identity is adopted, not sent twice (ADR-0009); one SLURM doesn't answer for is
        tried again next check, and one it refuses fails the run."""
        from icmm import platform_settings
        from icmm.coordinator import files
        from icmm.scheduler import CoordinatorLaunch, RefusedError, SchedulerUnavailableError
        from icmm.wire.run import FailureCause

        conn = self.db.connection()
        output_folder, engine = conn.execute(
            "SELECT output_folder, engine FROM runs WHERE id = ?", (run,)
        ).fetchone()
        saved = platform_settings.read(conn)
        if saved is None:
            return
        try:
            found = scheduler.find(identity)
            job_id = (
                found[0]
                if found
                else scheduler.launch_coordinator(
                    CoordinatorLaunch(
                        data_folder=self.data_folder,
                        run=run,
                        generation=number,
                        identity=identity,
                        log=files.coordinator_log(
                            files.run_folder(output_folder, run, feed_id(conn)), number
                        ),
                        engine=engine,
                        job_defaults=saved.settings.job_defaults,
                    )
                )
            )
        except RefusedError as e:
            self._fail_unclaimed(
                scheduler, run, claimed, number, FailureCause.REFUSED, str(e) or None
            )
            return
        except SchedulerUnavailableError:
            return
        with self.db.write() as w:
            w.execute(
                "UPDATE coordinators SET job_id = ?, launched_at = ? "
                "WHERE run_id = ? AND generation = ?",
                (job_id, now(), run, number),
            )

    def _refused_waiting(
        self, scheduler: Scheduler, run: int, number: int, job_id: str, detail: str
    ) -> None:
        """A first coordinating job held for a reason that never clears: the run fails, as one
        `sbatch` refused does, while no generation has claimed it, and the job is canceled. One
        that can't be canceled now finds the run ended when it starts, and exits."""
        from icmm.scheduler import SchedulerUnavailableError
        from icmm.wire.run import FailureCause

        if not self._fail_unclaimed(scheduler, run, 0, number, FailureCause.REFUSED, detail):
            return
        try:
            scheduler.cancel([job_id], waiting_only=False)
        except SchedulerUnavailableError:
            print(f"run #{run}'s coordinating job {job_id} is still waiting", file=sys.stderr)

    def _fail_unclaimed(
        self,
        scheduler: Scheduler,
        run: int,
        claimed: int,
        number: int,
        cause: FailureCause,
        detail: str | None,
    ) -> bool:
        """Fails the run with no coordinator left to: its tasks canceled first, so none runs on
        under a failed run, then in the write transaction that checks no generation after
        `claimed` has claimed it and none after `number` has been launched; whether it did. Left
        for the next check if its tasks can't be canceled yet."""
        from icmm.coordinator.sweep import fail_unfinished
        from icmm.scheduler import SchedulerUnavailableError
        from icmm.wire.run import RunFailure

        out = (
            self.db.connection()
            .execute(
                "SELECT identity, job_id FROM arrays INDEXED BY arrays_out "
                "WHERE run_id = ? AND ended_at IS NULL ORDER BY number",
                (run,),
            )
            .fetchall()
        )
        try:
            job_ids: list[str] = []
            for identity, job_id in out:
                job_ids += [job_id] if job_id is not None else scheduler.find(identity)
            if job_ids:
                scheduler.cancel(job_ids, waiting_only=False)
        except SchedulerUnavailableError:
            return False
        with self.db.write() as conn:
            if not _unclaimed(conn, run, claimed, number):
                return False
            fail_unfinished(conn, run, RunFailure(cause=cause, detail=detail, failed_starts=[]))
        return True

    def _launched(self, run: int, key: str, number: int, job_id: str) -> None:
        from icmm.agent import requests

        with self.db.write() as conn:
            conn.execute(
                "UPDATE coordinators SET job_id = ?, launched_at = ? "
                "WHERE run_id = ? AND generation = ?",
                (job_id, now(), run, number),
            )
            requests.mark(conn, key, "succeeded")

    def _refused(self, run: int, key: str, number: int, detail: str | None) -> None:
        """The run fails before the generation it was handed to has it, while no later one has
        claimed it: as a coordinator would fail it, with its starts unfinished for a Resume."""
        from icmm.agent import requests
        from icmm.coordinator.sweep import fail_unfinished
        from icmm.wire.run import FailureCause, RunFailure

        with self.db.write() as conn:
            (generation, ended) = conn.execute(
                "SELECT generation, end_seq IS NOT NULL FROM runs WHERE id = ?", (run,)
            ).fetchone()
            if generation < number and not ended:
                failure = RunFailure(cause=FailureCause.REFUSED, detail=detail, failed_starts=[])
                fail_unfinished(conn, run, failure)
            requests.mark(conn, key, "succeeded")


def _unclaimed(conn: sqlite3.Connection, run: int, claimed: int, number: int) -> bool:
    """Whether the run is still in flight with generation `claimed` (0 for none) the last to
    have claimed it, and `number` is its latest coordinating job."""
    row = conn.execute(
        "SELECT generation = ? AND end_seq IS NULL AND deleted_at IS NULL, "
        "(SELECT MAX(generation) FROM coordinators WHERE run_id = runs.id) FROM runs WHERE id = ?",
        (claimed, run),
    ).fetchone()
    return row is not None and bool(row[0]) and row[1] == number
