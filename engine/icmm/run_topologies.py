"""A run's topologies as Run detail and Topology read them (ADR-0019, ADR-0021).

The run's coordinator keeps each topology's row as its starts move: its state, its start counts,
its **Best start** with its RMSEs, its near best and spread, and when its starts went out and
last ended. So each read here is one query over the run's rows (old ADR-0012, ADR-0014), and a
list walks an index from its cursor, whatever the run's size. Nothing is computed beyond counting
(ADR-0013).
"""

from __future__ import annotations

import json
import math
import sqlite3
from typing import Any

from icmm.wire.run import (
    SpreadSummary,
    Topology,
    TopologyArray,
    TopologyBest,
    TopologyOrder,
    TopologyState,
    TopologySummary,
    TopStart,
)

PAGE = 500
"""Topologies a page holds: under 1 KB each on the wire, inside its 1 MiB (ADR-0009)."""
TOP_10 = 10

RANK = (
    "best_start IS NULL",
    "best_val_rmse IS NULL",
    "COALESCE(best_val_rmse, 0)",
    "best_train_rmse IS NULL",
    "COALESCE(best_train_rmse, 0)",
    "position",
)
"""A topology's place in its run's ranking, as `topologies_ranked` indexes it: by its Best
start's Val RMSE, then Train RMSE, "—" after every number, then the topologies with no start
finished, in the order they go out (ADR-0006). A run without validation points has no Val RMSE,
so it ranks by Train RMSE alone."""
_RANK = ", ".join(RANK)
_FIRST = (-1, 0, 0, 0, 0, -1)
"""Before every topology's rank."""

_SUMMARY = (
    "t.graph",
    "t.open_state",
    "t.position",
    "t.state",
    "r.starts / r.topologies",
    "t.starts_finished",
    "t.starts_failed",
    "t.starts_running",
    "t.best_start",
    "t.best_train_rmse",
    "t.best_val_rmse",
    "t.near_best",
    "t.spread",
    "t.spread_min",
    "t.spread_q1",
    "t.spread_q3",
    "t.spread_max",
    "t.first_sent_at",
    "t.last_ended_at",
)
"""What a topology's row shows, in `_summary`'s order."""

_RANKED = (
    "ranked (n) AS MATERIALIZED (SELECT COUNT(*) FROM topologies INDEXED BY topologies_ranked "
    "WHERE run_id = ? AND (best_start IS NULL) = 0)"
)
"""How many of the run's topologies rank: those with a Best start, at the head of its index.
Counted once a read, not once a row."""

TOP = (
    "top (start, train_rmse, val_rmse, best) AS (SELECT t.start_index, t.train_rmse, t.val_rmse, "
    "t.best FROM start_tries t INDEXED BY start_tries_top CROSS JOIN starts s "
    "ON s.run_id = t.run_id AND s.graph = t.graph AND s.open_state = t.open_state "
    "AND s.start_index = t.start_index AND s.try = t.try WHERE t.run_id = ? AND t.graph = ? "
    "AND t.open_state = ? AND t.train_rmse IS NOT NULL AND s.state = 'finished' "
    "ORDER BY t.train_rmse, t.start_index LIMIT ?)"
)
"""A topology's Top 10, its finished starts by Train RMSE: a walk along `start_tries_top` that
stops at the tenth, so it reads ten starts' vectors whatever the topology's size. Its parameters
are the run, the graph, the open state and how many."""


class NotFoundError(Exception):
    """No such run, or no such topology in it: deleted, never submitted, or not listed yet."""


