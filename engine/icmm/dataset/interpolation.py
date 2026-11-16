"""Interpolation: the lab's not-a-knot cubic spline through every measured point (ADR-0011).

The lab's script (MSO's `cubicspline_interpolate_dataset.py`) fits `scipy.interpolate.CubicSpline`
with its default not-a-knot ends. The engine depends on pydantic alone, so the spline is written
out here the way scipy builds it: each knot's slope from one tridiagonal system, then a cubic
Hermite piece per gap. `tests/fixtures/interpolation` holds the lab's output it reproduces.

The desktop's engine runs it for the Dataset wizard's preview; the agent never does (ADR-0013).
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Callable, Sequence

from icmm.dataset.checks import (
    LOG_X_NEEDS_POSITIVE_X,
    POINTS_PER_GAP,
    REPEATED_X,
    DatasetError,
    Issue,
)
from icmm.dataset.model import MAX_POINTS_PER_GAP, Point, Protocol

X_DECIMALS = 4
"""The lab's script rounds each new x to 4 decimals and reads the spline at the rounded x. A gap
too narrow for that keeps its exact x, where the script would have repeated one."""


def interpolate(protocol: Protocol) -> Protocol:
    """`protocol` with its interpolated points made afresh from its measured ones.

    Raises `DatasetError` when the spline can't be drawn: a repeated x, a log x-axis with an
    x at or below 0, or a draft's points per gap outside 1 to 10. Each issue's path is within the
    protocol. A drawn spline can still break the dataset's limits, with more than 1,000 points or
    a value past its measure's range; `validate_dataset` says where.
    """
    measured = sorted((p for p in protocol.points if not p.interpolated), key=lambda p: p.x)
    if not protocol.interpolation.enabled:
        return protocol.model_copy(update={"points": measured})
    _check(protocol, measured)
    if len(measured) < 2:
        return protocol.model_copy(update={"points": measured})
    xs = [p.x for p in measured]
    axis: Callable[[float], float] = math.log if protocol.interpolation.log_x else float
    spline = _not_a_knot([axis(x) for x in xs], [p.value for p in measured])
    m = protocol.interpolation.points_per_gap
    added: list[Point] = []
    for left, right in zip(xs, xs[1:], strict=False):
        for x in _gap_xs(left, right, m):
            y = spline(axis(x))
            added.append(Point(x=x, value=y, sd=None, validation=False, interpolated=True))
    points = sorted(measured + added, key=lambda p: p.x)
    return protocol.model_copy(update={"points": points})


def _gap_xs(left: float, right: float, m: int) -> list[float]:
    """`m` x spaced evenly inside (left, right), rounded unless rounding would repeat an x."""
    exact = [left + k / (m + 1) * (right - left) for k in range(1, m + 1)]
    rounded = [round(x, X_DECIMALS) for x in exact]
    inside = [left, *rounded, right]
    return rounded if all(a < b for a, b in zip(inside, inside[1:], strict=False)) else exact


def _check(protocol: Protocol, measured: Sequence[Point]) -> None:
    issues: list[Issue] = []
    xs: set[float] = set()
    for k, p in enumerate(protocol.points):
        if p.interpolated:
            continue
        if p.x in xs:
            issues.append(Issue(path=("points", k, "x"), message=REPEATED_X))
        xs.add(p.x)
    if len(measured) >= 2 and protocol.interpolation.log_x and min(xs) <= 0:
        issues.append(Issue(path=("interpolation", "log_x"), message=LOG_X_NEEDS_POSITIVE_X))
    if not 1 <= protocol.interpolation.points_per_gap <= MAX_POINTS_PER_GAP:
        issues.append(Issue(path=("interpolation", "points_per_gap"), message=POINTS_PER_GAP))
    if issues:
        raise DatasetError(issues)


def _not_a_knot(xs: Sequence[float], ys: Sequence[float]) -> Callable[[float], float]:
    """The not-a-knot cubic spline through (xs, ys), with xs increasing and at least 2 long."""
    n = len(xs)
    dx = [xs[i + 1] - xs[i] for i in range(n - 1)]
    slope = [(ys[i + 1] - ys[i]) / dx[i] for i in range(n - 1)]
    if n == 2:
        s = [slope[0], slope[0]]
    elif n == 3:
        # Both ends' conditions fall on the one interior knot, so scipy takes the parabola.
        curvature = (slope[1] - slope[0]) / (xs[2] - xs[0])
        s = [slope[0] + curvature * (2 * x - xs[0] - xs[1]) for x in xs]
    else:
        s = _knot_slopes(xs, dx, slope)

    def spline(x: float) -> float:
        i = min(max(bisect_right(xs, x) - 1, 0), n - 2)
        t = (s[i] + s[i + 1] - 2 * slope[i]) / dx[i]
        c0 = t / dx[i]
        c1 = (slope[i] - s[i]) / dx[i] - t
        h = x - xs[i]
        return ((c0 * h + c1) * h + s[i]) * h + ys[i]

    return spline


def _knot_slopes(xs: Sequence[float], dx: list[float], slope: list[float]) -> list[float]:
    """Each knot's slope: interior rows match second derivatives, end rows the third's."""
    n = len(xs)
    lower = [0.0] * n
    diagonal = [0.0] * n
    upper = [0.0] * n
    rhs = [0.0] * n
    for i in range(1, n - 1):
        lower[i] = dx[i]
        diagonal[i] = 2 * (dx[i - 1] + dx[i])
        upper[i] = dx[i - 1]
        rhs[i] = 3 * (dx[i] * slope[i - 1] + dx[i - 1] * slope[i])
    d = xs[2] - xs[0]
    diagonal[0] = dx[1]
    upper[0] = d
    rhs[0] = ((dx[0] + 2 * d) * dx[1] * slope[0] + dx[0] ** 2 * slope[1]) / d
    d = xs[-1] - xs[-3]
    diagonal[-1] = dx[-2]
    lower[-1] = d
    rhs[-1] = (dx[-1] ** 2 * slope[-2] + (2 * d + dx[-1]) * dx[-2] * slope[-1]) / d
    return _solve_tridiagonal(lower, diagonal, upper, rhs)


def _solve_tridiagonal(
    lower: list[float], diagonal: list[float], upper: list[float], rhs: list[float]
) -> list[float]:
    """The Thomas algorithm; the spline's systems keep every pivot above 0 without pivoting."""
    n = len(diagonal)
    c = [0.0] * n
    d = [0.0] * n
    c[0] = upper[0] / diagonal[0]
    d[0] = rhs[0] / diagonal[0]
    for i in range(1, n):
        pivot = diagonal[i] - lower[i] * c[i - 1]
        c[i] = upper[i] / pivot
        d[i] = (rhs[i] - lower[i] * d[i - 1]) / pivot
    out = [0.0] * n
    out[-1] = d[-1]
    for i in range(n - 2, -1, -1):
        out[i] = d[i] - c[i] * out[i + 1]
    return out
