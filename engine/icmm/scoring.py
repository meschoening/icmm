"""Scoring fits: Cost, the RMSEs, the failure penalty and near best, above the core's raw sums
(ADR-0006, ADR-0021).

The core gives each protocol's unweighted squared error over its train points and over its
validation points (`icmm.core.ProtocolScore`). Here each protocol's sums are multiplied by its
Weight and by nothing else: no protocol is rescaled by the values it outputs. `fit.train.cost` is
the Cost, `fit.train.penalized` is what the search minimizes, and `fit.train.rmse` and
`fit.val.rmse` are the Train and Val RMSE.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from icmm.core import ProtocolScore

# What each failed point adds in place of its error: more than any finite cost can reach, so a
# failure ranks after every scored fit and fewer failures rank better (ADR-0006).
FAILURE_PENALTY = 1e100

NEAR_BEST = 0.01
"""How far above its topology's **Best start**'s Train RMSE a start may be and still be near
best, as a share of it (ADR-0021)."""


@dataclass(frozen=True)
class Errors:
    """A fit's errors over its train points, or over its validation points."""

    scored_cost: float  # Σ weight × SSE over the points that scored; a failed one adds nothing
    weighted_points: float  # Σ weight × n, failed points included
    failed: int  # points whose sweep failed: they add a penalty, never an error

    @property
    def cost(self) -> float | None:
        """Σ weight × SSE over these points: over the train points, the Cost.

        None when a point failed: it has no error, and the points that scored would flatter the fit.
        """
        return None if self.failed else self.scored_cost

    @property
    def rmse(self) -> float | None:
        """√(Σ weight × SSE / Σ weight × n): each point's error counted by its protocol's Weight.

        None when a point failed, since a failure is never shown as a number, and without
        points: a protocol, or a dataset, that holds no validation points out.
        """
        if self.failed or not self.weighted_points:
            return None
        return math.sqrt(self.scored_cost / self.weighted_points)

    @property
    def penalized(self) -> float:
        """What the search minimizes over the train points: `FAILURE_PENALTY` per failed point,
        or the cost capped at half the penalty when every point scored.

        Fewer failures always rank better, and fits with the same number of failures tie,
        regardless of their scored points or protocol Weights.
        """
        if self.failed:
            return self.failed * FAILURE_PENALTY
        return min(self.scored_cost, FAILURE_PENALTY / 2)


@dataclass(frozen=True)
class ProtocolErrors(Errors):
    """A protocol's weighted errors, with raw sums for its weight-independent RMSE."""

    raw_sse: float
    points: int

    @property
    def rmse(self) -> float | None:
        """Protocol RMSE, √(SSE / n) in its data's units, independent of Weight.

        None when a point failed or there are no points.
        """
        if self.failed or not self.points:
            return None
        return math.sqrt(self.raw_sse / self.points)


@dataclass(frozen=True)
class ProtocolFit:
    """One protocol's share of a fit: weighted costs and unweighted Protocol RMSEs."""

    train: ProtocolErrors
    val: ProtocolErrors


@dataclass(frozen=True)
class Fit:
    """How well one parameter vector fits a dataset."""

    train: Errors
    val: Errors
    protocols: tuple[ProtocolFit, ...]


def score(weights: Sequence[float], scores: Sequence[ProtocolScore]) -> Fit:
    """The fit the core's `scores` describe, each protocol weighted by its entry in `weights`."""
    protocols = tuple(
        ProtocolFit(
            ProtocolErrors(
                w * s.train_sse, w * s.train_points, s.train_failed, s.train_sse, s.train_points
            ),
            ProtocolErrors(w * s.val_sse, w * s.val_points, s.val_failed, s.val_sse, s.val_points),
        )
        for w, s in zip(weights, scores, strict=True)
    )
    return Fit(
        train=_total([p.train for p in protocols]),
        val=_total([p.val for p in protocols]),
        protocols=protocols,
    )


def _total(parts: Sequence[Errors]) -> Errors:
    cost = weighted_points = 0.0
    for part in parts:  # in protocol order, as the old library summed them
        cost += part.scored_cost
        weighted_points += part.weighted_points
    return Errors(cost, weighted_points, sum(part.failed for part in parts))


def near_best(best_train_rmse: float | None, train_rmses: Iterable[float | None]) -> int | None:
    """How many of a topology's **Finished** starts are **Near best**: their Train RMSE within
    `NEAR_BEST` of the Best start's, which counts itself (ADR-0021).

    A start whose Train RMSE is `None` (a failed sweep) never counts, and while the Best start's
    is `None`, so is the count.
    """
    if best_train_rmse is None:
        return None
    within = best_train_rmse * (1 + NEAR_BEST)
    return sum(1 for rmse in train_rmses if rmse is not None and rmse <= within)
