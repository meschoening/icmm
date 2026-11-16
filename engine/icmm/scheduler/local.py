"""This computer's scheduler (ADR-0019): a run's starts run as worker processes of its
**Coordinator**, under one **Running-starts cap** for every run here.

No daemon runs its jobs, so the runs database holds its queue (`local_jobs`, `local_tasks`), and
the coordinator that asks for its tasks' states does the scheduler's work: it ends the tasks whose
workers have exited, settles those whose coordinator is gone, then gives free slots to waiting
tasks, earlier run first, and starts its own. A task whose worker was lost with its coordinator,
as in a restart, waits again and is fit again from its seed, even one whose worker wrote its best
so far as the restart stopped it. Workers run from the coordinator's own interpreter: the run's
engine.

A coordinator asks every sweep, so its scheduler sees whether its run waits healthily: from its
generation's second tick, a worker of its own still running, its run's waiting tasks finding
every slot held by running starts or live earlier runs, or its run held for space is the
generation's progress (ADR-0019). Restarts then never fail a healthy run, and a coordinator that
crashes in its first sweep still makes none.

Each process is named by its id and start time (`icmm.processes`), so a coordinator or worker
that has ended is never mistaken for one that runs.
"""

from __future__ import annotations

import errno
import signal
import sqlite3
import subprocess
import sys
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import ValidationError

from icmm import platform_settings
from icmm import processes as host
from icmm.coordinator import files
from icmm.db import RunsDb, now
from icmm.jobs import ArrayJob, StartTask
from icmm.scheduler import (
    ArrayLaunch,
    CoordinatorLaunch,
    RefusedError,
    SchedulerUnavailableError,
    TaskState,
)
from icmm.wire.run import StartCause


class Child(Protocol):
    """A worker this process started."""

    identity: str

    def poll(self) -> int | None: ...

    def terminate(self) -> None: ...


class Processes(Protocol):
    """This computer's processes, as the scheduler names, starts and stops them."""

    def me(self) -> str: ...

    def alive(self, identity: str) -> bool: ...

    def launch(self, argv: list[str], *, log: Path, cwd: Path) -> str:
        """Launches `argv` detached; answers its identity."""
        ...

    def spawn(self, argv: list[str], *, out: Path, cwd: Path) -> Child: ...

    def terminate(self, identity: str) -> None: ...


@dataclass(frozen=True)
class _Taken:
    """A slot this process took for one of its run's tasks, its worker still to start."""

    job: int
    task: int
    jobs: str
    folder: str
    threads: int


