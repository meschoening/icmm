"""The rolling window (old ADR-0030, ADR-0019): a run's starts go out as arrays, oldest topology
first, so that no more of them run at once than the **Running-starts cap**.

Each sweep shares the cap among the live arrays oldest first, through each array's throttle (the
most of its tasks that may run at once), then sends the next arrays with what's left. SLURM reads
a throttle of 0 as no limit, so every live array keeps at least one slot, and an array goes out
only while a slot is free: a freed slot waits up to one sweep, and at most cap + N − 1 tasks, N
the largest array, are ever sent and unfinished. Only a cap lowered below the number of live
arrays can't hold: each of them runs one task until it drains.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True)
class LiveArray:
    """An array that went out and hasn't ended, as the plan sees it."""

    job_id: str
    unfinished: int
    """Its tasks running or waiting."""
    throttle: int
    """The last throttle the scheduler took."""


@dataclass(frozen=True)
class WindowPlan:
    throttle_updates: list[tuple[str, int]] = field(default_factory=list)
    """`(job id, throttle)`, every decrease before any increase, so that a decrease that fails can
    stop the sweep before an increase takes the cap past its limit."""
    new_array_throttles: list[int] = field(default_factory=list)
    """A throttle for each array to send now, in the order they wait."""


def plan_window(live: Sequence[LiveArray], *, capacity: int, queued: Sequence[int]) -> WindowPlan:
    """Shares `capacity` among the `live` arrays, oldest first, then gives what's left to the
    arrays waiting to go out, whose sizes `queued` lists in the order they wait.

    Each live array with a task left keeps one slot, and the rest go oldest first. Σ running ≤
    capacity holds while the live arrays are no more than it, because an array runs at most
    min(unfinished, throttle) tasks, unfinished never grows (a requeue moves a task from running
    to waiting), and an array goes out only with a share of at least 1.
    """
    if capacity < 1:
        raise ValueError(f"capacity must be at least 1, not {capacity}")
    if any(size < 1 for size in queued):
        raise ValueError(f"an array holds at least 1 task: {list(queued)}")
    left = max(0, capacity - sum(array.unfinished > 0 for array in live))
    decreases: list[tuple[str, int]] = []
    increases: list[tuple[str, int]] = []
    for array in live:
        if array.unfinished <= 0:
            continue  # ended: nothing left to throttle
        more = min(array.unfinished - 1, left)
        left -= more
        share = 1 + more
        if min(array.unfinished, array.throttle) == share or share == array.throttle:
            continue  # its throttle already binds at its share
        (decreases if share < array.throttle else increases).append((array.job_id, share))
    new: list[int] = []
    for size in queued:
        if left < 1:
            break
        new.append(min(size, left))
        left -= new[-1]
    return WindowPlan(throttle_updates=decreases + increases, new_array_throttles=new)
