"""What the C++ core receives for one protocol: typed arrays, never a dataset file (ADR-0003).

The arrays pass to ctypes without copying: `(c_double * n).from_buffer(arrays.x)`. Weight is not
here; it applies above the core (ADR-0006).
"""

from __future__ import annotations

import math
from array import array
from dataclasses import dataclass
from enum import IntEnum

from icmm.dataset.model import (
    SWEPT,
    DecayTime,
    Peak,
    Protocol,
    SweptQuantity,
    TimeToPeak,
    measured_steps,
    swept_quantities,
)


class MeasureCode(IntEnum):
    PEAK = 1
    DECAY_TIME = 2
    TIME_TO_PEAK = 3


@dataclass(frozen=True)
class ProtocolArrays:
    holding_mV: float
    step_voltage_mV: array[float]  # NaN at the swept step's voltage
    step_duration_ms: array[float]  # NaN at the swept step's duration
    swept_step: int
    swept_quantity: SweptQuantity
    measured_step: int
    measure: MeasureCode
    decay_from: float  # NaN unless the measure is a decay time
    decay_to: float
    time_resolution_ms: float
    normalized: bool
    x: array[float]  # sorted
    value: array[float]
    validation: array[int]  # 1 for a validation point


def core_arrays(protocol: Protocol) -> ProtocolArrays:
    """`protocol`, which has passed its checks, as the core's arrays."""
    swept = swept_quantities(protocol.steps)
    measured = measured_steps(protocol.steps)
    if len(swept) != 1 or len(measured) != 1:
        raise ValueError(f"{protocol.name}: needs one swept quantity and one measured step")
    measure = protocol.steps[measured[0]].measure
    points = sorted(protocol.points, key=lambda p: p.x)
    return ProtocolArrays(
        holding_mV=protocol.holding_mV,
        step_voltage_mV=array("d", (_or_nan(s.voltage_mV) for s in protocol.steps)),
        step_duration_ms=array("d", (_or_nan(s.duration_ms) for s in protocol.steps)),
        swept_step=swept[0][0],
        swept_quantity=swept[0][1],
        measured_step=measured[0],
        measure=_MEASURE_CODES[type(measure)],
        decay_from=measure.from_ if isinstance(measure, DecayTime) else math.nan,
        decay_to=measure.to if isinstance(measure, DecayTime) else math.nan,
        time_resolution_ms=protocol.time_resolution_ms,
        normalized=protocol.normalized,
        x=array("d", (p.x for p in points)),
        value=array("d", (p.value for p in points)),
        validation=array("B", (p.validation for p in points)),
    )


_MEASURE_CODES = {
    Peak: MeasureCode.PEAK,
    DecayTime: MeasureCode.DECAY_TIME,
    TimeToPeak: MeasureCode.TIME_TO_PEAK,
}


def _or_nan(value: float | str) -> float:
    return math.nan if value == SWEPT else float(value)