class LocalScheduler:
    """This computer's scheduler, for one Data folder. A coordinator's own connection to the runs
    database is never this one's, so each call takes its own transactions."""

    max_array_size: int | None = None
    result_grace_s = 0.0

    def __init__(
        self,
        data_folder: Path,
        *,
        processes: Processes | None = None,
        python: str = sys.executable,
    ) -> None:
        """`python` runs the workers, and any coordinator whose run has no engine of its own."""
        self.data_folder = data_folder
        self.db = RunsDb(data_folder)
        self.processes: Processes = processes if processes is not None else _Os()
        self.python = python
        self._me: str | None = None
        self._children: dict[tuple[int, int], Child] = {}
        self._arrays: dict[int, ArrayJob] = {}
        self._first_tick_asked = False  # whether its generation's first tick was asked for
        self._progressed = False  # whether the generation it claimed has recorded its progress

    def me(self) -> str:
        if self._me is None:
            self._me = self.processes.me()
        return self._me

    def own_job(self) -> str | None:
        """None: nothing waits behind a generation here, since `icmm recover` and the agent
        relaunch a run whose coordinator is gone (ADR-0019)."""
        return None

    def alive(self, claimer: str) -> bool:
        """Whether the process `claimer`, a coordinator here, still runs."""
        return self.processes.alive(claimer)

    def alive_many(self, claimers: Sequence[str], *, budget_s: float) -> dict[str, bool | None]:
        """Checks process identities directly, without ticking the local job queue."""
        return {claimer: self.alive(claimer) for claimer in claimers}

    def close(self) -> None:
        """Closes this thread's connection to the runs database."""
        self.db.close()

    def launch_coordinator(self, launch: CoordinatorLaunch) -> str:
        """Launches the generation detached, from the run's engine (ADR-0020); touches no
        database, so a caller may hold a write transaction. A launch that can never work (no
        such program, no permission, the run's engine gone) is refused; one that may next time,
        or whose log's folder can't be made yet (its storage may be away), is unanswered."""
        argv = [
            self._engine(launch),
            "-I",
            "-m",
            "icmm",
            "coordinate",
            "--data-folder",
            str(launch.data_folder),
            "--run",
            str(launch.run),
            "--generation",
            str(launch.generation),
        ]
        try:
            launch.log.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise SchedulerUnavailableError(f"the coordinator's log can't be made yet: {e}") from e
        try:
            return self.processes.launch(argv, log=launch.log, cwd=launch.data_folder)
        except OSError as e:
            if e.errno in _NEVER:
                raise RefusedError(f"ICMM couldn't start its coordinator: {e}") from e
            raise SchedulerUnavailableError(f"ICMM couldn't start its coordinator yet: {e}") from e

    def submit_array(self, launch: ArrayLaunch) -> str:
        """Queues the array's tasks, waiting, for this process's run; one already queued under
        the launch's identity is answered, never taken twice."""
        with self._write() as conn:
            row = conn.execute(
                "SELECT id FROM local_jobs WHERE identity = ?", (launch.identity,)
            ).fetchone()
            if row is not None:
                return str(row[0])
            run = self._run_of_me(conn)
            if run is None:
                raise SchedulerUnavailableError("this process coordinates no run")
            cursor = conn.execute(
                "INSERT INTO local_jobs (identity, run_id, jobs, folder, tasks, throttle, "
                "threads, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    launch.identity,
                    run,
                    str(launch.jobs),
                    str(launch.folder),
                    launch.tasks,
                    launch.throttle,
                    launch.job_defaults.cpus_per_start,
                    now(),
                ),
            )
            job = cursor.lastrowid
            conn.executemany(
                "INSERT INTO local_tasks (job_id, task, state) VALUES (?, ?, 'waiting')",
                ((job, task) for task in range(launch.tasks)),
            )
        return str(job)

    def set_throttle(self, job_id: str, throttle: int) -> None:
        ids = _numbers([job_id])
        if not ids:
            return
        with self._write() as conn:
            conn.execute("UPDATE local_jobs SET throttle = ? WHERE id = ?", (throttle, *ids))

    def cancel(self, job_ids: Sequence[str], *, waiting_only: bool) -> None:
        """Ends the jobs' waiting tasks, never run; and unless `waiting_only`, stops their running
        ones, each ending when its worker exits, without an error. A worker is asked to stop
        through its stop file, which it reads after each generation on every OS, then writes its
        best so far; only one whose stop file can't be written is ended at once (#327)."""
        ids = list(_numbers(job_ids))
        if not ids:
            return
        among = f"job_id IN ({', '.join('?' * len(ids))})"
        stopping: list[tuple[int, int, str, str | None]] = []
        with self._write() as conn:
            at = now()
            # `state != 'ended'` is `local_tasks_open`'s own condition: SQLite uses a partial
            # index only for a query whose WHERE says it.
            conn.execute(
                "UPDATE local_tasks INDEXED BY local_tasks_open SET state = 'ended', "
                "canceled = 1, ended_at = ? "
                f"WHERE state != 'ended' AND state = 'waiting' AND {among}",
                (at, *ids),
            )
            if not waiting_only:
                self._record(conn)
                stopping = conn.execute(
                    "SELECT t.job_id, t.task, j.folder, t.process "
                    "FROM local_tasks t INDEXED BY local_tasks_open "
                    "JOIN local_jobs j ON j.id = t.job_id "
                    f"WHERE t.state != 'ended' AND t.state = 'running' AND t.{among}",
                    ids,
                ).fetchall()
                conn.execute(
                    "UPDATE local_tasks INDEXED BY local_tasks_open SET canceled = 1 "
                    f"WHERE state != 'ended' AND state = 'running' AND {among}",
                    ids,
                )
                # A slot whose worker never started has nothing to wait for, and never ran.
                conn.execute(
                    "UPDATE local_tasks INDEXED BY local_tasks_open SET state = 'ended', "
                    "ended_at = ? WHERE state != 'ended' AND state = 'running' "
                    f"AND process IS NULL AND {among}",
                    (at, *ids),
                )
        for job, task, folder, process in stopping:
            if process is None:
                continue  # never started: its task has ended
            try:
                _stop_file(Path(folder), job, task).touch()
            except OSError:
                child = self._children.get((job, task))
                if child is not None:
                    child.terminate()
                else:
                    self.processes.terminate(process)

    def tasks(self, job_ids: Sequence[str]) -> dict[str, dict[int, TaskState]]:
        """Does the scheduler's work for this process (`_tick`), then answers each known job's
        tasks."""
        ids = _numbers(job_ids)
        with _answering():
            self._tick()
            if not ids:
                return {}
            rows = (
                self.db.connection()
                .execute(
                    "SELECT job_id, task, state, ran, cause, exit_code FROM local_tasks "
                    f"WHERE job_id IN ({', '.join('?' * len(ids))}) ORDER BY job_id, task",
                    list(ids),
                )
                .fetchall()
            )
        answer: dict[str, dict[int, TaskState]] = {}
        for job, task, state, ran, cause, exit_code in rows:
            answer.setdefault(ids[job], {})[task] = (
                TaskState(
                    "ended",
                    ran=bool(ran),
                    cause=StartCause(cause) if cause else None,
                    exit_code=exit_code,
                )
                if state == "ended"
                else TaskState(state)
            )
        return answer

    def find(self, identity: str) -> list[str]:
        """The coordinator launched with `identity`, once its launch is recorded, or the array
        queued with it."""
        with _answering():
            conn = self.db.connection()
            launched = conn.execute(
                "SELECT job_id FROM coordinators WHERE identity = ? AND job_id IS NOT NULL",
                (identity,),
            ).fetchall()
            queued = conn.execute(
                "SELECT id FROM local_jobs WHERE identity = ?", (identity,)
            ).fetchall()
        return [job for (job,) in launched] + [str(job) for (job,) in queued]

    # The scheduler's work.

    def _tick(self) -> None:
        """Ends the tasks whose workers exited, settles those whose coordinator is gone, takes
        this run's share of the free slots in one write transaction, then starts their workers.

        From its second tick, the run's generation has made progress (ADR-0019), recorded once,
        when it waits healthily: a worker this process started or adopted at an earlier tick
        still runs, and so has had its start sent; the run's waiting tasks get no slot, since
        running starts or live earlier runs' waiting tasks hold every one (`_take`); or the run
        is held for space. Its first tick counts none, so a coordinator that crashes in its first
        sweep, as in a crash loop, never makes progress, and nor does a tick the runs database
        doesn't answer. Starting a worker isn't enough: on Windows a coordinator's workers end
        with it, so one that crashes right after starting them would refit the same lost starts
        every generation."""
        me = self.me()
        past_first_tick, self._first_tick_asked = self._first_tick_asked, True
        polled = {key: child.poll() for key, child in self._children.items()}
        exited = {key: code for key, code in polled.items() if code is not None}
        ran_on = len(exited) < len(polled)  # each started at an earlier tick
        with self._write() as conn:
            self._record(conn)
            at = now()
            for (job, task), code in exited.items():
                conn.execute(
                    "UPDATE local_tasks SET state = 'ended', exit_code = ?, ended_at = ?, "
                    "cause = CASE WHEN canceled = 0 THEN ? END "
                    "WHERE job_id = ? AND task = ? AND state = 'running' AND owner = ?",
                    (code, at, _cause(code), job, task, me),
                )
            mine = self._run_of_me(conn)
            ran_on = self._settle(conn, me, mine) or ran_on
            taken, waits_for_slots = ([], False) if mine is None else self._take(conn, me, mine)
            progressed = (
                mine is not None
                and past_first_tick
                and not self._progressed
                and (ran_on or waits_for_slots or _held_for_space(conn, mine))
            )
            if progressed:
                conn.execute(
                    "UPDATE coordinators SET progressed = 1 WHERE run_id = ? AND generation = "
                    "(SELECT generation FROM runs WHERE id = ?) AND claimed_by = ?",
                    (mine, mine, me),
                )
        self._progressed = self._progressed or progressed
        for key in exited:
            del self._children[key]
        self._start(taken)

    def _record(self, conn: sqlite3.Connection) -> None:
        """Names each of this process's workers on its task, if a failed transaction left it
        unnamed: its worker started, so it ran."""
        for (job, task), child in self._children.items():
            conn.execute(
                "UPDATE local_tasks SET process = ?, ran = 1 WHERE job_id = ? AND task = ? "
                "AND state = 'running' AND owner = ? AND process IS NULL",
                (child.identity, job, task, self.me()),
            )

    def _settle(self, conn: sqlite3.Connection, me: str, run: int | None) -> bool:
        """Every running task on This computer that isn't this process's own child and that no
        other live coordinator owns: those whose coordinator is gone, and the workers this
        process adopted. A worker still alive runs on, adopted by its run's coordinator if this
        is it; one gone (or never started) ends once its result is written or it was canceled,
        else waits again to be fit from its seed. So does one a restart stopped mid-search, though
        it wrote its best so far. One whose array's job file can't be read yet is left as it is.

        Answers whether a worker this process adopted at an earlier tick still runs."""
        rows = conn.execute(
            "SELECT t.job_id, t.task, t.owner, t.process, t.canceled, j.run_id, j.jobs "
            "FROM local_tasks t INDEXED BY local_tasks_open JOIN local_jobs j ON j.id = t.job_id "
            "WHERE t.state != 'ended' AND t.state = 'running'"
        ).fetchall()
        at = now()
        adopted = False
        for job, task, owner, process, canceled, its_run, jobs in rows:
            if (job, task) in self._children:
                continue
            if owner is not None and owner != me and self.processes.alive(owner):
                continue  # its coordinator settles it
            where = (job, task)
            if process is not None and self.processes.alive(process):
                if its_run == run and owner == me:
                    adopted = True
                elif its_run == run:
                    conn.execute(
                        "UPDATE local_tasks SET owner = ? WHERE job_id = ? AND task = ?",
                        (me, *where),
                    )
                continue
            found = self._start_task(job, jobs, task)
            if found is None and not canceled:
                # Whether it wrote a result can't be told while its storage is away: fit again
                # now, it might refit a start that finished, or a try its coordinator has ended.
                continue
            result = None if found is None else files.read_result(found)
            if (
                found is not None
                and result is not None
                and result.end_reason == "canceled"
                and not canceled
                and owner != me
                and self._try_out(conn, job, task)
            ):
                # A signal its scheduler never sent stopped it, with its coordinator gone, as a
                # restart, a shutdown or a logout stops every process: its start was lost with
                # them. Its result is deleted, so no coordinator collects it, and it's fit again.
                # One its coordinator saw end, its own child or adopted, failed as lost; one whose
                # try or run has ended was collected, and is left as it is.
                try:
                    found.result.unlink(missing_ok=True)
                except OSError:
                    # Left running: a later tick tries again, unless the run's own coordinator,
                    # sweeping now, first collects it as a lost start.
                    continue
                result = None
            written = result is not None
            if canceled or written:
                conn.execute(
                    "UPDATE local_tasks SET state = 'ended', ran = MAX(ran, ?), ended_at = ? "
                    "WHERE job_id = ? AND task = ?",
                    (int(written), at, *where),
                )
            else:
                conn.execute(
                    "UPDATE local_tasks SET state = 'waiting', owner = NULL, process = NULL, "
                    "ran = 0, started_at = NULL WHERE job_id = ? AND task = ?",
                    where,
                )
        return adopted

    def _take(self, conn: sqlite3.Connection, me: str, mine: int) -> tuple[list[_Taken], bool]:
        """The free slots under the cap, given to waiting tasks earlier run first, each array
        within its throttle; this run's take theirs now. Another run's task holds its slot only
        while that run has a coordinator to take it at its next tick (`_claims`). Answers the
        slots this run took, and whether one of its tasks is left waiting for want of a slot:
        running starts fill the cap, or live earlier runs' waiting tasks take what's free. A task
        held back by its array's throttle while a slot is free waits for no slot."""
        saved = platform_settings.read(conn)
        cap = saved.settings.job_defaults.max_running_starts if saved is not None else 0
        running: dict[int, int] = dict(
            conn.execute(
                "SELECT job_id, COUNT(*) FROM local_tasks INDEXED BY local_tasks_open "
                "WHERE state != 'ended' AND state = 'running' GROUP BY job_id"
            ).fetchall()
        )
        free = cap - sum(running.values())
        waiting = conn.execute(
            "SELECT j.id, j.run_id, j.jobs, j.folder, j.threads, j.throttle, t.task "
            "FROM local_tasks t INDEXED BY local_tasks_open JOIN local_jobs j ON j.id = t.job_id "
            "WHERE t.state != 'ended' AND t.state = 'waiting' ORDER BY j.run_id, j.id, t.task"
        ).fetchall()
        mine_waits = any(run == mine for _, run, *_ in waiting)
        claims: dict[int, bool] = {mine: True}
        taken: list[_Taken] = []
        waits_for_slots = False
        for job, run, jobs, folder, threads, throttle, task in waiting:
            if free <= 0:
                # No slot is left for this task or any after it, so this run's waiting tasks
                # wait for one, unless all of them came before it (held back by their throttle).
                waits_for_slots = mine_waits and run <= mine
                break
            if running.get(job, 0) >= throttle:
                continue
            if run not in claims:
                claims[run] = self._claims(conn, run)
            if not claims[run]:
                continue
            running[job] = running.get(job, 0) + 1
            free -= 1
            if run == mine:
                taken.append(_Taken(job, task, jobs, folder, threads))
        at = now()
        # It hasn't run until its worker starts (`_start`).
        conn.executemany(
            "UPDATE local_tasks SET state = 'running', owner = ?, process = NULL, "
            "started_at = ? WHERE job_id = ? AND task = ?",
            ((me, at, t.job, t.task) for t in taken),
        )
        return taken, waits_for_slots

    def _claims(self, conn: sqlite3.Connection, run: int) -> bool:
        """Whether the run, in flight, has a coordinator that runs: its latest generation's, the
        process that claimed it, else the one launched as it and still starting. So a run
        relaunched after a restart keeps its turn while its coordinator starts."""
        row = conn.execute(
            "SELECT COALESCE(c.claimed_by, c.job_id) FROM runs r JOIN coordinators c "
            "ON c.run_id = r.id AND c.generation = "
            "(SELECT MAX(generation) FROM coordinators WHERE run_id = r.id) "
            "WHERE r.id = ? AND r.end_seq IS NULL",
            (run,),
        ).fetchone()
        return row is not None and row[0] is not None and self.processes.alive(row[0])

    def _start(self, taken: Sequence[_Taken]) -> None:
        """Starts a worker in each slot taken, then records each by its process; a worker that
        won't start ends its task with an error."""
        if not taken:
            return
        started: list[tuple[_Taken, Child]] = []
        failed: list[_Taken] = []
        for slot in taken:
            folder = Path(slot.folder)
            argv = [
                self.python,
                "-I",
                "-m",
                "icmm",
                "run-start",
                "--array",
                slot.jobs,
                "--task",
                str(slot.task),
                "--threads",
                str(slot.threads),
                "--stop-file",
                str(_stop_file(folder, slot.job, slot.task)),
            ]
            try:
                child = self.processes.spawn(
                    argv, out=folder / f"local-{slot.job}_{slot.task}.out", cwd=folder
                )
            except OSError as e:
                print(f"task {slot.job}_{slot.task} couldn't start: {e}", file=sys.stderr)
                failed.append(slot)
                continue
            self._children[(slot.job, slot.task)] = child
            started.append((slot, child))
        me = self.me()
        stopped: list[Child] = []
        with self._write() as conn:
            for slot, child in started:
                cursor = conn.execute(
                    "UPDATE local_tasks SET process = ?, ran = 1 WHERE job_id = ? AND task = ? "
                    "AND state = 'running' AND owner = ?",
                    (child.identity, slot.job, slot.task, me),
                )
                if cursor.rowcount == 0:
                    stopped.append(child)  # canceled while it started
            at = now()
            # Its start was tried: it fails with an error rather than going out again.
            conn.executemany(
                "UPDATE local_tasks SET state = 'ended', ran = 1, cause = 'error', ended_at = ? "
                "WHERE job_id = ? AND task = ? AND state = 'running' AND owner = ?",
                ((at, slot.job, slot.task, me) for slot in failed),
            )
        for child in stopped:
            child.terminate()

    def _try_out(self, conn: sqlite3.Connection, job: int, task: int) -> bool:
        """Whether the task's try is still out: neither its coordinator, once it collects a
        result, nor its run has ended it. Its array names it: the job's identity is the array's,
        and the task its place in it."""
        return (
            conn.execute(
                "SELECT 1 FROM local_jobs j JOIN arrays a ON a.identity = j.identity "
                "JOIN runs r ON r.id = a.run_id JOIN start_tries t ON t.run_id = a.run_id "
                "AND t.array = a.number AND t.array_task = ? "
                "WHERE j.id = ? AND r.end_seq IS NULL AND t.ended_at IS NULL",
                (task, job),
            ).fetchone()
            is not None
        )

    def _start_task(self, job: int, jobs: str, task: int) -> StartTask | None:
        """Where the task's worker writes, read through the array's job file; `None` while that
        can't be read."""
        array = self._arrays.get(job)
        if array is None:
            try:
                array = ArrayJob.model_validate_json(Path(jobs).read_bytes())
            except (OSError, ValidationError):
                return None  # unreadable for now: asked again next tick
            self._arrays[job] = array
        if not 0 <= task < len(array.tasks):
            return None
        return array.tasks[task]

    def _run_of_me(self, conn: sqlite3.Connection) -> int | None:
        """The run in flight whose current generation this process claimed, if any."""
        row = conn.execute(
            "SELECT c.run_id FROM coordinators c JOIN runs r ON r.id = c.run_id "
            "AND r.generation = c.generation WHERE c.claimed_by = ? AND r.end_seq IS NULL "
            "ORDER BY c.run_id",
            (self.me(),),
        ).fetchone()
        return None if row is None else row[0]

    def _engine(self, launch: CoordinatorLaunch) -> str:
        """The interpreter of the run's engine (ADR-0020), installed in the Data folder; this
        one's if the run has none. A run whose engine is no longer installed is refused: only
        Resume runs it on another engine, and says so."""
        from icmm import bundle

        if launch.engine is None or launch.engine == bundle.own_bundle_key():
            return self.python
        python = bundle.interpreter(launch.data_folder / "engine" / launch.engine)
        if python is None:
            raise RefusedError(f"the run's engine {launch.engine} isn't installed on This computer")
        return str(python)

    @contextmanager
    def _write(self) -> Generator[sqlite3.Connection]:
        with _answering(), self.db.write() as conn:
            yield conn


