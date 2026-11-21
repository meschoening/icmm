"""Where a run's files go in its **Output folder**, and reading what its workers write.

A run's folder is `run-214-1f3a9c0e`: its number, then the first 8 hex digits of its runs
database's own id, so a rebuilt Data folder, or another platform sharing the Output folder, never
meets an older run's files. In it:

- `T12.3/start-37-try-1.ndjson`, `.json` and `.live.json`: each try's **Start log**, result and
  **Live snapshot**, a try named by its number, from 1, so a start sent again never appends to an
  earlier try's log;
- `arrays/5.json`: each array's job file (`icmm.start.ArrayJob`), by the array's number in the
  run;
- `arrays/5-37.out`: each SLURM array task's output, its job log, by the array's number and the
  task's; on This computer, `local-12_37.out`, by the job's id there and the task's;
- `coordinator-2.log`: each generation of the coordinator's own output.

The coordinator only opens files it knows the names of: it never lists a folder.
"""

from __future__ import annotations

import contextlib
import math
import os
from pathlib import Path

from pydantic import ValidationError

from icmm.durable import write_whole
from icmm.jobs import ArrayJob, StartTask
from icmm.progress import Curve
from icmm.topology import TopologyId
from icmm.wire.start import StartLogPoint, StartResult

BLOCK = 4096
"""Files take whole blocks of at least this on the reference cluster's home (ADR-0014)."""
RESULT_BYTES, VALUE_BYTES = 1024, 24
"""A result's fixed part, and each number it holds, written as JSON."""
TAIL_BYTES = 8192
"""How far back from a log's end its last line is looked for: a line is under 2 KB with 16
protocols."""


def run_folder(output_folder: str | Path, run: int, feed: str) -> Path:
    return Path(output_folder) / f"run-{run}-{feed[:8]}"


def identity(feed: str, run: int, kind: str, number: int) -> str:
    """A launch's identity (ADR-0009): the runs database's, the run's, and the launch's own, as
    `icmm-1f3a9c0e-214-c2` for a coordinator's second generation or `-a5` for its fifth array.
    The scheduler keeps it with the job, so a launch whose reply was lost is found again."""
    return f"icmm-{feed[:8]}-{run}-{kind}{number}"


def topology_folder(folder: Path, topology: TopologyId) -> Path:
    return folder / str(topology)


def start_task(folder: Path, topology: TopologyId, start: int, attempt: int) -> StartTask:
    """Where try `attempt` of a start writes."""
    place, stem = topology_folder(folder, topology), f"start-{start}-try-{attempt}"
    return StartTask(
        start_index=start,
        log=place / f"{stem}.ndjson",
        result=place / f"{stem}.json",
        snapshot=place / f"{stem}.live.json",
    )


def array_jobs(folder: Path, number: int) -> Path:
    return folder / "arrays" / f"{number}.json"


def job_logs(folder: Path, array: int, task: int, job_id: str | None) -> tuple[Path, ...]:
    """Where an array task's job log may be: SLURM's name, by the array's number in the run, then
    This computer's, by the job's id there (`icmm.scheduler`)."""
    slurm = array_jobs(folder, array).with_name(f"{array}-{task}.out")
    return (slurm,) if job_id is None else (slurm, folder / f"local-{job_id}_{task}.out")


def job_log(
    folder: Path, array: int | None, task: int | None, job_id: str | None, slurm: bool
) -> Path | None:
    """Where its scheduler writes an array task's job log, as `job_logs` names them, without a
    look at the folder; `None` before the task goes out, or on This computer before its job has
    an id there."""
    if array is None or task is None:
        return None
    if slurm:
        return job_logs(folder, array, task, None)[0]
    return None if job_id is None else job_logs(folder, array, task, job_id)[1]


def coordinator_log(folder: Path, generation: int) -> Path:
    return folder / f"coordinator-{generation}.log"


def write_jobs(path: Path, jobs: ArrayJob) -> None:
    """Writes an array's job file whole, durably, before the array goes out."""
    path.parent.mkdir(parents=True, exist_ok=True)
    write_whole(path, jobs.model_dump_json().encode())


def read_result(task: StartTask) -> StartResult | None:
    """The task's result, once its worker has written it; `None` before, or if what's there
    isn't this start's."""
    try:
        result = StartResult.model_validate_json(task.result.read_bytes())
    except (OSError, ValidationError):
        return None
    return result if result.start_index == task.start_index else None


def last_log_point(task: StartTask) -> StartLogPoint | None:
    """The last whole line of the task's Start log, read from its end."""
    try:
        with task.log.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            tail = f.read()
    except OSError:
        return None
    lines = tail.split(b"\n")[:-1]  # what follows the last newline is still being written
    if not lines:
        return None
    try:
        return StartLogPoint.model_validate_json(lines[-1])
    except ValidationError:
        return None


def first_log_point(task: StartTask) -> StartLogPoint | None:
    """The first whole line of the task's Start log: its first generation's point."""
    try:
        with task.log.open("rb") as f:
            line = f.readline(TAIL_BYTES)
    except OSError:
        return None
    if not line.endswith(b"\n"):
        return None
    try:
        return StartLogPoint.model_validate_json(line)
    except ValidationError:
        return None


def log_curve(task: StartTask, per_start: int) -> Curve | None:
    """The try's **Progress curve**, thinned from its whole Start log as it is now, a line at a
    time; `None` if there's no log to read. A line it can't read is passed over, and one still
    being written ends it."""
    curve = Curve()
    try:
        with task.log.open("rb") as log:
            for line in log:
                if not line.endswith(b"\n"):
                    break
                try:
                    point = StartLogPoint.model_validate_json(line)
                except ValidationError:
                    continue
                curve = curve.added(point.evaluations, point.train_rmse, per_start=per_start)
    except OSError:
        return None
    return curve


def tail(path: Path, lines: int = 20) -> str | None:
    """The last `lines` lines of a text file, at most `TAIL_BYTES`; `None` if it can't be read."""
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    return "\n".join(text.splitlines()[-lines:]) or None


def written(task: StartTask, job_logs: tuple[Path, ...]) -> int:
    """The bytes a try wrote, as written: its result, its Start log and its job log, each looked
    at by name; a file that isn't there counts 0."""
    total = 0
    for path in (task.result, task.log, *job_logs):
        with contextlib.suppress(OSError):
            total += path.stat().st_size
    return total


def forget_snapshot(task: StartTask) -> None:
    """Removes a Live snapshot its worker left when it died."""
    with contextlib.suppress(OSError):
        task.snapshot.unlink(missing_ok=True)


def start_bytes(
    *,
    num_states: int,
    protocols: int,
    evaluation_budget: int,
    population: int,
    log_every_generations: int,
) -> int:
    """What one start writes, at most (ADR-0014): its result, its Start log at its budget, and
    the scheduler's output, each rounded up to whole blocks. A topology has at most 2N edges."""
    from icmm import config as configs

    parameters = 2 * num_states + 2 * (2 * num_states) + 2
    result = RESULT_BYTES + VALUE_BYTES * (2 * parameters + 6 * protocols)
    generations = -(-evaluation_budget // population)
    lines = configs.log_points(generations, log_every_generations)
    log = lines * (configs.LINE_BYTES + configs.PROTOCOL_LINE_BYTES * protocols)
    return sum(_blocks(size) for size in (result, log, 0))


def _blocks(size: int) -> int:
    return max(1, math.ceil(size / BLOCK)) * BLOCK
