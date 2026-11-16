"""Runs in the runs database (ADR-0016, ADR-0019): what Submit records, and what Runs reads.

Submit records what a run fits, and nothing changes it after. The run's coordinator keeps the
rest on the run's row as its starts move: its state, stage times, counts, best so far and end,
so each read is one query, a row per run (old ADR-0012, ADR-0014). A run shows its config's name
and its dataset's name as they are now, and nothing else of either.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from icmm import stretches
from icmm.db import append_change, now
from icmm.wire.dataset import Template
from icmm.wire.run import (
    DatasetBest,
    EndedRun,
    Run,
    RunBest,
    RunConfig,
    RunCounts,
    RunDataset,
    RunFailure,
    RunHold,
    RunProgress,
    RunProtocol,
    RunQueued,
    RunResuming,
    RunsDataset,
    RunsOverview,
    RunSpace,
    RunStop,
    RunSummary,
    RunTiming,
)
from icmm.wire.simulation import ProtocolScore
from icmm.wire.start import CoordinatingJob

TOPIC = "runs"
PAGE = 200
"""Runs a list page holds: about 1 KB each on the wire, inside its 1 MiB (ADR-0009)."""
SCAN = 1000
"""Runs a filtered page walks at most, however few match: the rest are the next page's."""
ENDED = 50
"""The most ended runs `ended_since` answers."""
COORDINATING_JOBS = 256
"""The most coordinating jobs a run's list holds: each about 200 bytes on the wire."""
_MAX_KEY = 2**63 - 1

_SCORES = ("train_sse", "val_sse", "train_points", "train_failed", "val_points", "val_failed")
"""A try's stored scores, each a list by protocol, in `ProtocolScore`'s order."""

_SUMMARY = (
    "r.id",
    "r.config_id",
    "c.name",
    "c.deleted_at IS NOT NULL",
    "r.dataset_id",
    "d.name",
    "r.dataset_revision",
    "d.id IS NULL OR d.current_revision IS NULL OR d.deleted_at IS NOT NULL",
    "pin.scoring_digest IS NOT cur.scoring_digest",
    "r.num_states",
    "r.state",
    "r.hold",
    "r.hold_reason",
    "r.held_since",
    "r.has_validation",
    "r.topologies",
    "r.topologies_complete",
    "r.topologies_failed",
    "r.starts",
    "r.starts_finished",
    "r.starts_failed",
    "r.starts_running",
    "r.starts_queued",
    "r.starts_held",
    "r.best_graph",
    "r.best_open_state",
    "r.best_train_rmse",
    "r.best_val_rmse",
    "r.failure",
    "r.canceling_since",
    "r.resuming",
    "r.submitted_at",
    "r.ended_at",
    "(SELECT COUNT(*) FROM topologies f INDEXED BY topologies_fitting "
    "WHERE f.run_id = r.id AND f.state = 'fitting')",
    "r.queued_reason",
    "r.state_since",
    "r.space_folder",
    "r.space_free",
    "r.space_carries_on",
    "r.relaunched_at",
    "r.starts_still_improving",
    "r.starts_stopped",
    "r.first_running_at",
    "r.stops",
    "bt.best_start",
    *(f"ba.{column}" for column in _SCORES),
)
"""What a summary reads, in `_summary`'s order."""

_JOINS = (
    "LEFT JOIN configs c ON c.id = r.config_id "
    "LEFT JOIN datasets d ON d.id = r.dataset_id "
    "LEFT JOIN dataset_revisions pin "
    "ON pin.dataset_id = r.dataset_id AND pin.revision = r.dataset_revision "
    "LEFT JOIN dataset_revisions cur "
    "ON cur.dataset_id = d.id AND cur.revision = d.current_revision "
    "LEFT JOIN topologies bt "
    "ON bt.run_id = r.id AND bt.graph = r.best_graph AND bt.open_state = r.best_open_state "
    "LEFT JOIN starts bs ON bs.run_id = r.id AND bs.graph = r.best_graph "
    "AND bs.open_state = r.best_open_state AND bs.start_index = bt.best_start "
    "LEFT JOIN start_tries ba ON ba.run_id = r.id AND ba.graph = r.best_graph "
    "AND ba.open_state = r.best_open_state AND ba.start_index = bt.best_start AND ba.try = bs.try"
)
"""What a summary shows of the run's config and dataset, and of its best topology's **Best
start**, each by its key. A config's row outlives its delete, as its tombstone (ADR-0016), so
every run has one."""


class NotFoundError(Exception):
    """No such run: deleted, or never submitted."""


class NoGenerationError(Exception):
    """The run's coordinator has had no such generation."""


