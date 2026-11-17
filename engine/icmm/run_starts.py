"""A run's starts as Topology and the Start page read them (ADR-0019), and where each try's
files are.

Each start's row names its latest try, and the try's row keeps what it ran with, its result's
best and errors, and, while it runs, its latest log point, which the run's coordinator copies
there each sweep (ADR-0009). So a list or a start is one query (old ADR-0012, ADR-0014). Its
files, the **Start log**, the **Live snapshot** and the scheduler's output, are named from the
run's Output folder and read only when asked for, a page at a time.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from icmm.run_topologies import TOP, TOP_10, top_10
from icmm.wire.run import StartCause
from icmm.wire.start import (
    RanWith,
    Start,
    StartCurve,
    StartProgress,
    StartState,
    StartSummary,
    StartTry,
    TryBefore,
)

PAGE = 200
"""Starts a page holds: each under 3 KB on the wire with its best vector at 16 states (98
parameters), inside the page's 1 MiB (ADR-0009)."""

_STATES: dict[str, StartState] = {
    "pending": "waiting",
    "sent": "queued",
    "running": "running",
    "finished": "finished",
    "failed": "failed",
    "canceled": "canceled",
}
"""The wire's word for each of the runs database's start states."""

_END_REASON = "CASE WHEN {0}.overflowed THEN 'overflow' ELSE {0}.end_reason END"
"""A try's end reason: the runs database keeps an overflowed one's as 'budget', for older engines
(migration 25)."""

_SUMMARY = (
    "s.start_index",
    "s.state",
    "s.try",
    "t.cause",
    _END_REASON.format("t"),
    "t.train_rmse",
    "t.val_rmse",
    "t.live_generation",
    "t.live_evaluations",
    "t.live_train_rmse",
    "t.live_val_rmse",
    "t.evaluations",
    "t.elapsed_s",
    "t.still_improving",
    "t.best",
    "t.try",
    "t.engine",
    "t.cpus",
    "t.memory_mb",
    "t.time_limit_min",
    "t.array",
    "t.array_task",
    "t.array_job_id",
    "t.job_id",
    "t.node",
    "t.peak_memory_mb",
    "t.exit_code",
    "t.scheduler_state",
    "t.sent_at",
    "t.started_at",
    "t.ended_at",
)
"""What a start's row shows, in `_summary`'s order."""

_RESULT = (
    "s.seed",
    "s.start_point",
    "t.generations",
    "t.cost",
    "t.val_cost",
    "t.train_sse",
    "t.train_points",
    "t.train_failed",
    "t.val_sse",
    "t.val_points",
    "t.val_failed",
    "t.still_improving_change",
    f"(SELECT json_group_array(json_array(x.try, x.cause, {_END_REASON.format('x')}, x.node, "
    "x.scheduler_state, x.exit_code, x.started_at, x.ended_at)) FROM start_tries x "
    "WHERE x.run_id = s.run_id AND x.graph = s.graph AND x.open_state = s.open_state "
    "AND x.start_index = s.start_index)",
)
"""What a start shows besides, in `read`'s order."""

_LATEST_TRY = (
    "LEFT JOIN start_tries t ON t.run_id = s.run_id AND t.graph = s.graph "
    "AND t.open_state = s.open_state AND t.start_index = s.start_index AND t.try = s.try"
)

_TRY_BEFORE = (
    "LEFT JOIN start_tries b ON b.run_id = s.run_id AND b.graph = s.graph "
    "AND b.open_state = s.open_state AND b.start_index = s.start_index AND b.try = s.try - 1"
)
_BEFORE = ("b.try", "b.cause", "b.node", "b.scheduler_state", "b.exit_code")
"""How the try before the latest ended, in `read`'s order."""

_TOP_AT = len(_SUMMARY) + len(_RESULT) + 2 + len(_BEFORE)
"""Where `read`'s Top 10 columns begin."""


class NotFoundError(Exception):
    """No such run, topology, start or try: deleted, never submitted, or not listed yet."""


@dataclass(frozen=True)
class TryFiles:
    """Where a start's try writes, and how its run sent it."""

    try_number: int
    """0 for a start that hasn't gone out, which has no files."""
    log: Path | None
    snapshot: Path | None
    job_logs: tuple[Path, ...]
    """Where the scheduler may have put its output: SLURM's name, then This computer's."""
    ended: bool
    """The try has ended, or there's none."""