def _held_for_space(conn: sqlite3.Connection, run: int) -> bool:
    """Whether the run's coordinator found its folders short of room, and sends nothing."""
    (hold,) = conn.execute("SELECT hold FROM runs WHERE id = ?", (run,)).fetchone()
    return hold == "space"


@contextmanager
def _answering() -> Generator[None]:
    """A runs database another process holds too long is a scheduler that didn't answer."""
    try:
        yield
    except sqlite3.OperationalError as e:
        if "locked" in str(e) or "busy" in str(e):
            raise SchedulerUnavailableError(str(e)) from e
        raise


_NEVER = frozenset({errno.ENOENT, errno.ENOTDIR, errno.EACCES, errno.EPERM, errno.ENOEXEC})
"""A launch that fails with one of these will fail again: no such program, or no permission."""


def _cause(code: int) -> str | None:
    """Why a worker its run didn't cancel ended with exit code `code`: none at 0; out of memory
    when SIGKILL ended it, as Linux's OOM killer and macOS under memory pressure do; else an
    error, its own or a crash's signal."""
    if code == 0:
        return None
    if sys.platform != "win32" and code == -signal.SIGKILL:
        return StartCause.OUT_OF_MEMORY.value
    return StartCause.ERROR.value


def _stop_file(folder: Path, job: int, task: int) -> Path:
    """The file whose appearance asks the task's worker to stop, beside its output."""
    return folder / f"local-{job}_{task}.stop"


