"""Results' reads across a dataset's runs (#336, #341): its **Ranking groups**, a group's
leaderboard, and a topology's rank N of M in its group, which Topology's read takes too
(ADR-0003, ADR-0006).

Each run keeps its group, its dataset and its pinned revision's scoring digest, on its row, and
each topology its Best start's RMSEs, near best, spread and counts, which its coordinator keeps.
So each read is a few indexed queries over those rows, inside the login node's budget (old
ADR-0012, ADR-0014; ADR-0013): nothing is computed beyond counting.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from typing import Any, Literal

from icmm.wire.results import (
    GroupDataset,
    GroupRank,
    GroupRun,
    Leaderboard,
    LeaderboardRow,
    LeaderboardRun,
    ListLeaderboardParams,
    RankingGroup,
    RankingGroups,
)
from icmm.wire.run import RunConfig, SpreadSummary, TopologyBest


class NotFoundError(Exception):
    """This platform never had the dataset."""


def groups(conn: sqlite3.Connection, dataset: str) -> RankingGroups:
    """The dataset's Ranking groups, from its revisions and its runs: the current one first,
    even with no run, then each earlier one with runs, the latest replaced first."""
    found = conn.execute(
        "SELECT d.name, d.deleted_at, cur.scoring_digest FROM datasets d "
        "LEFT JOIN dataset_revisions cur "
        "ON cur.dataset_id = d.id AND cur.revision = d.current_revision WHERE d.id = ?",
        (dataset,),
    ).fetchone()
    if found is None:
        raise NotFoundError
    name, deleted_at, current = found
    if deleted_at is not None:
        current = None
    # Each digest's first save, and when its last revision was replaced: by the next revision,
    # or, past the last, by the dataset's delete.
    spans = conn.execute(
        "WITH revs AS (SELECT revision, scoring_digest, saved_at, "
        "LEAD(saved_at) OVER (ORDER BY revision) AS replaced_at "
        "FROM dataset_revisions WHERE dataset_id = ?), "
        "last AS (SELECT scoring_digest, MIN(saved_at) AS since, MAX(revision) AS revision "
        "FROM revs GROUP BY scoring_digest) "
        "SELECT l.scoring_digest, l.since, COALESCE(r.replaced_at, ?) FROM last l "
        "JOIN revs r ON r.revision = l.revision",
        (dataset, deleted_at),
    ).fetchall()
    runs: dict[str, list[GroupRun]] = {}
    for digest, run, config_id, config_name, config_deleted, num_states, state in conn.execute(
        "SELECT r.scoring_digest, r.id, r.config_id, c.name, c.deleted_at IS NOT NULL, "
        "r.num_states, r.state FROM runs r INDEXED BY runs_ranking "
        "JOIN configs c ON c.id = r.config_id "
        "WHERE r.dataset_id = ? AND r.deleted_at IS NULL ORDER BY r.id DESC",
        (dataset,),
    ):
        runs.setdefault(digest, []).append(
            GroupRun(
                id=run,
                config=RunConfig(id=config_id, name=config_name, deleted=bool(config_deleted)),
                num_states=num_states,
                state=state,
            )
        )
    listed = [
        RankingGroup(
            scoring_digest=digest,
            current=digest == current,
            current_from=since,
            current_until=None if digest == current else until,
            runs=runs.get(digest, []),
        )
        for digest, since, until in spans
        if digest == current or digest in runs
    ]
    listed.sort(key=lambda g: g.current_until or "", reverse=True)
    listed.sort(key=lambda g: not g.current)
    return RankingGroups(
        dataset=GroupDataset(id=dataset, name=name, deleted=deleted_at is not None),
        groups=listed,
    )


PAGE = 100
"""Rows a leaderboard page holds: under 1 KB each on the wire, inside its 1 MiB (ADR-0009)."""

_INF = "9e999"
"""Infinity, as SQL writes it: the key of a "—", after every number."""


@dataclass(frozen=True)
class _Order:
    """How an order walks each run's ranked topologies: along `index`, by `walk`, its columns
    in the index's order, a run's rows unique by them.

    `key`: the first of `walk` is the row's key, "—" last either way, and the rest are the Val
    rank's ties, ascending either way. `run`: by a key of the run's, `run_key`, then by `walk`,
    the Val rank. `whole`: `walk` all one way, then by run."""

    index: str
    walk: tuple[str, ...]
    kind: Literal["key", "run", "whole"]
    run_key: str = "0"


_TIES = ("rank_val", "rank_train", "position")
"""The Val rank's keys within a run: a group breaks their ties by run."""

