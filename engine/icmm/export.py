"""Exporting a start (#344, #336 decision 7): its parameters, and its fit with its traces, as the
desktop's **Host engine** writes them where the user chose (ADR-0013, ADR-0015).

What's shown or exported is canonical (ADR-0007): each state read relative to the open state,
with b > 0, under `parameter_names`' names. The RMSEs and the Cost are the ones its worker
stored, weighted as ADR-0006 has them, so they agree with every page that shows them. The fit is
simulated again by this engine, and the traces keep every moment the measured step records at
its protocol's Time resolution: the drawing strides each sweep to at most 256 moments and its
end (`trace_samples`), too coarse to lay over a recording.

A file is written through a file of its own beside it, then renamed over the chosen one, so a
failed export leaves whatever was there before.
"""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from collections.abc import Callable, Iterable, Iterator, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, TextIO

from icmm.core import Core, Session, Topology
from icmm.dataset import Dataset, Protocol, core_arrays, recorded_moments
from icmm.dataset.model import (
    SWEPT,
    DecayTime,
    Measure,
    Peak,
    SweptQuantity,
    measured_steps,
    swept_quantities,
)
from icmm.durable import fsync_folder, replace_file
from icmm.parameters import canonical, parameter_names
from icmm.scoring import ProtocolErrors
from icmm.simulation import simulate
from icmm.wire.export import ExportedRun, ExportedStart
from icmm.wire.simulation import StartFit

FIT_HEADER = (
    "protocol",
    "x",
    "value",
    "sd",
    "simulated",
    "validation",
    "interpolated",
    "x_unit",
    "value_unit",
    "normalized",
    "capped",
)
"""A fit's columns: a dataset file's (`x,value,sd,validation,interpolated`), its protocol first
and the start's simulated value beside its data; then how to read them (RF14, #368): x's unit,
the unit of its value, SD and simulated value, whether they're normalized, and whether the
simulated value is a decay time at its cap."""
DECAY_CAP = 1e6
"""A decay time that never ends in its step is this many of its Time resolution (the core's
`measure.cc`)."""
TRACES_HEADER = ("protocol", "x", "time_ms", "voltage_mV", "open_probability")
"""A trace's columns: each recorded sweep, named by its protocol and its x, at each moment of
its measured step, timed from the sweep's start as the inspector draws it, to its Time
resolution's places (RF14, #368)."""


def is_csv(path: Path) -> bool:
    """Whether a start's parameters go to `path` as CSV, which its name ending `.csv` asks for;
    JSON otherwise."""
    return path.name.lower().endswith(".csv")


def traces_name(name: str) -> str:
    """The traces file's name beside a fit named `name`: `-traces` before its `.csv`."""
    stem = name[:-4] if name.lower().endswith(".csv") else name
    return f"{stem}-traces.csv"


def parameters_document(
    topology: Topology,
    dataset: Dataset | None,
    fit: StartFit,
    start: ExportedStart,
    run: ExportedRun,
) -> dict[str, Any]:
    """A start's parameters as Export writes them, in the order a reader takes them in: which
    start, its topology, its parameters, how well they fit, then what its run fit them with.

    Its Train and Val RMSE and its Cost are the ones its worker stored, as the Start page shows
    them. Each protocol's RMSE is its Protocol RMSE, √(SSE / n) in its data's units, from the
    scores its worker stored; without `dataset`, a revision this ICMM can't read, the protocols
    go without their weights, named as the run recorded them (#387). Either way, `fit.scores`
    holds one score a protocol.
    """
    written = f"T{fit.graph}.{fit.open_state}"
    values = canonical(topology, fit.parameters)
    protocols = None if dataset is None else dataset.protocols
    names = run.protocols if protocols is None else [p.name for p in protocols]
    return {
        "start": f"#{fit.run}/{written} start {fit.start}",
        "run": {"id": fit.run, "config": run.config_name},
        "topology": {
            "id": written,
            "num_states": topology.num_states,
            "open_state": topology.open_state,
            "edges": [sorted(edge) for edge in topology.edges],
        },
        "parameters": dict(zip(parameter_names(topology), values, strict=True)),
        "read": read_line(topology),
        "train_rmse": start.train_rmse,
        "val_rmse": start.val_rmse,
        "cost": start.cost,
        "protocols": [
            {
                "name": names[i] if i < len(names) else None,
                "weight": None if protocols is None else protocols[i].weight,
                "train_rmse": _rmse(s.train_sse, s.train_points, s.train_failed),
                "val_rmse": _rmse(s.val_sse, s.val_points, s.val_failed),
            }
            for i, s in enumerate(fit.scores)
        ],
        "settings": None if run.settings is None else run.settings.model_dump(mode="json"),
        "search_seed": run.search_seed,
        "seed": start.seed,
        "engine": fit.engine,
        "dataset": {
            "id": fit.dataset_id,
            "name": run.dataset_name,
            "revision": fit.dataset_revision,
        },
    }


