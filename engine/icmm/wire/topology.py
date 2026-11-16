"""**State graphs** as the topology lists hold them (ADR-0017, ADR-0018): each one's edges and open
states, for the drawings of topologies the desktop lays out itself. And Find custom topology's
question and answer (#222, #223): a topology typed in the user's own state numbers, and its id."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from icmm.wire.base import MAX_WIRE_INT, WireInt, WireModel

MAX_STATE_GRAPHS = 1000
"""The most state graphs one read names: a thousand 16-state graphs are about 300 KB."""


class ReadStateGraphsParams(WireModel):
    num_states: WireInt
    graphs: list[WireInt] = Field(max_length=MAX_STATE_GRAPHS)
    """State graph numbers in the list for `num_states`, as ids name them: `T1991` is 1991."""


class StateGraph(WireModel):
    graph: WireInt
    edges: list[list[WireInt]]
    """Each edge as its two states, the lower first, sorted: the order of its edge parameters."""
    open_states: list[WireInt]
    """Its **Open states**, lowest first: one topology each (ADR-0018). A state its symmetry
    makes the same as one of these isn't one."""


class StateGraphs(WireModel):
    state_graphs: list[StateGraph]
    """One for each state graph asked for, in the order first asked."""


MAX_TRANSITIONS = 256
"""The most transitions Find custom topology sends: a topology within the rules has at most 120
(16 states with 4 neighbors each have 32), so the rest only break them."""

type StateNumber = Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]
"""A state's number as the user typed it: any whole number, one per state."""


class MatchTopologyParams(WireModel):
    transitions: list[Annotated[list[StateNumber], Field(min_length=2, max_length=2)]] = Field(
        max_length=MAX_TRANSITIONS
    )
    """Each transition as the two state numbers it joins, as typed: either way round, in any
    order. Every state is in one."""
    open_state: StateNumber | None
    """The open state's typed number; `null` for the state graph alone, every topology of it."""


class TypedState(WireModel):
    number: WireInt
    """The state's number as typed."""
    state: WireInt
    """ICMM's number for it in the topology found: the number its parameters carry."""


class FoundTopology(WireModel):
    """The topology's id: `T{graph}.{open_state}` in the list for `num_states`."""

    num_states: WireInt
    graph: WireInt
    open_state: WireInt | None
    """Named by the lowest state its symmetry makes the same as the typed open state (ADR-0018);
    `null` when none was typed."""
    states: list[TypedState]
    """Each typed number, lowest first, with ICMM's number for that state."""


type TopologyRule = Literal[
    "open_state",
    "self_transition",
    "repeated_transition",
    "num_states",
    "neighbors",
    "connected",
    "loop",
]
"""`open_state`: the open state isn't one of the typed states. `self_transition`: a state joined
to itself. `repeated_transition`: two transitions join the same states. `num_states`: fewer than 3
or more than 16 states. `neighbors`: a state with more than 4. `connected`: states not joined to
the rest. `loop`: a loop through more than 4 states (ADR-0017)."""


class TopologyIssue(WireModel):
    rule: TopologyRule
    states: list[WireInt]
    """The typed numbers of the states that break it: around the loop from its lowest state for
    `loop`, else lowest first. For `connected`, every state apart from the open state's piece
    (the largest without one). For `loop` with no `loop`, every state of its block."""
    transitions: list[WireInt]
    """The transitions that break it, as places in `transitions`."""
    loop: list[WireInt] | None
    """For `loop`, the shortest loop through more than 4 states in its block, as `states` names
    it; `null` for other rules, or when the search for one gave up."""


class TopologyMatch(WireModel):
    """A typed topology's id, or every rule it breaks; never both."""

    found: FoundTopology | None
    issues: list[TopologyIssue]
