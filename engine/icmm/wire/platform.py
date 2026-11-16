"""The Platform settings: the Output folder and Job defaults a Data folder keeps for itself.

They live in the runs database with a revision, and every computer that connects shares them
(ADR-0009). The scheduler isn't a choice: the Job defaults' `type` is the one the agent found.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field

from icmm.wire.base import WireInt, WireModel
from icmm.wire.handshake import Scheduler


class ContainerRuntime(StrEnum):
    APPTAINER = "apptainer"
    DOCKER = "docker"


class ContainerOverride(WireModel):
    """Runs a platform's jobs inside a container image instead of its engine bundle."""

    runtime: ContainerRuntime
    image: str
    """The image's path on the platform."""


class SlurmJobDefaults(WireModel):
    type: Literal["slurm"]
    account: str | None
    """`null` sends no `-A`, so the cluster bills the user's default account."""
    partition: str | None
    """`null` sends no `-p`, so the job goes to the cluster's default partition."""
    cpus_per_start: WireInt
    """The threads each start runs, all on one node."""
    memory_per_start_mb: WireInt
    time_limit_per_start_min: WireInt
    max_running_starts: WireInt
    """The **Running-starts cap**: the most of one run's starts running at once."""
    excluded_nodes: list[str]
    run_coordinator_time_limit_min: WireInt
    """The time limit of each run's coordinating job, which hands on to a successor."""
    check_for_results_every_s: WireInt
    container: ContainerOverride | None
    """`null` runs jobs from the engine bundle (ADR-0002)."""


class LocalJobDefaults(WireModel):
    type: Literal["local"]
    cpus_per_start: WireInt
    max_running_starts: WireInt


type JobDefaults = Annotated[SlurmJobDefaults | LocalJobDefaults, Field(discriminator="type")]


class PlatformSettings(WireModel):
    output_folder: str
    """Where new runs keep their results and **Start logs**; each run keeps its own."""
    job_defaults: JobDefaults


class SavedPlatformSettings(WireModel):
    revision: WireInt
    settings: PlatformSettings


class PlatformSettingsResult(WireModel):
    saved: SavedPlatformSettings | None
    """`null` until Platform setup saves them."""


class SavePlatformSettingsParams(WireModel):
    request_key: str
    expected_revision: WireInt | None
    """The revision the edit started from; `null` for Platform setup's first save."""
    settings: PlatformSettings


class Revision(WireModel):
    revision: WireInt


class Partition(WireModel):
    name: str
    accounts: list[str]
    """The user's accounts that may use it."""
    max_jobs_per_user: WireInt | None
    """The most jobs one user may run in it at once, from its QOS; `null` when unlimited or
    unknown."""
    max_cpus_per_user: WireInt | None
    max_time_min: WireInt | None
    """The longest time limit a job in it may ask for; `null` when unlimited or unknown."""


class SlurmLookup(WireModel):
    """What SLURM says about the user. A part it wouldn't say is empty."""

    max_array_size: WireInt
    """The array size the coordinator uses, including its fallback when SLURM cannot say."""
    accounts: list[str]
    default_account: str | None
    partitions: list[Partition]
    """Only those at least one of the user's accounts may use."""
    default_partition: str | None
    """`null` when the cluster has none, so a job must name one."""


class LocalLookup(WireModel):
    """What a platform without SLURM says about the computer its starts run on."""

    cores: WireInt
    """Its logical cores, which its running starts share."""


class SchedulerLookup(WireModel):
    scheduler: Scheduler
    """The scheduler this platform has; Platform setup shows it, never asks for it."""
    slurm: SlurmLookup | None
    """`null` without SLURM."""
    local: LocalLookup | None
    """`null` with SLURM."""
    proposed: PlatformSettings
    """What Platform setup fills in."""


class CheckFoldersParams(WireModel):
    output_folder: str
    """The Output folder as the user wrote it; the Data folder is the agent's own."""


class FolderCheck(WireModel):
    free_bytes: WireInt | None
    """The smaller of the disk's free space and the user's quota left; `null` if unreadable."""
    refusal: str | None
    """Why the folder can't be used here, as a sentence; `null` when it can."""


class FolderChecks(WireModel):
    data_folder: FolderCheck
    output_folder: FolderCheck
