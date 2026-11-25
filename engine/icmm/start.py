"""Running one start (ADR-0008): CMA-ES from one seeded **Start point** over its whole **Evaluation
budget**, as the old engine searched, writing its **Start log**, **Live snapshot** and result
(`icmm.wire.start`). It runs in a job on a compute node, or on This computer, and never opens the
runs database (ADR-0009).

The search is the old `optimize.py`'s: pycma with σ0 = 1 in raw coordinates, `BoundTransform`, and
every stop test off, so a start ends only at its budget, rounded up to a whole **Generation**. Every
random choice comes from the start's own seed, drawn from the run's **Search seed**, its topology id
and its start index, never from the clock or numpy's global state.

With no stop test, a converged start's step size can grow until CMA-ES's state overflows (#468), or
shrink until it underflows to 0, and it can no longer sample. The start ends there, finished with
its best so far: the search is unchanged, only where it ends is reported.
"""

from __future__ import annotations

import math
import os
import signal
import socket
import sys
import time
import warnings
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Literal, TypedDict

import numpy as np

from icmm.core import Core, Session, packaged_library
from icmm.dataset import core_arrays, read_revision
from icmm.durable import write_whole
from icmm.jobs import ArrayJob, StartJob
from icmm.scoring import Fit, score
from icmm.sobol import point as sobol_point
from icmm.topology import Lists, TopologyId
from icmm.wire.start import (
    EndReason,
    LiveSnapshot,
    SnapshotProtocol,
    StartLogPoint,
    StartResult,
)

with warnings.catch_warnings():
    warnings.simplefilter("ignore")  # it can't plot without matplotlib, which a start never does
    import cma

# Each purpose's first spawn-key word, so no two of a run's random streams coincide.
_START, _SOBOL = 0, 1


def main(
    job: str | None,
    *,
    array: str | None = None,
    task: int | None = None,
    threads: int | None,
    libicmm: str | None,
    lists: str | None,
    stop_file: str | None = None,
) -> int:
    """`icmm run-start`: runs the start `job` names, or task `task` of the `array` job, as a
    scheduler's job does.

    SIGTERM or SIGINT ends it as canceled and SIGUSR1 as near its time limit, after the generation
    it's in; the first signal names the end reason. A SLURM job signals only its batch shell, so
    the batch script forwards both (`--signal=B:USR1@180`), as #44's benchmark did. `stop_file`
    appearing ends it as canceled too: This computer's scheduler stops its workers so on every
    OS, since a signal on Windows is TerminateProcess, which no handler sees (#327).
    """
    asked: list[EndReason] = []

    def handle(signum: int, reason: EndReason) -> None:
        signal.signal(signum, lambda *_: asked.append(reason))

    def stop() -> EndReason | None:
        if asked:
            return asked[0]
        if stop_file is not None and os.path.exists(stop_file):
            return "canceled"
        return None

    handle(signal.SIGTERM, "canceled")
    handle(signal.SIGINT, "canceled")
    if sys.platform != "win32":
        handle(signal.SIGUSR1, "time_limit")
    if job is not None:
        spec = StartJob.model_validate_json(Path(job).read_bytes())
    else:
        assert array is not None and task is not None
        spec = ArrayJob.model_validate_json(Path(array).read_bytes()).job(task)
    run_start(
        spec,
        core=Core(packaged_library() if libicmm is None else libicmm),
        lists=Lists(None if lists is None else Path(lists)),
        threads=threads or _cpus(),
        stop=stop,
    )
    return 0


def _cpus() -> int:
    """The CPUs this start may use: its SLURM allocation, else every one it may run on."""
    allocated = os.environ.get("SLURM_CPUS_PER_TASK", "")
    if allocated.isdigit() and int(allocated) > 0:
        return int(allocated)
    if sys.platform == "linux":
        return len(os.sched_getaffinity(0))
    return os.cpu_count() or 1


