"""Simulating a start on the desktop (ADR-0013, #88).

No start's simulated outputs are stored. The agent answers `read_start_fit`, what a simulation
needs and nothing it computes, and `read_dataset_revision`, the run's **Dataset revision**, which
never changes, so the desktop keeps it by its id. The desktop's **Host engine** then answers
`simulate_start` with each sweep's open probability, each point's simulated value and each
protocol's score, and says whether its costs drift from the stored ones.

Per-protocol lists are in the revision's protocol order, and per-point lists in each protocol's
point order.
"""

from __future__ import annotations

from icmm.wire.base import WireInt, WireModel
from icmm.wire.dataset import DatasetContent


class ReadStartFitParams(WireModel):
    run: WireInt
    graph: WireInt
    """The topology's state graph, `T{graph}`."""
    open_state: WireInt
    start: WireInt
    """The start's index in its topology, written `start 37`."""


class ProtocolScore(WireModel):
    """One protocol's score for one parameter vector: the core's raw sums of squared errors over
    its train and its validation points, unweighted, with how many points each has and how many
    failed. A failed point adds nothing to a sum."""

    train_sse: float
    val_sse: float
    train_points: WireInt
    train_failed: WireInt
    val_points: WireInt
    val_failed: WireInt


class StartFit(WireModel):
    """What simulating a start needs, read from the runs database in one query: its raw best
    **Parameters**, its topology, its run's **Dataset revision**, and how its worker scored them,
    on which engine."""

    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    num_states: WireInt
    dataset_id: str
    dataset_revision: WireInt
    """The revision the run fits, pinned at submit."""
    parameters: list[float]
    """The best vector its latest try with one stored, raw as its search left it: 2 per state,
    2 per edge, then the sigmoid's a and b, in ln units (ADR-0007). A failed start's is its best
    so far, which never counts."""
    engine: str | None
    """The key of the **Engine bundle** that fit it; `null` for one run from a checkout."""
    scores: list[ProtocolScore]
    """How its worker scored `parameters`."""


class ReadDatasetRevisionParams(WireModel):
    id: str
    revision: WireInt


class SimulateStartParams(WireModel):
    dataset: DatasetContent
    """The run's revision, as `read_dataset_revision` read it."""
    fit: StartFit
    """As `read_start_fit` read it."""


class SimulatedPoint(WireModel):
    """One point's sweep, simulated."""

    value: float | None
    """What the point's score compares with its data: a peak, or a decay time or time to peak in
    ms, divided as its protocol is normalized; `null` for a **Failed sweep**."""
    time_ms: list[float]
    """The measured step's recorded moments, from its start: at most 256 evenly strided ones,
    then the step's end (old ADR-0010), and fewer in a dataset of many sweeps, so the whole
    reply stays under the wire's line limit."""
    open_probability: list[float | None]
    """At each of `time_ms`; `null` where a failed sweep's simulation isn't a number."""


class ModelLine(WireModel):
    """The model as a fit chart draws its line (#367): its value at 200 x evenly spaced from the
    protocol's first point's x to its last on the chart's axis (log-even when its interpolation
    is on a log x axis), joined with every point's own x, in order."""

    x: list[float]
    value: list[float | None]
    """At each of `x`, as a point's `value` is, a normalized protocol's divided by the model's
    largest train value at the points' x, as the score divides it, so it can rise above 1
    between them; `null` for a **Failed sweep**."""


class SimulatedProtocol(WireModel):
    name: str
    points: list[SimulatedPoint]
    line: ModelLine
    score: ProtocolScore
    """As the desktop's engine scored the start's parameters."""


class Drift(WireModel):
    """The start's costs as drawn disagree with its stored ones beyond rounding, such as for a
    start fit by an older engine whose simulation has since changed (ADR-0013)."""

    fit_engine: str | None
    """The engine that fit it."""
    drawn_engine: str | None
    """The engine that drew it: this computer's."""
    protocols: list[str]
    """The protocols whose train or val SSE, or failed points, disagree."""


class StartSimulation(WireModel):
    protocols: list[SimulatedProtocol]
    engine: str | None
    """The key of the engine that drew it, this computer's **Host engine**; `null` when it runs
    from a checkout."""
    drift: Drift | None
    """`null` when every protocol's score matches the stored one within rounding."""
