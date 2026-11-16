"""SLURM's `Scheduler` (ADR-0019): each array task's state, from what the queue and accounting say.

The queue is the controller's word on the tasks it still holds and the reasons they wait;
accounting's is on the tasks that ended, and a task it lists as ended is ended, since that is final.
A task neither can place, or in a state not named here, is left out: unknown is never ended, so its
start stays open and keeps its slot.

Each launch is a batch job named for its identity: an array of starts, whose batch shell passes
SLURM's signals on to its start, or a generation of a run's coordinator, which runs from the run's
engine beside SLURM's commands, never in the container override.
"""

from __future__ import annotations

import os
import shlex
import socket
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Protocol

from icmm import processes
from icmm.scheduler import (
    WARN_S,
    ArrayLaunch,
    CoordinatorLaunch,
    RefusedError,
    SchedulerUnavailableError,
    TaskState,
)
from icmm.scheduler.slurm import DEFAULT_MAX_ARRAY_SIZE, AccountedTask, LiveTask, SlurmCli
from icmm.wire.platform import ContainerRuntime, JobDefaults, SlurmJobDefaults
from icmm.wire.run import StartCause

COORDINATOR_MEMORY_MB = 1024
"""What a coordinating job asks for: it reads files and the runs database, and drives SLURM."""
RESULT_GRACE_S = 120.0
"""How long a task SLURM says ended may take to show its result: written on a compute node, it may
not reach the coordinator's NFS client for up to a minute."""

WORKER_SCRIPT = """\
#!/bin/bash
# {identity}, task $SLURM_ARRAY_TASK_ID: one start. SLURM's warning ahead of the time limit
# (USR1) reaches only this shell, and a cancel's TERM may not reach a start inside a container,
# so it passes each on to the start, which writes its best so far.
child=
trap 'kill -USR1 "$child" 2>/dev/null' USR1
trap 'kill -TERM "$child" 2>/dev/null' TERM
{command} &
child=$!
# A trap interrupts wait with a status above 128 while the start runs on.
while wait "$child"; status=$?; [ "$status" -gt 128 ] && kill -0 "$child" 2>/dev/null; do :; done
exit "$status"
"""
"""An array task's batch script: `str.format` with the array's `identity` and the start's
`command`."""
COORDINATOR_SCRIPT = """\
#!/bin/bash
# {identity}: generation {generation} of run #{run}'s coordinator.
exec {command}
"""
"""A coordinating job's batch script: `str.format` with the launch's `identity`, `generation` and
`run`, and the coordinator's `command`."""

QUEUED_REASONS = frozenset({"", "Resources", "Priority", "JobArrayTaskLimit"})
"""The reasons a waiting task could start the moment resources free up: it waits for them, for its
turn, or for its own array's throttle (**Queued**). Any other holds it (**Held**)."""
_ACCOUNT = "Choose another account"
_BILLING = "Choose another account or partition"
_TIME = "Lower its time limit"
_SIZE = "Lower CPUs or memory per start"
REFUSALS = {
    "InvalidAccount": ("the account doesn't exist, or isn't yours to bill", _ACCOUNT),
    "InvalidQOS": ("the account has no QOS that may use the partition", _BILLING),
    "AccountNotAllowed": ("the partition doesn't take jobs from the account", _BILLING),
    "PartitionTimeLimit": ("its time limit is longer than the partition allows", _TIME),
    "QOSMaxWallDurationPerJobLimit": ("its time limit is longer than the QOS allows", _TIME),
    "PartitionConfig": ("the partition has no room for the CPUs or memory it asks for", _SIZE),
    "BadConstraints": ("no node has the CPUs, memory or features it asks for", _SIZE),
}
"""The held reasons that never clear with time, since the job can't run as asked: what each
means, and what to change in Job defaults (ADR-0019). A refusal stops the run. Maintenance
(`ReqNodeNotAvail`), a partition that's down or a per-user limit pass, so hold as any other."""
QUEUED_STATES = frozenset({"PENDING", "REQUEUED", "REQUEUE_FED"})
WAITING_STATES = QUEUED_STATES | {"REQUEUE_HOLD", "RESV_DEL_HOLD", "SPECIAL_EXIT"}
RUNNING_STATES = frozenset(
    {
        "RUNNING",
        "COMPLETING",
        "CONFIGURING",
        "SUSPENDED",
        "RESIZING",
        "SIGNALING",
        "STAGE_OUT",
        "STOPPED",
    }
)
"""A task in any of these is still the controller's: its start stays open."""
ENDED: dict[str, StartCause | None] = {
    "COMPLETED": None,
    "CANCELLED": None,  # codespell:ignore cancelled
    "FAILED": StartCause.ERROR,
    "OUT_OF_MEMORY": StartCause.OUT_OF_MEMORY,
    "TIMEOUT": StartCause.TIME_LIMIT,
    "NODE_FAIL": StartCause.LOST,
    "BOOT_FAIL": StartCause.LOST,
    "PREEMPTED": StartCause.LOST,
    "DEADLINE": StartCause.LOST,
}
"""The accounting states that are final, each with the cause it gives a start that left no result;
`None` where the task ended as a task does."""
_STEP_OUT_OF_MEMORY_STATES = frozenset({"COMPLETED", "FAILED"})
"""The states a task takes when its step ran out of memory but the batch shell lived on."""


