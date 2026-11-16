"""The **Coordinator** (ADR-0019): the one process that carries a **Run**, on either scheduler.

A generation claims its run before it acts, so an earlier generation or a duplicate exits without
sending anything (ADR-0009). On SLURM it then queues its successor behind its own job, so whatever
ends it, the next generation takes over with no desktop connected; the generation that ends the
run cancels it. Then each sweep:

1. finds any array whose launch may have reached the scheduler unrecorded (ADR-0009);
2. stops the run on a waiting task the scheduler won't run as asked, and queues the successor
   anew if it went without taking over;
3. collects what ended: a result means the start ran to its end, scored through `icmm.scoring`; a
   task the scheduler says ended without one has failed, once its result has had time to appear,
   except that a start the cluster lost goes out again, avoiding the node that lost it, up to
   twice; running starts' latest log points are copied into the runs database, and added to
   their **Progress curves**, and each try that ended keeps its whole log's curve
   (`icmm.progress`) and adds the bytes it wrote to the run's folder size;
4. sends the next arrays in the rolling window (`window`), oldest topology first, each with the
   **Job defaults** as they are then, unless the run's folders are short of space;
5. says whether the run is running, held or queued, and ends it once nothing is left to fit.

A newer engine about to raise the floor asks it to hand the run over (`icmm.hand_over`): it stops
at the end of the sweep it's in, cancels the generation queued behind it, and claims no run
since; one the floor has risen past stops at its next write (ADR-0020).

Only **Finished** starts count. A run completes once every start has finished; it fails when it
stops on its own with starts unfinished: after 20 failed starts in a row, a refusal, or three
generations in a row that made no progress. A generation in a job hands on before its time
limit (`hand_on_after_s`).

It only reads the files it knows the names of (`files`), never re-reads the run's config or its
dataset's current revision, and writes the runs database in short transactions, each fenced by
its generation.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
import sys
import time
from collections.abc import Callable, Generator, Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from icmm import config as configs
from icmm import folders, hand_over, run_store, stretches
from icmm.coordinator import files
from icmm.coordinator.window import LiveArray, plan_window
from icmm.core import ProtocolScore, Topology
from icmm.dataset import read_revision
from icmm.dataset.store import revision_folder
from icmm.db import (
    HandOverPendingError,
    NewerSchemaError,
    RunsDb,
    append_change,
    feed_id,
    iso,
    now,
)
from icmm.jobs import ArrayJob, StartTask
from icmm.parameters import ParameterBounds, parameter_count, parameter_spread
from icmm.progress import Curve
from icmm.progress import read as read_curve
from icmm.scheduler import (
    ArrayLaunch,
    CoordinatorLaunch,
    RefusedError,
    Scheduler,
    SchedulerUnavailableError,
    TaskState,
)
from icmm.scoring import near_best, score
from icmm.topology import Lists, TopologyId
from icmm.wire.config import AllTopologies, Config, TopologySample
from icmm.wire.platform import JobDefaults, SlurmJobDefaults
from icmm.wire.run import FailedStarts, FailureCause, RunFailure, StartCause
from icmm.wire.start import StartLogPoint, StartResult

type Sweep = Literal["going", "ended", "superseded", "handed_over"]

_COORDINATOR = FailureCause.COORDINATOR

TOPIC = "runs"
STOP_AFTER_FAILURES = 20
"""Failed starts in a row, none finishing between, after which a run sends no more."""
LOST_RERUNS = 2
"""How many times a start the cluster lost is sent again before it fails as lost."""
STALLED_GENERATIONS = 3
"""Generations in a row without progress after which a run fails."""
SPACE_RESERVE = 100 * 10**6
"""What each folder keeps free, beside what the next starts will write (ADR-0014)."""
HAND_ON_MARGIN_S = 600
"""How long before its job's time limit a coordinating job hands on: time to finish its sweep,
whose `sacct` and `sbatch` may each take 30 s, and exit before SLURM ends it."""
SWEEP_EVERY_S = 5
"""How often This computer's coordinator sweeps; SLURM's says in its Job defaults."""
TOP_10 = 10
"""How many of a topology's finished starts its **Top 10** holds, the lowest Train RMSE first."""
_FINISHED = (
    "FROM start_tries t JOIN starts s ON s.run_id = t.run_id AND s.graph = t.graph "
    "AND s.open_state = t.open_state AND s.start_index = t.start_index AND s.try = t.try "
    "WHERE s.run_id = ? AND s.graph = ? AND s.open_state = ? AND s.state = 'finished'"
)
"""A topology's finished starts, each with the try that finished it."""


class SupersededError(Exception):
    """A later generation has claimed the run."""


