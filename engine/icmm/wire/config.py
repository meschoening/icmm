"""A **Config** as it crosses the wire, format 1 (ADR-0016): the dataset it fits, its topology
search space, and its search settings and bounds.

The desktop sends drafts, which may break any limit, so these types carry only the shape: closed
and strict, so that a misspelled key is refused, never dropped. The limits and every check across
fields are `validate_config`'s (`icmm.config`), whose issues reach the desktop beside their fields.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from icmm.wire.base import RunState, WireInt, WireModel
from icmm.wire.errors import Issue, UnreadableError


class AllTopologies(WireModel):
    """Every topology with the config's number of states."""

    kind: Literal["all"]


class TopologySample(WireModel):
    """A Random sample: each run draws `count` topologies at submit, from its **Search seed**,
    and records the ones it drew (ADR-0017). The config never holds drawn ids."""

    kind: Literal["sample"]
    count: WireInt


class SpecificId(WireModel):
    """One of Specific IDs: a **State graph** (`T1991`), or one of its topologies (`T1991.6`)."""

    graph: WireInt
    """The state graph's number in the list for the config's number of states, counted from 0."""
    open_state: WireInt | None
    """The topology's **Open state**; `null` for every topology of the state graph, one per open
    state (ADR-0018)."""


class SpecificIds(WireModel):
    kind: Literal["ids"]
    ids: list[SpecificId]
    """In the order they were written."""


type WhichTopologies = Annotated[
    AllTopologies | TopologySample | SpecificIds, Field(discriminator="kind")
]


class TopologySpace(WireModel):
    num_states: WireInt | None
    """From 3 to 16; `null` until it's chosen. A new config starts without one, and a save
    needs it."""
    which: WhichTopologies
    """Exactly one of All, a Random sample and Specific IDs; a new config starts on a sample of
    5."""


class SearchSettings(WireModel):
    """How each start searches (ADR-0008)."""

    starts_per_topology: WireInt
    """100 by default."""
    population: WireInt
    """Candidates per **Generation**; 50 by default."""
    evaluation_budget: WireInt
    """How many candidates each start scores, rounded up to a whole generation; 1,000,000 by
    default."""
    log_every_generations: WireInt
    """How often each start writes its **Start log**: its first generation, every this many, and
    its last; 200 by default."""
    search_seed: WireInt | None
    """From 0 to 4,294,967,295; `null`, the default, draws one at submit for each run."""
    sobol_start_points: bool
    """Off by default."""


class Bounds(WireModel):
    """The search box, as `icmm.parameters.ParameterBounds` reads it (ADR-0007)."""

    rate_min: float
    """The lowest a state or edge parameter may be, in ln units; −10 by default."""
    rate_max: float
    """The highest a state or edge parameter may be, in ln units; 10 by default."""
    sigmoid_min_mV: float
    """The lowest the **Sigmoid**'s a or b may be, in mV; −80 by default."""
    sigmoid_max_mV: float
    """The highest the **Sigmoid**'s a or b may be, in mV; 60 by default."""


class Config(WireModel):
    """A config's settings, which a run keeps as they were when it was submitted (ADR-0016)."""

    format: Literal[1]
    name: str
    """Letters, digits, ., - and _, up to 64; unique on the platform, ignoring case."""
    dataset_id: str
    """The **Dataset** it fits, never a revision: Submit fits the current one."""
    topology: TopologySpace
    search: SearchSettings
    bounds: Bounds


class ValidateConfigParams(WireModel):
    config: Config


class TopologyCounts(WireModel):
    """The list for the config's number of states."""

    state_graphs: WireInt
    """`T0` to one less than this."""
    topologies: WireInt
    """Every state graph at each of its open states."""


class Work(WireModel):
    """What a run of the config would fit; each count is `null` until it can be counted."""

    topologies: WireInt | None
    """All's count, the sample's size, or what the saved Specific IDs name."""
    per_id: list[WireInt]
    """With Specific IDs, how many topologies each saved id fits, in order: a state graph's open
    states, or 1. Empty otherwise."""
    starts: WireInt | None
    """`topologies` × starts per topology."""
    bytes_per_start: WireInt | None
    """The coordinator’s estimate for one start’s files; `null` until its inputs are known."""
    evaluations_per_start: WireInt | None
    """The evaluation budget rounded up to a whole generation: what each start runs."""


