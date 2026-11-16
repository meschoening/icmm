"""What a start fits and where it writes: one start's job, or an array's, as `icmm run-start`
reads it (ADR-0008). The coordinator writes them; light enough for the agent to import."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from icmm.parameters import ParameterBounds

type Count = Annotated[int, Field(ge=1)]


class _Fit(BaseModel):
    """What a topology's starts fit and how they search."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    dataset: Path
    """The run's pinned dataset revision folder."""
    num_states: Annotated[int, Field(ge=3, le=16)]
    graph: Annotated[int, Field(ge=0)]
    open_state: Annotated[int, Field(ge=0)]
    search_seed: Annotated[int, Field(ge=0, le=2**32 - 1)]
    population: Annotated[int, Field(ge=2)]
    evaluation_budget: Count
    log_every_generations: Count
    sobol_start_points: bool
    bounds: ParameterBounds


class StartTask(BaseModel):
    """Which start one task runs, and where it writes."""

    model_config = ConfigDict(extra="forbid", strict=True)

    start_index: Annotated[int, Field(ge=0)]
    log: Path
    snapshot: Path
    result: Path


class StartJob(_Fit, StartTask):
    """What one start fits, how it searches, and where it writes."""


class ArrayJob(_Fit):
    """An array's starts, all on one topology: task i runs `tasks[i]`. The coordinator writes one
    for each array it sends, so a task finds its start in one file (#246)."""

    tasks: Annotated[list[StartTask], Field(min_length=1)]

    def job(self, task: int) -> StartJob:
        """Task `task`'s start; `IndexError` for a task the array hasn't."""
        if not 0 <= task < len(self.tasks):
            raise IndexError(f"the array has tasks 0–{len(self.tasks) - 1}, not {task}")
        return StartJob(**{k: v for k, v in self if k != "tasks"}, **dict(self.tasks[task]))