ORDERS: dict[str, _Order] = {
    "rank": _Order("topologies_by_rank", _TIES, "key"),
    "train": _Order("topologies_by_train", ("rank_train", "rank_val", "position"), "key"),
    "near_best": _Order("topologies_by_near_best", ("near_key", *_TIES), "key"),
    "spread": _Order("topologies_by_spread", ("spread_key", *_TIES), "key"),
    "starts": _Order("topologies_by_starts", ("starts_finished", *_TIES), "key"),
    "states": _Order("topologies_by_rank", _TIES, "run", run_key="num_states"),
    "run": _Order("topologies_by_rank", _TIES, "run", run_key="id"),
    "topology": _Order("topologies_by_id", ("graph", "open_state"), "whole"),
}

_ROW = (
    "r.id",
    "c.id",
    "c.name",
    "c.deleted_at IS NOT NULL",
    "r.state",
    "r.num_states",
    "t.graph",
    "t.open_state",
    "t.state",
    "t.state = 'fitting' AND r.end_seq IS NULL",
    "r.starts / r.topologies",
    "t.starts_finished",
    "t.starts_failed",
    "t.starts_running",
    "(SELECT COUNT(*) FROM starts s WHERE s.run_id = t.run_id AND s.graph = t.graph "
    "AND s.open_state = t.open_state AND s.state = 'sent')",
    "t.best_start",
    "t.best_train_rmse",
    "t.best_val_rmse",
    "(SELECT a.still_improving FROM starts s JOIN start_tries a ON a.run_id = s.run_id "
    "AND a.graph = s.graph AND a.open_state = s.open_state AND a.start_index = s.start_index "
    "AND a.try = s.try WHERE s.run_id = t.run_id AND s.graph = t.graph "
    "AND s.open_state = t.open_state AND s.start_index = t.best_start)",
    "t.near_best",
    "t.spread",
    "t.spread_min",
    "t.spread_q1",
    "t.spread_q3",
    "t.spread_max",
)
"""What a row shows, in `_row`'s order. Then its rank's keys, then its place in the walk."""

_GROUP = (
    "FROM runs INDEXED BY runs_ranking WHERE dataset_id = :dataset AND scoring_digest = :digest "
    "AND deleted_at IS NULL"
)


@dataclass(frozen=True)
class _Cursor:
    """Where a page ended: its last row's run, its run's key, and its place in its run's walk."""

    run: int
    run_key: float
    walk: tuple[float, ...]


def page(conn: sqlite3.Connection, params: ListLeaderboardParams) -> Leaderboard:
    """A page of the Ranking group's leaderboard, in the caller's read transaction: a merge of
    its runs' walks from the cursor, which reads about the page's own rows whatever the group's
    size, then their Val ranks and the totals. `ValueError` for a cursor this didn't give, or
    one of another order."""
    group = {"dataset": params.dataset, "digest": params.scoring_digest}
    validation, ranked = conn.execute(
        f"SELECT COALESCE(MAX(has_validation), 0), COALESCE(SUM(topologies_ranked), 0) {_GROUP}",
        group,
    ).fetchone()
    metric = "rank_val" if validation else "rank_train"
    # Without validation points every Val RMSE is "—": the rank is by Train RMSE, either way.
    order = ORDERS["train" if params.order == "rank" and not validation else params.order]
    cursor = _cursor(params.after, params.order, params.descending, order)
    values: dict[str, Any] = {
        **group,
        "run": params.run,
        "states": params.num_states,
        "max": params.max_rmse,
        "min": params.min_near_best,
        "limit": PAGE + 1,
    }
    if cursor is not None:
        values |= {"run0": cursor.run, "key0": cursor.run_key}
        values |= {f"w{i}": w for i, w in enumerate(cursor.walk)}
    walked = conn.execute(_walk(order, params, cursor is not None, metric), values).fetchall()
    shown = walked[:PAGE]
    ends = len(_ROW)
    ranks = _ranks(conn, group, [(*row[ends : ends + 3], row[0]) for row in shown])
    next = None
    if len(walked) > PAGE:
        last = shown[-1]
        place = _Cursor(run=last[0], run_key=last[ends + 3], walk=tuple(last[ends + 4 :]))
        next = _position(params.order, params.descending, place)
    total, still_improving = _total(conn, params, values, metric)
    return Leaderboard(
        rows=[_row(row, rank) for row, rank in zip(shown, ranks, strict=True)],
        total=total,
        still_improving=still_improving,
        ranked=ranked,
        validation=bool(validation),
        next=next,
    )