def read_line(topology: Topology) -> str:
    """How to read the parameters (#42, RF14): each state against the open state, folded to
    b > 0, in natural-log units but the sigmoid's a and b, which are in mV (ADR-0007)."""
    return f"relative to open state {topology.open_state}, with b > 0; ln units, a and b in mV"


def _rmse(sse: float, points: int, failed: int) -> float | None:
    """A Protocol RMSE as `icmm.scoring` has it: `None` where a point failed, or without
    points."""
    return ProtocolErrors(sse, points, failed, sse, points).rmse


def parameters_json(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def parameters_csv(document: dict[str, Any]) -> str:
    """The document as two columns, `name,value`, one row a value, as a spreadsheet reads it:
    nested keys joined by `.`, each protocol's under its name (`protocol_2` for an unnamed one),
    edges written as the parameters name them (`0_1 1_3`), and a list in the settings as its
    JSON. An empty cell is `null`."""
    rows: list[tuple[str, object]] = [
        ("start", document["start"]),
        ("run", document["run"]["id"]),
        ("config", document["run"]["config"]),
        ("dataset", document["dataset"]["name"]),
        ("dataset_id", document["dataset"]["id"]),
        ("dataset_revision", document["dataset"]["revision"]),
        ("topology", document["topology"]["id"]),
        ("num_states", document["topology"]["num_states"]),
        ("open_state", document["topology"]["open_state"]),
        ("edges", " ".join(f"{i}_{j}" for i, j in document["topology"]["edges"])),
        ("read", document["read"]),
        *document["parameters"].items(),
        ("train_rmse", document["train_rmse"]),
        ("val_rmse", document["val_rmse"]),
        ("cost", document["cost"]),
    ]
    for i, p in enumerate(document["protocols"]):
        named = f"protocol_{i + 1}" if p["name"] is None else p["name"]
        rows += [(f"{named}.{key}", p[key]) for key in ("weight", "train_rmse", "val_rmse")]
    if document["settings"] is not None:
        rows += _flattened("settings", document["settings"])
    rows += [
        ("search_seed", document["search_seed"]),
        ("seed", document["seed"]),
        ("engine", document["engine"]),
    ]
    return _csv_text([("name", "value"), *((name, _cell(value)) for name, value in rows)])


def _flattened(prefix: str, node: object) -> Iterator[tuple[str, object]]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _flattened(f"{prefix}.{key}", value)
    elif isinstance(node, list):
        yield prefix, json.dumps(node, separators=(",", ":"), allow_nan=False)
    else:
        yield prefix, node


def _cell(value: object) -> str:
    """A value as a CSV cell: a float to all its digits, a whole one as an integer, `null` empty,
    and a bool as 1 or 0, as a dataset file marks its points."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 2**53 else repr(value)
    return str(value)


def _csv_text(rows: Iterable[Sequence[str]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerows(rows)
    return out.getvalue()


def fit_csv(core: Core, topology: Topology, dataset: Dataset, parameters: Sequence[float]) -> str:
    """Each point's data beside its simulated value, `null` (empty) for a **Failed sweep**,
    protocol by protocol, each in order of x as the core reads its points, with its units, its
    normalization and its cap."""
    rows: list[Sequence[str]] = [FIT_HEADER]
    for protocol, simulated in zip(
        dataset.protocols, simulate(core, topology, dataset, parameters), strict=True
    ):
        points = sorted(protocol.points, key=lambda p: p.x)
        units = x_unit(protocol), value_unit(protocol)
        capped = _capped(core, topology, protocol, parameters)
        for point, drawn, cap in zip(points, simulated.points, capped, strict=True):
            rows.append(
                (
                    protocol.name,
                    _cell(point.x),
                    _cell(point.value),
                    _cell(point.sd),
                    _cell(drawn.value),
                    _cell(point.validation),
                    _cell(point.interpolated),
                    *units,
                    _cell(protocol.normalized),
                    _cell(cap),
                )
            )
    return _csv_text(rows)


def x_unit(protocol: Protocol) -> str:
    """The unit of a protocol's x: its swept voltage's, mV, or its swept duration's, ms."""
    _, quantity = swept_quantities(protocol.steps)[0]
    return "ms" if quantity == SweptQuantity.DURATION else "mV"


def value_unit(protocol: Protocol) -> str:
    """The unit of a protocol's values: a fraction of the largest where it's normalized (ADR-0010),
    else a peak's open probability or a time's ms."""
    if protocol.normalized:
        return "fraction"
    return "open probability" if isinstance(_measure(protocol), Peak) else "ms"


def _measure(protocol: Protocol) -> Measure:
    measure = protocol.steps[measured_steps(protocol.steps)[0]].measure
    assert measure is not None
    return measure


def _capped(
    core: Core, topology: Topology, protocol: Protocol, parameters: Sequence[float]
) -> list[bool]:
    """Whether each point's simulated decay time is its cap, a decay that never ended in its
    step: simulated without normalizing, since a normalized one is a fraction of the largest.
    A rise, a peak and a time to peak have none."""
    measure = _measure(protocol)
    if not isinstance(measure, DecayTime) or measure.from_ < measure.to:
        return [False] * len(protocol.points)
    raw = protocol.model_copy(update={"normalized": False})
    with Session(core, topology, [core_arrays(raw)]) as session:
        values = session.simulate(parameters, 1).values[0]
    cap = DECAY_CAP * protocol.time_resolution_ms
    return [value is not None and value >= cap for value in values]


def write_traces(
    out: TextIO,
    core: Core,
    topology: Topology,
    dataset: Dataset,
    parameters: Sequence[float],
) -> None:
    """Every recorded sweep's open probability over its measured step, at every moment its Time
    resolution records, written to `out` as CSV: `null` (empty) where a failed sweep's simulation
    isn't a number. An interpolated point isn't a recorded sweep, so it has no trace.

    Each sweep is simulated on its own, so memory holds one sweep's moments at a time however
    many the dataset records: a sweep is simulated from rest at the holding potential whatever
    the others are, so its trace is the one the whole protocol's simulation gives it.
    """
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(TRACES_HEADER)
    for protocol in dataset.protocols:
        measured = measured_steps(protocol.steps)[0]
        for point in sorted(protocol.points, key=lambda p: p.x):
            if point.interpolated:
                continue
            offset, voltage, duration = _measured_step(protocol, measured, point.x)
            one = protocol.model_copy(update={"points": [point]})
            moments = recorded_moments(duration, protocol.time_resolution_ms)
            # One more than it strides past, so every moment the core records is kept.
            with Session(core, topology, [core_arrays(one)]) as session:
                trace = session.simulate(parameters, moments).traces[0][0]
            cells = _cell(point.x), _cell(voltage)
            # Each moment to the Time resolution's places, and the step's own end to its own.
            digits = max(_places(v) for v in (protocol.time_resolution_ms, offset, duration))
            writer.writerows(
                (protocol.name, cells[0], _cell(round(offset + t, digits)), cells[1], _cell(p))
                for t, p in zip(trace.time_ms, trace.open_probability, strict=True)
            )


def _places(value: float) -> int:
    """How many decimal places `value` takes as written: 1 for 0.1 ms, 0 for 500 ms."""
    exponent = Decimal(repr(value)).normalize().as_tuple().exponent
    return max(0, -exponent) if isinstance(exponent, int) else 0


def _measured_step(protocol: Protocol, measured: int, x: float) -> tuple[float, float, float]:
    """The sweep at `x`'s measured step: when it starts from the sweep's start, its voltage and
    its duration, each step's swept quantity taking x. The start is the steps' sum as written,
    0.3 ms after steps of 0.1 and 0.2 ms, not their float sum."""

    def value(v: float | str) -> float:
        return x if v == SWEPT else float(v)

    offset = float(sum(Decimal(repr(value(s.duration_ms))) for s in protocol.steps[:measured]))
    step = protocol.steps[measured]
    return offset, value(step.voltage_mV), value(step.duration_ms)


def write_text(path: Path, text: str) -> None:
    """`text` as `path`, written whole."""
    write_streamed(path, lambda out: out.write(text))


def write_streamed(path: Path, write: Callable[[TextIO], object]) -> None:
    """What `write` writes as `path`, UTF-8 with LF line ends: through a file of its own beside
    it, flushed, then renamed over it, so a failure leaves what was there before."""
    fd, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    part = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as out:
            write(out)
            out.flush()
            os.fsync(out.fileno())
        replace_file(part, path)
        fsync_folder(path.parent)
    finally:
        part.unlink(missing_ok=True)