def list_page(
    conn: sqlite3.Connection, run: int, graph: int, open_state: int, after: str | None
) -> tuple[list[StartSummary], str | None]:
    """A page of the topology's starts by index, and the next page's cursor; one query, which
    walks the starts' key from the cursor. `ValueError` for a cursor this didn't give,
    `NotFoundError` for a topology the run hasn't listed."""
    bound = _cursor(after)
    where = (run, graph, open_state)
    rows = conn.execute(
        "WITH page AS (SELECT start_index FROM starts WHERE run_id = ? AND graph = ? "
        "AND open_state = ? AND start_index > ? ORDER BY start_index LIMIT ?) "
        f"SELECT p.start_index, {', '.join(_SUMMARY)} FROM topologies tp "
        "JOIN runs r ON r.id = tp.run_id AND r.deleted_at IS NULL LEFT JOIN page p "
        "LEFT JOIN starts s ON s.run_id = tp.run_id AND s.graph = tp.graph "
        f"AND s.open_state = tp.open_state AND s.start_index = p.start_index {_LATEST_TRY} "
        "WHERE tp.run_id = ? AND tp.graph = ? AND tp.open_state = ? ORDER BY p.start_index",
        (*where, bound, PAGE + 1, *where),
    ).fetchall()
    if not rows:
        raise NotFoundError
    found = [row[1:] for row in rows if row[0] is not None]
    page = [_summary(row) for row in found[:PAGE]]
    return page, f"s {found[PAGE - 1][0]}" if len(found) > PAGE else None


def progress_page(
    conn: sqlite3.Connection, run: int, graph: int, open_state: int, after: str | None
) -> tuple[list[StartCurve], str | None]:
    """A page of the topology's **Progress curves** by start, each of its latest try, and the
    next page's cursor; one query, which walks the tries that have one from the cursor, so
    starts that haven't run cost it nothing. `ValueError` for a cursor this didn't give,
    `NotFoundError` for a topology the run hasn't listed."""
    bound = _cursor(after)
    where = (run, graph, open_state)
    rows = conn.execute(
        "WITH page AS (SELECT s.start_index, s.state, t.curve FROM start_tries t "
        "INDEXED BY start_tries_curves JOIN starts s ON s.run_id = t.run_id "
        "AND s.graph = t.graph AND s.open_state = t.open_state "
        "AND s.start_index = t.start_index AND s.try = t.try "
        "WHERE t.run_id = ? AND t.graph = ? AND t.open_state = ? AND t.start_index > ? "
        "AND t.curve IS NOT NULL ORDER BY t.start_index LIMIT ?) "
        "SELECT p.start_index, p.state, p.curve FROM topologies tp "
        "JOIN runs r ON r.id = tp.run_id AND r.deleted_at IS NULL LEFT JOIN page p "
        "WHERE tp.run_id = ? AND tp.graph = ? AND tp.open_state = ? ORDER BY p.start_index",
        (*where, bound, PAGE + 1, *where),
    ).fetchall()
    if not rows:
        raise NotFoundError
    found = [row for row in rows if row[0] is not None]
    page = [
        StartCurve(start=start, state=_STATES[state], **json.loads(curve))
        for start, state, curve in found[:PAGE]
    ]
    return page, f"s {found[PAGE - 1][0]}" if len(found) > PAGE else None


def read(conn: sqlite3.Connection, run: int, graph: int, open_state: int, start: int) -> Start:
    """The start, with its result in full, its Start log's path and its topology's Top 10, in one
    query; `NotFoundError` for one the run doesn't hold."""
    from icmm.coordinator import files
    from icmm.topology import TopologyId

    where = (run, graph, open_state)
    rows = conn.execute(
        f"WITH {TOP} SELECT {', '.join(_SUMMARY)}, {', '.join(_RESULT)}, r.output_folder, m.value, "
        f"{', '.join(_BEFORE)}, top.start, top.train_rmse, top.val_rmse, top.best "
        "FROM starts s JOIN runs r ON r.id = s.run_id AND r.deleted_at IS NULL "
        f"JOIN meta m ON m.key = 'feed' {_LATEST_TRY} {_TRY_BEFORE} LEFT JOIN top "
        "WHERE s.run_id = ? AND s.graph = ? AND s.open_state = ? AND s.start_index = ? "
        "ORDER BY top.train_rmse, top.start",
        (*where, TOP_10, *where, start),
    ).fetchall()
    if not rows:
        raise NotFoundError
    first = rows[0]
    summary = _summary(first)
    (
        seed,
        start_point,
        generations,
        cost,
        val_cost,
        train_sse,
        train_points,
        train_failed,
        val_sse,
        val_points,
        val_failed,
        still_improving_change,
        tries,
        output_folder,
        feed,
    ) = first[len(_SUMMARY) : len(_SUMMARY) + len(_RESULT) + 2]
    had_before, cause_before, *ended_before = first[_TOP_AT - len(_BEFORE) : _TOP_AT]
    log = job_log = None
    if summary.try_number:
        folder = files.run_folder(output_folder, run, feed)
        task = files.start_task(folder, TopologyId(graph, open_state), start, summary.try_number)
        log = str(task.log)
        ran = summary.ran_with
        if ran is not None:
            # A SLURM try asks for a time limit; This computer's asks for none (`sweep`).
            path = files.job_log(
                folder, ran.array, ran.array_task, ran.array_job_id, ran.time_limit_min is not None
            )
            job_log = None if path is None else str(path)
    return Start(
        **dict(summary),
        seed=seed,
        start_point=_json(start_point),
        generations=generations,
        cost=cost,
        val_cost=val_cost,
        train_sse=_json(train_sse),
        train_points=_json(train_points),
        train_failed=_json(train_failed),
        val_sse=_json(val_sse),
        val_points=_json(val_points),
        val_failed=_json(val_failed),
        still_improving_change=still_improving_change,
        log=log,
        job_log=job_log,
        top_10=top_10(row[_TOP_AT:] for row in rows),
        before=None
        if had_before is None
        else TryBefore(
            cause=None if cause_before is None else StartCause(cause_before),
            **dict(zip(("node", "scheduler_state", "exit_code"), ended_before, strict=True)),
        ),
        tries=sorted(map(_try, json.loads(tries)), key=lambda t: t.try_number),
    )