def _filters(params: ListLeaderboardParams, metric: str, live: str) -> str:
    """What a row must be to be listed, beyond ranking, as SQL on the row's own columns: the
    filters a walk checks along its index, and `live`, whether its run is in flight."""
    kept = ""
    if params.max_rmse is not None:
        kept += f" AND {metric} <= :max"
    if params.min_near_best is not None:
        kept += f" AND near_key >= :min AND near_key < {_INF}"
    if not params.fitting:
        kept += f" AND ({live} = 0 OR state != 'fitting')"
    return kept


def _walk(order: _Order, params: ListLeaderboardParams, after: bool, metric: str) -> str:
    """The merge: each run's first row from the cursor, then, a row at a time, the least of
    what's waiting, replaced by its run's next. A recursive query's ORDER BY pops its queue in
    order, so it reads each run's walk only as far as the page reaches."""
    n = len(order.walk)
    w = [f"w{i}" for i in range(n)]
    descending = params.descending
    o = [f"o{i}" for i in range(len(_sort(order, descending, w, "rk")))]
    columns = ["rid", "id", "live", "rk", *w, *o]

    def computed(source: str) -> str:
        """Row `t` from `source`'s run, named as `m` names its columns: a compound query's ORDER
        BY reads its first query's names."""
        walk = [f"t.{column}" for column in order.walk]
        sort = _sort(order, descending, walk, f"{source}.rk")
        values = ["t.rowid", f"{source}.id", f"{source}.live", f"{source}.rk", *walk, *sort]
        return ", ".join(f"{v} AS {name}" for v, name in zip(values, columns, strict=True))

    def next_of(source: str, start: str | None) -> str:
        """The rowid of `source`'s run's next row after `source`'s place in its walk; for a
        run's first, `start` says whether to begin at its walk's start."""
        here = [f"{source}.{name}" for name in w]
        kept = _filters(params, metric, f"{source}.live")
        base = (
            f"FROM topologies INDEXED BY {order.index} WHERE run_id = {source}.id "
            f"AND best_start IS NOT NULL{kept}"
        )
        columns = ", ".join(order.walk)
        if order.kind != "key" or not descending:
            if order.kind == "whole" and descending:
                backward = ", ".join(f"{c} DESC" for c in order.walk)
                return (
                    f"SELECT rowid {base} AND ({columns}) < ({', '.join(here)}) "
                    f"ORDER BY {backward} LIMIT 1"
                )
            return (
                f"SELECT rowid {base} AND ({columns}) > ({', '.join(here)}) "
                f"ORDER BY {columns} LIMIT 1"
            )
        # Descending by a key: the next of its ties, else the first of the next lower key, else
        # the first "—".
        key, ties = order.walk[0], ", ".join(order.walk[1:])
        same = (
            f"SELECT rowid {base} AND {key} = {here[0]} AND ({ties}) > ({', '.join(here[1:])}) "
            f"ORDER BY {ties} LIMIT 1"
        )
        below = f"CASE WHEN {start} THEN {_INF} ELSE {here[0]} END" if start else here[0]
        lower = (
            f"SELECT rowid {base} AND {key} = (SELECT MAX({key}) {base} AND {key} < {below}) "
            f"ORDER BY {ties} LIMIT 1"
        )
        last = f"SELECT rowid {base} AND {key} = {_INF} ORDER BY {ties} LIMIT 1"
        if start is None:
            return (
                f"SELECT COALESCE(({same}), CASE WHEN {here[0]} < {_INF} "
                f"THEN COALESCE(({lower}), ({last})) END)"
            )
        return (
            f"SELECT COALESCE(CASE WHEN NOT {start} THEN ({same}) END, "
            f"CASE WHEN {start} OR {here[0]} < {_INF} THEN COALESCE(({lower}), ({last})) END)"
        )

    runs = (
        f"SELECT id, end_seq IS NULL AS live, {order.run_key} AS rk, "
        f"{_starts(order, descending, after)} {_GROUP} "
        "AND (:run IS NULL OR id = :run) AND (:states IS NULL OR num_states = :states)"
    )
    if after and order.kind == "run":
        runs += f" AND {order.run_key} {'<=' if descending else '>='} :key0"
    by = ", ".join([*o, "id"])
    return (
        f"WITH RECURSIVE g (id, live, rk, start, {', '.join(w)}) AS ({runs}), "
        f"m ({', '.join(columns)}) AS ("
        f"SELECT {computed('g')} FROM g "
        f"JOIN topologies t ON t.rowid = ({next_of('g', 'g.start')}) "
        "UNION ALL "
        f"SELECT {computed('m')} FROM m "
        f"JOIN topologies t ON t.rowid = ({next_of('m', None)}) "
        f"ORDER BY {by} LIMIT :limit) "
        f"SELECT {', '.join(_ROW)}, t.rank_val, t.rank_train, t.position, m.rk, "
        f"{', '.join(f'm.{name}' for name in w)} FROM m "
        "JOIN topologies t ON t.rowid = m.rid JOIN runs r ON r.id = m.id "
        f"JOIN configs c ON c.id = r.config_id ORDER BY {', '.join(f'm.{x}' for x in [*o, 'id'])}"
    )