class ConfigCheck(WireModel):
    issues: list[Issue]
    """Every issue found, each with the path to its field under `config`: an error stops a save,
    a note doesn't. None when it can be saved as it is."""
    config: Config
    """The config as a save would keep it: as sent, but for Specific IDs, which are the
    normalized list the notes describe."""
    counts: TopologyCounts | None
    """`null` while the number of states is unchosen, outside 3–16, or has no list."""
    work: Work


class ListConfigsParams(WireModel):
    after: str | None
    """The `next` of the page before; `null` for the first page."""


class ConfigDatasetName(WireModel):
    """The dataset a config names, as the runs database has it now."""

    id: str
    name: str | None
    """Its name now, or when it was deleted; `null` when this platform never had it."""
    deleted: bool
    """Deleted, or never on this platform: the config can't submit until it names another."""


class ConfigRun(WireModel):
    """A config's newest run, by number: what its run status shows."""

    id: WireInt
    """Its number, written `#214`."""
    state: RunState
    ended_at: str | None
    """In UTC (ISO 8601); `null` while in flight."""


class ConfigSummary(WireModel):
    id: str
    revision: WireInt
    name: str
    modified_at: str
    """When it was last saved, in UTC (ISO 8601)."""
    dataset: ConfigDatasetName
    num_states: WireInt | None
    which: Literal["all", "sample", "ids"] | None
    """Which topologies it fits: All, a Random sample or Specific IDs, so its row on Configs can
    say "5 random topologies"; `null` for one a newer ICMM saved, or whose settings can't be
    read."""
    topologies: WireInt | None
    """How many topologies a run of it fits, as its save counted them."""
    starts: WireInt | None
    """How many starts a run of it holds, as its save counted them."""
    unreadable: UnreadableError | None
    """Why it can't be read, as `read_config` would say: a newer ICMM saved it. `null` when it
    can be."""
    latest_run: ConfigRun | None
    """Its newest run, by number; `null` before its first. A deleted run isn't one."""


class ConfigList(WireModel):
    configs: list[ConfigSummary]
    """Newest modified first. Pages after the first keep the order it found, so a config saved
    between pages is listed once, where it was then, with what it holds now; one made since
    isn't listed, and one deleted since is left out. The `configs` change says which."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class ReadConfigParams(WireModel):
    id: str


class ConfigDataset(WireModel):
    """The dataset a config names, and whether a run can be submitted with it now."""

    id: str
    name: str | None
    """Its name now, or when it was deleted; `null` when this platform never had it."""
    deleted: bool
    """Deleted, or never on this platform: Submit run is blocked until the config names
    another."""
    revision: WireInt | None
    """Its current revision, which Submit fits; `null` when `deleted`."""
    unreadable: UnreadableError | None
    """Why its current revision can't be read, with `read_dataset`'s problem and sentence;
    `null` when it can, or it's `deleted`. Submit run is blocked while it's set."""


class SavedConfig(WireModel):
    """A config as it was last saved."""

    id: str
    revision: WireInt
    modified_at: str
    """When it was last saved, in UTC (ISO 8601)."""
    config: Config
    topologies: WireInt | None
    """How many topologies a run of it fits, as its save counted them."""
    starts: WireInt | None
    """How many starts a run of it holds, as its save counted them."""
    dataset: ConfigDataset


class SaveConfigParams(WireModel):
    request_key: str
    id: str | None
    """The config to save over; `null` to make a new one."""
    expected_revision: WireInt | None
    """The revision the edit started from; `null` with a new config."""
    config: Config


class ConfigRevision(WireModel):
    id: str
    revision: WireInt


class DuplicateConfigParams(WireModel):
    request_key: str
    id: str
    """The config to copy, as it was last saved."""


class DuplicatedConfig(WireModel):
    id: str
    """The copy's own id."""
    revision: WireInt
    name: str
    """The free name the copy was saved under: `<name>-copy`, or `-copy-2`, `-copy-3`… when
    another config has it, ignoring case, cut to 64 characters."""


class DeleteConfigParams(WireModel):
    request_key: str
    id: str


class DeletedConfig(WireModel):
    id: str


class CountConfigsParams(WireModel):
    dataset_id: str


class ConfigCount(WireModel):
    configs: WireInt
    """How many configs name the dataset, for Delete's confirm on Dataset detail."""