def list_page(
    conn: sqlite3.Connection,
    run: int,
    order: TopologyOrder,
    after: str | None,
    state: TopologyState | None = None,
) -> tuple[list[TopologySummary], int, str | None]:
    """A page of the run's topologies in `order`, only those in `state` if given, how many rank,
    and the next page's cursor: `r <rank>` by rank, `s <position>` in the order they go out. One
    query, which walks an index from the cursor. `ValueError` for a cursor this didn't give, one
    of the other order, or a state by rank; `NotFoundError` for a run deleted or never
    submitted."""
    bound = _cursor(after, order)
    if state is not None:
        if order == "rank":
            raise ValueError("a state is listed in the order its topologies go out")
        walk = (
            "SELECT graph, open_state, position AS k0 FROM topologies INDEXED BY "
            "topologies_state WHERE run_id = ? AND state = ? AND position > ? "
            "ORDER BY position LIMIT ?"
        )
        bound = (state, *bound)
        sort = key_columns = "p.k0"
    elif order == "rank":
        keys = ", ".join(f"{key} AS k{i}" for i, key in enumerate(RANK))
        walk = (
            f"SELECT graph, open_state, {keys} FROM topologies INDEXED BY topologies_ranked "
            f"WHERE run_id = ? AND ({_RANK}) > ({', '.join('?' * len(RANK))}) "
            f"ORDER BY {_RANK} LIMIT ?"
        )
        sort = ", ".join(f"p.k{i}" for i in range(len(RANK)))
        key_columns = sort
    else:
        walk = (
            "SELECT graph, open_state, position AS k0 FROM topologies INDEXED BY "
            "topologies_order WHERE run_id = ? AND position > ? ORDER BY position LIMIT ?"
        )
        sort = key_columns = "p.k0"
    rows = conn.execute(
        f"WITH page AS ({walk}), {_RANKED} "
        f"SELECT r.id, ranked.n, {', '.join(_SUMMARY)}, {key_columns} FROM runs r "
        "CROSS JOIN ranked LEFT JOIN page p LEFT JOIN topologies t ON t.run_id = r.id "
        "AND t.graph = p.graph AND t.open_state = p.open_state "
        f"WHERE r.id = ? AND r.deleted_at IS NULL ORDER BY {sort}",
        (run, *bound, PAGE + 1, run, run),
    ).fetchall()
    if not rows:
        raise NotFoundError
    ranked = rows[0][1]
    found = [row for row in rows if row[2] is not None]
    page = [_summary(row[2:]) for row in found[:PAGE]]
    if len(found) <= PAGE:
        return page, ranked, None
    last = found[PAGE - 1][2 + len(_SUMMARY) :]
    return page, ranked, _position(order, last)


def read(conn: sqlite3.Connection, run: int, graph: int, open_state: int) -> Topology:
    """The topology, with its rank in its run and in its run's Ranking group, its starts
    counted by state, its arrays, each parameter's spread and its Top 10, in one query;
    `NotFoundError` for one the run hasn't listed."""
    from icmm import leaderboard

    where = (run, graph, open_state)
    head = (
        *_SUMMARY,
        "ranked.n",
        "CASE WHEN t.best_start IS NULL THEN NULL ELSE 1 + (SELECT COUNT(*) FROM topologies "
        f"INDEXED BY topologies_ranked WHERE run_id = r.id AND ({_RANK}) < "
        f"({', '.join(f't.{key}' if key == 'position' else _outer(key) for key in RANK)})) END",
        *leaderboard.in_group("t", "r"),
        "(SELECT COUNT(*) FROM starts s WHERE s.run_id = t.run_id AND s.graph = t.graph "
        "AND s.open_state = t.open_state AND s.state = 'sent')",
        "(SELECT COUNT(*) FROM starts s WHERE s.run_id = t.run_id AND s.graph = t.graph "
        "AND s.open_state = t.open_state AND s.state = 'pending')",
        "t.parameter_spreads",
        "(SELECT json_group_array(json_object('number', a.number, 'job_id', a.job_id, "
        "'tasks', a.tasks, 'sent_at', a.sent_at, 'ended_at', a.ended_at)) FROM (SELECT * FROM "
        "arrays INDEXED BY arrays_topology WHERE run_id = t.run_id AND graph = t.graph "
        "AND open_state = t.open_state ORDER BY number) a)",
    )
    # The topology's row is worked out once, then joined to each of its Top 10.
    rows = conn.execute(
        f"WITH {TOP}, {_RANKED}, head AS MATERIALIZED (SELECT "
        f"{', '.join(f'{column} AS c{i}' for i, column in enumerate(head))} "
        "FROM topologies t JOIN runs r ON r.id = t.run_id AND r.deleted_at IS NULL "
        "CROSS JOIN ranked WHERE t.run_id = ? AND t.graph = ? AND t.open_state = ?) "
        "SELECT head.*, top.start, top.train_rmse, top.val_rmse, top.best FROM head "
        "LEFT JOIN top ORDER BY top.train_rmse, top.start",
        (*where, TOP_10, run, *where),
    ).fetchall()
    if not rows:
        raise NotFoundError
    first = rows[0]
    rest = first[len(_SUMMARY) :]
    ranked, rank, group_rank, group_ranked, queued, waiting, spreads, arrays = rest[:8]
    return Topology(
        **dict(_summary(first)),
        rank=rank,
        ranked=ranked,
        group_rank=group_rank,
        group_ranked=group_ranked,
        starts_queued=queued,
        starts_waiting=waiting,
        parameter_spreads=None if spreads is None else json.loads(spreads),
        arrays=[TopologyArray(**a) for a in json.loads(arrays)],
        top_10=top_10(row[len(_SUMMARY) + 8 :] for row in rows),
    )


