"""`hello`, the first line of every session: the desktop and agent check they speak one protocol.

Both sides compare `major.minor`; any other method before `hello` gets `bad_request` (ADR-0009).
"""

from __future__ import annotations

from enum import StrEnum

from icmm.wire.base import WireInt, WireModel


class HelloParams(WireModel):
    protocol: str
    """The desktop's protocol, `major.minor`."""
    app_version: str


class Scheduler(StrEnum):
    """Which backend the agent drives: separate from how the desktop reaches it."""

    SLURM = "slurm"
    LOCAL = "local"


class Platform(WireModel):
    """The data folder's platform settings, from its runs database."""

    output_folder: str
    scheduler: Scheduler


class HostFacts(WireModel):
    """What the agent found on the host it runs on."""

    host: str
    scheduler: Scheduler
    """The scheduler this host can drive: `slurm` when `sbatch` is on its PATH."""
    cpus: WireInt
    cache_ns: list[WireInt]
    """The state counts whose topology caches the engine bundle carries."""


class HelloResult(WireModel):
    protocol: str
    """The agent's protocol, `major.minor`."""
    engine_version: str
    bundle_key: str | None
    """The installed engine bundle; `null` when the agent runs from a checkout."""
    platform: Platform | None
    """`null` until the data folder is set up."""
    facts: HostFacts
