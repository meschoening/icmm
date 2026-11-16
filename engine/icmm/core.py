"""The C++ core (libicmm) through its C ABI: scoring parameter vectors against a dataset.

A `Session` holds one topology and one dataset's protocols, as `icmm.dataset.core_arrays` builds
them; it scores parameter vectors and returns each protocol's raw, unweighted squared error over
its train and validation points, and each point's model value (ADR-0010). It also simulates one
vector whole for drawing it, each sweep's open probability over its measured step beside those
(#88). Weights, costs and RMSE apply above it (ADR-0006). The types here mirror
`engine/cpp/include/icmm.h`.
"""

from __future__ import annotations

import ctypes
import math
import os
import sys
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Self

from icmm.dataset import ProtocolArrays

# The C ABI this module's types mirror (ICMM_ABI_VERSION in icmm.h).
ABI_VERSION = 3

TRACE_SAMPLES = 256
"""The most strided moments a drawn sweep keeps before its last, as the old app's per-start
traces kept them (old ADR-0010)."""

_OK = 0


class CoreError(Exception):
    """The core refused a call; the message is its own."""


def library_name() -> str:
    """libicmm's file name on this OS."""
    if sys.platform == "win32":
        return "icmm.dll"
    if sys.platform == "darwin":
        return "libicmm.dylib"
    return "libicmm.so"


def packaged_library() -> Path:
    """Where an installed engine keeps libicmm: inside the package, in `_native/`."""
    return Path(__file__).parent / "_native" / library_name()


@dataclass(frozen=True)
class Topology:
    """A state graph: edge i joins `edges[i]`, in the order of the edge parameters."""

    num_states: int
    edges: tuple[tuple[int, int], ...]
    open_state: int


@dataclass(frozen=True)
class ProtocolScore:
    """One protocol's score for one parameter vector. Failed points add nothing to a sum."""

    train_sse: float
    val_sse: float
    train_points: int
    train_failed: int
    val_points: int
    val_failed: int


@dataclass(frozen=True)
class Trace:
    """A sweep's open probability over its measured step, from its start, in ms. A failed sweep
    holds None wherever its simulation wasn't a number."""

    time_ms: list[float]
    open_probability: list[float | None]


@dataclass(frozen=True)
class Simulation:
    """One parameter vector simulated whole: per protocol, each point's value as
    `Session.point_values` gives it, each point's sweep, and its score as `Session.score` gives
    it."""

    values: list[list[float | None]]
    traces: list[list[Trace]]
    scores: list[ProtocolScore]


class _Topology(ctypes.Structure):
    _fields_ = [
        ("num_states", ctypes.c_int32),
        ("num_edges", ctypes.c_int32),
        ("edges", ctypes.POINTER(ctypes.c_int32)),
        ("open_state", ctypes.c_int32),
    ]


_Doubles = ctypes.POINTER(ctypes.c_double)


class _Protocol(ctypes.Structure):
    _fields_ = [
        ("holding_mV", ctypes.c_double),
        ("num_steps", ctypes.c_int32),
        ("step_voltage_mV", _Doubles),
        ("step_duration_ms", _Doubles),
        ("swept_step", ctypes.c_int32),
        ("swept_quantity", ctypes.c_int32),
        ("measured_step", ctypes.c_int32),
        ("measure", ctypes.c_int32),
        ("decay_from", ctypes.c_double),
        ("decay_to", ctypes.c_double),
        ("time_resolution_ms", ctypes.c_double),
        ("normalized", ctypes.c_int32),
        ("num_points", ctypes.c_int32),
        ("x", _Doubles),
        ("value", _Doubles),
        ("validation", ctypes.POINTER(ctypes.c_uint8)),
    ]


class _Score(ctypes.Structure):
    _fields_ = [
        ("train_sse", ctypes.c_double),
        ("val_sse", ctypes.c_double),
        ("train_points", ctypes.c_int32),
        ("train_failed", ctypes.c_int32),
        ("val_points", ctypes.c_int32),
        ("val_failed", ctypes.c_int32),
    ]


class _Simulation(ctypes.Structure):
    _fields_ = [
        ("values", _Doubles),
        ("num_values", ctypes.c_int32),
        ("scores", ctypes.POINTER(_Score)),
        ("max_samples", ctypes.c_int32),
        ("trace_lengths", ctypes.POINTER(ctypes.c_int32)),
        ("trace_time_ms", _Doubles),
        ("trace_open", _Doubles),
        ("trace_capacity", ctypes.c_int64),
    ]