def held_reason(reason: str, state: str) -> str | None:
    """Why a waiting task is held, in the scheduler's own words; `None` while it could start the
    moment resources free up. Only `Resources`, `Priority`, no reason and `JobArrayTaskLimit` can,
    so every other reason holds, unknown ones included (ADR-0019); a state that holds on its own,
    with no reason, is its own."""
    if reason not in QUEUED_REASONS:
        return reason
    return None if state in QUEUED_STATES else state


def refusal(reason: str) -> str | None:
    """Why the job can't run as asked and what to change, for a held reason that never clears
    with time; `None` for any other."""
    code = reason.partition(",")[0].strip()
    if code not in REFUSALS:
        return None
    meaning, change = REFUSALS[code]
    return (
        f"SLURM won't run the job as asked ({code}): {meaning}. "
        f"{change} in Job defaults, then Resume the run."
    )


class Commands(Protocol):
    """What `SlurmScheduler` asks of SLURM: `SlurmCli`'s scheduling commands."""

    def budgeted(self, budget_s: float) -> Commands: ...

    def queue(self, job_ids: Sequence[str]) -> list[LiveTask] | None: ...

    def accounting(self, job_ids: Sequence[str]) -> list[AccountedTask] | None: ...

    def named(self, name: str) -> list[str] | None: ...

    def max_array_size(self) -> int | None: ...

    def submit(self, options: Sequence[str], script: str) -> str: ...

    def set_throttle(self, job_id: str, throttle: int) -> bool: ...

    def cancel(self, job_ids: Sequence[str], *, waiting_only: bool) -> bool: ...


