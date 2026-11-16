"""The topology lists' RPC: each state graph's edges and open states, which the desktop draws."""

from __future__ import annotations

from icmm.agent.serve import AgentError
from icmm.topology import Lists, TopologyError
from icmm.wire.errors import NotFoundData, NotFoundError
from icmm.wire.topology import ReadStateGraphsParams, StateGraph, StateGraphs


def read_state_graphs(params: ReadStateGraphsParams, *, lists: Lists) -> StateGraphs:
    """A seek per state graph in each of two list files (ADR-0013)."""
    num_states, graphs = params.num_states, list(dict.fromkeys(params.graphs))
    if not graphs:
        return StateGraphs(state_graphs=[])
    try:
        edges = lists.edges(num_states, graphs)
        orbits = lists.orbits(num_states, graphs)
    except TopologyError as e:
        unread = f"T{_unread(lists, num_states, graphs)}"
        data = NotFoundData(kind="state_graph", id=unread)
        raise AgentError(NotFoundError(code="not_found", message=str(e), data=data)) from None
    return StateGraphs(
        state_graphs=[
            StateGraph(
                graph=graph,
                edges=[list(edge) for edge in edges[graph]],
                open_states=[s for s, lowest in enumerate(orbits[graph]) if s == lowest],
            )
            for graph in graphs
        ]
    )


def _unread(lists: Lists, num_states: int, graphs: list[int]) -> int:
    """The state graph a refusal names: the lowest past the list, as `Lists` checks them, or the
    first asked for when there's no list."""
    try:
        count = lists.state_graphs(num_states)
    except TopologyError:
        return graphs[0]
    return min(graph for graph in graphs if not 0 <= graph < count)