@dataclass(frozen=True)
class Pinned:
    """What a run fits, as Submit found it: nothing changes it after."""

    config_id: str
    config_revision: int
    format: int
    settings: str
    """The config's settings as saved, as JSON."""
    num_states: int
    topologies: int
    starts: int
    dataset_id: str
    dataset_revision: int
    has_validation: bool
    search_seed: int
    output_folder: str
    engine: str | None


def coordinator_ended(
    conn: sqlite3.Connection, run: int, generation: int, exit_code: int | None, *, own: bool
) -> None:
    """Records that generation `generation` of the run's coordinator ended, with its exit code:
    as it says itself (`own`), or else as whoever found it gone first, leaving what's recorded
    alone. `exit_code` is `None` when the scheduler keeps none."""
    if own:
        updated = conn.execute(
            "UPDATE coordinators SET ended_at = ?, exit_code = ? "
            "WHERE run_id = ? AND generation = ?",
            (now(), exit_code, run, generation),
        ).rowcount
    else:
        # Only what it adds, so a dispatcher asking every pass changes nothing more.
        updated = conn.execute(
            "UPDATE coordinators SET ended_at = COALESCE(ended_at, ?), "
            "exit_code = COALESCE(exit_code, ?) WHERE run_id = ? AND generation = ? "
            "AND (ended_at IS NULL OR (exit_code IS NULL AND ? IS NOT NULL))",
            (now(), exit_code, run, generation, exit_code),
        ).rowcount
    if updated:
        append_change(conn, TOPIC, str(run))


def coordinating_jobs(conn: sqlite3.Connection, run: int) -> list[CoordinatingJob]:
    """The run's latest coordinating jobs that began or ended, the latest first, in one query;
    `NotFoundError` for a run gone."""
    rows = conn.execute(
        "SELECT c.generation, COALESCE(c.job_id, c.claimed_by), c.claimed_at, c.ended_at, "
        "c.exit_code, c.progressed FROM runs r LEFT JOIN coordinators c ON c.run_id = r.id "
        "AND (c.claimed_at IS NOT NULL OR c.ended_at IS NOT NULL) "
        "WHERE r.id = ? AND r.deleted_at IS NULL ORDER BY c.generation DESC LIMIT ?",
        (run, COORDINATING_JOBS),
    ).fetchall()
    if not rows:
        raise NotFoundError
    return [
        CoordinatingJob(
            generation=generation,
            job_id=job_id,
            started_at=started_at,
            ended_at=ended_at,
            exit_code=exit_code,
            progressed=bool(progressed),
        )
        for generation, job_id, started_at, ended_at, exit_code, progressed in rows
        if generation is not None
    ]


def coordinator_log(conn: sqlite3.Connection, run: int, generation: int) -> Path:
    """Where generation `generation` of the run's coordinator writes its log; `NotFoundError`
    for a run gone, `NoGenerationError` for a generation it hasn't had."""
    from icmm.coordinator import files

    row = conn.execute(
        "SELECT r.output_folder, m.value, c.generation FROM runs r JOIN meta m ON m.key = 'feed' "
        "LEFT JOIN coordinators c ON c.run_id = r.id AND c.generation = ? "
        "WHERE r.id = ? AND r.deleted_at IS NULL",
        (generation, run),
    ).fetchone()
    if row is None:
        raise NotFoundError
    output_folder, feed, found = row
    if found is None:
        raise NoGenerationError
    return files.coordinator_log(files.run_folder(output_folder, run, feed), generation)


def still_current(conn: sqlite3.Connection, pinned: Pinned) -> bool:
    """Whether the config and its dataset are still as Submit checked them, in the caller's
    transaction."""
    row = conn.execute(
        "SELECT c.revision, d.current_revision FROM configs c "
        "LEFT JOIN datasets d ON d.id = ? AND d.deleted_at IS NULL "
        "WHERE c.id = ? AND c.deleted_at IS NULL",
        (pinned.dataset_id, pinned.config_id),
    ).fetchone()
    return row is not None and tuple(row) == (pinned.config_revision, pinned.dataset_revision)


