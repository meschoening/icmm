"""Templates, derived from a protocol's structure (ADR-0003).

A protocol shows the template whose structure it has: how many steps, which quantity is swept,
and which step is measured and how. Its voltages, durations, decay window and settings don't
count, and a protocol that matches no template is Custom. Only structure counts, so a draft as
the wire carries it, whatever its values, has a template too.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, Protocol

from icmm.dataset.model import SWEPT, TemplatePreset

type Template = Literal[
    "gv_activation", "steady_state_inactivation", "recovery", "decay_time", "time_to_peak"
]


def _preset(
    steps: list[dict[str, object]],
    *,
    normalized: bool,
    time_resolution_ms: float,
    log_x: bool = False,
) -> TemplatePreset:
    return TemplatePreset.model_validate(
        {
            "holding_mV": -100,
            "steps": steps,
            "normalized": normalized,
            "weight": 1,
            "time_resolution_ms": time_resolution_ms,
            "interpolation": {"enabled": False, "points_per_gap": 1, "log_x": log_x},
        }
    )


# The old wizard's defaults; the decay window is the time constant's, 100 % → 37 % (ADR-0010).
TEMPLATES: dict[Template, TemplatePreset] = {
    "gv_activation": _preset(
        [{"voltage_mV": SWEPT, "duration_ms": 10, "measure": {"kind": "peak"}}],
        normalized=True,
        time_resolution_ms=0.1,
    ),
    "steady_state_inactivation": _preset(
        [
            {"voltage_mV": SWEPT, "duration_ms": 500},
            {"voltage_mV": -20, "duration_ms": 25, "measure": {"kind": "peak"}},
        ],
        normalized=True,
        time_resolution_ms=0.1,
    ),
    "recovery": _preset(
        [
            {"voltage_mV": -20, "duration_ms": 500},
            {"voltage_mV": -100, "duration_ms": SWEPT},
            {"voltage_mV": -20, "duration_ms": 50, "measure": {"kind": "peak"}},
        ],
        normalized=True,
        time_resolution_ms=0.1,
        log_x=True,
    ),
    "decay_time": _preset(
        [
            {
                "voltage_mV": SWEPT,
                "duration_ms": 10,
                "measure": {"kind": "decay_time", "from": 1, "to": 0.37},
            }
        ],
        normalized=False,
        time_resolution_ms=0.01,
    ),
    "time_to_peak": _preset(
        [{"voltage_mV": SWEPT, "duration_ms": 10, "measure": {"kind": "time_to_peak"}}],
        normalized=False,
        time_resolution_ms=0.05,
    ),
}


class _Measure(Protocol):
    @property
    def kind(self) -> str: ...


class _Step(Protocol):
    @property
    def voltage_mV(self) -> object: ...
    @property
    def duration_ms(self) -> object: ...
    @property
    def measure(self) -> _Measure | None: ...


class _Steps(Protocol):
    """A protocol, a preset or a draft on the wire: anything with steps."""

    @property
    def steps(self) -> Sequence[_Step]: ...


def template_of(protocol: _Steps) -> Template | Literal["custom"]:
    structure = _structure(protocol.steps)
    for template, preset in TEMPLATES.items():
        if _structure(preset.steps) == structure:
            return template
    return "custom"


def _structure(steps: Sequence[_Step]) -> tuple[object, ...]:
    swept = tuple(
        (j, quantity)
        for j, step in enumerate(steps)
        for quantity, value in (("voltage", step.voltage_mV), ("duration", step.duration_ms))
        if value == SWEPT
    )
    measured = tuple((j, step.measure.kind) for j, step in enumerate(steps) if step.measure)
    return len(steps), swept, measured
