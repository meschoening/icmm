"""`validate_dataset`: the per-field limits and every cross-field check (ADR-0003).

Each issue carries a path to the field or point it is about and a sentence to show there. A
protocol's cross-field checks run once its own fields are within their limits, so an issue in
one protocol never hides another's.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from icmm import names
from icmm.dataset.model import (
    MAX_DURATION_MS,
    MAX_VOLTAGE_MV,
    MIN_VOLTAGE_MV,
    Dataset,
    DecayTime,
    Peak,
    Protocol,
    SweptQuantity,
    TimeToPeak,
    measured_steps,
    swept_quantities,
)

type IssuePath = tuple[str | int, ...]


class Issue(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: IssuePath
    message: str


class DatasetError(ValueError):
    """A dataset that fails its checks, with every issue found."""

    def __init__(self, issues: list[Issue]) -> None:
        super().__init__("; ".join(_located(i) for i in issues))
        self.issues = issues


def _located(issue: Issue) -> str:
    """The issue as one line, after the path to its field if it has one."""
    return f"{'.'.join(map(str, issue.path))}: {issue.message}" if issue.path else issue.message


UNKNOWN_FORMAT = "This dataset's format isn't one this version of ICMM can read."
REPEATED_X = "Another point already has this x."
LOG_X_NEEDS_POSITIVE_X = "A log x-axis needs every x above 0."
POINTS_PER_GAP = "Points per gap must be a whole number from 1 to 10."
VALIDATION_SHARE = "The validation share must be from 5 % to 50 %."
DECAY_PAST_THE_STEP = "A decay time must be shorter than the measured step's duration."
MAX_RECORDED_MOMENTS = 1_000_000


def validate_dataset(raw: Any, *, names_in_use: Iterable[str] = ()) -> list[Issue]:
    """Every issue with `raw`, a dataset as the wire or a revision's files give it.

    A built `Dataset` is checked afresh, since its fields can change after it was built.
    `names_in_use` are the names of the platform's other datasets.
    """
    if isinstance(raw, Dataset):
        raw = raw.model_dump(by_alias=True, warnings=False)
    try:
        dataset = Dataset.model_validate(raw)
    except ValidationError as error:
        return _field_issues(error) + _cross_field_issues_of_valid_protocols(raw, names_in_use)
    return _cross_field_issues(dataset.name, list(enumerate(dataset.protocols)), names_in_use, True)


def recorded_moments(duration_ms: float, time_resolution_ms: float) -> int:
    """Moments a measured step records: its first, then one each time resolution to its end.

    The last interval is shorter when the duration isn't a whole number of them (ADR-0010). A
    duration within 1e-12 (relative) of a whole number counts as whole, so rounding in
    duration ÷ resolution never adds a moment. The core records on this count.
    """
    steps = duration_ms / time_resolution_ms
    nearest = round(steps)
    whole = math.isclose(steps, nearest, rel_tol=1e-12)
    return (nearest if whole else math.ceil(steps)) + 1


# Tags the model's unions add to an error's location; the path to the field leaves them out.
_UNION_TAGS = frozenset({"fixed", "swept", "peak", "decay_time", "time_to_peak"})

_FIELD_SENTENCES = {
    "id": "The dataset id must be 10 lowercase letters or digits.",
    "format": UNKNOWN_FORMAT,
    "protocols": "A dataset has 1 to 32 protocols.",
    "holding_mV": "The holding potential must be from −250 to +250 mV.",
    "voltage_mV": "A step's voltage must be from −250 to +250 mV, or swept.",
    "duration_ms": "A step's duration must be above 0 and at most 100,000 ms, or swept.",
    "steps": "A protocol has 1 to 20 steps.",
    "measure": "The measure must be peak, decay time or time to peak.",
    "from": "A decay fraction must be above 0 and at most 1 (100 %).",
    "to": "A decay fraction must be above 0 and at most 1 (100 %).",
    "weight": "Weight must be a number above 0.",
    "time_resolution_ms": "The time resolution must be a number above 0 ms.",
    "points_per_gap": POINTS_PER_GAP,
    "validation_share": VALIDATION_SHARE,
    "points": "A protocol has 1 to 1,000 points, interpolated points included.",
    "x": "Each point's x must be a finite number.",
    "value": "Each point's value must be a finite number.",
    "sd": "SD must be blank or at least 0.",
    "validation": "Each point is marked validation or not: true or false.",
    "interpolated": "Each point is marked interpolated or not: true or false.",
}


def _field_issues(error: ValidationError) -> list[Issue]:
    issues: dict[IssuePath, Issue] = {}
    for detail in error.errors():
        path = tuple(key for key in detail["loc"] if key not in _UNION_TAGS)
        if path not in issues:
            message = _sentence(path, detail["type"], detail["msg"], detail.get("input"))
            issues[path] = Issue(path=path, message=message)
    return list(issues.values())


def _sentence(path: IssuePath, kind: str, pydantic_message: str, value: Any) -> str:
    if kind == "missing":
        return "This is required."
    if kind == "extra_forbidden":
        return "This isn't part of the dataset format."
    field = path[-1] if path else ""
    if field == "name":
        rule = names.DATASET if len(path) == 1 else names.PROTOCOL
        problem = (
            names.EMPTY
            if value is None
            else rule.problem(value)
            if isinstance(value, str)
            else None
        )
        if problem is not None:
            return problem
    if isinstance(field, str) and field in _FIELD_SENTENCES:
        return _FIELD_SENTENCES[field]
    return pydantic_message.rstrip(".") + "."


def _cross_field_issues_of_valid_protocols(raw: Any, names_in_use: Iterable[str]) -> list[Issue]:
    """The cross-field checks of a dataset some of whose fields fail their limits."""
    if not isinstance(raw, dict):
        return []
    name = raw.get("name")
    protocols = raw.get("protocols")
    valid: list[tuple[int, Protocol]] = []
    for i, protocol in enumerate(protocols if isinstance(protocols, list) else []):
        try:
            valid.append((i, Protocol.model_validate(protocol)))
        except ValidationError:
            continue
    every_protocol_valid = isinstance(protocols, list) and len(valid) == len(protocols)
    return _cross_field_issues(
        name if isinstance(name, str) else None, valid, names_in_use, every_protocol_valid
    )


# Reserved by Windows as file names in any case, so never a protocol name (it names a CSV).
_WINDOWS_DEVICES = frozenset(
    {"con", "prn", "aux", "nul"} | {f"{port}{n}" for port in ("com", "lpt") for n in range(1, 10)}
)


def _cross_field_issues(
    name: str | None,
    protocols: list[tuple[int, Protocol]],
    names_in_use: Iterable[str],
    every_protocol_valid: bool,
) -> list[Issue]:
    issues: list[Issue] = []
    if name is not None and name.casefold() in {n.casefold() for n in names_in_use}:
        issues.append(Issue(path=("name",), message="Another dataset already has this name."))
    seen: set[str] = set()
    for i, protocol in protocols:
        found = _Issues(("protocols", i))
        folded = protocol.name.casefold()
        if folded in seen:
            found.add("name", message="Another protocol in this dataset has this name.")
        elif folded in _WINDOWS_DEVICES:
            found.add("name", message="Windows reserves this name for a device.")
        seen.add(folded)
        _check_protocol(protocol, found)
        issues += found.issues
    points = [p for _, protocol in protocols for p in protocol.points]
    if every_protocol_valid and points and all(p.validation for p in points):
        issues.append(
            Issue(
                path=("protocols",),
                message="Keep at least one train point: every point is a validation point.",
            )
        )
    return issues


class _Issues:
    """The issues found in one protocol, each at a path under it."""

    def __init__(self, at: IssuePath) -> None:
        self.at = at
        self.issues: list[Issue] = []

    def add(self, *path: str | int, message: str) -> None:
        self.issues.append(Issue(path=(*self.at, *path), message=message))


def _check_protocol(protocol: Protocol, found: _Issues) -> None:
    swept = swept_quantities(protocol.steps)
    measured = measured_steps(protocol.steps)
    if not swept:
        found.add("steps", message="Sweep one step's voltage or duration.")
    elif len(swept) > 1:
        found.add("steps", message=f"Sweep only one voltage or duration; this sweeps {len(swept)}.")
    if not measured:
        found.add("steps", message="Measure one step.")
    elif len(measured) > 1:
        found.add("steps", message=f"Measure only one step; this measures {len(measured)}.")

    xs: set[float] = set()
    for k, p in enumerate(protocol.points):
        if p.x in xs:
            found.add("points", k, "x", message=REPEATED_X)
        xs.add(p.x)
    if protocol.interpolation.log_x and min(xs) <= 0:
        found.add("interpolation", "log_x", message=LOG_X_NEEDS_POSITIVE_X)
    measured_points = sum(not p.interpolated for p in protocol.points)
    if protocol.interpolation.enabled and measured_points < 2:
        found.add("interpolation", "enabled", message="Interpolation needs 2 measured points.")

    if len(swept) == 1:
        out_of_range = _check_swept_x(protocol, swept[0][1], found)
        if len(measured) == 1:
            _check_measure(protocol, swept[0], measured[0], out_of_range, found)


def _check_swept_x(protocol: Protocol, quantity: SweptQuantity, found: _Issues) -> set[int]:
    """Checks every point's x as the swept quantity; returns the points out of range."""
    out_of_range: set[int] = set()
    for k, p in enumerate(protocol.points):
        if quantity is SweptQuantity.VOLTAGE and not MIN_VOLTAGE_MV <= p.x <= MAX_VOLTAGE_MV:
            found.add("points", k, "x", message="A swept voltage must be from −250 to +250 mV.")
            out_of_range.add(k)
        elif quantity is SweptQuantity.DURATION and not 0 < p.x <= MAX_DURATION_MS:
            found.add(
                "points", k, "x", message="A swept duration must be above 0 and at most 100,000 ms."
            )
            out_of_range.add(k)
    return out_of_range