def _sort(order: _Order, descending: bool, walk: list[str], run_key: str) -> list[str]:
    """How a row sorts across runs, before its run breaks the last ties: from its place in its
    run's `walk` and its run's key."""
    if order.kind == "key":
        key = walk[0]
        return [f"{key} >= {_INF}", f"-{key}", *walk[1:]] if descending else walk
    if order.kind == "run":
        return [f"-{run_key}" if descending else run_key, *walk]
    return [f"-{column}" for column in walk] if descending else walk


def _starts(order: _Order, descending: bool, after: bool) -> str:
    """Where each run's walk starts, as `g`'s columns: whether at its walk's start, then its
    place in its walk, which the first row must come after (or, walked backward, before). A run
    after the cursor's in the group's order takes the cursor's own place too: ties go by run."""
    n = len(order.walk)
    if not after:
        start = "1" if order.kind == "key" and descending else "0"
        lowest = _INF if order.kind == "whole" and descending else "-1"
        return ", ".join([start, *[lowest] * n])
    # The last of the walk is unique in its run and whole, so half a step takes in the cursor's
    # own place for runs after its run.
    shift = "+" if order.kind == "whole" and descending else "-"
    later = f"{shift} 0.5 * (id > :run0)"
    if order.kind == "run":
        # A run past the cursor's run key starts at its walk's start.
        places = [f"CASE WHEN {order.run_key} = :key0 THEN :w{i} ELSE -1 END" for i in range(n)]
        places[-1] = f"CASE WHEN {order.run_key} = :key0 THEN :w{n - 1} {later} ELSE -1 END"
        return ", ".join(["0", *places])
    return ", ".join(["0", *[f":w{i}" for i in range(n - 1)], f":w{n - 1} {later}"])


def _ranks(
    conn: sqlite3.Connection, group: dict[str, str], keys: list[tuple[Any, ...]]
) -> list[int]:
    """Each row's Val rank in the group, from its rank's keys and its run: one more than the
    group's rows before it. Taken in rank order, each row counts only those since the row before,
    so the counting reaches no further than the page's last row in rank order."""
    if not keys:
        return []
    rows = ", ".join(f"(:i{i}, :v{i}, :t{i}, :p{i}, :r{i})" for i in range(len(keys)))
    values: dict[str, Any] = dict(group)
    for i, (v, t, p, r) in enumerate(keys):
        values |= {f"i{i}": i, f"v{i}": v, f"t{i}": t, f"p{i}": p, f"r{i}": r}
    # A row of an earlier run comes before one of a later run where their keys tie: half a step
    # on the position says so.
    since = _between(
        list(_TIES),
        ["p.pv", "p.pt", "p.pp + 0.5 * (g.id < p.prun)"],
        ["p.v", "p.t", "p.pos + 0.5 * (g.id < p.run)"],
    )
    ranked = conn.execute(
        f"WITH g (id) AS (SELECT id {_GROUP}), "
        f"page (i, v, t, pos, run) AS (VALUES {rows}), "
        "p AS (SELECT page.*, COALESCE(LAG(v) OVER w, -1) AS pv, "
        "COALESCE(LAG(t) OVER w, -1) AS pt, COALESCE(LAG(pos) OVER w, -1) AS pp, "
        "COALESCE(LAG(run) OVER w, 0) AS prun FROM page "
        "WINDOW w AS (ORDER BY v, t, pos, run)), "
        f"gaps AS (SELECT p.i, p.v, p.t, p.pos, p.run, (SELECT SUM({since}) FROM g) AS n FROM p) "
        "SELECT i, 1 + SUM(n) OVER (ORDER BY v, t, pos, run ROWS UNBOUNDED PRECEDING) FROM gaps",
        values,
    ).fetchall()
    by_row = dict(ranked)
    return [by_row[i] for i in range(len(keys))]