@dataclass(frozen=True)
class _Run:
    """What the run fits, pinned at submit, and where its files go."""

    id: int
    settings: Config
    search_seed: int
    num_states: int
    topologies: int
    starts: int
    has_validation: bool
    engine: str | None
    output_folder: Path
    folder: Path
    feed: str
    revision: Path
    weights: list[float]
    start_bytes: int

    @property
    def per_topology(self) -> int:
        return self.starts // self.topologies

    @property
    def bounds(self) -> ParameterBounds:
        return ParameterBounds(**self.settings.bounds.model_dump())

    @property
    def per_start(self) -> int:
        """The evaluations each start runs: its budget, rounded up to a whole generation."""
        search = self.settings.search
        return -(-search.evaluation_budget // search.population) * search.population


@dataclass
class _Out:
    """A try that went out and hasn't ended."""

    topology: TopologyId
    start: int
    attempt: int
    array: int
    task: int
    job_id: str | None
    running: bool
    live_generation: int | None
    curve: str | None
    """Its **Progress curve** as its row keeps it; `None` before its log has been read."""

    @property
    def key(self) -> tuple[int, int, int, int]:
        return (self.topology.graph, self.topology.open_state, self.start, self.attempt)


@dataclass
class _Array:
    number: int
    topology: TopologyId
    identity: str
    tasks: int
    throttle: int
    job_id: str | None


class Coordinator:
    """One generation of a run's coordinator, once it has claimed the run."""

    def __init__(
        self,
        db: RunsDb,
        data_folder: Path,
        run: _Run,
        generation: int,
        *,
        scheduler: Scheduler,
        lists: Lists,
        clock: Callable[[], float],
        wall_clock: Callable[[], datetime],
        free_space: Callable[[str], int | None],
    ) -> None:
        self.db = db
        self.data_folder = data_folder
        self.run = run
        self.generation = generation
        self.scheduler = scheduler
        self.lists = lists
        self.clock = clock
        self.wall_clock = wall_clock
        self.free_space = free_space
        self._ended_seen: dict[tuple[int, int, int, int], float] = {}
        self._topologies: dict[TopologyId, Topology] = {}
        self._successor_refused = False
        self._canceled: set[str] = set()
        """The jobs this generation has canceled, as its run cancels."""

    @classmethod
    def claim(
        cls,
        data_folder: Path,
        run: int,
        generation: int,
        *,
        scheduler: Scheduler,
        lists: Lists | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        free_space: Callable[[str], int | None] = folders.folder_space,
    ) -> Coordinator | None:
        """Claims the run for `generation`; `None` if it can't: the run has ended, is gone, or
        this generation or a later one has claimed it. A run whose last three generations made no
        progress stops, and this one winds it down. `wall_clock` is now in UTC: when its arrays
        go out and its topologies end, which place its **Stretches**."""
        db = RunsDb(data_folder)
        try:
            claimed = _claim(db, data_folder, run, generation, scheduler.me())
        except BaseException:
            db.close()
            raise
        if claimed is None:
            db.close()
            return None
        pinned, held, stalled = claimed
        coordinator = cls(
            db,
            data_folder,
            pinned,
            generation,
            scheduler=scheduler,
            lists=lists or Lists(),
            clock=clock,
            wall_clock=wall_clock,
            free_space=free_space,
        )
        try:
            coordinator._queue_successor(None)
        except SupersededError:
            pass  # its first sweep says so
        if stalled >= STALLED_GENERATIONS:
            detail = files.tail(files.coordinator_log(pinned.folder, held))
            coordinator._stop(FailureCause.COORDINATOR, detail)
            coordinator.sweep()
        return coordinator

    def close(self) -> None:
        self.db.close()

    def ended(self, exit_code: int) -> None:
        """Records this generation's end, unless the runs database can't take it now: then
        whoever finds it gone does."""
        try:
            with self.db.write() as conn:
                run_store.coordinator_ended(conn, self.run.id, self.generation, exit_code, own=True)
        except Exception as e:
            print(f"generation {self.generation} couldn't record its end: {e!r}", file=sys.stderr)

    def sweep(self) -> Sweep:
        """One sweep: what ended, then the window, then the run's state; whether the run goes on,
        has ended, a later generation has it, or a newer engine takes it over."""
        try:
            if hand_over.requested(self.db.connection(), self.db.known):
                return self._hand_over()
            swept = self._sweep()
            if swept == "going" and hand_over.requested(self.db.connection(), self.db.known):
                return self._hand_over()
        except SupersededError:
            return "superseded"
        except NewerSchemaError:
            return "handed_over"  # the floor rose past this engine mid-sweep: it writes no more
        if swept == "ended":
            self._cancel_successor()
        return swept

    def _hand_over(self) -> Sweep:
        """Ends this generation for a newer engine's (ADR-0020): with progress, so the run goes
        on from its next generation as from any that ended, and with the generation queued
        behind it, of this engine, canceled. One that can't be canceled now claims nothing when
        it starts."""
        with self._write() as conn:
            self._progressed(conn)
        self._cancel_successor()
        return "handed_over"

    def hand_on(self) -> bool:
        """Ends this generation at its own time limit: progress, so its successor carries on.
        Whether one waits to: a generation with none, as when SLURM didn't answer, sweeps on."""
        try:
            with self._write() as conn:
                self._progressed(conn)
            return self._queue_successor(None)
        except SupersededError:
            return True

    @property
    def interval_s(self) -> int:
        jobs = self._job_defaults(self.db.connection())
        return (
            jobs.check_for_results_every_s if isinstance(jobs, SlurmJobDefaults) else SWEEP_EVERY_S
        )

    # The sweep.

    def _sweep(self) -> Sweep:
        listed, ended, canceling = (
            self.db.connection()
            .execute(
                "SELECT topologies_listed_at IS NOT NULL, end_seq IS NOT NULL, "
                "canceling_since IS NOT NULL FROM runs WHERE id = ?",
                (self.run.id,),
            )
            .fetchone()
        )
        stopping = self._stopping()
        if ended:
            return "ended"
        if not canceling and stopping is not None and stopping.cause is _COORDINATOR:
            return self._give_up()
        if not listed and not canceling:
            self._list_topologies()
        for array in [a for a in self._arrays() if a.job_id is None]:
            self._reconcile(array, resend=stopping is None and not canceling)
        arrays = self._arrays()
        live = [a for a in arrays if a.job_id is not None]
        if canceling:
            self._cancel_tasks(live)
        successor = self._successor_job()
        asked = [a.job_id for a in live if a.job_id] + ([successor] if successor else [])
        try:
            # Asked every sweep, with no job ids when nothing is out (`Scheduler.tasks`). Left
            # unanswered, the window waits for the next sweep's answer: no new array goes out and
            # no throttle changes.
            states = self.scheduler.tasks(asked)
        except SchedulerUnavailableError:
            states = None
        waiting_behind = None
        if states is not None:
            self._refuse(states)
            if successor is not None:
                waiting_behind = states.pop(successor, {}).get(0)
        if states is not None or successor is None:
            self._queue_successor(waiting_behind)
        self._collect(states)
        if canceling:
            pass  # its tasks are canceled: it waits for them to end
        elif self._stopping() is not None:
            self._wind_down(live, states)
        elif states is not None and len(live) == len(arrays):
            # An unresolved launch may already be running with its stored throttle. Leave the
            # window unchanged until reconciliation can account for every array's capacity.
            self._window(live, states)
        return self._settle(states)

    def _list_topologies(self) -> None:
        """The topology stage: the run's topologies from the bundled lists, a sample drawn from
        its **Search seed**, each with its starts, in the order the window sends them."""
        space = self.run.settings.topology
        which, n = space.which, self.run.num_states
        if isinstance(which, AllTopologies):
            orbits = self.lists.orbits(n, range(self.lists.state_graphs(n)))
            ids = [
                TopologyId(g, state)
                for g, lowest in orbits.items()
                for state, low in enumerate(lowest)
                if state == low
            ]
        elif isinstance(which, TopologySample):
            ids = self.lists.sample(n, which.count, self.run.search_seed)
        else:
            ids = []
            for id in which.ids:
                states = (
                    self.lists.open_states(n, id.graph)
                    if id.open_state is None
                    else [id.open_state]
                )
                ids += [TopologyId(id.graph, state) for state in states]
        if len(ids) != self.run.topologies:
            raise RuntimeError(
                f"listed {len(ids)} topologies, not the {self.run.topologies} pinned"
            )
        with self._write() as conn:
            conn.executemany(
                "INSERT INTO topologies (run_id, graph, open_state, position, state) "
                "VALUES (?, ?, ?, ?, 'next')",
                [(self.run.id, t.graph, t.open_state, i) for i, t in enumerate(ids)],
            )
            conn.executemany(
                "INSERT INTO starts (run_id, graph, open_state, start_index, state) "
                "VALUES (?, ?, ?, ?, 'pending')",
                (
                    (self.run.id, t.graph, t.open_state, i)
                    for t in ids
                    for i in range(self.run.per_topology)
                ),
            )
            conn.execute(
                "UPDATE runs SET topologies_listed_at = ? WHERE id = ?", (now(), self.run.id)
            )
            append_change(conn, TOPIC, str(self.run.id))

    def _arrays(self) -> list[_Array]:
        return [
            _Array(number, TopologyId(graph, state), identity, tasks, throttle, job_id)
            for number, graph, state, identity, tasks, throttle, job_id in self.db.connection()
            .execute(
                "SELECT number, graph, open_state, identity, tasks, throttle, job_id FROM arrays "
                "INDEXED BY arrays_out WHERE run_id = ? AND ended_at IS NULL ORDER BY number",
                (self.run.id,),
            )
            .fetchall()
        ]

    def _out(self) -> list[_Out]:
        rows = (
            self.db.connection()
            .execute(
                "SELECT t.graph, t.open_state, t.start_index, t.try, t.array, t.array_task, "
                "a.job_id, t.started_at IS NOT NULL, t.live_generation, t.curve "
                "FROM start_tries t INDEXED BY start_tries_out JOIN arrays a "
                "ON a.run_id = t.run_id AND a.number = t.array "
                "WHERE t.run_id = ? AND t.ended_at IS NULL ORDER BY t.array, t.array_task",
                (self.run.id,),
            )
            .fetchall()
        )
        return [_Out(TopologyId(g, o), *rest) for g, o, *rest in rows]

    # Collecting.

    def _collect(self, states: dict[str, dict[int, TaskState]] | None) -> None:
        """Ends each try whose result has appeared, or whose task ended without one, with its whole
        log's curve; marks the tries now running, with their latest log points."""
        ended: list[tuple[_Out, StartResult | None, TaskState | None, Curve | None]] = []
        running: list[tuple[_Out, StartLogPoint | None, str | None, Curve | None]] = []
        withdrawn: list[_Out] = []
        for out in self._out():
            task = files.start_task(self.run.folder, out.topology, out.start, out.attempt)
            result = files.read_result(task)
            if result is not None and not self._fits(result, out):
                result = None  # not this start's, or a best it can't read: as if none appeared
            state = None
            if states is not None and out.job_id in states:
                state = states[out.job_id].get(out.task)
            if result is not None and result.end_reason == "canceled" and states is None:
                # A stop by hand fails the start, a restart's is fit again; on This computer only
                # the scheduler's answer tells them apart (`LocalScheduler._settle`), so it's
                # collected at a sweep the scheduler answers.
                continue
            if result is not None:
                ended.append((out, result, state, files.log_curve(task, self.run.per_start)))
            elif state is None:
                continue
            elif state.status == "ended" and not state.ran:
                withdrawn.append(out)
            elif state.status == "ended":
                seen = self._ended_seen.setdefault(out.key, self.clock())
                if self.clock() - seen >= self.scheduler.result_grace_s:
                    files.forget_snapshot(task)
                    ended.append((out, None, state, files.log_curve(task, self.run.per_start)))
            elif state.status == "running":
                point = files.last_log_point(task)
                generation = None if point is None else point.generation
                if not out.running or generation != out.live_generation:
                    running.append((out, point, state.node, self._grown(task, out, point)))
        if not (ended or running or withdrawn):
            return
        wrote = sum(self._written(out) for out, *_ in ended)
        at = iso(self.wall_clock())
        with self._write() as conn:
            touched: set[TopologyId] = set()
            finished: set[TopologyId] = set()
            for out, result, state, curve in ended:
                if self._end_try(conn, out, result, state, curve):
                    finished.add(out.topology)
                touched.add(out.topology)
            ended_in = set(touched)
            for out in withdrawn:
                self._withdraw(conn, out)
                touched.add(out.topology)
            for out, point, node, curve in running:
                self._mark_running(conn, out, point, node, curve)
            completed = self._settle_topologies(conn, touched, ended_in, finished, at)
            if ended:
                self._progressed(conn)
                self._wrote(conn, wrote)
                stretches.record(conn, self.run.id, at, completed)
            append_change(conn, TOPIC, str(self.run.id))

    def _written(self, out: _Out) -> int:
        """The bytes the try wrote in the run's folder, looked at by name as it's collected."""
        task = files.start_task(self.run.folder, out.topology, out.start, out.attempt)
        return files.written(task, files.job_logs(self.run.folder, out.array, out.task, out.job_id))

    def _wrote(self, conn: sqlite3.Connection, wrote: int) -> None:
        """Adds what the tries collected wrote to the run's folder bytes; a run from before they
        were counted (`NULL`) keeps none (`icmm.db`, migration 18)."""
        conn.execute(
            "UPDATE runs SET folder_bytes = folder_bytes + ? WHERE id = ?", (wrote, self.run.id)
        )

    def _grown(self, task: StartTask, out: _Out, point: StartLogPoint | None) -> Curve | None:
        """A running try's curve with its latest log point: its log so far, the first time its
        log is read, so a try found running late still begins at its first generation."""
        if point is None:
            return None
        kept = read_curve(out.curve)
        if kept is None:
            return files.log_curve(task, self.run.per_start)
        return kept.added(point.evaluations, point.train_rmse, per_start=self.run.per_start)

    def _topology(self, topology: TopologyId) -> Topology:
        """The topology's states and edges, read from the lists once."""
        if topology not in self._topologies:
            self._topologies[topology] = self.lists.topology(self.run.num_states, topology)
        return self._topologies[topology]

    def _fits(self, result: StartResult, out: _Out) -> bool:
        return (
            (result.num_states, result.graph, result.open_state, result.search_seed)
            == (
                self.run.num_states,
                out.topology.graph,
                out.topology.open_state,
                self.run.search_seed,
            )
            and len(result.train_sse) == len(self.run.weights)
            and len(result.best) == parameter_count(self._topology(out.topology))
        )

    def _end_try(
        self,
        conn: sqlite3.Connection,
        out: _Out,
        result: StartResult | None,
        state: TaskState | None,
        curve: Curve | None,
    ) -> bool:
        """Ends the try, keeping its whole log's curve, or its last if its log can't be read;
        whether its start finished."""
        canceling = _canceling(conn, self.run.id)
        if result is None:
            assert state is not None
            outcome, cause = "failed", state.cause or StartCause.LOST
            if canceling and state.cause is None:
                # Stopped by its run's cancel before it could write its best so far.
                outcome, cause = "canceled", None
        elif result.end_reason == "budget":
            outcome, cause = "finished", None
        elif result.end_reason == "time_limit":
            outcome, cause = "failed", StartCause.TIME_LIMIT
        elif canceling:
            # Stopped by its run's cancel: it keeps its best so far, which never counts, and
            # Resume fits it again (ADR-0019).
            outcome, cause = "canceled", None
        else:
            # Signaled to stop while its run isn't canceling, by hand or by a preemption: it
            # kept its best so far, but the cluster lost it (ADR-0019).
            outcome, cause = "failed", StartCause.LOST
        key = (self.run.id, *out.key)
        if cause is StartCause.LOST and self._rerun(conn, out):
            outcome = "pending"
        at = now()
        conn.execute(
            "UPDATE start_tries SET cause = ?, node = COALESCE(?, node), "
            "peak_memory_mb = COALESCE(?, peak_memory_mb), exit_code = COALESCE(?, exit_code), "
            "scheduler_state = COALESCE(?, scheduler_state), ended_at = ?, "
            "curve = COALESCE(?, curve) "
            "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ? AND try = ?",
            (
                None if cause is None else cause.value,
                state.node if state else None,
                state.peak_memory_mb if state else None,
                state.exit_code if state else None,
                state.scheduler_state if state else None,
                at,
                None if curve is None else curve.to_json(),
                *key,
            ),
        )
        if result is not None:
            self._record_result(conn, key, result)
        conn.execute(
            "UPDATE starts SET state = ?, seed = COALESCE(?, seed), "
            "start_point = COALESCE(?, start_point) "
            "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ?",
            (
                outcome,
                None if result is None else result.seed,
                None if result is None else json.dumps(result.start_point),
                *key[:4],
            ),
        )
        finished, failed = int(outcome == "finished"), int(outcome == "failed")
        self._count(conn, out.topology, finished=finished, failed=failed, running=-out.running)
        if outcome == "canceled":
            # Stopped mid-run by its run's cancel: one canceled before it began is withdrawn, not
            # ended here (`TaskState.ran`). Resume fits it again from the beginning.
            conn.execute(
                "UPDATE runs SET starts_stopped = starts_stopped + 1 WHERE id = ?", (self.run.id,)
            )
        if finished:
            conn.execute("UPDATE runs SET failed_in_a_row = 0 WHERE id = ?", (self.run.id,))
        elif failed:
            conn.execute(
                "UPDATE runs SET failed_in_a_row = failed_in_a_row + 1 WHERE id = ?",
                (self.run.id,),
            )
            (in_a_row,) = conn.execute(
                "SELECT failed_in_a_row FROM runs WHERE id = ?", (self.run.id,)
            ).fetchone()
            if in_a_row >= STOP_AFTER_FAILURES:
                self._stop_in(conn, FailureCause.STOPPED_EARLY, None)
        return outcome == "finished"

    def _rerun(self, conn: sqlite3.Connection, out: _Out) -> bool:
        """Whether a start the cluster lost goes out again: while its run still sends, up to
        `LOST_RERUNS` times. Its next try starts from its own seed, with its own files."""
        if self._stopping() is not None or _canceling(conn, self.run.id):
            return False
        (lost,) = conn.execute(
            "SELECT COUNT(*) FROM start_tries WHERE run_id = ? AND graph = ? AND open_state = ? "
            "AND start_index = ? AND try < ? AND cause = 'lost'",
            (self.run.id, *out.key),
        ).fetchone()
        return lost < LOST_RERUNS

    def _record_result(
        self, conn: sqlite3.Connection, key: tuple[int, ...], result: StartResult
    ) -> None:
        """Stores a result's best and its errors, scored with the pinned revision's Weights."""
        fit = score(
            self.run.weights,
            [
                ProtocolScore(*sums)
                for sums in zip(
                    result.train_sse,
                    result.val_sse,
                    result.train_points,
                    result.train_failed,
                    result.val_points,
                    result.val_failed,
                    strict=True,
                )
            ],
        )
        conn.execute(
            "UPDATE start_tries SET best = ?, generations = ?, evaluations = ?, elapsed_s = ?, "
            "cost = ?, val_cost = ?, train_rmse = ?, val_rmse = ?, penalized = ?, "
            "train_sse = ?, train_points = ?, train_failed = ?, val_sse = ?, val_points = ?, "
            "val_failed = ?, end_reason = ?, still_improving = ?, still_improving_change = ?, "
            "node = COALESCE(node, ?) "
            "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ? AND try = ?",
            (
                json.dumps(result.best),
                result.generations,
                result.evaluations,
                result.wall_time_s,
                fit.train.cost,
                fit.val.cost,
                fit.train.rmse,
                fit.val.rmse,
                fit.train.penalized,
                json.dumps(result.train_sse),
                json.dumps(result.train_points),
                json.dumps(result.train_failed),
                json.dumps(result.val_sse),
                json.dumps(result.val_points),
                json.dumps(result.val_failed),
                result.end_reason,
                None if result.still_improving is None else int(result.still_improving),
                result.still_improving_change,
                result.host,
                *key,
            ),
        )
        if result.end_reason == "budget":
            (cpus,) = conn.execute(
                "SELECT cpus FROM start_tries WHERE run_id = ? AND graph = ? AND open_state = ? "
                "AND start_index = ? AND try = ?",
                key,
            ).fetchone()
            conn.execute(
                "INSERT INTO run_timings (run_id, cpus, starts, evaluations, elapsed_s) "
                "VALUES (?, ?, 1, ?, ?) ON CONFLICT (run_id, cpus) DO UPDATE SET "
                "starts = starts + 1, evaluations = evaluations + excluded.evaluations, "
                "elapsed_s = elapsed_s + excluded.elapsed_s",
                (self.run.id, cpus, result.evaluations, result.wall_time_s),
            )

    def _withdraw(self, conn: sqlite3.Connection, out: _Out) -> None:
        """A try whose task ended without ever starting: its start waits to go out again."""
        conn.execute(
            "UPDATE start_tries SET ended_at = ? WHERE run_id = ? AND graph = ? "
            "AND open_state = ? AND start_index = ? AND try = ?",
            (now(), self.run.id, *out.key),
        )
        conn.execute(
            "UPDATE starts SET state = 'pending' "
            "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ?",
            (self.run.id, *out.key[:3]),
        )
        self._count(conn, out.topology, running=-out.running)

    def _mark_running(
        self,
        conn: sqlite3.Connection,
        out: _Out,
        point: StartLogPoint | None,
        node: str | None,
        curve: Curve | None,
    ) -> None:
        """A try now running, on its node, with its latest log point and its curve so far: lists
        read them from here (ADR-0009)."""
        key = (self.run.id, *out.key)
        conn.execute(
            "UPDATE start_tries SET started_at = COALESCE(started_at, ?), "
            "live_generation = COALESCE(?, live_generation), "
            "live_evaluations = COALESCE(?, live_evaluations), "
            "live_train_rmse = CASE WHEN ? THEN ? ELSE live_train_rmse END, "
            "live_val_rmse = CASE WHEN ? THEN ? ELSE live_val_rmse END, "
            "curve = COALESCE(?, curve), node = COALESCE(?, node) "
            "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ? AND try = ?",
            (
                now(),
                None if point is None else point.generation,
                None if point is None else point.evaluations,
                point is not None,
                None if point is None else point.train_rmse,
                point is not None,
                None if point is None else point.val_rmse,
                None if curve is None else curve.to_json(),
                node,
                *key,
            ),
        )
        if not out.running:
            conn.execute(
                "UPDATE starts SET state = 'running' "
                "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ?",
                key[:4],
            )
            self._count(conn, out.topology, running=1)
            conn.execute(
                "UPDATE runs SET first_running_at = COALESCE(first_running_at, ?) WHERE id = ?",
                (now(), self.run.id),
            )

    def _count(
        self,
        conn: sqlite3.Connection,
        topology: TopologyId,
        *,
        finished: int = 0,
        failed: int = 0,
        running: int = 0,
    ) -> None:
        """Moves the topology's and the run's start counts."""
        counts = (finished, failed, running)
        conn.execute(
            "UPDATE topologies SET starts_finished = starts_finished + ?, "
            "starts_failed = starts_failed + ?, starts_running = starts_running + ? "
            "WHERE run_id = ? AND graph = ? AND open_state = ?",
            (*counts, self.run.id, topology.graph, topology.open_state),
        )
        conn.execute(
            "UPDATE runs SET starts_finished = starts_finished + ?, "
            "starts_failed = starts_failed + ?, starts_running = starts_running + ? WHERE id = ?",
            (*counts, self.run.id),
        )

    def _settle_topologies(
        self,
        conn: sqlite3.Connection,
        touched: Iterable[TopologyId],
        ended: set[TopologyId],
        finished: set[TopologyId],
        at: str,
    ) -> int:
        """Each touched topology's **Best start**, the finished start with the lowest Train RMSE,
        fewer failed train points first (ADR-0006); where a start finished, its near best and
        spread; and its end, once every start has ended: complete, or failed when none finished.
        Then the run's best topology. A start of those in `ended` ended at `at`. Answers how many
        topologies completed."""
        best_changed = False
        completed = 0
        for topology in touched:
            where = (self.run.id, topology.graph, topology.open_state)
            best = conn.execute(
                "SELECT t.start_index, t.train_rmse, t.val_rmse "
                f"{_FINISHED} ORDER BY t.penalized, t.start_index LIMIT 1",
                where,
            ).fetchone()
            # A canceled start is unfinished: Resume fits it again.
            (unended, starts_finished) = conn.execute(
                "SELECT SUM(state IN ('pending', 'sent', 'running', 'canceled')), "
                "SUM(state = 'finished') "
                "FROM starts WHERE run_id = ? AND graph = ? AND open_state = ?",
                where,
            ).fetchone()
            row = conn.execute(
                "SELECT state, best_start FROM topologies "
                "WHERE run_id = ? AND graph = ? AND open_state = ?",
                where,
            ).fetchone()
            state = row[0]
            if not unended:
                state = "complete" if starts_finished else "failed"
            if best is not None and best[0] != row[1]:
                best_changed = True
            conn.execute(
                "UPDATE topologies SET state = ?, best_start = ?, best_train_rmse = ?, "
                "best_val_rmse = ?, last_ended_at = COALESCE(?, last_ended_at) "
                "WHERE run_id = ? AND graph = ? AND open_state = ?",
                (
                    state,
                    *(best or (None, None, None)),
                    at if topology in ended else None,
                    *where,
                ),
            )
            if best is not None and topology in finished:
                self._settle_spread(conn, topology, best[1])
            if state != row[0] and state in ("complete", "failed"):
                column = "topologies_complete" if state == "complete" else "topologies_failed"
                conn.execute(
                    f"UPDATE runs SET {column} = {column} + 1 WHERE id = ?", (self.run.id,)
                )
                completed += state == "complete"
        if best_changed:
            self._settle_best(conn)
        return completed

    def _settle_spread(
        self, conn: sqlite3.Connection, topology: TopologyId, best_train_rmse: float | None
    ) -> None:
        """The topology's **Near best** count and its **Top 10**'s **Parameter spread**, worked
        again from its finished starts (ADR-0021)."""
        where = (self.run.id, topology.graph, topology.open_state)
        rmses = [rmse for (rmse,) in conn.execute(f"SELECT t.train_rmse {_FINISHED}", where)]
        top = [
            json.loads(vector)
            for (vector,) in conn.execute(
                f"SELECT t.best {_FINISHED} AND t.train_rmse IS NOT NULL "
                "ORDER BY t.train_rmse, t.start_index LIMIT ?",
                (*where, TOP_10),
            )
        ]
        spread = parameter_spread(self._topology(topology), self.run.bounds, top)
        stored = (
            (None,) * 6
            if spread is None
            else (
                spread.median,
                spread.min,
                spread.q1,
                spread.q3,
                spread.max,
                json.dumps(spread.parameters),
            )
        )
        conn.execute(
            "UPDATE topologies SET near_best = ?, spread = ?, spread_min = ?, spread_q1 = ?, "
            "spread_q3 = ?, spread_max = ?, parameter_spreads = ? "
            "WHERE run_id = ? AND graph = ? AND open_state = ?",
            (near_best(best_train_rmse, rmses), *stored, *where),
        )

    def _settle_best(self, conn: sqlite3.Connection) -> None:
        """The run's best topology: by its Best start's Val RMSE, "—" after every number, or by
        Train RMSE for a run without validation points (ADR-0006)."""
        rank = "best_val_rmse IS NULL, best_val_rmse, " if self.run.has_validation else ""
        best = conn.execute(
            "SELECT graph, open_state, best_train_rmse, best_val_rmse FROM topologies "
            f"WHERE run_id = ? AND best_start IS NOT NULL ORDER BY {rank}"
            "best_train_rmse IS NULL, best_train_rmse, position LIMIT 1",
            (self.run.id,),
        ).fetchone()
        conn.execute(
            "UPDATE runs SET best_graph = ?, best_open_state = ?, best_train_rmse = ?, "
            "best_val_rmse = ? WHERE id = ?",
            (*best, self.run.id),
        )

    # Sending.

    def _window(self, live: Sequence[_Array], states: dict[str, dict[int, TaskState]]) -> None:
        """Shares the cap among the arrays out, then sends the next arrays with what's left."""
        conn = self.db.connection()
        jobs = self._job_defaults(conn)
        if any(a.job_id not in states for a in live):
            return  # unknown is never ended: an array the scheduler left out keeps its slots
        # A task left out of an array's answer is unknown, so it keeps its slot too.
        unfinished = {
            a.job_id: a.tasks - sum(t.status == "ended" for t in states[a.job_id or ""].values())
            for a in live
        }
        waiting = list(self._waiting(conn, jobs.max_running_starts))
        plan = plan_window(
            [LiveArray(a.job_id or "", unfinished[a.job_id], a.throttle) for a in live],
            capacity=jobs.max_running_starts,
            queued=[len(starts) for _, starts in waiting],
        )
        sending = waiting[: len(plan.new_array_throttles)]
        rising = any(t > _throttle(live, j) for j, t in plan.throttle_updates)
        if (sending or rising) and not self._room([s for _, s in sending]):
            # Held for space: nothing more is released, by a new array or a raised throttle.
            plan = type(plan)(
                [(j, t) for j, t in plan.throttle_updates if t < _throttle(live, j)], []
            )
            sending = []
        for job_id, throttle in plan.throttle_updates:
            try:
                self.scheduler.set_throttle(job_id, throttle)
            except SchedulerUnavailableError:
                if throttle < _throttle(live, job_id):
                    return  # the cap no longer holds: nothing more this sweep
                continue
            with self._write() as w:
                w.execute(
                    "UPDATE arrays SET throttle = ? WHERE run_id = ? AND job_id = ?",
                    (throttle, self.run.id, job_id),
                )
        for (topology, starts), throttle in zip(sending, plan.new_array_throttles, strict=False):
            if not self._send(topology, starts, throttle, jobs):
                return

    def _waiting(
        self, conn: sqlite3.Connection, most: int
    ) -> Generator[tuple[TopologyId, list[int]]]:
        """The arrays waiting to go out, oldest topology first, each topology's unsent starts
        split at the scheduler's MaxArraySize; at most `most`, since each takes a slot."""
        size = self.scheduler.max_array_size
        given = 0
        topologies = conn.execute(
            "SELECT graph, open_state FROM topologies WHERE run_id = ? "
            "AND state IN ('next', 'fitting') ORDER BY position",
            (self.run.id,),
        ).fetchall()
        for graph, state in topologies:
            starts = [
                s
                for (s,) in conn.execute(
                    "SELECT start_index FROM starts INDEXED BY starts_pending WHERE run_id = ? "
                    "AND graph = ? AND open_state = ? AND state = 'pending' ORDER BY start_index",
                    (self.run.id, graph, state),
                )
            ]
            for i in range(0, len(starts), size or len(starts) or 1):
                if given == most:
                    return
                given += 1
                yield TopologyId(graph, state), starts[i : i + (size or len(starts))]

    def _room(self, sending: Sequence[Sequence[int]]) -> bool:
        """Whether the run's folders have room for the starts about to go out: 100 MB beside what
        they'll write, or twice that once the run is held for space (ADR-0014)."""
        conn = self.db.connection()
        (hold,) = conn.execute("SELECT hold FROM runs WHERE id = ?", (self.run.id,)).fetchone()
        releases = SPACE_RESERVE + self.run.start_bytes * sum(map(len, sending))
        need = releases * 2 if hold == "space" else releases
        free = [
            (f, folder)
            for folder in (str(self.run.output_folder), str(self.data_folder))
            if (f := self.free_space(folder)) is not None
        ]
        fullest = min(free, default=None)
        room = fullest is None or fullest[0] >= need
        if room != (hold != "space"):
            with self._write() as w:
                w.execute(
                    "UPDATE runs SET hold = ?, hold_reason = NULL, held_since = ?, "
                    "space_folder = ?, space_free = ?, space_carries_on = ? WHERE id = ?",
                    (None, None, None, None, None, self.run.id)
                    if room or fullest is None
                    else (
                        "space",
                        now(),
                        folders.from_home(fullest[1]),
                        fullest[0],
                        releases * 2,
                        self.run.id,
                    ),
                )
                append_change(w, TOPIC, str(self.run.id))
        return room

    def _send(
        self, topology: TopologyId, starts: Sequence[int], throttle: int, jobs: JobDefaults
    ) -> bool:
        """Records the array, writes its job file and sends it; whether the window goes on."""
        with self._write() as conn:
            (number,) = conn.execute(
                "SELECT COALESCE(MAX(number), 0) + 1 FROM arrays WHERE run_id = ?",
                (self.run.id,),
            ).fetchone()
            identity = files.identity(self.run.feed, self.run.id, "a", number)
            conn.execute(
                "INSERT INTO arrays (run_id, number, graph, open_state, identity, generation, "
                "tasks, throttle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    self.run.id,
                    number,
                    topology.graph,
                    topology.open_state,
                    identity,
                    self.generation,
                    len(starts),
                    throttle,
                ),
            )
            slurm = jobs if isinstance(jobs, SlurmJobDefaults) else None
            for task, start in enumerate(starts):
                where = (self.run.id, topology.graph, topology.open_state, start)
                conn.execute(
                    "UPDATE starts SET state = 'sent', try = try + 1 "
                    "WHERE run_id = ? AND graph = ? AND open_state = ? AND start_index = ?",
                    where,
                )
                conn.execute(
                    "INSERT INTO start_tries (run_id, graph, open_state, start_index, try, "
                    "engine, array, array_task, cpus, memory_mb, time_limit_min) "
                    "SELECT run_id, graph, open_state, start_index, try, ?, ?, ?, ?, ?, ? "
                    "FROM starts WHERE run_id = ? AND graph = ? AND open_state = ? "
                    "AND start_index = ?",
                    (
                        self.run.engine,
                        number,
                        task,
                        jobs.cpus_per_start,
                        slurm and slurm.memory_per_start_mb,
                        slurm and slurm.time_limit_per_start_min,
                        *where,
                    ),
                )
            conn.execute(
                "UPDATE topologies SET state = 'fitting' "
                "WHERE run_id = ? AND graph = ? AND open_state = ? AND state = 'next'",
                (self.run.id, topology.graph, topology.open_state),
            )
        array = _Array(number, topology, identity, len(starts), throttle, None)
        return self._launch(array, jobs)

    def _launch(self, array: _Array, jobs: JobDefaults) -> bool:
        """Writes the array's job file and sends it, recording the job id it gets; whether the
        window goes on. A refusal takes the array back and stops the run sending; a scheduler
        that doesn't answer leaves it to be found next sweep."""
        conn = self.db.connection()
        tries = conn.execute(
            "SELECT start_index, try FROM start_tries WHERE run_id = ? AND array = ? "
            "ORDER BY array_task",
            (self.run.id, array.number),
        ).fetchall()
        avoiding = tuple(
            node
            for (node,) in conn.execute(
                "SELECT DISTINCT p.node FROM start_tries t JOIN start_tries p "
                "ON p.run_id = t.run_id AND p.graph = t.graph AND p.open_state = t.open_state "
                "AND p.start_index = t.start_index AND p.try < t.try "
                "WHERE t.run_id = ? AND t.array = ? AND p.cause = 'lost' "
                "AND p.node IS NOT NULL ORDER BY p.node",
                (self.run.id, array.number),
            )
        )
        folder = files.topology_folder(self.run.folder, array.topology)
        folder.mkdir(parents=True, exist_ok=True)
        path = files.array_jobs(self.run.folder, array.number)
        files.write_jobs(path, self._array_job(array.topology, tries))
        try:
            job_id = self.scheduler.submit_array(
                ArrayLaunch(
                    identity=array.identity,
                    jobs=path,
                    tasks=array.tasks,
                    throttle=array.throttle,
                    folder=self.run.folder,
                    engine=self.run.engine,
                    job_defaults=jobs,
                    avoiding=avoiding,
                )
            )
        except RefusedError as e:
            self._take_back(array)
            self._stop(FailureCause.REFUSED, str(e) or None)
            return False
        except SchedulerUnavailableError:
            return False
        self._sent(array, job_id)
        return True

    def _array_job(self, topology: TopologyId, tries: Sequence[tuple[int, int]]) -> ArrayJob:
        search = self.run.settings.search
        return ArrayJob(
            dataset=self.run.revision,
            num_states=self.run.num_states,
            graph=topology.graph,
            open_state=topology.open_state,
            search_seed=self.run.search_seed,
            population=search.population,
            evaluation_budget=search.evaluation_budget,
            log_every_generations=search.log_every_generations,
            sobol_start_points=search.sobol_start_points,
            bounds=self.run.bounds,
            tasks=[
                files.start_task(self.run.folder, topology, start, attempt)
                for start, attempt in tries
            ],
        )

    def _sent(self, array: _Array, job_id: str) -> None:
        with self._write() as conn:
            at = iso(self.wall_clock())
            conn.execute(
                "UPDATE arrays SET job_id = ?, sent_at = ? WHERE run_id = ? AND number = ?",
                (job_id, at, self.run.id, array.number),
            )
            conn.execute(
                "UPDATE start_tries SET array_job_id = ?, job_id = ? || '_' || array_task, "
                "sent_at = ? WHERE run_id = ? AND array = ?",
                (job_id, job_id, at, self.run.id, array.number),
            )
            conn.execute(
                "UPDATE topologies SET first_sent_at = COALESCE(first_sent_at, ?) "
                "WHERE run_id = ? AND graph = ? AND open_state = ?",
                (at, self.run.id, array.topology.graph, array.topology.open_state),
            )
            conn.execute(
                "UPDATE runs SET first_array_at = COALESCE(first_array_at, ?) WHERE id = ?",
                (at, self.run.id),
            )
            self._progressed(conn)
            append_change(conn, TOPIC, str(self.run.id))

    def _take_back(self, array: _Array) -> None:
        """Undoes an array the scheduler refused: its starts wait unsent again."""
        with self._write() as conn:
            where = (self.run.id, array.number)
            conn.execute(
                "UPDATE starts SET state = 'pending', try = try - 1 WHERE (run_id, graph, "
                "open_state, start_index) IN (SELECT run_id, graph, open_state, start_index "
                "FROM start_tries WHERE run_id = ? AND array = ?)",
                where,
            )
            conn.execute("DELETE FROM start_tries WHERE run_id = ? AND array = ?", where)
            conn.execute("DELETE FROM arrays WHERE run_id = ? AND number = ?", where)
            conn.execute(
                "UPDATE topologies SET state = 'next' WHERE run_id = ? AND graph = ? "
                "AND open_state = ? AND NOT EXISTS (SELECT 1 FROM arrays a WHERE a.run_id = ? "
                "AND a.graph = ? AND a.open_state = ?)",
                (self.run.id, *_where(array.topology), self.run.id, *_where(array.topology)),
            )

    def _reconcile(self, array: _Array, *, resend: bool) -> None:
        """An array recorded but not known sent: adopted if the scheduler has it, and any copy
        beside it canceled; if it says it hasn't, sent again, or taken back once the run has
        stopped sending; left for the next sweep if it can't say (ADR-0009)."""
        try:
            found = self.scheduler.find(array.identity)
        except SchedulerUnavailableError:
            return
        if not found:
            if resend:
                self._launch(array, self._job_defaults(self.db.connection()))
            else:
                self._take_back(array)
            return
        self._sent(array, found[0])
        if len(found) > 1:
            try:
                self.scheduler.cancel(found[1:], waiting_only=False)
            except SchedulerUnavailableError:
                print(f"array {array.identity} has copies {found[1:]} still out", file=sys.stderr)

    # The successor.

    def _successor_job(self) -> str | None:
        """The job id of the generation queued behind this one, once it's known."""
        if self.scheduler.own_job() is None:
            return None
        row = (
            self.db.connection()
            .execute(
                "SELECT job_id FROM coordinators WHERE run_id = ? AND generation > ? "
                "ORDER BY generation DESC LIMIT 1",
                (self.run.id, self.generation),
            )
            .fetchone()
        )
        return None if row is None else row[0]

    def _queue_successor(self, state: TaskState | None) -> bool:
        """Queues the next generation behind this one's own job, once: whatever ends this one,
        the next takes over with no desktop connected (ADR-0019). Its launch is recorded with its
        identity first, so one whose reply was lost is found rather than sent twice; one the
        scheduler says has ended without taking over (canceled by hand) is queued anew, as the
        generation after it. Whether one waits, or none needs to: a scheduler that doesn't
        answer is asked again next sweep, and one that refuses stops the run."""
        after = self.scheduler.own_job()
        if after is None:
            return True
        if self._successor_refused:
            return False
        row = (
            self.db.connection()
            .execute(
                "SELECT generation, identity, job_id FROM coordinators WHERE run_id = ? "
                "AND generation > ? ORDER BY generation DESC LIMIT 1",
                (self.run.id, self.generation),
            )
            .fetchone()
        )
        identity: str | None = None
        if row is None:
            number = self.generation + 1
        elif row[2] is not None:
            if state is None or state.status != "ended":
                return True
            number = row[0] + 1
        else:
            number, identity = row[0], str(row[1])
            try:
                found = self.scheduler.find(identity)
            except SchedulerUnavailableError:
                return False
            if found:
                self._successor_launched(number, found[0])
                if len(found) > 1:
                    with contextlib.suppress(SchedulerUnavailableError):
                        self.scheduler.cancel(found[1:], waiting_only=False)
                return True
        if identity is None:
            identity = files.identity(self.run.feed, self.run.id, "c", number)
            with self._write() as conn:
                conn.execute(
                    "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
                    (self.run.id, number, identity),
                )
        try:
            job_id = self.scheduler.launch_coordinator(
                CoordinatorLaunch(
                    data_folder=self.data_folder,
                    run=self.run.id,
                    generation=number,
                    identity=identity,
                    log=files.coordinator_log(self.run.folder, number),
                    engine=self.run.engine,
                    job_defaults=self._job_defaults(self.db.connection()),
                    after=after,
                )
            )
        except RefusedError as e:
            self._successor_refused = True
            with self._write() as conn:
                conn.execute(
                    "DELETE FROM coordinators WHERE run_id = ? AND generation = ?",
                    (self.run.id, number),
                )
                self._stop_in(conn, FailureCause.REFUSED, str(e) or None)
            return False
        except SchedulerUnavailableError:
            return False
        self._successor_launched(number, job_id)
        return True

    def _successor_launched(self, number: int, job_id: str) -> None:
        with self._write() as conn:
            conn.execute(
                "UPDATE coordinators SET job_id = ?, launched_at = ? "
                "WHERE run_id = ? AND generation = ?",
                (job_id, now(), self.run.id, number),
            )

    def _cancel_successor(self) -> None:
        """The run has ended: the generation waiting behind this one goes. One that can't be
        canceled now finds the run ended when it starts, and exits."""
        successor = self._successor_job()
        if successor is not None:
            with contextlib.suppress(SchedulerUnavailableError):
                self.scheduler.cancel([successor], waiting_only=False)

    # Stopping and ending.

    def _stopping(self) -> RunFailure | None:
        (stopping,) = (
            self.db.connection()
            .execute("SELECT stopping FROM runs WHERE id = ?", (self.run.id,))
            .fetchone()
        )
        return None if stopping is None else RunFailure.model_validate_json(stopping)

    def _stop(self, cause: FailureCause, detail: str | None) -> None:
        with self._write() as conn:
            self._stop_in(conn, cause, detail)

    def _stop_in(self, conn: sqlite3.Connection, cause: FailureCause, detail: str | None) -> None:
        """The run sends nothing more, and fails once nothing it sent is left."""
        stopping = RunFailure(cause=cause, detail=detail, failed_starts=[])
        conn.execute(
            "UPDATE runs SET stopping = ? WHERE id = ? AND stopping IS NULL",
            (stopping.model_dump_json(), self.run.id),
        )

    def _refuse(self, states: dict[str, dict[int, TaskState]]) -> None:
        """A waiting task the scheduler won't run as asked stops the run as a refused launch
        does, in the scheduler's words with what to change (ADR-0019)."""
        refused = next(
            (
                t.refused
                for tasks in states.values()
                for t in tasks.values()
                if t.status == "waiting" and t.refused
            ),
            None,
        )
        if refused is not None:
            self._stop(FailureCause.REFUSED, refused)

    def _wind_down(
        self, live: Sequence[_Array], states: dict[str, dict[int, TaskState]] | None
    ) -> None:
        """A run that has stopped sending cancels its tasks still waiting, so none starts, and
        lets the running ones finish. Check every sweep: tasks missing from an earlier answer
        may become known later."""
        if states is None:
            return
        job_ids = [
            a.job_id
            for a in live
            if a.job_id and any(t.status == "waiting" for t in states.get(a.job_id, {}).values())
        ]
        if job_ids:
            try:
                self.scheduler.cancel(job_ids, waiting_only=True)
            except SchedulerUnavailableError:
                return

    def _cancel_tasks(self, live: Sequence[_Array]) -> None:
        """A run canceling: every task it has out is canceled, once by this generation, before
        its scheduler is asked about them, so none waiting starts. The running ones end their
        generation and write their best so far, which `_collect` keeps as canceled."""
        job_ids = [a.job_id for a in live if a.job_id and a.job_id not in self._canceled]
        if not job_ids:
            return
        try:
            self.scheduler.cancel(job_ids, waiting_only=False)
        except SchedulerUnavailableError:
            return  # asked again next sweep
        self._canceled.update(job_ids)

    def _give_up(self) -> Sweep:
        """A run whose coordinators kept failing: cancels every task it has out, takes back any
        array never known sent, and fails at once, its starts left unfinished for a Resume; then
        `sweep` cancels the generation waiting behind it. It reads no result and asks nothing
        more of the scheduler, since that may be what crashed the generations before it."""
        job_ids: list[str] = []
        for array in self._arrays():
            if array.job_id is not None:
                job_ids.append(array.job_id)
                continue
            try:
                found = self.scheduler.find(array.identity)
            except SchedulerUnavailableError:
                return "going"
            if found:
                job_ids += found
            else:
                self._take_back(array)
        if job_ids:
            try:
                self.scheduler.cancel(job_ids, waiting_only=False)
            except SchedulerUnavailableError:
                return "going"
        with self._write() as conn:
            fail_unfinished(conn, self.run.id, self._stopping())
        return "ended"

    def _settle(self, states: dict[str, dict[int, TaskState]] | None) -> Sweep:
        """The run's state, judged per task: running while one runs, else held while one waits on
        something other than resources or the run is held for space, else queued. It ends once
        nothing it sent is out and nothing is left to send, or it's stopping."""
        with self._write() as conn:
            (out,) = conn.execute(
                "SELECT COUNT(*) FROM start_tries INDEXED BY start_tries_out "
                "WHERE run_id = ? AND ended_at IS NULL",
                (self.run.id,),
            ).fetchone()
            pending = conn.execute(
                "SELECT 1 FROM starts INDEXED BY starts_pending "
                "WHERE run_id = ? AND state = 'pending' LIMIT 1",
                (self.run.id,),
            ).fetchone()
            stopping = self._stopping()
            conn.execute(
                "UPDATE arrays SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL AND "
                "job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM start_tries t WHERE "
                "t.run_id = arrays.run_id AND t.array = arrays.number AND t.ended_at IS NULL)",
                (now(), self.run.id),
            )
            if not out and (
                pending is None or stopping is not None or _canceling(conn, self.run.id)
            ):
                self._end(conn, stopping)
                return "ended"
            if states is not None:
                self._judge_state(conn, states)
        return "going"

    def _judge_state(
        self, conn: sqlite3.Connection, states: dict[str, dict[int, TaskState]]
    ) -> None:
        """The hold is kept while the run runs, so a run held for space resumes only at twice
        the room; it shows only while nothing runs. The waiting tasks are counted queued or held
        beside the running ones, whatever the run's state."""
        tasks = [t for tasks in states.values() for t in tasks.values()]
        state, hold, reason, since, queued_reason, *counted = conn.execute(
            "SELECT state, hold, hold_reason, held_since, queued_reason, starts_queued, "
            "starts_held FROM runs WHERE id = ?",
            (self.run.id,),
        ).fetchone()
        waiting = [t for t in tasks if t.status == "waiting"]
        counts = [sum(1 for t in waiting if not t.held), sum(1 for t in waiting if t.held)]
        held = next((t.held for t in tasks if t.status == "waiting" and t.held), None)
        judged_queued = next((t.queued for t in waiting if t.queued), None)
        if hold == "space":
            judged_hold, judged_reason = "space", None
        elif held is not None:
            judged_hold, judged_reason = "scheduler", held
        else:
            judged_hold, judged_reason = None, None
        if any(t.status == "running" for t in tasks):
            judged = "running"
        else:
            judged = "queued" if judged_hold is None else "held"
        if judged != "queued":
            judged_queued = None
        shown = (judged, judged_hold, judged_reason, judged_queued, *counts)
        if shown != (state, hold, reason, queued_reason, *counted):
            if judged_hold != hold:
                since = None if judged_hold is None else now()
            conn.execute(
                "UPDATE runs SET state = ?, hold = ?, hold_reason = ?, held_since = ?, "
                "queued_reason = ?, starts_queued = ?, starts_held = ?, "
                "state_since = CASE WHEN state = ? THEN state_since ELSE ? END WHERE id = ?",
                (
                    judged,
                    judged_hold,
                    judged_reason,
                    since,
                    judged_queued,
                    *counts,
                    judged,
                    now(),
                    self.run.id,
                ),
            )
            append_change(conn, TOPIC, str(self.run.id))

    def _end(self, conn: sqlite3.Connection, stopping: RunFailure | None) -> None:
        end_run(conn, self.run.id, stopping)

    # The database.

    @contextmanager
    def _write(self) -> Generator[sqlite3.Connection]:
        """A write transaction, once the run is still this generation's."""
        with self.db.write() as conn:
            (generation,) = conn.execute(
                "SELECT generation FROM runs WHERE id = ?", (self.run.id,)
            ).fetchone()
            if generation != self.generation:
                raise SupersededError
            yield conn

    def _progressed(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE coordinators SET progressed = 1 WHERE run_id = ? AND generation = ?",
            (self.run.id, self.generation),
        )

    def _job_defaults(self, conn: sqlite3.Connection) -> JobDefaults:
        from icmm import platform_settings

        saved = platform_settings.read(conn)
        if saved is None:
            raise RuntimeError("the platform has no Job defaults")
        return saved.settings.job_defaults