class Core:
    """libicmm, loaded from `path`."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        lib = ctypes.CDLL(str(Path(path)))
        lib.icmm_abi_version.argtypes = []
        lib.icmm_abi_version.restype = ctypes.c_int32
        built_for = lib.icmm_abi_version()
        if built_for != ABI_VERSION:
            raise CoreError(
                f"{path} was built for ABI {built_for}; this engine needs ABI {ABI_VERSION}."
            )
        lib.icmm_version.argtypes = []
        lib.icmm_version.restype = ctypes.c_char_p
        lib.icmm_last_error.argtypes = []
        lib.icmm_last_error.restype = ctypes.c_char_p
        lib.icmm_session_create.argtypes = [
            ctypes.POINTER(_Topology),
            ctypes.POINTER(_Protocol),
            ctypes.c_int32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.icmm_session_create.restype = ctypes.c_int32
        lib.icmm_session_destroy.argtypes = [ctypes.c_void_p]
        lib.icmm_session_destroy.restype = None
        lib.icmm_param_count.argtypes = [ctypes.c_void_p]
        lib.icmm_param_count.restype = ctypes.c_int32
        lib.icmm_score.argtypes = [
            ctypes.c_void_p,
            _Doubles,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.POINTER(_Score),
        ]
        lib.icmm_score.restype = ctypes.c_int32
        lib.icmm_point_values.argtypes = [ctypes.c_void_p, _Doubles, _Doubles, ctypes.c_int32]
        lib.icmm_point_values.restype = ctypes.c_int32
        lib.icmm_simulate.argtypes = [ctypes.c_void_p, _Doubles, ctypes.POINTER(_Simulation)]
        lib.icmm_simulate.restype = ctypes.c_int32
        self._lib = lib

    @property
    def version(self) -> str:
        return self._lib.icmm_version().decode()

    def _check(self, status: int) -> None:
        if status != _OK:
            raise CoreError(self._lib.icmm_last_error().decode(errors="replace"))


class Session:
    """One topology and one dataset's protocols, loaded into the core. Close it when done."""

    def __init__(self, core: Core, topology: Topology, protocols: Sequence[ProtocolArrays]) -> None:
        self._core = core
        self._handle = ctypes.c_void_p()
        self.num_protocols = len(protocols)
        self._points = [len(p.x) for p in protocols]
        flat = [state for edge in topology.edges for state in edge]
        edges = (ctypes.c_int32 * max(len(flat), 1))(*flat)
        c_topology = _Topology(topology.num_states, len(topology.edges), edges, topology.open_state)
        c_protocols = (_Protocol * max(len(protocols), 1))(*(_protocol(p) for p in protocols))
        core._check(
            core._lib.icmm_session_create(
                ctypes.byref(c_topology), c_protocols, len(protocols), ctypes.byref(self._handle)
            )
        )
        self.num_params: int = core._lib.icmm_param_count(self._handle)

    def score(self, params: Sequence[float]) -> list[ProtocolScore]:
        """Each protocol's score for one parameter vector."""
        return self.score_batch([params])[0]

    def score_batch(
        self, params: Sequence[Sequence[float]], threads: int = 1
    ) -> list[list[ProtocolScore]]:
        """Each protocol's score for each parameter vector, on up to `threads` threads."""
        for i, vector in enumerate(params):
            self._check_length(i, vector)
        flat = (ctypes.c_double * max(len(params) * self.num_params, 1))(
            *(value for vector in params for value in vector)
        )
        scores = (_Score * max(len(params) * self.num_protocols, 1))()
        self._core._check(
            self._core._lib.icmm_score(self._handle, flat, len(params), threads, scores)
        )
        n = self.num_protocols
        return [[_score(s) for s in scores[i * n : (i + 1) * n]] for i in range(len(params))]

    def point_values(self, params: Sequence[float]) -> list[list[float | None]]:
        """Each protocol's model value at each of its points for one parameter vector: what the
        point's score compares with its data, divided as its protocol is normalized. A failed
        point's value is None."""
        self._check_length(0, params)
        vector = (ctypes.c_double * max(len(params), 1))(*params)
        total = sum(self._points)
        values = (ctypes.c_double * max(total, 1))()
        self._core._check(self._core._lib.icmm_point_values(self._handle, vector, values, total))
        out: list[list[float | None]] = []
        start = 0
        for n in self._points:
            out.append([None if math.isnan(v) else v for v in values[start : start + n]])
            start += n
        return out

    def simulate(self, params: Sequence[float], max_samples: int = TRACE_SAMPLES) -> Simulation:
        """One parameter vector simulated whole, for drawing it: each sweep's trace keeps at most
        `max_samples` strided moments of its measured step, then its end. Its values and scores
        are exactly `point_values`' and `score`'s."""
        self._check_length(0, params)
        vector = (ctypes.c_double * max(len(params), 1))(*params)
        total = sum(self._points)
        capacity = max(total * (max_samples + 1), 1)
        values = (ctypes.c_double * max(total, 1))()
        scores = (_Score * max(self.num_protocols, 1))()
        lengths = (ctypes.c_int32 * max(total, 1))()
        times = (ctypes.c_double * capacity)()
        opens = (ctypes.c_double * capacity)()
        out = _Simulation(values, total, scores, max_samples, lengths, times, opens, capacity)
        self._core._check(self._core._lib.icmm_simulate(self._handle, vector, ctypes.byref(out)))
        drawn: list[list[float | None]] = []
        traces: list[list[Trace]] = []
        point = moment = 0
        for n in self._points:
            drawn.append([None if math.isnan(v) else v for v in values[point : point + n]])
            sweeps = []
            for length in lengths[point : point + n]:
                span = slice(moment, moment + length)
                sweeps.append(
                    Trace(
                        time_ms=times[span],
                        open_probability=[v if math.isfinite(v) else None for v in opens[span]],
                    )
                )
                moment += length
            traces.append(sweeps)
            point += n
        return Simulation(
            values=drawn, traces=traces, scores=[_score(s) for s in scores[: self.num_protocols]]
        )

    def _check_length(self, i: int, vector: Sequence[float]) -> None:
        if len(vector) != self.num_params:
            raise CoreError(
                f"vector {i}: it has {len(vector)} parameters; the topology takes "
                f"{self.num_params}."
            )

    def close(self) -> None:
        if self._handle:
            self._core._lib.icmm_session_destroy(self._handle)
            self._handle = ctypes.c_void_p()

    def __del__(self) -> None:
        if hasattr(self, "_handle"):
            self.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


