"""Run detail's and Topology's reads: a run's topologies, a page at a time, and one topology in
full (ADR-0019, ADR-0021). Each is one query over the rows the run's coordinator keeps; nothing
is read from the Output folder (ADR-0013).

`icmm.run_topologies` is imported on first use, so the agent's start path stays as light as
`hello` needs.
"""

from __future__ import annotations

from icmm.agent.serve import AgentError
from icmm.db import RunsDb
from icmm.wire.errors import BadRequestError, NotFoundData, NotFoundError
from icmm.wire.run import ListTopologiesParams, ReadTopologyParams, Topology, TopologyList


def list_topologies(params: ListTopologiesParams, *, db: RunsDb) -> TopologyList:
    from icmm import run_topologies

    try:
        page, ranked, next = run_topologies.list_page(
            db.connection(), params.run, params.order, params.after, params.state
        )
    except ValueError:
        message = (
            "A `state` lists in `sent` order."
            if params.state is not None and params.order == "rank"
            else "`after` isn't a page's `next`."
        )
        raise AgentError(BadRequestError(code="bad_request", message=message)) from None
    except run_topologies.NotFoundError:
        raise AgentError(run_not_found(params.run)) from None
    return TopologyList(topologies=page, ranked=ranked, next=next)


def read_topology(params: ReadTopologyParams, *, db: RunsDb) -> Topology:
    from icmm import run_topologies

    try:
        return run_topologies.read(db.connection(), params.run, params.graph, params.open_state)
    except run_topologies.NotFoundError:
        raise AgentError(topology_not_found(params.run, params.graph, params.open_state)) from None


def run_not_found(run: int) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message=f"Run #{run} isn't on this platform any more.",
        data=NotFoundData(kind="run", id=str(run)),
    )


def topology_not_found(run: int, graph: int, open_state: int) -> NotFoundError:
    """A run gone, or one that hasn't listed this topology: before its topology stage, or one it
    doesn't fit."""
    name = f"#{run}/T{graph}.{open_state}"
    return NotFoundError(
        code="not_found",
        message=f"{name} isn't on this platform: its run is gone, or doesn't fit it.",
        data=NotFoundData(kind="topology", id=name),
    )
