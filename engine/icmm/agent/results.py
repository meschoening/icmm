"""Results' reads: a dataset's Ranking groups, a group's leaderboard a page at a time, and a
topology's rank N of M in its group (#336, #341). Each is a few indexed queries over the rows the
runs' coordinators keep; nothing is read from the Output folder (ADR-0013).

`icmm.leaderboard` is imported on first use, so the agent's start path stays as light as `hello`
needs.
"""

from __future__ import annotations

from icmm.agent.serve import AgentError
from icmm.db import RunsDb, reading
from icmm.wire.errors import BadRequestError, NotFoundData, NotFoundError
from icmm.wire.results import (
    GroupRank,
    Leaderboard,
    ListLeaderboardParams,
    ListRankingGroupsParams,
    RankingGroups,
    ReadGroupRankParams,
)


def list_ranking_groups(params: ListRankingGroupsParams, *, db: RunsDb) -> RankingGroups:
    from icmm import leaderboard

    conn = db.connection()
    try:
        with reading(conn):
            return leaderboard.groups(conn, params.dataset)
    except leaderboard.NotFoundError:
        raise AgentError(dataset_not_found(params.dataset)) from None


def list_leaderboard(params: ListLeaderboardParams, *, db: RunsDb) -> Leaderboard:
    from icmm import leaderboard

    conn = db.connection()
    try:
        with reading(conn):
            return leaderboard.page(conn, params)
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None


def read_group_rank(params: ReadGroupRankParams, *, db: RunsDb) -> GroupRank:
    from icmm import leaderboard
    from icmm.agent.topologies import topology_not_found

    conn = db.connection()
    try:
        with reading(conn):
            return leaderboard.group_rank(conn, params.run, params.graph, params.open_state)
    except leaderboard.TopologyNotFoundError:
        raise AgentError(topology_not_found(params.run, params.graph, params.open_state)) from None


def dataset_not_found(dataset: str) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message="This dataset isn't on this platform.",
        data=NotFoundData(kind="dataset", id=dataset),
    )