def _check_measure(
    protocol: Protocol,
    swept: tuple[int, SweptQuantity],
    measured: int,
    out_of_range: set[int],
    found: _Issues,
) -> None:
    step = protocol.steps[measured]
    measure = step.measure
    if isinstance(measure, DecayTime) and measure.from_ == measure.to:
        found.add(
            "steps", measured, "measure", "to", message="The two decay fractions must differ."
        )
    if isinstance(measure, TimeToPeak) and protocol.normalized:
        found.add("normalized", message="Time to peak can't be normalized.")

    duration_is_swept = swept == (measured, SweptQuantity.DURATION)
    longest = 0.0
    past_the_step = False
    for k, p in enumerate(protocol.points):
        if k in out_of_range:
            continue
        duration = p.x if duration_is_swept else step.duration_ms
        assert isinstance(duration, float)
        longest = max(longest, duration)
        if isinstance(measure, Peak) and not protocol.normalized and not 0 <= p.value <= 1:
            found.add(
                "points",
                k,
                "value",
                message="An un-normalized peak is an open probability, 0 to 1.",
            )
        elif isinstance(measure, DecayTime) and p.value <= 0:
            found.add("points", k, "value", message="A decay time must be above 0 ms.")
        elif isinstance(measure, DecayTime) and p.value >= duration:
            # A swept duration is each point's own; a fixed one is the step's field, said once.
            if duration_is_swept:
                found.add("points", k, "value", message=DECAY_PAST_THE_STEP)
            past_the_step = True
        elif isinstance(measure, TimeToPeak) and not 0 <= p.value <= duration:
            found.add(
                "points",
                k,
                "value",
                message="A time to peak must be from 0 ms to the measured step's duration.",
            )
    if past_the_step and not duration_is_swept:
        found.add("steps", measured, "duration_ms", message=DECAY_PAST_THE_STEP)
    # Reject huge ratios (including overflow to infinity) before rounding to a moment count.
    if longest and (
        longest / protocol.time_resolution_ms >= MAX_RECORDED_MOMENTS
        or recorded_moments(longest, protocol.time_resolution_ms) > MAX_RECORDED_MOMENTS
    ):
        found.add(
            "time_resolution_ms",
            message="The time resolution is too fine: the measured step would record more "
            "than 1,000,000 moments.",
        )