class SlurmScheduler:
    """The SLURM cluster a run's coordinator and the agent's lifecycle dispatcher drive."""

    max_array_size: int | None
    result_grace_s = RESULT_GRACE_S

    def __init__(
        self,
        cli: Commands,
        *,
        python: str = sys.executable,
        environ: Mapping[str, str] = os.environ,
    ) -> None:
        """`python` runs each start: the coordinator's own interpreter, which is its run's engine
        (ADR-0020)."""
        self.cli = cli
        self.python = python
        self.environ = environ
        self.max_array_size = cli.max_array_size() or DEFAULT_MAX_ARRAY_SIZE

    @classmethod
    def on_host(cls, cli: SlurmCli | None = None) -> SlurmScheduler:
        """This host's SLURM. Its commands share no budget, since a coordinator calls them for as
        long as it runs. `cli` runs them instead: a test's, whose commands never time out."""
        return cls(SlurmCli(budget_s=None) if cli is None else cli)

    def me(self) -> str:
        """The coordinator's job id; outside a job, as `icmm cleanup` runs on the login node,
        this host and process, by its id and start time (`icmm.processes`)."""
        return self.environ.get("SLURM_JOB_ID") or f"{socket.gethostname()}:{processes.me()}"

    def alive(self, claimer: str) -> bool | None:
        """Whether a coordinating job still runs, as the queue and accounting say: `None` when
        neither knows it. A claimer outside a job runs only on its own host, where only it can
        be seen: on another, it reads as gone."""
        host, outside, process = claimer.partition(":")
        if outside:
            return host == socket.gethostname() and processes.alive(process)
        task = self.tasks([claimer]).get(claimer, {}).get(0)
        return None if task is None else task.status == "running"

    def alive_many(self, claimers: Sequence[str], *, budget_s: float) -> dict[str, bool | None]:
        """Checks host processes as `alive` does, and jobs in one queue/accounting pair. Only
        this request's commands carry a deadline; the scheduler's session stays unbounded."""
        cli = self.cli.budgeted(budget_s)
        answer = {claimer: self.alive(claimer) for claimer in claimers if ":" in claimer}
        jobs = list(dict.fromkeys(claimer for claimer in claimers if ":" not in claimer))
        if jobs:
            states = self._tasks(jobs, cli)
            for job in jobs:
                task = states[job].get(0)
                answer[job] = None if task is None else task.status == "running"
        return answer

    def own_job(self) -> str | None:
        """The coordinating job this process runs in; `None` outside one."""
        return self.environ.get("SLURM_JOB_ID") or None

    def tasks(self, job_ids: Sequence[str]) -> dict[str, dict[int, TaskState]]:
        """Each job's tasks by index, from the queue first and then accounting, which wins for
        a task it lists as ended; a job that isn't an array is its own task 0.
        `SchedulerUnavailableError` where the queue didn't answer; accounting that didn't leaves
        the ended tasks out, as unknown. A job neither knows is answered `{}`, so its slots stay
        held."""
        return self._tasks(job_ids, self.cli)

    def _tasks(self, job_ids: Sequence[str], cli: Commands) -> dict[str, dict[int, TaskState]]:
        if not job_ids:
            return {}
        listed = cli.queue(job_ids)
        if listed is None:
            raise SchedulerUnavailableError("squeue didn't answer")
        accounted = cli.accounting(job_ids) or []
        answer: dict[str, dict[int, TaskState]] = {job_id: {} for job_id in job_ids}
        live = {(t.job_id, t.task): t for t in listed if t.job_id in answer}
        recorded = {(a.job_id, a.task): a for a in accounted if a.job_id in answer}
        for key in sorted(live.keys() | recorded.keys()):
            state = _task_state(live.get(key), recorded.get(key))
            if state is not None:
                answer[key[0]][key[1]] = state
        return answer

    def submit_array(self, launch: ArrayLaunch) -> str:
        """Sends the array: each task one start on one node, with the Job defaults' CPUs, memory
        and time limit, warned `WARN_S` ahead of it; never requeued, since a start sent again is
        the coordinator's to send. `RefusedError` in SLURM's words if it won't take it."""
        jobs = _slurm(launch.job_defaults)
        options = [
            f"--job-name={launch.identity}",
            *_billing(jobs),
            "--nodes=1",
            "--ntasks=1",
            f"--cpus-per-task={jobs.cpus_per_start}",
            f"--mem={jobs.memory_per_start_mb}M",
            f"--time={jobs.time_limit_per_start_min}",
            *_excluding(jobs, launch.avoiding),
            "--no-requeue",
            f"--signal=B:USR1@{WARN_S}",
            f"--array=0-{launch.tasks - 1}%{launch.throttle}",
            f"--output={launch.jobs.with_name(launch.jobs.stem + '-%a.out')}",
        ]
        return self.cli.submit(options, worker_script(launch, jobs, self.python))

    def launch_coordinator(self, launch: CoordinatorLaunch) -> str:
        """Sends the generation as a job of one CPU and `COORDINATOR_MEMORY_MB`, for the Job
        defaults' coordinator time limit, waiting behind `launch.after` if it names a job.
        `RefusedError` in SLURM's words if it won't take it."""
        jobs = _slurm(launch.job_defaults)
        options = [
            f"--job-name={launch.identity}",
            *_billing(jobs),
            "--nodes=1",
            "--ntasks=1",
            "--cpus-per-task=1",
            f"--mem={COORDINATOR_MEMORY_MB}M",
            f"--time={jobs.run_coordinator_time_limit_min}",
            *_excluding(jobs),
            "--no-requeue",
            *([f"--dependency=afterany:{launch.after}"] if launch.after else []),
            f"--output={launch.log}",
        ]
        return self.cli.submit(options, coordinator_script(launch, self.python))

    def set_throttle(self, job_id: str, throttle: int) -> None:
        """Changes the most of the array's tasks that may run at once: one `scontrol` call."""
        if not self.cli.set_throttle(job_id, throttle):
            raise SchedulerUnavailableError(f"scontrol didn't change {job_id}'s throttle")

    def cancel(self, job_ids: Sequence[str], *, waiting_only: bool) -> None:
        """Cancels the jobs' tasks, only those still waiting with `waiting_only`; SLURM signals
        a running task's batch shell, which passes it on to the start."""
        if not self.cli.cancel(job_ids, waiting_only=waiting_only):
            raise SchedulerUnavailableError(f"scancel didn't cancel {', '.join(job_ids)}")

    def find(self, identity: str) -> list[str]:
        """The jobs named `identity`, in the queue or accounting, ascending."""
        found = self.cli.named(identity)
        if found is None:
            raise SchedulerUnavailableError(f"SLURM didn't say which jobs are {identity}")
        return found


