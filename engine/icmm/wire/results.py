"""What Results reads across a dataset's runs (#336, #341): its **Ranking groups**, a group's
leaderboard, and a topology's rank N of M in its group.

Runs on one dataset whose revisions differ only in what can't change a score make up a Ranking
group, and their topologies rank together and only with each other (ADR-0003). A group ranks its
topologies by their **Best start**'s Val RMSE, or Train RMSE without validation points, "—" after
every number; a topology with no finished start isn't listed (ADR-0006).
"""

from __future__ import annotations

from typing import Literal

from icmm.wire.base import RunState, WireInt, WireModel
from icmm.wire.run import RunConfig, SpreadSummary, TopologyBest, TopologyState


class ListRankingGroupsParams(WireModel):
    dataset: str


class GroupDataset(WireModel):
    id: str
    name: str | None
    """Its name now, or when it was deleted."""
    deleted: bool


class GroupRun(WireModel):
    """A run in a Ranking group, for Results' Runs and States filters."""

    id: WireInt
    config: RunConfig
    num_states: WireInt
    state: RunState


class RankingGroup(WireModel):
    """The runs on revisions of the dataset that score alike, named by their scoring digest."""

    scoring_digest: str
    current: bool
    """Whether it's the dataset's current data: never for a deleted dataset."""
    current_from: str
    """When the first revision with this data was saved, in UTC (ISO 8601)."""
    current_until: str | None
    """When the last revision with this data was replaced by one that scores differently, or
    the dataset was deleted; `null` while current."""
    runs: list[GroupRun]
    """Newest first; none for a current group no run has fit yet."""


class RankingGroups(WireModel):
    dataset: GroupDataset
    groups: list[RankingGroup]
    """The current group first, even without runs, then each earlier group with runs, the
    latest replaced first."""


type LeaderboardOrder = Literal[
    "rank", "train", "near_best", "spread", "starts", "states", "run", "topology"
]
"""What the leaderboard sorts by. `rank`: the Val rank, by the Best start's Val RMSE then its
Train RMSE, "—" after every number (ADR-0006); in a group without validation points every Val
RMSE is "—", so it ranks by Train RMSE. `train`: the Best start's Train RMSE. `near_best`: how
many finished starts are Near best. `spread`: the Parameter spread's median. `starts`: how many
starts finished. `states`: the run's number of states. `run`: the run's number. `topology`: its
id, `T12.3`, then its run. Ties go by Val rank, and "—" goes last either way, except `topology`,
whose ties go by run."""


class ListLeaderboardParams(WireModel):
    dataset: str
    scoring_digest: str
    """The Ranking group's."""
    order: LeaderboardOrder
    descending: bool
    run: WireInt | None
    """Only this run's topologies."""
    num_states: WireInt | None
    """Only the topologies of runs with this many states."""
    max_rmse: float | None
    """Only the topologies whose Best start's Val RMSE, or Train RMSE in a group without
    validation points, is at most this: "—" isn't."""
    min_near_best: WireInt | None
    """Only the topologies with at least this many Near best starts."""
    fitting: bool
    """Whether topologies still fitting are listed, by their Best start so far."""
    after: str | None
    """The `next` of the page before, with the same order and filters; `null` for the first."""


class LeaderboardRun(WireModel):
    id: WireInt
    config: RunConfig
    """Its config's name is the run's: `#214 herg-wt-11state`."""
    state: RunState


class LeaderboardRow(WireModel):
    """A run's topology, `#214/T12.3`, as its coordinator keeps it, through its Best start."""

    rank: WireInt
    """Its Val rank in the Ranking group, whatever the order and filters: the `#` column."""
    run: LeaderboardRun
    num_states: WireInt
    graph: WireInt
    open_state: WireInt
    state: TopologyState
    fitting: bool
    """Still fitting in a run in flight: its numbers are "so far". A canceled or failed run's
    topology that ended short is its run's state, with its finished starts."""
    starts: WireInt
    starts_finished: WireInt
    starts_failed: WireInt
    starts_running: WireInt
    starts_queued: WireInt
    """Sent and waiting at the scheduler."""
    best: TopologyBest
    still_improving: bool | None
    """Whether its Best start was still improving at its budget's end; `null` where it didn't
    run its whole budget, or its engine didn't say."""
    near_best: WireInt | None
    spread: SpreadSummary | None


class Leaderboard(WireModel):
    rows: list[LeaderboardRow]
    """A page of at most 100, in the order asked for. A row whose place moves between pages is
    listed where it was then, twice or not at all; the `runs` change says to read it again."""
    total: WireInt
    """How many rows the filters keep, over every page."""
    still_improving: WireInt
    """How many of the rows the filters keep, over every page, whose Best start was **Still
    improving** at its end (RF20, #368)."""
    ranked: WireInt
    """How many topologies the Ranking group ranks, whatever the filters: the M of rank N of M."""
    validation: bool
    """Whether the group's data has validation points; without them, it ranks by Train RMSE."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class ReadGroupRankParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt


class GroupRank(WireModel):
    """A topology's rank N of M in its run's Ranking group, for a Best start's page."""

    rank: WireInt | None
    """Its Val rank in the group; `null` until one of its starts has finished."""
    ranked: WireInt
    """How many topologies the group ranks."""
    dataset: str
    scoring_digest: str
    current: bool
    """Whether the group is its dataset's current data: "on herg-wt", or its earlier data."""
