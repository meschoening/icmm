"""`WireModel`, the base of every type that crosses the wire.

A wire type is closed (an unknown key is an error), strict (no string-to-number coercion) and
finite: a NaN or infinity fails where it's made, not as a `null` the Rust side then rejects.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_WIRE_INT = 2**53 - 1
WireInt = Annotated[int, Field(ge=-MAX_WIRE_INT, le=MAX_WIRE_INT)]
"""An integer that Rust's i64 and JavaScript's number can both represent exactly."""

type RunState = Literal["queued", "held", "running", "completed", "failed", "canceled"]
"""In flight, judged per job: running while one of its starts runs, else held while one of its
jobs waits on something other than free resources, else queued. It ends completed once every start
has finished, failed when it stops on its own with starts unfinished, or canceled (ADR-0019)."""


class WireModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        # Each model builds its validator on first use, not at import: the agent answers hello
        # about 3 s after it starts on a login node capped at 7 % of a core (ADR-0009).
        defer_build=True,
        strict=True,
        allow_inf_nan=False,
        # A field's docstring becomes its schema description, so Rust and TS carry it too.
        use_attribute_docstrings=True,
    )