def _try(row: list[Any]) -> StartTry:
    fields = dict(zip(_TRY, row, strict=True))
    cause = fields.pop("cause")
    return StartTry(cause=None if cause is None else StartCause(cause), **fields)


_TRY = (
    "try_number",
    "cause",
    "end_reason",
    "node",
    "scheduler_state",
    "exit_code",
    "started_at",
    "ended_at",
)
"""A try's fields, in `read`'s `json_array` order."""


def try_files(
    conn: sqlite3.Connection,
    run: int,
    graph: int,
    open_state: int,
    start: int,
    try_number: int | None,
) -> TryFiles:
    """Where try `try_number` of the start writes, its latest with `None`, in one query;
    `NotFoundError` for a start the run doesn't hold, or a try it hasn't had."""
    from icmm.coordinator import files
    from icmm.topology import TopologyId

    row = conn.execute(
        "SELECT s.try, t.try, t.ended_at IS NOT NULL, t.array, t.array_task, t.array_job_id, "
        "r.output_folder, m.value FROM starts s "
        "JOIN runs r ON r.id = s.run_id AND r.deleted_at IS NULL JOIN meta m ON m.key = 'feed' "
        "LEFT JOIN start_tries t ON t.run_id = s.run_id AND t.graph = s.graph "
        "AND t.open_state = s.open_state AND t.start_index = s.start_index "
        "AND t.try = COALESCE(?, s.try) "
        "WHERE s.run_id = ? AND s.graph = ? AND s.open_state = ? AND s.start_index = ?",
        (try_number, run, graph, open_state, start),
    ).fetchone()
    if row is None:
        raise NotFoundError
    latest, found, ended, array, task, job_id, output_folder, feed = row
    if found is None:
        if try_number is None and latest == 0:
            return TryFiles(0, None, None, (), True)
        raise NotFoundError
    folder = files.run_folder(output_folder, run, feed)
    where = files.start_task(folder, TopologyId(graph, open_state), start, found)
    job_logs = () if array is None else files.job_logs(folder, array, task, job_id)
    return TryFiles(found, where.log, where.snapshot, job_logs, bool(ended))


def _summary(row: tuple[Any, ...]) -> StartSummary:
    (
        start,
        state,
        try_number,
        cause,
        end_reason,
        train_rmse,
        val_rmse,
        live_generation,
        live_evaluations,
        live_train_rmse,
        live_val_rmse,
        evaluations,
        elapsed_s,
        still_improving,
        best,
        had_try,
        *ran_with,
    ) = row[: len(_SUMMARY)]
    return StartSummary(
        start=start,
        state=_STATES[state],
        try_number=try_number,
        cause=None if cause is None else StartCause(cause),
        end_reason=end_reason,
        train_rmse=train_rmse,
        val_rmse=val_rmse,
        so_far=StartProgress(
            generation=live_generation,
            evaluations=live_evaluations,
            train_rmse=live_train_rmse,
            val_rmse=live_val_rmse,
        )
        if state == "running" and live_generation is not None
        else None,
        evaluations=evaluations,
        elapsed_s=elapsed_s,
        still_improving=None if still_improving is None else bool(still_improving),
        best=_json(best),
        ran_with=None
        if had_try is None
        else RanWith(**dict(zip(_RAN_WITH, ran_with, strict=True))),
    )


_RAN_WITH = tuple(column.removeprefix("t.") for column in _SUMMARY[_SUMMARY.index("t.engine") :])


def _json(text: str | None) -> Any:
    return None if text is None else json.loads(text)


def _cursor(after: str | None) -> int:
    if after is None:
        return -1
    kind, _, key = after.partition(" ")
    if kind != "s" or not key.isascii() or not key.isdigit() or int(key) >= 2**63:
        raise ValueError(f"not a cursor: {after!r}")
    return int(key)