def _between(columns: list[str], lo: list[str], hi: list[str], same: str = "") -> str:
    """How many of run `g.id`'s ranked rows have `columns` from `lo` up to but not including
    `hi`, as SQL: a sum of counts each along one column, after equal ones, so each walks its
    range alone. A range over several columns at once is checked again at every row."""
    if len(columns) == 1:
        return _count(f"{same} AND {columns[0]} >= {lo[0]} AND {columns[0]} < {hi[0]}")
    column, rest = columns[0], columns[1:]
    at_lo, at_hi = f"{same} AND {column} = {lo[0]}", f"{same} AND {column} = {hi[0]}"
    between = _count(f"{same} AND {column} > {lo[0]} AND {column} < {hi[0]}")
    return (
        f"(CASE WHEN {lo[0]} = {hi[0]} THEN {_between(rest, lo[1:], hi[1:], at_lo)} "
        f"ELSE {_from(rest, lo[1:], at_lo)} + {between} + {_before(rest, hi[1:], at_hi)} END)"
    )


def _from(columns: list[str], lo: list[str], same: str) -> str:
    """How many have `columns` at `lo` or after, as `_between` counts them."""
    if len(columns) == 1:
        return _count(f"{same} AND {columns[0]} >= {lo[0]}")
    after = _count(f"{same} AND {columns[0]} > {lo[0]}")
    return f"{after} + {_from(columns[1:], lo[1:], f'{same} AND {columns[0]} = {lo[0]}')}"


def _before(columns: list[str], hi: list[str], same: str) -> str:
    """How many have `columns` before `hi`, as `_between` counts them."""
    if len(columns) == 1:
        return _count(f"{same} AND {columns[0]} < {hi[0]}")
    lower = _count(f"{same} AND {columns[0]} < {hi[0]}")
    return f"{lower} + {_before(columns[1:], hi[1:], f'{same} AND {columns[0]} = {hi[0]}')}"


def _count(where: str) -> str:
    return (
        "(SELECT COUNT(*) FROM topologies INDEXED BY topologies_by_rank WHERE run_id = g.id "
        f"AND best_start IS NOT NULL{where})"
    )


def _total(
    conn: sqlite3.Connection, params: ListLeaderboardParams, values: dict[str, Any], metric: str
) -> tuple[int, int]:
    """How many rows the filters keep, and how many of them have a Best start that was still
    improving: from each run's counts of its ranked topologies and of those still improving,
    without a filter on their numbers; else counted along the index a filter bounds: Near
    best's, or the ranking metric's for Max RMSE alone."""
    runs = (
        f"SELECT id, end_seq IS NULL AS live, topologies_ranked, topologies_still_improving "
        f"{_GROUP} AND (:run IS NULL OR id = :run) AND (:states IS NULL OR num_states = :states)"
    )
    numbers = _filters(params.model_copy(update={"fitting": True}), metric, "0")
    if numbers:
        index = (
            "topologies_by_near_best"
            if params.min_near_best is not None
            else "topologies_by_rank"
            if metric == "rank_val"
            else "topologies_by_train"
        )

        def each(also: str) -> str:
            return (
                f"(SELECT COUNT(*) FROM topologies INDEXED BY {index} WHERE run_id = g.id "
                f"AND best_start IS NOT NULL{numbers}{also})"
            )

        every, improving = each(""), each(_IMPROVING)
    else:
        every, improving = "g.topologies_ranked", "g.topologies_still_improving"

    def fitting(also: str) -> str:
        if params.fitting:
            return "0"
        return (
            "(SELECT COUNT(*) FROM topologies INDEXED BY topologies_fitting WHERE run_id = g.id "
            f"AND state = 'fitting' AND best_start IS NOT NULL{numbers}{also})"
        )

    def kept(each: str, also: str) -> str:
        return f"COALESCE(SUM({each} - CASE WHEN g.live THEN {fitting(also)} ELSE 0 END), 0)"

    total, still_improving = conn.execute(
        f"WITH g AS ({runs}) SELECT {kept(every, '')}, {kept(improving, _IMPROVING)} FROM g",
        values,
    ).fetchone()
    return total, still_improving


_IMPROVING = " AND best_still_improving = 1"
"""A row whose Best start was still improving at its end (migration 24)."""