def _score(s: _Score) -> ProtocolScore:
    return ProtocolScore(
        s.train_sse, s.val_sse, s.train_points, s.train_failed, s.val_points, s.val_failed
    )


def _doubles(values: array[float], name: str) -> ctypes.Array[ctypes.c_double]:
    if values.typecode != "d":
        raise TypeError(f"{name}: the core reads it as doubles, array('d').")
    return (ctypes.c_double * len(values)).from_buffer(values)


def _protocol(p: ProtocolArrays) -> _Protocol:
    """`p` as the ABI's struct, over its own arrays without copying; the session copies them."""
    if not len(p.x) == len(p.value) == len(p.validation):
        raise CoreError("x, value, and validation must have equal lengths.")
    if len(p.step_voltage_mV) != len(p.step_duration_ms):
        raise CoreError("step_voltage_mV and step_duration_ms must have equal lengths.")
    if p.validation.typecode != "B":
        raise TypeError("validation: the core reads it as bytes, array('B').")
    validation = (ctypes.c_uint8 * len(p.validation)).from_buffer(p.validation)
    return _Protocol(
        holding_mV=p.holding_mV,
        num_steps=len(p.step_voltage_mV),
        step_voltage_mV=_doubles(p.step_voltage_mV, "step_voltage_mV"),
        step_duration_ms=_doubles(p.step_duration_ms, "step_duration_ms"),
        swept_step=p.swept_step,
        swept_quantity=int(p.swept_quantity),
        measured_step=p.measured_step,
        measure=int(p.measure),
        decay_from=p.decay_from,
        decay_to=p.decay_to,
        time_resolution_ms=p.time_resolution_ms,
        normalized=int(p.normalized),
        num_points=len(p.x),
        x=_doubles(p.x, "x"),
        value=_doubles(p.value, "value"),
        validation=validation,
    )
