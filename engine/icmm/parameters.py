"""A fit's parameters: their names, their canonical form, the rates they set (ADR-0007), and how
much they differ across a topology's **Top 10** (ADR-0021).

A topology with N states and E edges has 2N + 2E + 2 parameters, laid out as the core reads them:
a pair per state (s, sᵛ), then a pair per edge in the topology's edge order (e, eᵛ), then the
sigmoid's a and b in mV.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from icmm.core import Topology

MAX_RATE_BOUND = 20
"""Past ±20 the rates a box allows overflow the core, so every evaluation is a failed sweep (the
old app's limit)."""
type RateBound = Annotated[float, Field(ge=-MAX_RATE_BOUND, le=MAX_RATE_BOUND)]


class ParameterBounds(BaseModel):
    """The search box: one range for every rate parameter, one for the sigmoid's a and b.

    The config holds it; checks across its fields (each min below its max) are the config's.
    """

    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, use_attribute_docstrings=True
    )

    rate_min: RateBound = -10.0
    """The lowest a state or edge parameter may be, in ln units."""
    rate_max: RateBound = 10.0
    """The highest a state or edge parameter may be, in ln units."""
    sigmoid_min_mV: float = -80.0
    """The lowest a or b may be, in mV."""
    sigmoid_max_mV: float = 60.0
    """The highest a or b may be, in mV."""

    def box(self, topology: Topology) -> list[tuple[float, float]]:
        """Each parameter's (lower, upper) bound, in layout order."""
        rate = (self.rate_min, self.rate_max)
        sigmoid = (self.sigmoid_min_mV, self.sigmoid_max_mV)
        return [rate] * (2 * topology.num_states + 2 * len(topology.edges)) + [sigmoid] * 2

    def canonical_box(self, topology: Topology) -> list[tuple[float, float]]:
        """Each parameter's (lower, upper) as `canonical` shows it, in layout order: the values
        it can give a vector in the box, which the app draws each value against.

        A state's pair is a difference of two values in the box, so it reaches ±(max − min). An
        edge's constant part is as searched; its voltage part is negated by the fold wherever b
        can be negative. a is as searched, and b folds to its magnitude.
        """
        lo, hi = self.rate_min, self.rate_max
        state = (lo - hi, hi - lo)
        b_lo, b_hi = self.sigmoid_min_mV, self.sigmoid_max_mV
        if b_lo > 0:  # Never folded. At 0, b can be −0, which folds.
            e_v, b = (lo, hi), (b_lo, b_hi)
        elif b_hi < 0:  # Always folded.
            e_v, b = (-hi, -lo), (-b_hi, -b_lo)
        else:
            e_v, b = (min(lo, -hi), max(hi, -lo)), (0.0, max(-b_lo, b_hi))
        edge = [(lo, hi), e_v]
        return [state] * (2 * topology.num_states) + edge * len(topology.edges) + [(b_lo, b_hi), b]


@dataclass(frozen=True)
class EdgeRates:
    """One edge's two rates at one voltage, in ms⁻¹: i → j and j → i, with i < j; inf past what a
    float holds."""

    i: int
    j: int
    i_to_j: float
    j_to_i: float


def parameter_names(topology: Topology) -> list[str]:
    """Each parameter's export name, in layout order.

    State 3's pair is `s3` and `s3_V`, the edge between states 1 and 3 has `e1_3` and `e1_3_V`, and
    the sigmoid's are `a_mV` and `b_mV`. States are numbered as in the topology drawing.
    """
    names = [name for i in range(topology.num_states) for name in (f"s{i}", f"s{i}_V")]
    for edge in topology.edges:
        i, j = sorted(edge)
        names += [f"e{i}_{j}", f"e{i}_{j}_V"]
    return [*names, "a_mV", "b_mV"]


def parameter_count(topology: Topology) -> int:
    """How many parameters the topology takes: 2N + 2E + 2."""
    return 2 * topology.num_states + 2 * len(topology.edges) + 2