def run_start(
    job: StartJob,
    *,
    core: Core,
    lists: Lists,
    threads: int = 1,
    clock: Callable[[], float] = time.monotonic,
    host: str | None = None,
    stop: Callable[[], EndReason | None] = lambda: None,
) -> StartResult:
    """Runs `job`'s start to its end and writes its result, which it returns.

    `stop` is asked after each generation; an end reason it answers before the last ends the start
    there, its last generation logged."""
    began = clock()
    dataset = read_revision(job.dataset)
    weights = [p.weight for p in dataset.protocols]
    arrays = [core_arrays(p) for p in dataset.protocols]
    topology_id = TopologyId(job.graph, job.open_state)
    topology = lists.topology(job.num_states, topology_id)
    box = job.bounds.box(topology)
    lower, upper = (np.array(side) for side in zip(*box, strict=True))
    seed = start_seed(job.search_seed, topology_id, job.start_index)
    x0 = np.array(
        start_point(
            box, job.search_seed, topology_id, job.start_index, sobol=job.sobol_start_points
        )
    )
    generations = -(-job.evaluation_budget // job.population)
    window = 9 * generations // 10  # the generation the budget's last 10 % starts after

    job.log.write_bytes(b"")
    with Session(core, topology, arrays) as session:
        es = cma.CMAEvolutionStrategy(
            x0,
            1.0,
            _options(job.population, job.evaluation_budget, lower, upper, _streams(seed)[1]),
        )
        best_f, best_x, best_fit = math.inf, x0.tolist(), None
        end_reason: EndReason = "budget"
        rmse_at_window: float | None = None
        shown_for: list[float] | None = None
        shown: list[SnapshotProtocol] = []
        generation = logged = 0
        steps = _steps(es, lower, upper)
        while generation < generations:
            try:
                # pycma finds each candidate's sampled genotype by the array it asked with, so
                # it's told those arrays, as the old engine told it; copies would be rebuilt
                # through the bounds' inverse, changing the search.
                asked = es.ask()
            except Exception:
                if best_fit is None or (flowed := _out_of_range(es)) is None:
                    raise
                end_reason = flowed  # it ends at the generation it last scored
            else:
                generation += 1
                candidates = [x.tolist() for x in asked]
                fits = [score(weights, s) for s in session.score_batch(candidates, threads)]
                values = [fit.train.penalized for fit in fits]
                i = int(np.argmin(values))
                if values[i] < best_f:
                    best_f, best_x, best_fit = values[i], candidates[i], fits[i]
                try:
                    es.tell(asked, values)
                except Exception:
                    if (flowed := _out_of_range(es)) is None:
                        raise
                    end_reason = flowed  # it logs the steps of the last tell that succeeded
                else:
                    if all(map(math.isfinite, measured := _steps(es, lower, upper))):
                        steps = measured
                assert best_fit is not None
                if generation == window:
                    rmse_at_window = best_fit.train.rmse
                if (
                    end_reason == "budget"
                    and (reason := stop()) is not None
                    and generation < generations
                ):
                    end_reason = reason
            assert best_fit is not None
            if logged != generation and (
                generation in (1, generations)
                or generation % job.log_every_generations == 0
                or end_reason != "budget"
            ):
                logged = generation
                point = StartLogPoint(
                    generation=generation,
                    evaluations=generation * job.population,
                    elapsed_s=round(clock() - began, 3),
                    sigma=steps[0],
                    largest_step=steps[1],
                    **_errors(best_fit),
                )
                with job.log.open("ab") as log:
                    log.write(point.model_dump_json().encode() + b"\n")
                if shown_for is not best_x:  # simulated once for each best
                    shown_for, shown = (
                        best_x,
                        [
                            SnapshotProtocol(name=p.name, x=a.x.tolist(), value=values)
                            for p, a, values in zip(
                                dataset.protocols, arrays, session.point_values(best_x), strict=True
                            )
                        ],
                    )
                snapshot = LiveSnapshot(
                    generation=generation,
                    evaluations=point.evaluations,
                    best=best_x,
                    protocols=shown,
                )
                try:
                    write_whole(job.snapshot, snapshot.model_dump_json().encode(), durable=False)
                except PermissionError:
                    pass  # Windows: a reader has it open; the next log point replaces it
            if end_reason != "budget":
                break
    if end_reason in ("overflow", "underflow"):
        print(
            f"ended at {generation * job.population:,} of {job.evaluation_budget:,} evaluations: "
            f"CMA-ES's step size {end_reason}ed",
            file=sys.stderr,
            flush=True,
        )
    assert best_fit is not None
    result = StartResult(
        num_states=job.num_states,
        graph=job.graph,
        open_state=job.open_state,
        start_index=job.start_index,
        search_seed=job.search_seed,
        seed=seed,
        start_point=x0.tolist(),
        best=best_x,
        generations=generation,
        evaluations=generation * job.population,
        val_cost=best_fit.val.cost,
        train_points=[p.train.points for p in best_fit.protocols],
        val_points=[p.val.points for p in best_fit.protocols],
        end_reason=end_reason,
        still_improving=(
            _still_improving(rmse_at_window, best_fit.train.rmse)
            if end_reason == "budget" and window >= 1
            else None
        ),
        still_improving_change=(
            _change(rmse_at_window, best_fit.train.rmse)
            if end_reason == "budget" and window >= 1
            else None
        ),
        wall_time_s=round(clock() - began, 3),
        host=socket.gethostname() if host is None else host,
        **_errors(best_fit),
    )
    write_whole(job.result, result.model_dump_json().encode())
    try:
        job.snapshot.unlink(missing_ok=True)
    except PermissionError:
        pass  # Windows: a reader has it open; the result says the start ended
    return result


class GenerationsTime(TypedDict):
    scoring_s: float
    """The seconds spent in the core, scoring each generation's candidates."""
    searching_s: float
    """The rest of the generations' seconds: CMA-ES sampling and updating, and each score."""
    evaluations: int


def time_generations(
    session: Session,
    box: Sequence[tuple[float, float]],
    weights: Sequence[float],
    *,
    population: int,
    threads: int,
    seconds: float,
    clock: Callable[[], float] = time.perf_counter,
) -> GenerationsTime:
    """Submit's time estimate (#508): generations of a start's search on `session`, as
    `run_start` runs them, from a start point drawn from seed 0, timed for `seconds` after one
    untimed generation that warms the core and CMA-ES; then the generation it's in ends."""
    lower, upper = (np.array(side) for side in zip(*box, strict=True))
    draws, search = _streams(0)
    budget = population * 10**6  # no generation here comes near it
    es = cma.CMAEvolutionStrategy(
        draws.uniform(lower, upper), 1.0, _options(population, budget, lower, upper, search)
    )
    scoring = searching = 0.0
    evaluations = 0
    warm = False
    while evaluations == 0 or scoring + searching < seconds:
        began = clock()
        asked = es.ask()
        candidates = [x.tolist() for x in asked]
        sent = clock()
        scores = session.score_batch(candidates, threads)
        scored = clock()
        es.tell(asked, [score(weights, s).train.penalized for s in scores])
        ended = clock()
        if warm:
            scoring += scored - sent
            searching += (ended - began) - (scored - sent)
            evaluations += population
        warm = True
    return GenerationsTime(scoring_s=scoring, searching_s=searching, evaluations=evaluations)


def _steps(
    es: cma.CMAEvolutionStrategy, lower: np.ndarray, upper: np.ndarray
) -> tuple[float, float]:
    """CMA-ES's step size σ, and its largest σ·√Cᵢᵢ over its parameter's range."""
    with np.errstate(all="ignore"):
        return float(es.sigma), float(np.max(es.stds / (upper - lower)))


def _out_of_range(es: cma.CMAEvolutionStrategy) -> Literal["overflow", "underflow"] | None:
    """Whether CMA-ES can no longer sample, and which way its state left the floating-point range.

    "underflow" once a coordinate's step factor σ·scaling (pycma's `sigma_vec`) is below the
    normal range, on its way to the 0 the tell then divides a 0 step by: in run #2's start 40 on
    McKelvey a converged start's σ shrank 14 decades every 200 generations until σ times a
    coordinate's scaling, each still normal, underflowed: 1.9e-287 · 1.2e-37 is 0 in the tell that
    asserted. It's asked first, since what the tell then computes from that factor can overflow
    too. "overflow" once the step size, mean, evolution paths or covariance aren't finite
    (#468)."""
    with np.errstate(all="ignore"):
        factor = es.sigma * np.asarray(getattr(es.sigma_vec, "scaling", es.sigma_vec))
        if np.all(np.isfinite(factor)) and not np.all(factor >= np.finfo(float).tiny):
            return "underflow"
        state = [es.sigma, es.mean, es.pc, es.stds, getattr(es.adapt_sigma, "ps", 0.0)]
        state += [getattr(es.sm, "C", 0.0), getattr(es.sm, "D", 0.0)]  # the full sampler's
        return None if all(np.all(np.isfinite(part)) for part in state) else "overflow"


def _change(before: float | None, after: float | None) -> float | None:
    """The Train RMSE's change from `before` to `after`, as a fraction; none without both."""
    if before is None or after is None or not before > 0:
        return None
    return after / before - 1


def start_seed(search_seed: int, topology: TopologyId, start_index: int) -> int:
    """A start's own seed: 53 bits from numpy's `SeedSequence` over (search seed, topology id,
    start index), so re-running one start, or adding starts, never changes another's."""
    key = (_START, topology.graph, topology.open_state, start_index)
    sequence = np.random.SeedSequence(search_seed, spawn_key=key)
    return int(sequence.generate_state(1, np.uint64)[0] >> 11)


def _still_improving(before: float | None, after: float | None) -> bool:
    """Whether the Train RMSE fell more than 1 % from `before` to `after`; a failed sweep has none,
    so leaving one behind counts as improving, and ending on one doesn't."""
    if after is None:
        return False
    return before is None or before - after > 0.01 * before


def start_point(
    box: Sequence[tuple[float, float]],
    search_seed: int,
    topology: TopologyId,
    start_index: int,
    *,
    sobol: bool,
) -> list[float]:
    """Where a start's search begins in `box`: by default one uniform draw from its own seed.

    With `sobol`, start k takes point k of its topology's scrambled Sobol sequence, seeded from
    (search seed, topology id), with a and b, the last two parameters, on Sobol's first two
    dimensions: they're the pair whose 2-D projection is spread evenly (ADR-0008).
    """
    lower, upper = (np.array(side) for side in zip(*box, strict=True))
    if not sobol:
        draws = _streams(start_seed(search_seed, topology, start_index))[0]
        return draws.uniform(lower, upper).tolist()
    key = (_SOBOL, topology.graph, topology.open_state)
    sequence = np.random.SeedSequence(search_seed, spawn_key=key)
    u = sobol_point(len(box), start_index, np.random.default_rng(sequence))
    return (lower + np.roll(u, -2) * (upper - lower)).tolist()


def _streams(seed: int) -> tuple[np.random.Generator, np.random.Generator]:
    """A start's two independent streams: its start point's draw, and its search's, so that Sobol
    start points change only where a start begins."""
    point, search = np.random.SeedSequence(seed).spawn(2)
    return np.random.default_rng(point), np.random.default_rng(search)


def _options(
    population: int, budget: int, lower: np.ndarray, upper: np.ndarray, rng: np.random.Generator
) -> cma.CMAOptions:
    """The old `optimize.py`'s options, with its draws from `rng` rather than numpy's global
    state, and silent."""
    options = cma.CMAOptions()
    options.set("popsize", population)
    options.set("bounds", [lower, upper])
    options.set("maxfevals", budget)
    for key in ("mindx", "minstd", "tolfun", "tolfunhist", "tolfunrel", "tolx"):
        options.set(key, 0)
    for key in (
        "tolconditioncov",
        "tolfacupx",
        "tolflatfitness",
        "tolstagnation",
        "tolupsigma",
        "maxiter",
    ):
        options.set(key, math.inf)
    options.set("tolxstagnation", False)
    options.set("seed", math.nan)  # leaves numpy's global state alone
    options.set("randn", lambda *shape: rng.standard_normal(shape))
    options.set("verbose", -9)
    options.set("verb_log", 0)
    options.set("verb_disp", 0)
    return options


class _Errors(TypedDict):
    cost: float | None
    train_rmse: float | None
    val_rmse: float | None
    train_sse: list[float]
    train_failed: list[int]
    val_sse: list[float]
    val_failed: list[int]


def _errors(fit: Fit) -> _Errors:
    """The best's errors, as the log and the result write them."""
    return {
        "cost": fit.train.cost,
        "train_rmse": fit.train.rmse,
        "val_rmse": fit.val.rmse,
        "train_sse": [p.train.raw_sse for p in fit.protocols],
        "train_failed": [p.train.failed for p in fit.protocols],
        "val_sse": [p.val.raw_sse for p in fit.protocols],
        "val_failed": [p.val.failed for p in fit.protocols],
    }
