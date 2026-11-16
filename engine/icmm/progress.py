"""A start's **Progress curve** (#286): its best Train RMSE so far against evaluations, thinned
from its try's **Start log** to at most `POINTS` points, for Topology's Optimization progress.

Reading every start's log when the page opens would parse about 13 MB on the login node for a
topology of 100 starts (ADR-0013), so the run's coordinator keeps each try's curve in the runs
database instead: it adds a running try's latest log point at each sweep, and thins the whole log
once the try ends. It runs on a compute node, or on This computer.

Thinning is Visvalingam and Whyatt's, a point at a time: past `POINTS`, the inner point whose
triangle with its two neighbors is smallest goes, measured as the chart draws it, its start's
evaluations across 1014 px and each decade of RMSE 118 px. The first and last points always stay.
A best with no Train RMSE (a failed sweep, "—") has no place on a log scale, so it isn't kept.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

POINTS = 64
"""The most a curve keeps: a point every 16 px across the chart, about 1.6 KB on the wire."""
_ACROSS = 1014 / 118
"""How far a start's whole Evaluation budget spans, in decades of RMSE, as the chart draws it."""
_TINY = 1e-12
"""Where an exact fit, at 0, sits on the log scale, for measuring."""


@dataclass(frozen=True)
class Curve:
    points: list[tuple[int, float]] = field(default_factory=list)
    """(evaluations, Train RMSE), by evaluations; each RMSE to 5 significant figures."""

    def added(self, evaluations: int, train_rmse: float | None, *, per_start: int) -> Curve:
        """The curve with a later log point, thinned back to `POINTS`; itself for a point with no
        Train RMSE, or one no later than its last. `per_start` is the evaluations each start
        runs, which sets how the chart measures."""
        if train_rmse is None or (self.points and evaluations <= self.points[-1][0]):
            return self
        points = [*self.points, (evaluations, float(f"{train_rmse:.5g}"))]
        if len(points) > POINTS:
            del points[_flattest(points, per_start)]
        return Curve(points)

    def to_json(self) -> str:
        """As the runs database keeps it, and the wire carries it: its two lists."""
        return json.dumps(
            {"evaluations": [e for e, _ in self.points], "train_rmse": [r for _, r in self.points]}
        )

    @classmethod
    def from_json(cls, text: str) -> Curve:
        kept = json.loads(text)
        return cls(list(zip(kept["evaluations"], kept["train_rmse"], strict=True)))


def read(text: str | None) -> Curve | None:
    """A try's curve as its row keeps it; `None` before its coordinator has read its log."""
    return None if text is None else Curve.from_json(text)


def _flattest(points: list[tuple[int, float]], per_start: int) -> int:
    """The inner point whose going changes the drawing least: the smallest triangle it makes
    with its neighbors, the earliest of equals."""
    drawn = [(e / per_start * _ACROSS, math.log10(max(r, _TINY))) for e, r in points]

    def area(i: int) -> float:
        (x0, y0), (x1, y1), (x2, y2) = drawn[i - 1 : i + 2]
        return abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))

    return min(range(1, len(points) - 1), key=area)
