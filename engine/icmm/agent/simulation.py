"""`read_start_fit`: what the desktop needs to simulate a start (ADR-0013, #88).

No start's simulated outputs are stored, and the login node computes nothing, so the agent reads
the start's raw best vector, its topology, its run's Dataset revision and how its worker scored
it, in one indexed query, and the desktop's host engine simulates. The revision itself is
`read_dataset_revision`'s, which the desktop keeps by its id.
"""

from __future__ import annotations

import json
import sqlite3

from icmm.agent.serve import AgentError
from icmm.db import RunsDb
from icmm.wire.errors import NotFoundData, NotFoundError
from icmm.wire.simulation import ProtocolScore, ReadStartFitParams, StartFit

_SCORES = ("train_sse", "val_sse", "train_points", "train_failed", "val_points", "val_failed")


class RunGone(Exception):
    """The run is deleted, or was never submitted."""


class NoBest(Exception):
    """The start has no stored best yet."""


def read_start_fit(params: ReadStartFitParams, *, db: RunsDb) -> StartFit:
    run, graph, open_state, start = params.run, params.graph, params.open_state, params.start
    try:
        return read_fit(db.connection(), run, graph, open_state, start)
    except RunGone:
        error = NotFoundError(
            code="not_found",
            message=f"Run #{run} isn’t on this platform any more.",
            data=NotFoundData(kind="run", id=str(run)),
        )
    except NoBest:
        error = NotFoundError(
            code="not_found",
            message=f"#{run}/T{graph}.{open_state} start {start} has no parameters to draw yet.",
            data=NotFoundData(kind="start", id=f"{run}/T{graph}.{open_state}/{start}"),
        )
    raise AgentError(error)


def read_fit(
    conn: sqlite3.Connection, run: int, graph: int, open_state: int, start: int
) -> StartFit:
    """The start's fit from its latest try with a stored best: a failed or canceled try keeps
    its best so far, and a start fit again keeps its last one until the new try stores its own.
    `RunGone` for a run deleted or never submitted, and `NoBest` for a start with no best.

    One query: the run by its key, and the start's tries by theirs, newest first (ADR-0013)."""
    row = conn.execute(
        "SELECT r.num_states, r.dataset_id, r.dataset_revision, t.best, t.engine, "
        "t.train_sse, t.val_sse, t.train_points, t.train_failed, t.val_points, t.val_failed "
        "FROM runs r LEFT JOIN start_tries t ON t.run_id = r.id AND t.graph = ? "
        "AND t.open_state = ? AND t.start_index = ? AND t.best IS NOT NULL "
        "WHERE r.id = ? AND r.deleted_at IS NULL ORDER BY t.try DESC LIMIT 1",
        (graph, open_state, start, run),
    ).fetchone()
    if row is None:
        raise RunGone
    num_states, dataset_id, revision, best, engine, *sums = row
    if best is None:
        raise NoBest
    scores = zip(*(json.loads(s) for s in sums), strict=True)
    return StartFit(
        run=run,
        graph=graph,
        open_state=open_state,
        start=start,
        num_states=num_states,
        dataset_id=dataset_id,
        dataset_revision=revision,
        parameters=json.loads(best),
        engine=engine,
        scores=[ProtocolScore(**dict(zip(_SCORES, s, strict=True))) for s in scores],
    )
