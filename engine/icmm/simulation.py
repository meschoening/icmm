"""Simulating a start for drawing it (ADR-0013, #88): each sweep's open probability over its
measured step, each point's simulated value and each protocol's score, from the start's raw
**Parameters** and its run's **Dataset revision**, in one pass of the core (`Session.simulate`);
and the model's line on a fine grid of x, values only, in a second (#367).

No start's simulated outputs are stored, so the desktop's **Host engine** recomputes them, and
compares the scores with the ones the start's worker stored. Scores that disagree beyond
rounding are **drift**: the start was fit by an engine whose simulation differs from this one's.
"""

from __future__ import annotations

import bisect
import math
from array import array
from collections.abc import Sequence
from dataclasses import replace

from icmm.core import TRACE_SAMPLES, Core, Session, Topology
from icmm.core import ProtocolScore as CoreScore
from icmm.dataset import Dataset, Protocol, core_arrays
from icmm.wire.simulation import ModelLine, ProtocolScore, SimulatedPoint, SimulatedProtocol

DRIFT_RTOL = 1e-6
"""How far apart two engines' sums of squared errors may be and still count as the same. The
core does the same arithmetic on every engine (Eigen alone, in a fixed order, with no fused
multiply-adds the source doesn't write; ADR-0004), so what differs between arm64 and x86_64, or
macOS, Windows and Linux, is mostly the C library's `exp` and `tanh`, a few units in the last
place. A change to the simulation moves a sum by far more."""
DRIFT_ATOL = 1e-12
"""The same for a sum near 0, where a relative difference means nothing."""
TRACE_BUDGET = 65_536
"""The most strided moments one simulation's traces keep, all its sweeps together, before each
sweep's last. A dataset of many sweeps draws each with fewer, down to its first and last, so the
reply stays far under the wire's 16 MiB line however many points the dataset holds: 32 protocols
of 1,000 points keep 2 strided moments a sweep and the last, at most about 7 MB of JSON, and 9 MB
with each protocol's line (`LINE_SWEEPS`)."""


LINE_SWEEPS = 200
"""How many x evenly spaced across a protocol's points its line is drawn at, besides the points'
own (#362): within 2 px of the model on an exported figure for every golden dataset, where the
points' x alone strayed up to 45 px on a peak and 153 px on a decay time. Five protocols on this
grid cost about 7 ms more for a 4-state start, and 47 to 88 ms for 11 states, on an M1 Pro."""