def _numbers(job_ids: Sequence[str]) -> dict[int, str]:
    """The job ids that can be this scheduler's, by number; any other is none of its jobs."""
    return {int(j): j for j in job_ids if j.isascii() and j.isdigit() and len(j) <= 18}


class _OsChild:
    """A worker, as `subprocess` started it."""

    def __init__(self, identity: str, popen: subprocess.Popen[bytes]) -> None:
        self.identity = identity
        self._popen = popen

    def poll(self) -> int | None:
        return self._popen.poll()

    def terminate(self) -> None:
        self._popen.terminate()


class _Os:
    """This computer's own processes (`icmm.processes`)."""

    def __init__(self) -> None:
        self._launched: list[subprocess.Popen[bytes]] = []
        self._workers: host.Workers | None = None

    def me(self) -> str:
        return host.me()

    def alive(self, identity: str) -> bool:
        return host.alive(identity)

    def terminate(self, identity: str) -> None:
        host.terminate(identity)

    def launch(self, argv: list[str], *, log: Path, cwd: Path) -> str:
        # Reaps the coordinators launched before that have exited, so an agent collects no
        # zombies.
        self._launched = [p for p in self._launched if p.poll() is None]
        popen = host.launch_detached(argv, log=log, cwd=cwd)
        self._launched.append(popen)
        return host.identity(popen.pid) or f"{popen.pid}@"

    def spawn(self, argv: list[str], *, out: Path, cwd: Path) -> Child:
        if self._workers is None:
            self._workers = host.Workers()
        popen = self._workers.spawn(argv, out=out, cwd=cwd)
        return _OsChild(host.identity(popen.pid) or f"{popen.pid}@", popen)