def worker_script(launch: ArrayLaunch, jobs: SlurmJobDefaults, python: str) -> str:
    """An array task's batch script, which runs its start in the background and passes SLURM's
    signals on to it. The start runs from `python`, or in the Job defaults' container with the
    run's folder and its dataset revision bound in."""
    command = shlex.join([*_runner(launch, jobs, python), "run-start", "--array", str(launch.jobs)])
    command += ' --task "$SLURM_ARRAY_TASK_ID" --threads ' + str(jobs.cpus_per_start)
    return WORKER_SCRIPT.format(identity=launch.identity, command=command)


def coordinator_script(launch: CoordinatorLaunch, python: str) -> str:
    """A coordinating job's batch script: `icmm coordinate` from the run's engine, `python` for
    one run from a checkout, told its job's time limit so it hands on before it. Never in the
    container override: it drives SLURM's commands, which a container lacks."""
    jobs = _slurm(launch.job_defaults)
    command = shlex.join(
        [
            engine_python(launch.data_folder, launch.engine, python),
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
            "--time-limit-min",
            str(jobs.run_coordinator_time_limit_min),
        ]
    )
    return COORDINATOR_SCRIPT.format(
        identity=launch.identity, generation=launch.generation, run=launch.run, command=command
    )


def engine_python(data_folder: Path, engine: str | None, fallback: str) -> str:
    """The interpreter of **Engine bundle** `engine`, as the Data folder holds it (ADR-0020);
    `fallback` for an engine run from a checkout."""
    if engine is None:
        return fallback
    return str(data_folder / "engine" / engine / "python" / "bin" / "python3.12")


def _runner(launch: ArrayLaunch, jobs: SlurmJobDefaults, python: str) -> list[str]:
    """What runs `icmm`: `python`, or `python3` in the container with the run's folder and its
    dataset revision bound in at their own paths."""
    module = ["-I", "-m", "icmm"]
    container = jobs.container
    if container is None:
        return [python, *module]
    from icmm.jobs import ArrayJob  # here, not above: the agent's import path stays light

    folder = str(launch.folder)
    dataset = str(ArrayJob.model_validate_json(launch.jobs.read_bytes()).dataset)
    image = [container.image, "python3", *module]
    if container.runtime is ContainerRuntime.APPTAINER:
        return ["apptainer", "exec", "--bind", folder, "--bind", dataset, *image]
    mounts = ["-v", f"{folder}:{folder}", "-v", f"{dataset}:{dataset}"]
    return ["docker", "run", "--rm", *mounts, *image]


def _slurm(defaults: JobDefaults) -> SlurmJobDefaults:
    if not isinstance(defaults, SlurmJobDefaults):
        raise RefusedError("This platform's Job defaults are This computer's, not a cluster's.")
    return defaults


def _billing(jobs: SlurmJobDefaults) -> list[str]:
    """The account and partition to bill, each left to SLURM's default where unset."""
    account = [f"--account={jobs.account}"] if jobs.account else []
    return account + ([f"--partition={jobs.partition}"] if jobs.partition else [])


def _excluding(jobs: SlurmJobDefaults, avoiding: Sequence[str] = ()) -> list[str]:
    """The Job defaults' excluded nodes, then those a launch avoids."""
    nodes = list(dict.fromkeys([*jobs.excluded_nodes, *avoiding]))
    return [f"--exclude={','.join(nodes)}"] if nodes else []


def _task_state(live: LiveTask | None, record: AccountedTask | None) -> TaskState | None:
    """The task's state, or `None` where it is unknown for now: neither lists it, its state isn't
    named here, or the queue dropped it before accounting recorded its end."""
    if record is not None and record.state in ENDED:
        cause = ENDED[record.state]
        if record.step_out_of_memory and record.state in _STEP_OUT_OF_MEMORY_STATES:
            cause = StartCause.OUT_OF_MEMORY
        # Only a cancel can end a task before it started: any other end with no node counts a try.
        ran = record.node is not None or record.state != "CANCELLED"  # codespell:ignore cancelled
        return TaskState(
            "ended",
            ran=ran,
            cause=cause,
            node=record.node,
            peak_memory_mb=record.peak_memory_mb,
            exit_code=record.exit_code,
            scheduler_state=record.state,
        )
    if live is None:
        return None
    if live.state in WAITING_STATES:
        held = held_reason(live.reason, live.state)
        return TaskState(
            "waiting",
            held=held,
            queued=(live.reason or None) if held is None else None,
            refused=None if held is None else refusal(held),
            scheduler_state=live.state,
        )
    if live.state in RUNNING_STATES:
        return TaskState("running", node=live.node, scheduler_state=live.state)
    return None
