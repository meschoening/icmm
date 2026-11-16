"""Editing a dataset: a protocol whose measured points, interpolation or validation share change
is made afresh.

Its interpolated points are made again and its proposed split redrawn; every other protocol keeps
its points and marks (ADR-0011).
"""

from __future__ import annotations

import random

from icmm.dataset.checks import DatasetError, Issue
from icmm.dataset.interpolation import interpolate
from icmm.dataset.model import Dataset, Protocol
from icmm.dataset.split import propose_split


def regenerate(
    before: Dataset | None, after: Dataset, *, rng: random.Random | None = None
) -> Dataset:
    """`after`, an edit of `before`, with each changed protocol's points and proposal redrawn,
    each proposal at its protocol's validation share.

    A protocol is unchanged when `before` has one with the same points (x and value), the same
    validation share and, while it's on, the same interpolation settings, whatever its name or
    place, so renaming and reordering keep marks. Marks, SD and every other setting can change
    without a redraw. With each match, one prior occurrence is consumed, so added duplicates are
    made afresh. With no `before`, as for a dataset just read from a workbook, every protocol is
    made afresh.
    Raises `DatasetError`, its issues rooted at `("protocols", i)`, when a spline can't be drawn.
    """
    rng = rng or random.Random()
    unchanged = [_points(protocol) for protocol in before.protocols] if before else []
    protocols: list[Protocol] = []
    issues: list[Issue] = []
    for i, protocol in enumerate(after.protocols):
        signature = _points(protocol)
        if signature in unchanged:
            unchanged.remove(signature)
            protocols.append(protocol)
            continue
        try:
            protocols.append(propose_split(interpolate(protocol), rng=rng))
        except DatasetError as error:
            issues += [
                Issue(path=("protocols", i, *x.path), message=x.message) for x in error.issues
            ]
    if issues:
        raise DatasetError(issues)
    return after.model_copy(update={"protocols": protocols})


def _points(protocol: Protocol) -> object:
    """What decides the protocol's points: their x, values and kind, the interpolation settings
    while it's on, and its validation share. An interpolated point that changes is made again."""
    interpolation = protocol.interpolation
    points = sorted((p.x, p.value, p.interpolated) for p in protocol.points)
    return interpolation if interpolation.enabled else None, protocol.validation_share, points