def trace_samples(sweeps: int) -> int:
    """How many strided moments each of `sweeps` sweeps keeps before its last: the old app's 256,
    fewer when the whole simulation's would pass `TRACE_BUDGET`, and never fewer than 1."""
    return max(1, min(TRACE_SAMPLES, TRACE_BUDGET // max(sweeps, 1)))


def simulate(
    core: Core, topology: Topology, dataset: Dataset, parameters: Sequence[float]
) -> list[SimulatedProtocol]:
    """Each protocol of `dataset` simulated at `parameters` on `topology`, with its line."""
    with Session(core, topology, [core_arrays(p) for p in dataset.protocols]) as session:
        sweeps = sum(len(p.points) for p in dataset.protocols)
        simulated = session.simulate(parameters, trace_samples(sweeps))
    lines = model_lines(core, topology, dataset, parameters)
    return [
        SimulatedProtocol(
            name=protocol.name,
            points=[
                SimulatedPoint(
                    value=value, time_ms=trace.time_ms, open_probability=trace.open_probability
                )
                for value, trace in zip(values, traces, strict=True)
            ],
            line=line,
            score=_wire(score),
        )
        for protocol, values, traces, line, score in zip(
            dataset.protocols,
            simulated.values,
            simulated.traces,
            lines,
            simulated.scores,
            strict=True,
        )
    ]


def model_lines(
    core: Core, topology: Topology, dataset: Dataset, parameters: Sequence[float]
) -> list[ModelLine]:
    """Each protocol's line at `parameters`: its model at `line_x`, values only, in one session
    over every protocol's grid, unnormalized, then divided as the score divides its train points.
    Every protocol can be drawn there: the core sets any swept voltage, and any swept duration,
    exactly (#362)."""
    grids = [
        line_x([p.x for p in protocol.points], protocol.interpolation.log_x)
        for protocol in dataset.protocols
    ]
    arrays = [
        replace(
            core_arrays(protocol),
            normalized=False,
            x=array("d", grid),
            value=array("d", [0.0] * len(grid)),
            validation=array("B", [0] * len(grid)),
        )
        for protocol, grid in zip(dataset.protocols, grids, strict=True)
    ]
    with Session(core, topology, arrays) as session:
        raw = session.point_values(parameters)
    return [
        ModelLine(x=grid, value=_divided(protocol, grid, values))
        for protocol, grid, values in zip(dataset.protocols, grids, raw, strict=True)
    ]


def line_x(xs: Sequence[float], log: bool) -> list[float]:
    """Where a protocol's line is drawn: `LINE_SWEEPS` x evenly spaced from the first of `xs`
    to the last on the chart's axis (log-even on a `log` axis, as recovery's is), joined with
    every one of `xs`, in order. One even x a hair from a point's x gives way to the point's."""
    points = sorted(set(xs))
    lo, hi = points[0], points[-1]
    if not hi > lo:
        return points
    log = log and lo > 0
    a, b = (math.log(lo), math.log(hi)) if log else (lo, hi)
    along = [a + (b - a) * k / (LINE_SWEEPS - 1) for k in range(1, LINE_SWEEPS - 1)]
    near = (b - a) * 1e-12
    on_axis = [math.log(x) for x in points] if log else points
    kept = [x for x in along if not _beside(on_axis, x, near)]
    return sorted([*points, *(math.exp(x) if log else x for x in kept)])


def _beside(sorted_xs: Sequence[float], x: float, near: float) -> bool:
    """Whether `x` is within `near` of one of `sorted_xs`."""
    i = bisect.bisect_left(sorted_xs, x)
    return any(abs(x - sorted_xs[j]) <= near for j in (i - 1, i) if 0 <= j < len(sorted_xs))


def _divided(
    protocol: Protocol, xs: Sequence[float], raw: Sequence[float | None]
) -> list[float | None]:
    """A line's raw values as its protocol's train points are scored: a normalized protocol's
    divided by the model's largest train value at the points' x (the core's `train_top`), every
    value failed when that's 0. A value that isn't finite has failed."""
    values = [v if v is not None and math.isfinite(v) else None for v in raw]
    if not protocol.normalized:
        return values
    at = dict(zip(xs, values, strict=True))
    top = max(
        [0.0, *(v for p in protocol.points if not p.validation and (v := at[p.x]) is not None)]
    )
    if top == 0:
        return [None] * len(values)
    return [None if v is None else v / top for v in values]


def drifted(stored: Sequence[ProtocolScore], drawn: Sequence[ProtocolScore]) -> list[int]:
    """The indices of the protocols whose drawn score disagrees with the stored one beyond
    rounding: every protocol, when there aren't as many stored scores as protocols."""
    if len(stored) != len(drawn):
        return list(range(len(drawn)))
    return [i for i, (s, d) in enumerate(zip(stored, drawn, strict=True)) if not _agree(s, d)]


def _agree(stored: ProtocolScore, drawn: ProtocolScore) -> bool:
    counts = ("train_points", "train_failed", "val_points", "val_failed")
    return all(getattr(stored, c) == getattr(drawn, c) for c in counts) and all(
        _close(getattr(stored, s), getattr(drawn, s)) for s in ("train_sse", "val_sse")
    )


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= DRIFT_RTOL * max(abs(a), abs(b)) + DRIFT_ATOL


def _wire(score: CoreScore) -> ProtocolScore:
    return ProtocolScore(
        train_sse=score.train_sse,
        val_sse=score.val_sse,
        train_points=score.train_points,
        train_failed=score.train_failed,
        val_points=score.val_points,
        val_failed=score.val_failed,
    )
