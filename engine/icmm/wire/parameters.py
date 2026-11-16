"""A topology's fitted **Parameters**, made canonical on the desktop (ADR-0007, ADR-0013, #287).

The runs database stores each start's best vector raw, as its search left it. What's shown is
canonical: read relative to the open state, with b > 0. The desktop's **Host engine** answers
`canonical_parameters` from `icmm.parameters`, so the Parameters rows on Topology, Start and
Result show what an export writes.
"""

from __future__ import annotations

from pydantic import Field

from icmm.wire.base import WireInt, WireModel
from icmm.wire.config import Bounds

MAX_VECTORS = 1000
"""The most vectors one call sends: a topology's starts go in parts, each line well under the
wire's 16 MiB."""


class CanonicalParametersParams(WireModel):
    num_states: WireInt
    graph: WireInt
    """The topology's state graph, `T{graph}`."""
    open_state: WireInt
    bounds: Bounds
    """The run's search box, as its settings recorded it: what each value can take comes from
    it."""
    vectors: list[list[float]] = Field(max_length=MAX_VECTORS)
    """Raw **Parameters** as the runs database stores them: a pair per state, a pair per edge,
    then the **Sigmoid**'s a and b."""


class ParameterRange(WireModel):
    min: float
    max: float


class CanonicalParameters(WireModel):
    edges: list[list[WireInt]]
    """The topology's edges as the vectors lay them out: each its two states, the lower first,
    in the order of its edge parameters."""
    vectors: list[list[float]]
    """Each vector sent, in the same order and layout, read relative to the open state (whose
    pair is 0), with b > 0."""
    ranges: list[ParameterRange]
    """Each parameter's range in layout order: every value a vector in the box can show as. A
    state's pair reaches ±(max − min), since it's a difference; b folds to its magnitude."""


class EdgeRatesParams(WireModel):
    num_states: WireInt
    graph: WireInt
    """The topology's state graph, `T{graph}`."""
    open_state: WireInt
    vector: list[float]
    """A start's raw **Parameters**, or canonical ones: both set the same rates."""
    voltage_mV: float


class EdgeRate(WireModel):
    """One edge's two rates at the voltage asked, in ms⁻¹."""

    i: WireInt
    """The lower-numbered state."""
    j: WireInt
    i_to_j: float | None
    """`null` past what a number holds."""
    j_to_i: float | None


class EdgeRates(WireModel):
    rates: list[EdgeRate]
    """In the topology's edge order, as `CanonicalParameters.edges` has it."""
