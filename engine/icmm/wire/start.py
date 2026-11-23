"""A start's files (ADR-0008, ADR-0009): its **Start log**, one `StartLogPoint` a line; its **Live
snapshot** while it runs; and its result once it ends. The worker (`icmm.start`) writes them, and
the run's owner loop and the agent parse them with these types, never with regexes. They join the
generated bundle with the first method that carries them.

The reads below are what Topology and the Start page show of a start: its row in the runs
database, which its run's coordinator keeps (ADR-0019), and its files, paged.

Per-protocol lists are in the dataset revision's protocol order. Each SSE is the core's raw sum
over the points that scored, unweighted (`icmm.core.ProtocolScore`); the Cost and RMSEs are
`icmm.scoring`'s, `null` where a point failed.
"""

from __future__ import annotations

from typing import Literal

from icmm.wire.base import WireInt, WireModel
from icmm.wire.run import StartCause, TopStart

type EndReason = Literal["budget", "overflow", "canceled", "time_limit"]
"""Why a start stopped: it ran its **Evaluation budget**; CMA-ES's step size overflowed, so its
search could no longer sample (a converged start with no stop test, #468); it was canceled (SIGTERM
or SIGINT, or on This computer its stop file); or its job neared the scheduler's time limit
(SIGUSR1). The first two end it **Finished**."""


class StartLogPoint(WireModel):
    """One log point: the start's first **Generation**, every `log_every_generations`-th, and its
    last, with the best so far."""

    generation: WireInt
    evaluations: WireInt
    elapsed_s: float
    """Since the worker began, to the millisecond."""
    sigma: float
    """CMA-ES's step size σ."""
    largest_step: float
    """The largest σ·√Cᵢᵢ over its parameter's range: how far the search still moves."""
    cost: float | None
    train_rmse: float | None
    val_rmse: float | None
    train_sse: list[float]
    train_failed: list[WireInt]
    val_sse: list[float]
    val_failed: list[WireInt]


class SnapshotProtocol(WireModel):
    name: str
    x: list[float]
    """Every point's x, sorted, train and validation alike."""
    value: list[float | None]
    """The model's value at each x, as its score compares it with the data: normalized as the
    protocol is, times in ms; `null` for a failed point."""


class LiveSnapshot(WireModel):
    """A running start's best so far, replaced at each log point."""

    generation: WireInt
    evaluations: WireInt
    best: list[float]
    """The raw **Parameters** (ADR-0007)."""
    protocols: list[SnapshotProtocol]


class StartResult(WireModel):
    """A start that ended, with its best: written once, whole."""

    num_states: WireInt
    graph: WireInt
    open_state: WireInt
    start_index: WireInt
    search_seed: WireInt
    seed: WireInt
    """The start's own seed, from the search seed, topology id and start index."""
    start_point: list[float]
    best: list[float]
    """The raw **Parameters** (ADR-0007)."""
    generations: WireInt
    evaluations: WireInt
    cost: float | None
    val_cost: float | None
    train_rmse: float | None
    val_rmse: float | None
    train_sse: list[float]
    train_points: list[WireInt]
    train_failed: list[WireInt]
    val_sse: list[float]
    val_points: list[WireInt]
    val_failed: list[WireInt]
    end_reason: EndReason
    still_improving: bool | None
    """Whether the best's Train RMSE fell more than 1 % over the last 10 % of the evaluations;
    `null` for a start that ended early, an overflow included, or ran fewer than 2 generations."""
    still_improving_change: float | None
    """How much the best's Train RMSE changed over those evaluations, as a fraction: −0.018 fell
    1.8 %. `null` where `still_improving` is, or a failed sweep leaves either end without one."""
    wall_time_s: float
    host: str


type StartState = Literal["waiting", "queued", "running", "finished", "failed", "canceled"]
"""`waiting`: not sent out yet, or waiting to be sent again; `queued`: sent out and waiting at the
scheduler; then running, and **Finished** once it has run its **Evaluation budget**. A **Failed
start** stopped short for its `cause`; a canceled one was stopped by hand."""


class ListStartsParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    after: str | None
    """The `next` of the page before; `null` for the first page."""


class StartProgress(WireModel):
    """A running start's latest **Start log** point, as its coordinator last copied it: "so
    far"."""

    generation: WireInt
    evaluations: WireInt
    train_rmse: float | None
    val_rmse: float | None
    ends_at: str | None
    """When it ends at its own pace, in UTC (ISO 8601), as its coordinator last read its Start
    log: what its topology's ETA takes (#556). `null` until it has logged past its first point."""