def record(conn: sqlite3.Connection, request_key: str, pinned: Pinned) -> int:
    """Records a run of `pinned`, Queued, with its change row, in the caller's write transaction;
    answers its number, which no other run has had. Its folder's bytes count from 0, and its
    **Stretches** (`icmm.stretches`) are a minute each."""
    cursor = conn.execute(
        "INSERT INTO runs (request_key, config_id, config_revision, dataset_id, dataset_revision, "
        "format, settings, num_states, has_validation, search_seed, output_folder, engine, "
        "topologies, starts, state, submitted_at, folder_bytes, stretch_s) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?)",
        (
            request_key,
            pinned.config_id,
            pinned.config_revision,
            pinned.dataset_id,
            pinned.dataset_revision,
            pinned.format,
            pinned.settings,
            pinned.num_states,
            int(pinned.has_validation),
            pinned.search_seed,
            pinned.output_folder,
            pinned.engine,
            pinned.topologies,
            pinned.starts,
            now(),
            stretches.FIRST_S,
        ),
    )
    assert cursor.lastrowid is not None
    append_change(conn, TOPIC, str(cursor.lastrowid))
    return cursor.lastrowid


def end(
    conn: sqlite3.Connection,
    run_id: int,
    state: Literal["completed", "failed", "canceled"],
    failure: RunFailure | None = None,
) -> None:
    """Ends the run, with its change row, whose seq it keeps, in the caller's write transaction:
    `ended_since` reads that range (#229). A run that's resumed clears both. Any Cancel run of it
    still unfinished has succeeded: there's nothing left of it to cancel."""
    ended = now()
    conn.execute(
        "UPDATE runs SET state = ?, failure = ?, hold = NULL, hold_reason = NULL, "
        "held_since = NULL, queued_reason = NULL, space_folder = NULL, space_free = NULL, "
        "space_carries_on = NULL, state_since = ?, starts_running = 0, starts_queued = 0, "
        "starts_held = 0, canceling_since = NULL, resuming = NULL, ended_at = ?, end_seq = ? "
        "WHERE id = ?",
        (
            state,
            None if failure is None else failure.model_dump_json(),
            ended,
            ended,
            append_change(conn, TOPIC, str(run_id)),
            run_id,
        ),
    )
    finish_requests(conn, "cancel_run", run_id)


class StateError(Exception):
    """The run isn't in a state the request can act on: `reason` says which."""

    def __init__(self, reason: Literal["run_ended", "run_in_flight", "run_completed"]) -> None:
        super().__init__(reason)
        self.reason = reason


def cancel(conn: sqlite3.Connection, run_id: int) -> None:
    """Records a Cancel run of a run in flight, with its change row, in the caller's write
    transaction: it shows Canceling from the first cancel accepted until it ends. Its coordinator,
    or `icmm cleanup` where none carries it, does the rest (`icmm.coordinator.sweep`).
    `NotFoundError` for a run deleted or never submitted; `StateError` for one that has ended."""
    row = conn.execute(
        "SELECT end_seq IS NOT NULL FROM runs WHERE id = ? AND deleted_at IS NULL", (run_id,)
    ).fetchone()
    if row is None:
        raise NotFoundError
    if row[0]:
        raise StateError("run_ended")
    conn.execute(
        "UPDATE runs SET canceling_since = COALESCE(canceling_since, ?) WHERE id = ?",
        (now(), run_id),
    )
    append_change(conn, TOPIC, str(run_id))


def tombstone(conn: sqlite3.Connection, run_id: int) -> None:
    """Deletes a run that has ended, with its change row, in the caller's write transaction: it
    leaves every list and read at once, and `icmm cleanup` removes its jobs, files and rows after
    (ADR-0009). `NotFoundError` for a run already deleted or never submitted; `StateError` for one
    in flight."""
    row = conn.execute(
        "SELECT end_seq IS NULL FROM runs WHERE id = ? AND deleted_at IS NULL", (run_id,)
    ).fetchone()
    if row is None:
        raise NotFoundError
    if row[0]:
        raise StateError("run_in_flight")
    conn.execute("UPDATE runs SET deleted_at = ? WHERE id = ?", (now(), run_id))
    append_change(conn, TOPIC, str(run_id))