def coordinate(
    data_folder: Path,
    run: int,
    generation: int,
    *,
    scheduler: Scheduler,
    lists: Lists | None = None,
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Sweep | None:
    """One generation: claims the run, then sweeps until the run ends, a later generation has it,
    or `clock` reaches `deadline`, where it hands on. `None` if it couldn't claim the run."""
    c = Coordinator.claim(
        data_folder, run, generation, scheduler=scheduler, lists=lists, clock=clock
    )
    if c is None:
        return None
    exit_code = 1  # as Python exits on an error
    try:
        while (swept := c.sweep()) == "going":
            if deadline is not None and clock() >= deadline and c.hand_on():
                break
            sleep(c.interval_s)
        exit_code = 0
        return swept
    except (NewerSchemaError, HandOverPendingError):
        exit_code = 0  # `main` stops on the floor, as `hand_over.stop` exits
        raise
    finally:
        c.ended(exit_code)
        c.close()


def hand_on_after_s(time_limit_min: int) -> float:
    """How long a coordinating job with this time limit sweeps before it hands on:
    `HAND_ON_MARGIN_S` short of its limit, or half of it where that's shorter."""
    limit_s = time_limit_min * 60
    return max(limit_s / 2, limit_s - HAND_ON_MARGIN_S)


def main(data_folder: str, run: int, generation: int, time_limit_min: int | None = None) -> int:
    """`icmm coordinate`: generation `generation` of the run's coordinator, as its scheduler
    launches it. A duplicate, one superseded, or one below the floor exits without acting. In a
    job with a time limit, it hands on to its successor before that."""
    from icmm import scheduler as schedulers

    started = time.monotonic()
    folder = Path(data_folder).expanduser()
    scheduler = schedulers.for_host(folder)
    if scheduler is None:
        print("This engine can't drive this platform's scheduler.", file=sys.stderr)
        return 2
    deadline = None if time_limit_min is None else started + hand_on_after_s(time_limit_min)
    try:
        coordinate(folder, run, generation, scheduler=scheduler, deadline=deadline)
    except (NewerSchemaError, HandOverPendingError) as e:
        return hand_over.stop(e)
    return 0


def end_run(conn: sqlite3.Connection, run: int, stopping: RunFailure | None) -> None:
    """Ends the run in the caller's write transaction: canceled once a cancel was accepted,
    whatever stopped it; else completed once every start has finished; otherwise failed, with
    its failed starts counted by cause."""
    if _canceling(conn, run):
        run_store.end(conn, run, "canceled")
        return
    finished, starts = conn.execute(
        "SELECT starts_finished, starts FROM runs WHERE id = ?", (run,)
    ).fetchone()
    failure = None
    if finished < starts:
        counted = conn.execute(
            "SELECT t.cause, COUNT(*) FROM starts s JOIN start_tries t "
            "ON t.run_id = s.run_id AND t.graph = s.graph AND t.open_state = s.open_state "
            "AND t.start_index = s.start_index AND t.try = s.try "
            "WHERE s.run_id = ? AND s.state = 'failed' GROUP BY t.cause "
            "ORDER BY COUNT(*) DESC, t.cause",
            (run,),
        ).fetchall()
        failure = RunFailure(
            cause=stopping.cause if stopping else FailureCause.STARTS_FAILED,
            detail=stopping.detail if stopping else None,
            failed_starts=[FailedStarts(cause=StartCause(cause), starts=n) for cause, n in counted],
        )
    run_store.end(conn, run, "completed" if failure is None else "failed", failure)


def fail_unfinished(conn: sqlite3.Connection, run: int, stopping: RunFailure | None) -> None:
    """Fails the run with its starts unfinished, in the caller's write transaction, once its tasks
    are canceled: one whose coordinators kept failing, or whose next coordinator This computer
    refused (`icmm.coordinator.recover`). What was out is ended, and its starts wait for a
    Resume."""
    at = now()
    conn.execute(
        "UPDATE starts SET state = 'pending' WHERE run_id = ? AND state IN ('sent', 'running')",
        (run,),
    )
    conn.execute(
        "UPDATE start_tries SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", (at, run)
    )
    conn.execute("UPDATE arrays SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", (at, run))
    conn.execute("UPDATE topologies SET starts_running = 0 WHERE run_id = ?", (run,))
    end_run(conn, run, stopping)


def _canceling(conn: sqlite3.Connection, run: int) -> bool:
    """Whether a cancel of the run was accepted."""
    (canceling,) = conn.execute(
        "SELECT canceling_since IS NOT NULL FROM runs WHERE id = ?", (run,)
    ).fetchone()
    return bool(canceling)


def _where(topology: TopologyId) -> tuple[int, int]:
    return topology.graph, topology.open_state


def _throttle(live: Sequence[_Array], job_id: str) -> int:
    return next(a.throttle for a in live if a.job_id == job_id)


def _claim(
    db: RunsDb, data_folder: Path, run: int, generation: int, by: str
) -> tuple[_Run, int, int] | None:
    """Claims the run for `generation`, in one transaction: what it fits, the generation it held
    before, and how many generations in a row have made no progress, counted from the generation
    its latest Resume launched; `None` if it can't, or a newer engine is taking the runs over. A
    Resume being taken up shows no longer."""
    with db.write() as conn:
        if hand_over.requested(conn, db.known):
            return None
        row = conn.execute(
            "SELECT generation, stalled_generations, "
            "end_seq IS NOT NULL OR deleted_at IS NOT NULL, COALESCE(resumed_generation, 0) "
            "FROM runs WHERE id = ?",
            (run,),
        ).fetchone()
        if row is None or row[2] or row[0] >= generation:
            return None
        held, stalled, resumed = row[0], row[1], row[3]
        if held:
            # It ran before this one, which its scheduler starts once it has ended.
            run_store.coordinator_ended(conn, run, held, None, own=False)
        if held and held >= resumed:
            progressed = conn.execute(
                "SELECT progressed FROM coordinators WHERE run_id = ? AND generation = ?",
                (run, held),
            ).fetchone()
            stalled = 0 if progressed and progressed[0] else stalled + 1
        elif held:
            stalled = 0  # its generations before the Resume don't count
        conn.execute(
            "UPDATE runs SET generation = ?, stalled_generations = ?, "
            "claimed_at = COALESCE(claimed_at, ?), resuming = NULL WHERE id = ?",
            (generation, stalled, now(), run),
        )
        feed = feed_id(conn)
        conn.execute(
            "INSERT INTO coordinators (run_id, generation, identity, claimed_by, claimed_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, generation) DO UPDATE SET "
            "claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at",
            (run, generation, files.identity(feed, run, "c", generation), by, now()),
        )
        append_change(conn, TOPIC, str(run))
        return _pinned(conn, data_folder, run, feed), held, stalled


def _pinned(conn: sqlite3.Connection, data_folder: Path, run: int, feed: str) -> _Run:
    """What the run fits, as Submit recorded it: never the config or the dataset as they are
    now."""
    (
        settings,
        seed,
        num_states,
        topologies,
        starts,
        has_validation,
        engine,
        output_folder,
        dataset,
        revision,
    ) = conn.execute(
        "SELECT settings, search_seed, num_states, topologies, starts, has_validation, engine, "
        "output_folder, dataset_id, dataset_revision FROM runs WHERE id = ?",
        (run,),
    ).fetchone()
    config = configs.read_config(json.loads(settings))
    folder = revision_folder(data_folder, dataset, revision)
    protocols = read_revision(folder).protocols
    return _Run(
        id=run,
        settings=config,
        search_seed=seed,
        num_states=num_states,
        topologies=topologies,
        starts=starts,
        has_validation=bool(has_validation),
        engine=engine,
        output_folder=Path(output_folder),
        folder=files.run_folder(output_folder, run, feed),
        feed=feed,
        revision=folder,
        weights=[p.weight for p in protocols],
        start_bytes=files.start_bytes(
            num_states=num_states,
            protocols=len(protocols),
            evaluation_budget=config.search.evaluation_budget,
            population=config.search.population,
            log_every_generations=config.search.log_every_generations,
        ),
    )
