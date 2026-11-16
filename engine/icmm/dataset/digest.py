"""The scoring digest: runs on one dataset rank together when their revisions' digests match.

It covers everything that can change a score (ADR-0003): each protocol's holding potential,
steps, measure and window, time resolution, Normalized and Weight, and each point's x, value and
validation mark. Names, the id, protocol and point order, SD, the source, the interpolation
settings and the validation share stay out; interpolated points are in it as points.
"""

from __future__ import annotations

import hashlib
import json

from icmm.dataset.model import SWEPT, Dataset, DecayTime, Protocol, Step


def scoring_digest(dataset: Dataset) -> str:
    """A sha256 in hex; protocols count as a multiset, so their order and names don't matter."""
    protocols = sorted(_sha256(_scoring_view(p)) for p in dataset.protocols)
    return _sha256(protocols)


def _scoring_view(protocol: Protocol) -> object:
    return {
        "holding_mV": _canonical(protocol.holding_mV),
        "steps": [_step(step) for step in protocol.steps],
        "time_resolution_ms": _canonical(protocol.time_resolution_ms),
        "normalized": protocol.normalized,
        "weight": _canonical(protocol.weight),
        "points": sorted(
            (_canonical(p.x), _canonical(p.value), p.validation) for p in protocol.points
        ),
    }


def _step(step: Step) -> object:
    measure = step.measure
    return {
        "voltage_mV": _quantity(step.voltage_mV),
        "duration_ms": _quantity(step.duration_ms),
        "measure": measure and measure.kind,
        "window": [_canonical(measure.from_), _canonical(measure.to)]
        if isinstance(measure, DecayTime)
        else None,
    }


def _quantity(value: float | str) -> float | str:
    return SWEPT if value == SWEPT else _canonical(float(value))


def _canonical(value: float) -> float:
    return float(value) + 0.0  # 1 and 1.0 alike, and −0 as 0


def _sha256(value: object) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode()).hexdigest()