def canonical(topology: Topology, raw: Sequence[float]) -> list[float]:
    """`raw` as shown and exported: the same model, read relative to the open state, with b > 0.

    Two freedoms leave the model unchanged, and the search keeps both. Adding a constant to every
    state's s, or to every sᵛ, changes no rate, so the open state's pair is subtracted from every
    state's, leaving it 0. Negating b and every voltage part (each sᵛ and eᵛ) is a twin, so a
    vector with b < 0 is folded to its twin. The layout is unchanged, so the core reads it as it
    reads `raw`. It may sit outside the search box (b = −80 folds to 80); the raw vector stays
    what's stored (ADR-0007).
    """
    _check_length(topology, raw)
    params = list(raw)
    if math.copysign(1.0, params[-1]) < 0:  # -0.0 too, so b's twin at 0 folds alike
        params[1:-2:2] = [-v for v in params[1:-2:2]]
        params[-1] = -params[-1]
    # After the fold, so the open state's pair is x − x = +0, never −0.
    s_open, s_v_open = params[2 * topology.open_state], params[2 * topology.open_state + 1]
    for i in range(topology.num_states):
        params[2 * i] -= s_open
        params[2 * i + 1] -= s_v_open
    return params


@dataclass(frozen=True)
class Spread:
    """A topology's **Parameter spread** over its **Top 10** (ADR-0021)."""

    parameters: tuple[float | None, ...]
    """Each parameter's spread, in layout order; `None` for the open state's pair, which the
    canonical form holds at 0."""
    median: float
    """The topology's spread: the median over its parameters, the open state's pair left out."""
    min: float
    """The lowest spread among those parameters."""
    q1: float
    """The lower quartile, interpolated between ranks as numpy's default is."""
    q3: float
    """The upper quartile, interpolated the same way."""
    max: float
    """The highest spread among those parameters."""


def parameter_spread(
    topology: Topology, bounds: ParameterBounds, vectors: Sequence[Sequence[float]]
) -> Spread | None:
    """How much each parameter differs across `vectors`, the raw best vectors of a topology's
    Top 10; `None` with fewer than 2.

    Each vector is made canonical first, so a twin or a gauge shift reads as no spread. A
    parameter's spread is the sample SD (n − 1) of its values divided by its bound range, so ln
    units and mV share one scale.
    """
    if len(vectors) < 2:
        return None
    columns = zip(*(canonical(topology, v) for v in vectors), strict=True)
    open_pair = (2 * topology.open_state, 2 * topology.open_state + 1)
    parameters = tuple(
        None if i in open_pair else statistics.stdev(column) / (upper - lower)
        for i, (column, (lower, upper)) in enumerate(
            zip(columns, bounds.box(topology), strict=True)
        )
    )
    counted = sorted(s for s in parameters if s is not None)
    q1, median, q3 = statistics.quantiles(counted, n=4, method="inclusive")
    return Spread(parameters, median, counted[0], q1, q3, counted[-1])


def rates(topology: Topology, params: Sequence[float], voltage_mV: float) -> list[EdgeRates]:
    """Each edge's rates at `voltage_mV`, in the topology's edge order. Raw or canonical alike.

    ln rate(i → j) = ½[(eᵢⱼ + sⱼ − sᵢ) + (eᵢⱼᵛ + sⱼᵛ − sᵢᵛ)·tanh((V + a)/b)], as the core has it.
    """
    _check_length(topology, params)
    n = topology.num_states
    t = _sigmoid(voltage_mV, a=params[-2], b=params[-1])
    out = []
    for k, edge in enumerate(topology.edges):
        i, j = sorted(edge)
        e, e_v = params[2 * n + 2 * k], params[2 * n + 2 * k + 1]
        s = params[2 * j] - params[2 * i]
        s_v = params[2 * j + 1] - params[2 * i + 1]
        out.append(
            EdgeRates(
                i,
                j,
                _exp(0.5 * ((e + s) + (e_v + s_v) * t)),
                _exp(0.5 * ((e - s) + (e_v - s_v) * t)),
            )
        )
    return out


def _exp(x: float) -> float:
    """eˣ, or inf past what a float holds, where `math.exp` raises."""
    try:
        return math.exp(x)
    except OverflowError:
        return math.inf


def _sigmoid(voltage_mV: float, a: float, b: float) -> float:
    """tanh((V + a)/b), taking b = ±0 as the core's IEEE division does: tanh(±inf) = ±1."""
    x = voltage_mV + a
    if b == 0:
        return math.copysign(1.0, x) * math.copysign(1.0, b) if x else math.nan
    return math.tanh(x / b)


def _check_length(topology: Topology, params: Sequence[float]) -> None:
    takes = parameter_count(topology)
    if len(params) != takes:
        raise ValueError(f"The vector has {len(params)} parameters; the topology takes {takes}.")