class RanWith(WireModel):
    """What a start's latest try asked for, and where it ran (ADR-0019)."""

    engine: str | None
    """The **Engine bundle** it ran from; `null` for one run from a checkout."""
    cpus: WireInt
    memory_mb: WireInt | None
    """`null` on This computer, which asks for none."""
    time_limit_min: WireInt | None
    """`null` on This computer, which sets none."""
    array: WireInt | None
    """The array it went out in, by its number in the run."""
    array_task: WireInt | None
    array_job_id: str | None
    """`null` until the scheduler is known to have taken its array."""
    job_id: str | None
    """`<array job id>_<task>`."""
    node: str | None
    peak_memory_mb: WireInt | None
    """As the scheduler counted it once the try ended; `null` before, or when it didn't say."""
    exit_code: WireInt | None
    scheduler_state: str | None
    """The scheduler's own word for how it ended, such as SLURM's `OUT_OF_MEMORY`."""
    sent_at: str | None
    """In UTC (ISO 8601), as are its other times."""
    started_at: str | None
    ended_at: str | None


class StartSummary(WireModel):
    """A start, `#214/T12.3` start 37, as Topology lists it: its latest try."""

    start: WireInt
    """Its index in the topology, from 0."""
    state: StartState
    try_number: WireInt
    """Its latest **Try**, from 1; 0 before it first goes out."""
    cause: StartCause | None
    """Why its latest try failed; `null` unless it did."""
    end_reason: EndReason | None
    """Why its search stopped, once it has written its result."""
    train_rmse: float | None
    """Of its result's best; `null` before it, or "—" for a failed sweep (ADR-0006)."""
    val_rmse: float | None
    so_far: StartProgress | None
    """While it runs, once it has logged a point."""
    evaluations: WireInt | None
    elapsed_s: float | None
    still_improving: bool | None
    """Whether its best's Train RMSE fell more than 1 % over the last 10 % of its evaluations;
    `null` for a start that ended early, or ran fewer than 2 generations."""
    best: list[float] | None
    """Its result's raw **Parameters** (ADR-0007), a failed start's best so far included, which
    never counts; `null` before its result."""
    ran_with: RanWith | None
    """`null` before it first goes out."""


class StartList(WireModel):
    starts: list[StartSummary]
    """By start index."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class TopologyProgressParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    after: str | None
    """The `next` of the page before; `null` for the first page."""


class StartCurve(WireModel):
    """A start's **Progress curve**, of its latest try: its best Train RMSE so far against
    evaluations, at most 64 points its run's coordinator thinned from its **Start log**, the
    first and last always among them. A best with no Train RMSE isn't on it."""

    start: WireInt
    state: StartState
    evaluations: list[WireInt]
    """Rising, from its first logged generation's."""
    train_rmse: list[float]
    """At each of `evaluations`, to 5 significant figures."""


class TopologyProgress(WireModel):
    curves: list[StartCurve]
    """By start index: each start whose latest try's log its coordinator has read, which it does
    once it runs, and again once it ends."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class ReadStartParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt


class TryBefore(WireModel):
    """How a start's try before its latest ended: "2nd try, after node c07 failed
    `NODE_FAIL`"."""

    cause: StartCause | None
    node: str | None
    scheduler_state: str | None
    """The scheduler's own word for how it ended, such as SLURM's `NODE_FAIL`."""
    exit_code: WireInt | None


class StartTry(WireModel):
    """One of a start's tries: when it ran, and how it ended."""

    try_number: WireInt
    cause: StartCause | None
    """Why it failed; `null` unless it did."""
    end_reason: EndReason | None
    """Why its search stopped, once it has written its result."""
    node: str | None
    scheduler_state: str | None
    """The scheduler's own word for how it ended, such as SLURM's `NODE_FAIL`."""
    exit_code: WireInt | None
    started_at: str | None
    """In UTC (ISO 8601), as is `ended_at`."""
    ended_at: str | None
    """`null` while it runs, or waits to."""


class Start(StartSummary):
    """A start with its result in full, for the Start page and its Result."""

    still_improving_change: float | None
    """How much its best's Train RMSE changed over the last 10 % of its evaluations, which
    `still_improving` weighs, as a fraction: −0.018 fell 1.8 %. `null` where `still_improving`
    is, a failed sweep left either end without one, or an older engine fit it."""

    seed: WireInt | None
    """Its own seed, from the run's **Search seed**, its topology and its index; `null` before
    its result."""
    start_point: list[float] | None
    """Where its search began, raw; `null` before its result."""
    generations: WireInt | None
    cost: float | None
    """The **Cost** of its best; never shown, but exported."""
    val_cost: float | None
    train_sse: list[float] | None
    """Per protocol, in the dataset revision's order: each the core's raw sum over the points
    that scored, unweighted, as are the val sums."""
    train_points: list[WireInt] | None
    train_failed: list[WireInt] | None
    val_sse: list[float] | None
    val_points: list[WireInt] | None
    val_failed: list[WireInt] | None
    log: str | None
    """Its latest try's **Start log**, as a full path on the platform; `null` before it first goes
    out."""
    job_log: str | None
    """Its latest try's job log, as a full path on the platform: where its scheduler writes it,
    named without a look at the Output folder; `null` before it first goes out, or on This
    computer before its job has an id there."""
    top_10: list[TopStart]
    """Its topology's **Top 10**, the lowest Train RMSE first, for the band each parameter is
    drawn against (ADR-0021)."""
    before: TryBefore | None
    """Its try before its latest; `null` before its second."""
    tries: list[StartTry]
    """Each try it has had, the first first, for the lines that end its logs."""


class ReadStartLogParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    try_number: WireInt | None
    """Which try's log; `null` for its latest."""
    after: WireInt | None
    """Where in the file to read forward from, in bytes: 0, or the `next` of the page before;
    `null` to read the page that ends at `before`."""
    before: WireInt | None
    """With no `after`: where the page ends, in bytes, the `begins` of the page after it; `null`
    for the file's end, its last page."""


class StartLogPage(WireModel):
    """A page of a try's **Start log**: its whole lines from `after`, or back from `before`, up to
    about 512 KB of the file."""

    path: str | None
    """The log, as a full path on the platform; `null` for a start that hasn't gone out."""
    found: bool
    """Whether the file is there: a try whose worker hasn't begun has none yet, and an Output
    folder that's gone has lost it."""
    points: list[StartLogPoint]
    begins: WireInt
    """Where its first line begins: `after`, or past a line `before`'s page began in, which the
    page before it ends at; 0 once the log is read from its start."""
    next: WireInt
    """Where the next page begins: past the last whole line read."""
    size: WireInt
    """The file's size as it was read; the log is whole up to `next` once `next` reaches it."""
    skipped: WireInt
    """Whole lines on the page this engine can't read: written by another engine, or longer than
    a page."""


class ReadJobLogParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    try_number: WireInt | None
    """Which try's job log; `null` for its latest."""
    after: WireInt | None
    """Where in the file to read forward from, in bytes: 0, or the `next` of the page before;
    `null` to read the page that ends at `before`."""
    before: WireInt | None
    """With no `after`: where the page ends, in bytes, the `begins` of the page after it; `null`
    for the file's end, its last page."""


class JobLogPage(WireModel):
    """A page of what a scheduler kept of a job's output, its job log: up to 128 KB of the file
    from `after`, ending at a line's end when one is in reach, or back from `before`, beginning
    at a line's start when one is in reach."""

    path: str | None
    """The log, as a full path on the platform; `null` for a job that hasn't gone out."""
    found: bool
    text: str
    """Read as UTF-8; a byte that isn't is shown as �."""
    begins: WireInt
    """Where `text` begins in the file; 0 once the log is read from its start."""
    next: WireInt
    size: WireInt


class ListCoordinatingJobsParams(WireModel):
    run: WireInt


class CoordinatingJob(WireModel):
    """A generation of a run's **Coordinator** that ran: on a cluster, its coordinating job; on
    **This computer**, its process."""

    generation: WireInt
    """From 1, one more each time the run's coordinator is launched again."""
    job_id: str | None
    """The scheduler's id for it: its job's, or its process's on This computer."""
    started_at: str | None
    """When it claimed the run, in UTC (ISO 8601), as is `ended_at`; `null` for one that ended
    before it could."""
    ended_at: str | None
    """`null` while it runs."""
    exit_code: WireInt | None
    """`null` while it runs, or when it was killed outright where the scheduler keeps none."""
    progressed: bool
    """Whether it sent or collected a start, or handed the run on."""


class CoordinatingJobs(WireModel):
    jobs: list[CoordinatingJob]
    """Its latest 256 that began or ended, the latest first; one waiting in the queue behind
    another isn't one yet."""


class ReadCoordinatingJobLogParams(WireModel):
    run: WireInt
    generation: WireInt
    after: WireInt | None
    """Where in the file to read forward from, in bytes: 0, or the `next` of the page before;
    `null` to read the page that ends at `before`."""
    before: WireInt | None
    """With no `after`: where the page ends, in bytes, the `begins` of the page after it; `null`
    for the file's end, its last page."""


class WatchStartParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    after: WireInt | None
    """Where in its latest try's **Start log** to push lines from, as `read_start_log`'s `next`
    gave it; `null` for from its end now."""


class StartWatch(WireModel):
    """The watch on a start's latest try: its events come as `StartWatchEvent`s."""

    subscription: WireInt
    try_number: WireInt
    """The try it watches; 0 for a start that hasn't gone out, whose watch ends at once."""
    snapshot: LiveSnapshot | None
    """Its **Live snapshot** now; `null` while it has none."""


class StartWatchEvent(WireModel):
    """What changed in the watched try's files since the last event."""

    points: list[StartLogPoint]
    """The log's new whole lines, oldest first: at most about 512 KB of the file an event, the
    rest in the events that follow at once."""
    next: WireInt
    """Where in the log the next event's lines begin."""
    snapshot: LiveSnapshot | None
    """Its **Live snapshot**, when it was replaced since the last event; `null` when it wasn't."""
    ended: bool
    """The try has ended, and this is the watch's last event: its result is in `read_start`."""
