"""The proposed split: the validation points the Dataset wizard marks for the user (ADR-0011).

A proposal is drawn afresh each time, so no seed is kept: the marks are the record. The desktop's
engine draws it; the agent never does (ADR-0013).
"""

from __future__ import annotations

import math
import random

from icmm.dataset.model import Protocol


def propose_split(protocol: Protocol, *, rng: random.Random | None = None) -> Protocol:
    """`protocol` with its validation marks replaced by a fresh proposal.

    It marks the protocol's validation share of its points, rounded down, measured and
    interpolated alike, and none of a protocol with fewer than 3, such as a draft's with none
    yet. It never marks the lowest or highest x, so validation tests the curve between
    measurements, nor a normalized protocol's largest value, since holding that out would shrink
    the model's train normalizer.
    """
    share = protocol.validation_share
    if not 0 <= share <= 1:
        raise ValueError(f"The share must be from 0 to 1, not {share}.")
    points = protocol.points
    n = len(points)
    if n == 0:
        return protocol
    # Rounded first, so that 29 % of 100 points is 29, not 28.999999999999996 rounded down.
    count = math.floor(round(share * n, 9)) if n >= 3 else 0
    ends = (min(p.x for p in points), max(p.x for p in points))
    largest = max(p.value for p in points)
    eligible = [
        k
        for k, p in enumerate(points)
        if p.x not in ends and not (protocol.normalized and p.value == largest)
    ]
    held_out = set((rng or random.Random()).sample(eligible, min(count, len(eligible))))
    marked = [p.model_copy(update={"validation": k in held_out}) for k, p in enumerate(points)]
    return protocol.model_copy(update={"points": marked})