def reopen(
    conn: sqlite3.Connection, run_id: int, engine: str | None, data_folder: Path
) -> str | None:
    """Resumes a failed or canceled run, in the caller's write transaction: it's in flight again,
    Queued, with its failed and canceled starts waiting to go out as their next try, its topologies
    and counts taken back to match, and its next generation recorded for the lifecycle dispatcher
    to launch (ADR-0019). Nothing that stopped it is kept: its failure, why it stopped sending, its
    failed starts in a row, its generations without progress, why and since when it last waited,
    when it was last relaunched. Its finished starts, best and spread stay. `engine` replaces the
    run's own engine where that's no longer installed, or is below the floor (ADR-0020); answers
    the engine it fits on from here. `NotFoundError` for a run deleted or never submitted;
    `StateError` for one in flight or completed."""
    from icmm import bundle, engines
    from icmm.coordinator import files
    from icmm.db import feed_id

    row = conn.execute(
        "SELECT state, end_seq IS NULL, ended_at, engine FROM runs "
        "WHERE id = ? AND deleted_at IS NULL",
        (run_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError
    state, in_flight, ended_at, own = row
    if in_flight:
        raise StateError("run_in_flight")
    if state == "completed":
        raise StateError("run_completed")
    since = now()
    unfinished = conn.execute(
        "SELECT graph, open_state, SUM(state = 'failed') FROM starts "
        "WHERE run_id = ? AND state IN ('failed', 'canceled') GROUP BY graph, open_state",
        (run_id,),
    ).fetchall()
    reopened = {"complete": 0, "failed": 0}
    for graph, open_state, failed in unfinished:
        where = (run_id, graph, open_state)
        (was, ended) = conn.execute(
            "SELECT state, last_ended_at FROM topologies "
            "WHERE run_id = ? AND graph = ? AND open_state = ?",
            where,
        ).fetchone()
        if was in reopened:
            reopened[was] += 1
        if was == "complete":
            stretches.take_back(conn, run_id, ended)
        conn.execute(
            "UPDATE topologies SET starts_failed = starts_failed - ?, state = CASE "
            "WHEN state IN ('complete', 'failed') THEN 'fitting' ELSE state END "
            "WHERE run_id = ? AND graph = ? AND open_state = ?",
            (failed, *where),
        )
    conn.execute(
        "UPDATE starts SET state = 'pending' WHERE run_id = ? AND state IN ('failed', 'canceled')",
        (run_id,),
    )
    (generation,) = conn.execute(
        "SELECT COALESCE(MAX(generation), 0) + 1 FROM coordinators WHERE run_id = ?", (run_id,)
    ).fetchone()
    conn.execute(
        "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
        (run_id, generation, files.identity(feed_id(conn), run_id, "c", generation)),
    )
    usable = bundle.installed(data_folder, own) and not engines.below_floor(conn, own)
    fits = own if usable else engine
    resuming = RunResuming(since=since, ended=state, ended_at=ended_at)
    conn.execute(
        "UPDATE runs SET state = 'queued', failure = NULL, stopping = NULL, hold = NULL, "
        "hold_reason = NULL, held_since = NULL, failed_in_a_row = 0, stalled_generations = 0, "
        "starts_failed = starts_failed - ?, topologies_complete = topologies_complete - ?, "
        "topologies_failed = topologies_failed - ?, ended_at = NULL, end_seq = NULL, "
        "queued_reason = NULL, state_since = ?, relaunched_at = NULL, resuming = ?, "
        "resumed_generation = ?, engine = ?, first_running_at = NULL, stops = json_insert(stops, "
        "'$[#]', json_object('ended', state, 'ended_at', ended_at, "
        "'starts_finished', starts_finished, 'topologies_complete', topologies_complete, "
        "'starts_stopped', starts_stopped, 'failure', json(failure), 'resumed_at', ?, "
        "'ran_from', first_running_at)), starts_stopped = 0 WHERE id = ?",
        (
            sum(failed for *_, failed in unfinished),
            reopened["complete"],
            reopened["failed"],
            since,
            resuming.model_dump_json(),
            generation,
            fits,
            since,
            run_id,
        ),
    )
    append_change(conn, TOPIC, str(run_id))
    return fits


def finish_requests(conn: sqlite3.Connection, method: str, run_id: int) -> None:
    """Records every unfinished `method` request of the run as succeeded, in the caller's write
    transaction: their effect has landed (ADR-0009)."""
    conn.execute(
        "UPDATE requests INDEXED BY requests_unfinished SET status = 'succeeded', "
        "finished_at = ? WHERE method = ? AND status IN ('accepted', 'acting', "
        "'reconciliation_required') AND json_extract(params, '$.id') = ?",
        (now(), method, run_id),
    )


def _running(running: str | None, stops: list[dict[str, Any]]) -> dict[str, Any]:
    """`first_running_at` and `stops` as a summary says them, from how the runs DB keeps them:
    each stop with when the stretch of fitting it ended began (`ran_from`), and
    `first_running_at` the current stretch's. Resume clears it, so the coordinator, of any
    engine, sets it again when a start next runs (#326). A stop an engine recorded before #324
    has no progress or failure."""
    began = [stop["ran_from"] for stop in stops] + [running]
    return {
        "first_running_at": next((at for at in began if at is not None), None),
        "stops": [
            RunStop(
                ended=stop["ended"],
                ended_at=stop["ended_at"],
                starts_finished=stop.get("starts_finished"),
                topologies_complete=stop.get("topologies_complete"),
                starts_stopped=stop.get("starts_stopped"),
                failure=None
                if stop.get("failure") is None
                else RunFailure.model_validate(stop["failure"], strict=False),
                resumed_at=stop["resumed_at"],
                running_at=began[i + 1],
            )
            for i, stop in enumerate(stops)
        ],
    }


def read(conn: sqlite3.Connection, run_id: int, data_folder: Path) -> Run:
    """The run `run_id`, in one query, and whether its engine is still installed, in one look at
    the Data folder; `NotFoundError` for one deleted or never submitted."""
    from icmm import bundle, config, engines, folders
    from icmm.coordinator import files

    row = conn.execute(
        f"SELECT {', '.join(_SUMMARY)}, r.format, r.settings, r.search_seed, r.output_folder, "
        "r.engine, r.claimed_at, r.topologies_listed_at, r.first_array_at, r.folder_bytes, "
        "(SELECT value FROM meta WHERE key = 'feed'), pin.protocols "
        f"FROM runs r {_JOINS} WHERE r.id = ? AND r.deleted_at IS NULL",
        (run_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError
    (
        format,
        settings,
        seed,
        output_folder,
        engine,
        claimed,
        listed,
        sent,
        written,
        feed,
        protocols,
    ) = row[len(_SUMMARY) :]
    try:
        fits = None if format > config.FORMAT else config.read_config(json.loads(settings))
    except (ValueError, config.UnreadableConfig):
        fits = None
    return Run(
        **dict(_summary(row)),
        settings=fits,
        search_seed=seed,
        output_folder=output_folder,
        folder=folders.from_home(str(files.run_folder(output_folder, run_id, feed))),
        engine=engine,
        engine_installed=bundle.installed(data_folder, engine)
        and not engines.below_floor(conn, engine),
        claimed_at=claimed,
        topologies_listed_at=listed,
        first_array_at=sent,
        protocols=[
            RunProtocol(name=p["name"], template=Template(p["template"]))
            for p in json.loads(protocols or "[]")
        ],
        folder_bytes=written or None,
    )


def list_page(
    conn: sqlite3.Connection,
    filter: str | None,
    after: str | None,
    *,
    dataset: str | None = None,
    config: str | None = None,
) -> tuple[list[RunSummary], str | None]:
    """A page of the platform's runs, in flight newest first, then ended, the latest end first,
    and the next page's cursor: `i <id>` within those in flight, `e <end seq>` within those ended.

    One query, which walks each section's index from the cursor, so a page's work doesn't grow
    with the runs it doesn't show. A filter matches each run walked by its number, or its config's
    or dataset's name, and walks at most `SCAN` runs a page: past them, the page holds what it
    found, maybe nothing, and its cursor goes on from the last run walked. `ValueError` for a
    cursor this didn't give. `dataset` and `config` keep the runs of that dataset or config,
    with the filter's, walking as a filter does.
    """
    section, bound = _cursor(after)
    number, text = _filter(filter)
    named = number is not None or text is not None
    filtered = named or dataset is not None or config is not None
    walk = SCAN if filtered else PAGE + 1
    sections = []
    args: list[Any] = []
    if section != "e":
        sections.append(
            "SELECT * FROM (SELECT id, 0, id FROM runs INDEXED BY runs_in_flight "
            "WHERE end_seq IS NULL AND deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?)"
        )
        args += [bound if section == "i" else _MAX_KEY, walk]
    sections.append(
        "SELECT * FROM (SELECT id, 1, end_seq FROM runs INDEXED BY runs_ended "
        "WHERE end_seq IS NOT NULL AND deleted_at IS NULL AND end_seq < ? "
        "ORDER BY end_seq DESC LIMIT ?)"
    )
    args += [bound if section == "e" else _MAX_KEY, walk]
    match = (
        "((? IS NOT NULL AND r.id = ?) "
        "OR (? IS NOT NULL AND (instr(c.name_key, ?) > 0 OR instr(d.name_key, ?) > 0)) "
        "OR NOT ?) AND (? IS NULL OR r.dataset_id = ?) AND (? IS NULL OR r.config_id = ?)"
        if filtered
        else "TRUE"
    )
    matched = (
        (number, number, text, text, text, named, dataset, dataset, config, config)
        if filtered
        else ()
    )
    # The walk, then its last run and length, then the runs in it that match with what their
    # summaries show: a walk with no match still answers a row, for its cursor to go on from.
    rows = conn.execute(
        f"WITH walked (id, section, k) AS (SELECT * FROM ({' UNION ALL '.join(sections)}) "
        "ORDER BY 2, 3 DESC LIMIT ?), "
        "walk_end (section, k, walked) AS (SELECT section, k, (SELECT COUNT(*) FROM walked) "
        "FROM walked ORDER BY section DESC, k LIMIT 1), "
        "hits (id, section, k) AS (SELECT w.id, w.section, w.k FROM walked w "
        "JOIN runs r ON r.id = w.id JOIN configs c ON c.id = r.config_id "
        f"LEFT JOIN datasets d ON d.id = r.dataset_id WHERE {match} "
        "ORDER BY w.section, w.k DESC LIMIT ?) "
        f"SELECT {', '.join(_SUMMARY)}, h.section, h.k, e.section, e.k, e.walked "
        f"FROM walk_end e LEFT JOIN hits h LEFT JOIN runs r ON r.id = h.id {_JOINS} "
        "ORDER BY h.section, h.k DESC",
        (*args, walk, *matched, PAGE + 1),
    ).fetchall()
    found = [row for row in rows if row[0] is not None]
    page = [_summary(row) for row in found[:PAGE]]
    if len(found) > PAGE:
        hit_section, hit_key = found[PAGE - 1][len(_SUMMARY) : len(_SUMMARY) + 2]
        return page, _position(hit_section, hit_key)
    if filtered and rows and rows[0][-1] == walk:
        end_section, end_key = rows[0][-3:-1]
        return page, _position(end_section, end_key)
    return page, None


def overview(conn: sqlite3.Connection) -> RunsOverview:
    """How many runs are in each state, and each dataset's runs and best ended runs on its
    current data, each named by its best topology's **Best start**, in one query: the runs
    grouped by dataset, then by nothing, and each best's topology by its key."""
    rows = conn.execute(
        "WITH ranked AS MATERIALIZED (SELECT r.dataset_id, r.end_seq, r.ended_at, r.id, "
        # A run canceling shows so until it ends, and its end clears `canceling_since`.
        "CASE WHEN r.canceling_since IS NULL THEN r.state ELSE 'canceling' END AS state, "
        "r.num_states, r.has_validation, r.best_graph, r.best_open_state, r.best_train_rmse, "
        "r.best_val_rmse, "
        "pin.scoring_digest IS NOT cur.scoring_digest OR cur.scoring_digest IS NULL AS earlier "
        "FROM runs r LEFT JOIN datasets d ON d.id = r.dataset_id AND d.deleted_at IS NULL "
        "LEFT JOIN dataset_revisions pin "
        "ON pin.dataset_id = r.dataset_id AND pin.revision = r.dataset_revision "
        "LEFT JOIN dataset_revisions cur "
        "ON cur.dataset_id = d.id AND cur.revision = d.current_revision "
        "WHERE r.deleted_at IS NULL), "
        "val AS (SELECT dataset_id, id, best_graph, best_open_state, num_states, "
        "best_val_rmse AS rmse, "
        "ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY best_val_rmse, id) AS n "
        "FROM ranked WHERE end_seq IS NOT NULL AND NOT earlier AND has_validation "
        "AND best_val_rmse IS NOT NULL), "
        "train AS (SELECT dataset_id, id, best_graph, best_open_state, num_states, "
        "best_train_rmse AS rmse, "
        "ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY best_train_rmse, id) AS n "
        "FROM ranked WHERE end_seq IS NOT NULL AND NOT earlier AND NOT has_validation "
        "AND best_train_rmse IS NOT NULL), "
        "grouped AS (SELECT dataset_id, COUNT(*) AS runs, SUM(earlier) AS earlier, "
        "SUM(end_seq IS NULL) AS in_flight, "
        "SUM(state = 'running') AS running, SUM(state = 'canceling') AS canceling, "
        "SUM(state = 'queued') AS queued, "
        "SUM(state = 'held') AS held, SUM(end_seq IS NOT NULL) AS ended, "
        "SUM(state = 'failed') AS failed, SUM(state = 'canceled') AS canceled, "
        "MIN(ended_at) AS first_ended_at, MAX(id) AS latest FROM ranked GROUP BY dataset_id) "
        "SELECT g.dataset_id, d.name, d.id IS NULL OR d.deleted_at IS NOT NULL, g.runs, "
        "g.earlier, g.in_flight, v.id, v.best_graph, v.best_open_state, vt.best_start, "
        "v.num_states, v.rmse, t.id, t.best_graph, t.best_open_state, tt.best_start, "
        "t.num_states, t.rmse, "
        "g.running, g.canceling, g.queued, g.held, g.ended, g.failed, g.canceled, "
        "g.first_ended_at, g.latest "
        "FROM grouped g LEFT JOIN datasets d ON d.id = g.dataset_id "
        "LEFT JOIN val v ON v.dataset_id = g.dataset_id AND v.n = 1 "
        "LEFT JOIN train t ON t.dataset_id = g.dataset_id AND t.n = 1 "
        "LEFT JOIN topologies vt ON vt.run_id = v.id AND vt.graph = v.best_graph "
        "AND vt.open_state = v.best_open_state "
        "LEFT JOIN topologies tt ON tt.run_id = t.id AND tt.graph = t.best_graph "
        "AND tt.open_state = t.best_open_state "
        "ORDER BY d.name_key IS NULL, d.name_key, g.dataset_id"
    ).fetchall()
    datasets = []
    totals = [0] * 7
    first_ended: str | None = None
    for row in rows:
        dataset_id, name, deleted, runs, earlier, in_flight = row[:6]
        val, train, counts, first, latest = row[6:12], row[12:18], row[18:25], row[25], row[26]
        totals = [a + b for a, b in zip(totals, counts, strict=True)]
        if first is not None and (first_ended is None or first < first_ended):
            first_ended = first
        datasets.append(
            RunsDataset(
                id=dataset_id,
                name=name,
                deleted=bool(deleted),
                runs=runs,
                runs_earlier=runs if deleted else earlier,
                runs_in_flight=in_flight,
                latest_run=latest,
                best_val=None if deleted else _dataset_best(val),
                best_train=None if deleted else _dataset_best(train),
            )
        )
    running, canceling, queued, held, ended, failed, canceled = totals
    return RunsOverview(
        counts=RunCounts(
            running=running,
            canceling=canceling,
            queued=queued,
            held=held,
            ended=ended,
            failed=failed,
            canceled=canceled,
            first_ended_at=first_ended,
        ),
        datasets=datasets,
    )


def _dataset_best(row: Sequence[Any]) -> DatasetBest | None:
    """A dataset's best run, from its run, best topology, that topology's Best start, states and
    RMSE; `None` before one, or while its topology names no Best start."""
    run, graph, open_state, start, num_states, rmse = row
    if run is None or start is None:
        return None
    return DatasetBest(
        run=run, graph=graph, open_state=open_state, start=start, num_states=num_states, rmse=rmse
    )


def ended_since(conn: sqlite3.Connection, seq: int) -> tuple[str, int, int, list[EndedRun]]:
    """The feed's id and latest seq, how many runs' ends took a change row after `seq`, and the
    latest `ENDED` of them, latest first, in one query: the count walks the ended runs' index,
    and only the runs answered are read."""
    rows = conn.execute(
        "WITH since (id, end_seq) AS (SELECT id, end_seq FROM runs INDEXED BY runs_ended "
        "WHERE end_seq > ? AND deleted_at IS NULL), "
        "latest (id) AS (SELECT id FROM since ORDER BY end_seq DESC LIMIT ?) "
        "SELECT m.value, COALESCE(q.seq, 0), (SELECT COUNT(*) FROM since), "
        "r.id, r.config_id, c.name, c.deleted_at IS NOT NULL, r.state, r.ended_at "
        "FROM meta m LEFT JOIN sqlite_sequence q ON q.name = 'changes' "
        "LEFT JOIN latest l LEFT JOIN runs r ON r.id = l.id "
        "LEFT JOIN configs c ON c.id = r.config_id "
        "WHERE m.key = 'feed' ORDER BY r.end_seq DESC",
        (seq, ENDED),
    ).fetchall()
    feed, latest, count = rows[0][:3]
    ended = [
        EndedRun(
            id=id,
            config=RunConfig(id=config_id, name=name, deleted=bool(deleted)),
            state=state,
            ended_at=ended_at,
        )
        for *_, id, config_id, name, deleted, state, ended_at in rows
        if id is not None
    ]
    return feed, latest, count, ended


def timings(conn: sqlite3.Connection) -> list[RunTiming]:
    """The platform's finished starts summed by states and CPUs, in one query over a few rows
    per run."""
    return [
        RunTiming(
            num_states=states,
            cpus_per_start=cpus,
            runs=runs,
            starts=starts,
            evaluations=evaluations,
            elapsed_s=elapsed_s,
        )
        for states, cpus, runs, starts, evaluations, elapsed_s in conn.execute(
            "SELECT r.num_states, t.cpus, COUNT(*), SUM(t.starts), SUM(t.evaluations), "
            "SUM(t.elapsed_s) FROM run_timings t JOIN runs r ON r.id = t.run_id "
            "WHERE r.deleted_at IS NULL AND t.starts > 0 "
            "GROUP BY r.num_states, t.cpus ORDER BY r.num_states, t.cpus"
        )
    ]


def _summary(row: tuple[Any, ...]) -> RunSummary:
    (
        id,
        config_id,
        config_name,
        config_deleted,
        dataset_id,
        dataset_name,
        revision,
        dataset_deleted,
        rescored,
        num_states,
        state,
        hold,
        hold_reason,
        held_since,
        has_validation,
        topologies,
        topologies_complete,
        topologies_failed,
        starts,
        starts_finished,
        starts_failed,
        starts_running,
        starts_queued,
        starts_held,
        best_graph,
        best_open_state,
        best_train_rmse,
        best_val_rmse,
        failure,
        canceling_since,
        resuming,
        submitted_at,
        ended_at,
        topologies_fitting,
        queued_reason,
        state_since,
        space_folder,
        space_free,
        space_carries_on,
        relaunched_at,
        starts_still_improving,
        starts_stopped,
        running,
        stops,
        best_start,
        *scores,
    ) = row[: len(_SUMMARY)]
    return RunSummary(
        id=id,
        config=RunConfig(id=config_id, name=config_name, deleted=bool(config_deleted)),
        dataset=RunDataset(
            id=dataset_id,
            name=dataset_name,
            revision=revision,
            deleted=bool(dataset_deleted),
            earlier=not dataset_deleted and bool(rescored),
        ),
        num_states=num_states,
        state=state,
        held=None
        if hold is None or state != "held"
        else RunHold(
            kind=hold,
            reason=hold_reason,
            since=held_since or submitted_at,
            space=None
            if hold != "space" or space_folder is None
            else RunSpace(
                folder=space_folder,
                free_bytes=space_free or 0,
                carries_on_bytes=space_carries_on or 0,
            ),
        ),
        queued=None
        if state != "queued"
        else RunQueued(reason=queued_reason or None, since=state_since or submitted_at),
        relaunched_at=relaunched_at,
        validation=bool(has_validation),
        progress=RunProgress(
            topologies=topologies,
            topologies_complete=topologies_complete,
            topologies_failed=topologies_failed,
            topologies_fitting=topologies_fitting,
            starts=starts,
            starts_finished=starts_finished,
            starts_failed=starts_failed,
            starts_running=starts_running,
            starts_queued=starts_queued,
            starts_held=starts_held,
            starts_still_improving=starts_still_improving,
            starts_stopped=starts_stopped,
        ),
        best=None
        if best_graph is None or best_start is None
        else RunBest(
            graph=best_graph,
            open_state=best_open_state,
            start=best_start,
            train_rmse=best_train_rmse,
            val_rmse=best_val_rmse,
            scores=protocol_scores(scores),
        ),
        failure=None if failure is None else RunFailure.model_validate_json(failure),
        canceling=canceling_since,
        resuming=None if resuming is None else RunResuming.model_validate_json(resuming),
        submitted_at=submitted_at,
        ended_at=ended_at,
        **_running(running, json.loads(stops)),
    )


def protocol_scores(sums: Sequence[str | None]) -> list[ProtocolScore]:
    """A try's stored scores, `_SCORES`' JSON lists, as one `ProtocolScore` a protocol; none for
    a try that stored none."""
    if any(column is None for column in sums):
        return []
    columns = [json.loads(column) for column in sums if column is not None]
    return [
        ProtocolScore(**dict(zip(_SCORES, protocol, strict=True)))
        for protocol in zip(*columns, strict=True)
    ]


def _position(section: int, key: int) -> str:
    """A cursor at a run: in flight (`i`, by its number) or ended (`e`, by its end's seq)."""
    return f"{'e' if section else 'i'} {key}"


def _cursor(after: str | None) -> tuple[str | None, int]:
    if after is None:
        return None, _MAX_KEY
    section, _, key = after.partition(" ")
    if section not in ("i", "e") or not key.isdigit() or int(key) > _MAX_KEY:
        raise ValueError(f"not a cursor: {after!r}")
    return section, int(key)


def _filter(filter: str | None) -> tuple[int | None, str | None]:
    """The run number a filter names, if it's one, and the text a name must hold, unless it's a
    number written `#214`. No name holds `#`, so `#nav` matches nothing."""
    text = (filter or "").strip()
    if not text:
        return None, None
    digits = text.removeprefix("#")
    if not (digits.isascii() and digits.isdigit() and int(digits) <= _MAX_KEY):
        return None, text.casefold()
    return int(digits), None if text.startswith("#") else text.casefold()