def _row(row: tuple[Any, ...], rank: int) -> LeaderboardRow:
    (
        run,
        config_id,
        config_name,
        config_deleted,
        run_state,
        num_states,
        graph,
        open_state,
        state,
        fitting,
        starts,
        finished,
        failed,
        running,
        queued,
        best_start,
        best_train,
        best_val,
        still_improving,
        near_best,
        spread,
        spread_min,
        q1,
        q3,
        spread_max,
    ) = row[: len(_ROW)]
    return LeaderboardRow(
        rank=rank,
        run=LeaderboardRun(
            id=run,
            config=RunConfig(id=config_id, name=config_name, deleted=bool(config_deleted)),
            state=run_state,
        ),
        num_states=num_states,
        graph=graph,
        open_state=open_state,
        state=state,
        fitting=bool(fitting),
        starts=starts,
        starts_finished=finished,
        starts_failed=failed,
        starts_running=running,
        starts_queued=queued,
        best=TopologyBest(start=best_start, train_rmse=best_train, val_rmse=best_val),
        still_improving=None if still_improving is None else bool(still_improving),
        near_best=near_best,
        spread=None
        if spread is None
        else SpreadSummary(median=spread, min=spread_min, q1=q1, q3=q3, max=spread_max),
    )


def _position(order: str, descending: bool, place: _Cursor) -> str:
    """A cursor at a row: its order and direction, its run, its run's key and its place in its
    run's walk, each written so it reads back exactly."""
    numbers = " ".join(repr(float(v)) for v in (place.run_key, *place.walk))
    return f"{order} {'d' if descending else 'a'} {place.run} {numbers}"


def _cursor(after: str | None, name: str, descending: bool, order: _Order) -> _Cursor | None:
    if after is None:
        return None
    parts = after.split(" ")
    try:
        if (
            len(parts) == 4 + len(order.walk)
            and parts[0] == name
            and parts[1] == ("d" if descending else "a")
        ):
            run = int(parts[2])
            numbers = [float(p) for p in parts[3:]]
            if not any(math.isnan(v) for v in numbers):
                return _Cursor(run=run, run_key=numbers[0], walk=tuple(numbers[1:]))
    except ValueError:
        pass
    raise ValueError(f"not a cursor: {after!r}")


class TopologyNotFoundError(Exception):
    """No such run, or no such topology in it: deleted, never submitted, or not listed yet."""


def in_group(topology: str, run: str) -> tuple[str, str]:
    """A topology's rank N of M in its run's Ranking group, as two SQL expressions on the
    topology's row `topology` and its run's row `run`. N is one more than the group's rows
    before it, each run's counted along its `topologies_by_rank` as `_ranks` counts them, ties
    going to the earlier run, and `NULL` without a Best start; M is the sum of each run's count.
    So it reads about the rows ranked before it, whatever the group's size."""
    group = (
        f"FROM runs g INDEXED BY runs_ranking WHERE g.dataset_id = {run}.dataset_id "
        f"AND g.scoring_digest = {run}.scoring_digest AND g.deleted_at IS NULL"
    )
    keys = [f"{topology}.{key}" for key in _TIES]
    keys[-1] += f" + 0.5 * (g.id < {run}.id)"
    rank = (
        f"CASE WHEN {topology}.best_start IS NULL THEN NULL "
        f"ELSE 1 + (SELECT SUM({_before(list(_TIES), keys, '')}) {group}) END"
    )
    return rank, f"(SELECT COALESCE(SUM(g.topologies_ranked), 0) {group})"


def group_rank(conn: sqlite3.Connection, run: int, graph: int, open_state: int) -> GroupRank:
    """The topology's rank N of M in its run's Ranking group (`in_group`), in one query."""
    rank, ranked = in_group("t", "r")
    found = conn.execute(
        f"SELECT r.dataset_id, r.scoring_digest, {rank}, {ranked}, "
        "d.deleted_at IS NULL AND cur.scoring_digest IS r.scoring_digest "
        "FROM runs r JOIN topologies t ON t.run_id = r.id AND t.graph = ? AND t.open_state = ? "
        "LEFT JOIN datasets d ON d.id = r.dataset_id "
        "LEFT JOIN dataset_revisions cur "
        "ON cur.dataset_id = d.id AND cur.revision = d.current_revision "
        "WHERE r.id = ? AND r.deleted_at IS NULL",
        (graph, open_state, run),
    ).fetchone()
    if found is None:
        raise TopologyNotFoundError
    dataset, digest, rank, ranked, current = found
    return GroupRank(
        rank=rank, ranked=ranked, dataset=dataset, scoring_digest=digest, current=bool(current)
    )
