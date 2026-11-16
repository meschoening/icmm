"""The schedulers an agent drives: SLURM when the host has it, else local processes.

A run's **Coordinator** and the agent's lifecycle dispatcher see either one through `Scheduler`
(ADR-0019): each launch carries a deterministic identity that the scheduler keeps with the job, so
a launch that may or may not have reached it can be found again rather than repeated (ADR-0009).
"""

from __future__ import annotations

import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

from icmm.wire.handshake import Scheduler as SchedulerKind
from icmm.wire.platform import JobDefaults
from icmm.wire.run import StartCause

if TYPE_CHECKING:
    from icmm.scheduler.slurm import SlurmCli

WARN_S = 180
"""`--signal=B:USR1@180`: a SLURM start is warned 3 minutes before its time limit, to write its
best so far. Here rather than beside the job script, so the Platform settings' checks read it
without loading SLURM's scheduler."""


def detect() -> SchedulerKind:
    """`slurm` when `sbatch` is on the PATH. The scheduler is found, never chosen."""
    return SchedulerKind.SLURM if shutil.which("sbatch") else SchedulerKind.LOCAL


def for_host(data_folder: Path, *, slurm: SlurmCli | None = None) -> Scheduler | None:
    """This host's scheduler for the Data folder, as the coordinator and the lifecycle
    dispatcher drive it: SLURM's where `sbatch` is on the PATH (#248), else This computer's
    (#247). It always answers one: the `| None` types the callers' factories. `slurm` runs
    SLURM's commands in place of `SlurmScheduler.on_host`'s own."""
    if detect() is SchedulerKind.SLURM:
        from icmm.scheduler.slurm_scheduler import SlurmScheduler

        return SlurmScheduler.on_host(slurm)
    from icmm.scheduler.local import LocalScheduler

    return LocalScheduler(data_folder)


class SchedulerUnavailableError(Exception):
    """The scheduler didn't answer, or didn't say: try again later. Never read as a refusal."""


class RefusedError(Exception):
    """The scheduler won't take the job as asked; the message is its own words."""


@dataclass(frozen=True)
class CoordinatorLaunch:
    """One generation of a run's coordinator, to run `icmm coordinate` from the run's engine."""

    data_folder: Path
    run: int
    generation: int
    identity: str
    log: Path
    """Where its output goes."""
    engine: str | None
    """The run's **Engine bundle** key; `None` for an engine run from a checkout."""
    job_defaults: JobDefaults
    """As they are now: on SLURM, the coordinating job's account, partition and time limit."""
    after: str | None = None
    """The job it waits behind: it starts once that job has ended, whatever ended it. A
    generation queues its successor so (ADR-0019)."""


@dataclass(frozen=True)
class ArrayLaunch:
    """An array of starts: task i runs `icmm run-start --array <jobs> --task i`."""

    identity: str
    jobs: Path
    """The array's job file (`icmm.jobs.ArrayJob`)."""
    tasks: int
    throttle: int
    """The most of its tasks that may run at once."""
    folder: Path
    """The run's folder in its Output folder, for the scheduler's own output."""
    engine: str | None
    job_defaults: JobDefaults
    """As they are now: what each task asks for (ADR-0019)."""
    avoiding: tuple[str, ...] = ()
    """Nodes its tasks avoid beside the Job defaults' excluded ones: those that lost one of its
    starts on an earlier try (ADR-0019)."""


@dataclass(frozen=True)
class TaskState:
    """One array task, as the scheduler sees it."""

    status: Literal["waiting", "running", "ended"]
    held: str | None = None
    """Waiting on something other than free resources: the scheduler's own reason."""
    queued: str | None = None
    """Waiting for free resources, its turn or its array's throttle: the scheduler's own reason,
    `Resources`, `Priority` or `JobArrayTaskLimit`; `None` when held, or given none."""
    refused: str | None = None
    """Waiting on a hold that never clears with time, as the job can't run as asked: why, and
    what to change. The run stops on it (ADR-0019)."""
    ran: bool = True
    """Ended: whether it ever started. One that never did has no cause and is sent again."""
    cause: StartCause | None = None
    """Ended: why, if the scheduler says (out of memory, its time limit, an error, the node lost);
    `None` when it ended as a task does. Read only when the task wrote no result."""
    node: str | None = None
    peak_memory_mb: int | None = None
    exit_code: int | None = None
    scheduler_state: str | None = None


class Scheduler(Protocol):
    """What the coordinator and the agent's lifecycle dispatcher ask of a scheduler. Each call
    raises `SchedulerUnavailableError` when the scheduler doesn't answer."""

    max_array_size: int | None
    """The most tasks one array may hold (SLURM's MaxArraySize); `None` for no limit."""
    result_grace_s: float
    """How long a task it says ended may take to show its result: on SLURM, whose workers write
    on other machines, an NFS client may not see a new file for up to a minute; on This
    computer, whose workers write on its own, none (#327)."""

    def me(self) -> str:
        """This process, as the scheduler knows it: its job id, or its process id and start
        time."""
        ...

    def alive(self, claimer: str) -> bool | None:
        """Whether the coordinator that claimed a run as `claimer`, its `me()`, still runs;
        `None` where the scheduler can't say yet. A run canceling that none carries is
        `icmm cleanup`'s to end (`icmm.cleanup`)."""
        ...

    def alive_many(self, claimers: Sequence[str], *, budget_s: float) -> dict[str, bool | None]:
        """Checks coordinator identities together within one request's allowance. A caller must
        discard results arriving after its deadline; unavailable is never proof of an end."""
        ...

    def own_job(self) -> str | None:
        """This process's own job, for its successor to wait behind (`CoordinatorLaunch.after`);
        `None` where no successor waits: on This computer, whose relauncher launches the next
        generation once one is gone, or outside a job."""
        ...

    def launch_coordinator(self, launch: CoordinatorLaunch) -> str:
        """Launches the generation; answers its job id. `RefusedError` if it won't."""
        ...

    def submit_array(self, launch: ArrayLaunch) -> str:
        """Sends the array; answers its job id. `RefusedError` if it won't."""
        ...

    def set_throttle(self, job_id: str, throttle: int) -> None: ...

    def cancel(self, job_ids: Sequence[str], *, waiting_only: bool) -> None:
        """Cancels the jobs' tasks: only those still waiting, with `waiting_only`."""
        ...

    def tasks(self, job_ids: Sequence[str]) -> dict[str, dict[int, TaskState]]:
        """Each job's tasks by index; a job that isn't an array is its own task 0. A task left
        out is unknown for now: its start stays open. The coordinator asks every sweep, with no
        job ids when nothing is out: a scheduler with work of its own does it then, as This
        computer's does, and one with nothing to ask answers `{}` at once, as SLURM's does, so no
        sweep's empty ask reaches its controller."""
        ...

    def find(self, identity: str) -> list[str]:
        """The job ids of the jobs launched with `identity`, live or ended."""
        ...