def top_10(rows: Any) -> list[TopStart]:
    """The Top 10 joined onto a read's rows, as (start, train RMSE, val RMSE, best)."""
    return [
        TopStart(start=start, train_rmse=train, val_rmse=val, best=json.loads(best))
        for start, train, val, best in rows
        if start is not None
    ]


def _outer(key: str) -> str:
    """A rank key read from the outer row `t`, beside the same key of the index's rows."""
    for column in ("best_start", "best_val_rmse", "best_train_rmse"):
        key = key.replace(column, f"t.{column}")
    return key


def _summary(row: tuple[Any, ...]) -> TopologySummary:
    (
        graph,
        open_state,
        position,
        state,
        starts,
        finished,
        failed,
        running,
        best_start,
        best_train,
        best_val,
        near_best,
        spread,
        spread_min,
        q1,
        q3,
        spread_max,
        first_sent_at,
        last_ended_at,
    ) = row[: len(_SUMMARY)]
    return TopologySummary(
        graph=graph,
        open_state=open_state,
        position=position,
        state=state,
        provisional=state in ("next", "fitting"),
        starts=starts,
        starts_finished=finished,
        starts_failed=failed,
        starts_running=running,
        best=None
        if best_start is None
        else TopologyBest(start=best_start, train_rmse=best_train, val_rmse=best_val),
        near_best=near_best,
        spread=None
        if spread is None
        else SpreadSummary(median=spread, min=spread_min, q1=q1, q3=q3, max=spread_max),
        first_sent_at=first_sent_at,
        last_ended_at=last_ended_at,
    )


def _position(order: TopologyOrder, keys: tuple[Any, ...]) -> str:
    """A cursor at a topology: its rank keys, each written so it reads back exactly."""
    return f"{'r' if order == 'rank' else 's'} {' '.join(repr(k) for k in keys)}"


def _cursor(after: str | None, order: TopologyOrder) -> tuple[Any, ...]:
    if after is None:
        return _FIRST if order == "rank" else (-1,)
    kind, _, rest = after.partition(" ")
    parts = rest.split(" ")
    try:
        if kind == "r" and order == "rank" and len(parts) == len(RANK):
            flags = [int(parts[i]) for i in (0, 1, 3)]
            if any(f not in (0, 1) for f in flags):
                raise ValueError
            val, train = float(parts[2]), float(parts[4])
            if not (math.isfinite(val) and math.isfinite(train)):
                raise ValueError
            return (flags[0], flags[1], val, flags[2], train, int(parts[5]))
        if kind == "s" and order == "sent" and len(parts) == 1:
            return (int(parts[0]),)
    except ValueError:
        pass
    raise ValueError(f"not a cursor: {after!r}")
