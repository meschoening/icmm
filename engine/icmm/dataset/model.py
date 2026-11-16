"""The dataset manifest and its points, with every per-field limit (ADR-0003).

These models are the wire shape too: the schema bundle exports them, so the limits here reach
the desktop's types. Checks that span fields live in `checks.py`.
"""

from __future__ import annotations

from collections.abc import Sequence
from enum import IntEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag

FORMAT = 2

SWEPT = "swept"
MIN_VOLTAGE_MV = -250
MAX_VOLTAGE_MV = 250
MAX_DURATION_MS = 100_000
MAX_POINTS_PER_GAP = 10
MAX_DATASET_NAME = 64
DATASET_NAME = rf"[A-Za-z0-9._-]{{1,{MAX_DATASET_NAME}}}"
MAX_PROTOCOLS = 32
MAX_POINTS = 1000
DEFAULT_SHARE = 0.2
"""The lab's validation share: a fifth of each protocol's points, rounded down (ADR-0011)."""
MIN_SHARE = 0.05
MAX_SHARE = 0.5
PROTOCOL_NAME = r"[A-Za-z0-9_-]{1,32}"


def _fixed_or_swept(value: Any) -> str:
    return SWEPT if value == SWEPT else "fixed"


type Voltage = Annotated[float, Field(ge=MIN_VOLTAGE_MV, le=MAX_VOLTAGE_MV)]
type Duration = Annotated[float, Field(gt=0, le=MAX_DURATION_MS)]
type Fraction = Annotated[float, Field(gt=0, le=1)]

# A step's voltage or duration: a number, or "swept" to take each point's x.
type SweptVoltage = Annotated[
    Annotated[Voltage, Tag("fixed")] | Annotated[Literal["swept"], Tag(SWEPT)],
    Discriminator(_fixed_or_swept),
]
type SweptDuration = Annotated[
    Annotated[Duration, Tag("fixed")] | Annotated[Literal["swept"], Tag(SWEPT)],
    Discriminator(_fixed_or_swept),
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Peak(_Model):
    kind: Literal["peak"]


class TimeToPeak(_Model):
    kind: Literal["time_to_peak"]


class DecayTime(_Model):
    """The time between two fractions of the peak; running upward, a rise (ADR-0010)."""

    kind: Literal["decay_time"]
    from_: Fraction = Field(alias="from")
    to: Fraction


type Measure = Annotated[Peak | TimeToPeak | DecayTime, Field(discriminator="kind")]


class Step(_Model):
    voltage_mV: SweptVoltage
    duration_ms: SweptDuration
    measure: Measure | None = None


class SweptQuantity(IntEnum):
    """Which quantity of a step takes each point's x; the values are the C ABI's."""

    VOLTAGE = 0
    DURATION = 1


def swept_quantities(steps: Sequence[Step]) -> list[tuple[int, SweptQuantity]]:
    """Each swept quantity as (step index, quantity); a protocol that passes its checks has one."""
    swept = []
    for j, step in enumerate(steps):
        if step.voltage_mV == SWEPT:
            swept.append((j, SweptQuantity.VOLTAGE))
        if step.duration_ms == SWEPT:
            swept.append((j, SweptQuantity.DURATION))
    return swept


def measured_steps(steps: Sequence[Step]) -> list[int]:
    """The index of each measured step; a protocol that passes its checks has one."""
    return [j for j, step in enumerate(steps) if step.measure is not None]


class Interpolation(_Model):
    enabled: bool
    points_per_gap: Annotated[int, Field(ge=1, le=MAX_POINTS_PER_GAP)]
    log_x: bool


class Source(_Model):
    """Where the protocol's data came from; shown, never read."""

    workbook: str
    sheet: str


class Point(_Model):
    x: float
    value: float
    sd: Annotated[float, Field(ge=0)] | None
    validation: bool
    interpolated: bool


class TemplatePreset(_Model):
    """Where a new protocol from a template starts: everything but its name, source and points."""

    holding_mV: Voltage
    steps: Annotated[list[Step], Field(min_length=1, max_length=20)]
    normalized: bool
    weight: Annotated[float, Field(gt=0)]
    time_resolution_ms: Annotated[float, Field(gt=0)]
    interpolation: Interpolation
    validation_share: Annotated[float, Field(ge=MIN_SHARE, le=MAX_SHARE)] = DEFAULT_SHARE


class Protocol(_Model):
    name: Annotated[str, Field(pattern=f"^{PROTOCOL_NAME}$")]
    source: Source | None = None
    holding_mV: Voltage
    steps: Annotated[list[Step], Field(min_length=1, max_length=20)]
    normalized: bool
    weight: Annotated[float, Field(gt=0)]
    time_resolution_ms: Annotated[float, Field(gt=0)]
    interpolation: Interpolation
    validation_share: Annotated[float, Field(ge=MIN_SHARE, le=MAX_SHARE)] = DEFAULT_SHARE
    """How much of its points a proposal marks as validation points (ADR-0011). A manifest from
    before it was kept has none, which reads as the lab's 20 %."""
    points: Annotated[list[Point], Field(min_length=1, max_length=MAX_POINTS)]


class Dataset(_Model):
    format: Literal[2]
    id: Annotated[str, Field(pattern=r"^[a-z0-9]{10}$")]
    name: Annotated[str, Field(pattern=f"^{DATASET_NAME}$")]
    protocols: Annotated[list[Protocol], Field(min_length=1, max_length=MAX_PROTOCOLS)]
