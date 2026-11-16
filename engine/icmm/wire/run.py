"""A **Run** as Submit and Runs see it (ADR-0016, ADR-0019): what it fits, pinned at submit, and
how far its coordinator has carried it.

A run fits its config as saved and records the rest of what it fits as it's submitted: the
config's settings, its dataset's revision, its **Search seed**, its **Output folder** and its
engine. Nothing reads the config or the current dataset again; a run shows its config's name now,
following the config's id, and its dataset's name now.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from icmm.wire.base import RunState, WireInt, WireModel
from icmm.wire.changes import FeedPosition
from icmm.wire.config import Bounds, Config
from icmm.wire.dataset import DatasetContent, Template
from icmm.wire.simulation import ProtocolScore


class SubmitRunParams(WireModel):
    request_key: str
    config_id: str
    """The config to fit, as it was last saved: Submit changes none of its settings."""


class AcceptedRun(WireModel):
    """The run is recorded, Queued; its first coordinator goes out next (ADR-0009)."""

    run: WireInt
    """Its number, written `#214`; never given to another run."""


class ReadRunParams(WireModel):
    id: WireInt


class CancelRunParams(WireModel):
    request_key: str
    id: WireInt
    """A run in flight: queued, held or running."""


class CancelingRun(WireModel):
    """The cancel is recorded: the run shows Canceling until its coordinator, or `icmm cleanup`
    where it has none, has stopped its starts and ended it canceled (ADR-0009, ADR-0019)."""

    id: WireInt


class DeleteRunParams(WireModel):
    request_key: str
    id: WireInt
    """A run that has ended: completed, failed or canceled."""


class DeletedRun(WireModel):
    """The run has left every list. `icmm cleanup` then cancels any job of it left, and removes
    its files and its rows (ADR-0020)."""

    id: WireInt


class ResumeRunParams(WireModel):
    request_key: str
    id: WireInt
    """A run that failed or was canceled."""


class ResumedRun(WireModel):
    """The run is in flight again, Queued, fitting only the starts it hasn't finished; its next
    coordinator goes out next (ADR-0019)."""

    id: WireInt
    engine: str | None
    """The **Engine bundle** it fits on from here: its own (ADR-0020), or this engine's where its
    own is no longer installed, or a newer engine has raised the floor above it; `null` for an
    engine run from a checkout."""
    replaced_engine: str | None
    """Its own engine, gone or below the floor, that `engine` replaces: its resumed starts will
    agree with the rest in distribution, not to the last digit. `null` when it keeps its own."""


class RunConfig(WireModel):
    """The config a run was submitted from, as the runs database has it now."""

    id: str
    name: str
    """Its name now, or when it was deleted: the run follows the config's id."""
    deleted: bool


class RunDataset(WireModel):
    """The dataset a run fits."""

    id: str
    name: str | None
    """Its name now, or when it was deleted; `null` when this platform never had it."""
    revision: WireInt
    """The **Dataset revision** the run fits, pinned at submit."""
    deleted: bool
    earlier: bool
    """Fit to earlier data: the dataset's current revision scores differently, so the run
    ranks only with runs on its own revision (ADR-0003). Never set while `deleted`."""


class RunProtocol(WireModel):
    """A protocol of the revision a run fits, as the runs database recorded it when the revision
    was saved: so it's named even where the revision can't be read (#387)."""

    name: str
    template: Template


class RunSpace(WireModel):
    """The folder a run held for space waits on, as its coordinator found it when the hold began
    (ADR-0014)."""

    folder: str
    """The fuller of the Output and Data folders, from `~/` under the platform's home."""
    free_bytes: WireInt
    carries_on_bytes: WireInt
    """The free space it carries on at: twice what it releases below, 100 MB plus what its next
    starts write."""


class RunHold(WireModel):
    """Why nothing more of a held run can start yet."""

    kind: Literal["scheduler", "space"]
    """A scheduler's policy, or the app's own: the **Output folder** is full (ADR-0014)."""
    reason: str | None
    """The scheduler's own reason, such as `QOSMaxJobsPerUserLimit`; `null` for `space`."""
    since: str
    """In UTC (ISO 8601)."""
    space: RunSpace | None
    """For `space`: how short the folder was when the hold began; `null` for `scheduler`, and for
    a hold an older engine recorded."""


class RunQueued(WireModel):
    """Why a queued run waits, and since when."""

    reason: str | None
    """The scheduler's own reason, `Resources`, `Priority` or `JobArrayTaskLimit`; `null` when it
    gives none, and on This computer, where a run waits only for slots."""
    since: str
    """When it was last queued, in UTC (ISO 8601): submitted, resumed, or waiting again."""


class RunProgress(WireModel):
    topologies: WireInt
    """How many topologies the run fits."""
    topologies_complete: WireInt
    topologies_failed: WireInt
    """Topologies whose every start failed."""
    topologies_fitting: WireInt
    """Topologies with starts out: sent and not yet complete or failed."""
    starts: WireInt
    """How many starts the run holds."""
    starts_finished: WireInt
    """Starts that ran their whole **Evaluation budget**: only these count (ADR-0019)."""
    starts_failed: WireInt
    starts_running: WireInt
    starts_queued: WireInt
    """Its starts waiting at the scheduler that could start the moment resources free up, as
    its coordinator last heard."""
    starts_held: WireInt
    """Its starts waiting at the scheduler on something other than free resources, such as the
    user's job limit. Each running, queued or held start is one of the user's jobs, an array task
    counted alone; on SLURM, a run in flight has its coordinator running and its successor
    waiting besides (ADR-0019)."""
    starts_still_improving: WireInt
    """Finished starts **Still improving** at their end (#234): their Train RMSE was still
    falling when their evaluations ran out. Run detail shows its share of `starts_finished`."""
    starts_stopped: WireInt
    """Starts its cancel stopped while they ran (#324): Resume fits them again from the
    beginning, and moves the count into the stop it records."""


class RunBest(WireModel):
    """The run's best topology so far, through its **Best start**."""

    graph: WireInt
    open_state: WireInt
    start: WireInt
    """Its **Best start**, `#214/T12.3` start 37, whose RMSEs these are."""
    train_rmse: float | None
    val_rmse: float | None
    """`null` for a run without validation points, which ranks by Train RMSE."""
    scores: list[ProtocolScore]
    """How the Best start's worker scored its best, per protocol in the run's revision's order:
    each protocol's stored RMSE, as its page marks the highest (#389)."""


class FailureCause(StrEnum):
    """Why a failed run stopped (ADR-0019)."""

    STARTS_FAILED = "starts_failed"
    """It sent every start, and some failed."""
    STOPPED_EARLY = "stopped_early"
    """20 starts failed in a row with none finishing between, so it sent no more."""
    REFUSED = "refused"
    """The cluster wouldn't take one of its jobs as asked."""
    COORDINATOR = "coordinator"
    """Its coordinating job kept failing: three generations in a row ended without progress."""


class StartCause(StrEnum):
    """Why a **Failed start** stopped short of its budget."""

    OUT_OF_MEMORY = "out_of_memory"
    ERROR = "error"
    TIME_LIMIT = "time_limit"
    LOST = "lost"
    """The cluster lost it on three tries."""


class FailedStarts(WireModel):
    cause: StartCause
    starts: WireInt


class RunFailure(WireModel):
    cause: FailureCause
    detail: str | None
    """The scheduler's own words, such as `sbatch`'s refusal or a waiting job's reason; `null`
    when it has none."""
    failed_starts: list[FailedStarts]
    """The run's failed starts counted by cause, most first."""


class RunResuming(WireModel):
    """A Resume accepted that no coordinator has taken up yet."""

    since: str
    """When it was accepted, in UTC (ISO 8601)."""
    ended: Literal["failed", "canceled"]
    """How the run had ended."""
    ended_at: str
    """When it had ended, in UTC (ISO 8601)."""


class RunStop(WireModel):
    """A time the run ended failed or canceled and was resumed: its fitting time leaves out the
    time from `ended_at` until `running_at` (#326). Run detail draws it as a stage, after the
    stretch of fitting it ended (#324)."""

    ended: Literal["failed", "canceled"]
    ended_at: str
    """When it ended, in UTC (ISO 8601), as are the stop's other times."""
    starts_finished: WireInt | None
    """Its finished starts when it ended; `null` for a stop recorded before ICMM kept them."""
    topologies_complete: WireInt | None
    """Its complete topologies when it ended, before the Resume took back those it fits again;
    `null` for a stop recorded before ICMM kept them."""
    starts_stopped: WireInt | None
    """The starts its cancel stopped while they ran, which the Resume fits again from the
    beginning; `null` for a stop recorded before ICMM kept them."""
    failure: RunFailure | None
    """Why it failed; `null` for a cancel, and for a stop recorded before ICMM kept it."""
    resumed_at: str
    """When its Resume was accepted."""
    running_at: str | None
    """When one of its starts next ran; `null` until one has."""


class RunSummary(WireModel):
    """A run as Runs lists it."""

    id: WireInt
    config: RunConfig
    dataset: RunDataset
    num_states: WireInt
    state: RunState
    held: RunHold | None
    """Set while `state` is `held`."""
    queued: RunQueued | None
    """Set while `state` is `queued`."""
    relaunched_at: str | None
    """When This computer last launched its coordinator again, once it had stopped with the
    computer or crashed; `null` for a run never relaunched, and on a cluster."""
    validation: bool
    """Whether its dataset revision has validation points: without them, it ranks by Train RMSE,
    below the runs that have them (ADR-0006)."""
    progress: RunProgress
    best: RunBest | None
    """`null` until one of its starts has finished."""
    failure: RunFailure | None
    """Set once `state` is `failed`."""
    canceling: str | None
    """When a Cancel run was accepted, in UTC (ISO 8601), while the run hasn't ended: it shows
    Canceling, its starts stopping."""
    resuming: RunResuming | None
    """Set from a Resume's acceptance until a coordinator takes the run up: it shows Resuming,
    while `state` is queued."""
    submitted_at: str
    """In UTC (ISO 8601), as are the run's other times."""
    ended_at: str | None
    first_running_at: str | None
    """When the first of its starts ran: fitting begins. Its **Fitting time** runs from here to
    its end, or now, leaving out each of its `stops` (#326)."""
    stops: list[RunStop]
    """Each time it ended and was resumed, earliest first; empty for a run never resumed, and
    for one resumed before ICMM kept them."""


class ListRunsParams(WireModel):
    filter: str | None
    """Runs whose number is this, written `#214` or `214`, or whose config's or dataset's name
    holds it, ignoring case; `null` or blank for every run."""
    dataset: str | None
    """Only the runs of the dataset with this id, with `filter`'s; `null` for every dataset's."""
    config: str | None
    """Only the runs of the config with this id, with the others'; `null` for every config's."""
    after: str | None
    """The `next` of the page before; `null` for the first page."""


class RunList(WireModel):
    runs: list[RunSummary]
    """In flight, newest first, then those that ended, the latest end first. A run that moves
    between pages, ending or resumed, is listed where it was then, or not at all; the `runs`
    change says which."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class RunCounts(WireModel):
    """The platform's runs by state. A run canceling counts as canceling, not as the state it's
    leaving (#324)."""

    running: WireInt
    canceling: WireInt
    queued: WireInt
    held: WireInt
    ended: WireInt
    failed: WireInt
    """Of those ended."""
    canceled: WireInt
    """Of those ended."""
    first_ended_at: str | None
    """When the earliest of them ended, in UTC (ISO 8601); `null` before any has."""


class DatasetBest(WireModel):
    """A dataset's best run among those that ended on its current data: a run fit to earlier data
    scores differently, so it isn't one (ADR-0003, ADR-0006)."""

    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    """The run's top topology's **Best start**, `#211/T12.3` start 37, which names it (#389)."""
    num_states: WireInt
    rmse: float


class RunsDataset(WireModel):
    """A dataset with runs on this platform, for Runs' filter and Vs dataset best, and the runs
    and best Datasets and Dataset detail show."""

    id: str
    name: str | None
    """Its name now, or when it was deleted; `null` when this platform never had it."""
    deleted: bool
    runs: WireInt
    """In flight and ended, on any of its revisions."""
    runs_earlier: WireInt
    """Of those, the runs fit to earlier data; all of them once it's deleted."""
    runs_in_flight: WireInt
    """Of those, the runs queued, held or running."""
    latest_run: WireInt
    """Its latest run, in flight or ended: its highest id, since ids never recycle."""
    best_val: DatasetBest | None
    """The ended run with the lowest Val RMSE, of those with validation points; `null` before
    one, and once it's deleted."""
    best_train: DatasetBest | None
    """The ended run with the lowest Train RMSE, of those without validation points, which rank
    by Train RMSE; `null` before one, and once it's deleted."""


class RunsOverview(WireModel):
    """What Runs says of every run on the platform, whatever page it's on: one grouped query."""

    counts: RunCounts
    datasets: list[RunsDataset]
    """The datasets with runs, by name."""


class EndedRunsParams(WireModel):
    after: FeedPosition
    """The last change the desktop saw on this platform."""


class EndedRun(WireModel):
    id: WireInt
    config: RunConfig
    state: Literal["completed", "failed", "canceled"]
    ended_at: str
    """In UTC (ISO 8601)."""


class EndedRuns(WireModel):
    """The runs that ended since a feed position, for the notifications (#229)."""

    runs: list[EndedRun]
    """The latest 50 to end, the latest first. A run resumed since it ended isn't one."""
    count: WireInt
    """How many ended since, all told."""
    reset: bool
    """`after` isn't in this feed, or is past its end: the desktop can't tell what ended, and
    `runs` is empty."""
    latest: FeedPosition
    """The feed's latest change now: where the desktop has seen to, once it has notified these."""


class RunTiming(WireModel):
    """The finished starts of the platform's runs with this many states, at this many CPUs per
    start: Submit's time estimate divides their time by their evaluations (#229)."""

    num_states: WireInt
    cpus_per_start: WireInt
    runs: WireInt
    """How many runs they're from."""
    starts: WireInt
    evaluations: WireInt
    elapsed_s: float
    """Their elapsed times, summed."""


class RunTimings(WireModel):
    timings: list[RunTiming]
    """By number of states, then CPUs per start; empty before a start has finished here."""


class TimeEvaluationsParams(WireModel):
    """Submit's time estimate for a config the platform's finished starts haven't timed (#229)."""

    dataset: DatasetContent
    """The config's dataset, as `read_dataset` read its current revision."""
    num_states: WireInt
    bounds: Bounds


class EvaluationTime(WireModel):
    seconds_per_evaluation: float
    """On one thread of this computer."""
    evaluations: WireInt
    """How many it timed."""


class JobCounts(WireModel):
    running: WireInt
    """Jobs running, or holding a place, each array task counted."""
    pending: WireInt
    """Jobs waiting, each array task counted."""


class UserJobs(WireModel):
    """The user's jobs on the cluster now, for Submit's held forecast. A new run is held when the
    running jobs leave no room under the QOS's MaxJobsPerUser for its coordinator and one start;
    with room it can begin, though the scheduler's resources and priority decide when (ADR-0019)."""

    jobs: JobCounts | None
    """`null` on a platform without SLURM."""


class Run(RunSummary):
    """A run with what it fits, as it was pinned at submit, and when each stage began."""

    settings: Config | None
    """Its config's settings as they were saved when it was submitted; `null` for a run a newer
    ICMM submitted, in a format this one can't read."""
    search_seed: WireInt
    """The config's, or drawn at submit."""
    output_folder: str
    """Where its starts' results and **Start logs** go: the Output folder when it was submitted,
    as a full path on the platform."""
    folder: str
    """Its own folder in that Output folder, `run-214-1f3a9c0e`, from `~/` under the platform's
    home: what Copy run path copies, and what Delete run removes."""
    engine: str | None
    """The key of the **Engine bundle** its coordinator and workers run from (ADR-0020); `null`
    for a run submitted from an engine run from a checkout."""
    engine_installed: bool
    """Whether that engine is still on the platform, and not below the **Floor**. A Resume of a
    run whose engine isn't fits on the engine that answers it, and says so (ADR-0020)."""
    claimed_at: str | None
    """When its first coordinator claimed it: Queued ends."""
    topologies_listed_at: str | None
    first_array_at: str | None
    """When its first starts went out."""
    protocols: list[RunProtocol]
    """Its revision's protocols, in the order its starts' scores are stored: what names them
    where the revision can't be read (missing, damaged or saved by a newer ICMM)."""
    folder_bytes: WireInt | None
    """What its folder holds, as Delete run… says: the bytes of each try's result, Start log and
    job log, added up by its coordinator as it collects the try. `null` until any are counted,
    and for a run submitted before ICMM counted them."""


class RunStretchesParams(WireModel):
    run: WireInt


class RunStretch(WireModel):
    """A stretch of a run's time in which some of its topologies ended or its best moved."""

    stretch: WireInt
    """Its place from the run's first array, from 0: it began `stretch` × `stretch_s` seconds
    after `first_array_at`."""
    topologies_complete: WireInt
    """How many topologies completed in it."""
    best_train_rmse: float | None
    """The run's best at its end, as `best` says it: `null` before one, or where a sweep
    failed."""
    best_val_rmse: float | None


class RunStretches(WireModel):
    """A run's **Stretches**, for Run detail's progress chart past 2,000 topologies: what its
    coordinator kept as it collected, never each topology (ADR-0013)."""

    stretch_s: WireInt | None
    """How long each stretch lasts: a minute at first, doubling as the run's time grows, so a run
    keeps at most 500. `null` for a run submitted before ICMM kept them, which has none."""
    stretches: list[RunStretch]
    """Those in which something happened, earliest first."""


type TopologyState = Literal["next", "fitting", "complete", "failed"]
"""Waiting for its first array, fitting once one has gone out, then complete once every start
has ended with one finished, or failed when none did."""

type TopologyOrder = Literal["rank", "sent"]
"""`rank`: by the Best start's Val RMSE, or its Train RMSE in a run without validation points,
"—" after every number, then those with no start finished, in the order they go out (ADR-0006).
`sent`: the order the run's coordinator sends them, for Run detail's grid and its pace."""


class ListTopologiesParams(WireModel):
    run: WireInt
    order: TopologyOrder
    state: TopologyState | None
    """Only the topologies in this state, in `sent` order, for Run detail past 2,000 topologies:
    those fitting, next and failed, wherever they are among the run's; `null` for every one."""
    after: str | None
    """The `next` of the page before, in the same order; `null` for the first page."""


class TopologyBest(WireModel):
    """A topology's **Best start**: its finished start with the lowest Train RMSE (ADR-0006)."""

    start: WireInt
    train_rmse: float | None
    """`null` when a train point's sweep failed: shown as "—"."""
    val_rmse: float | None
    """`null` when a validation point's sweep failed, or the run has no validation points."""


class SpreadSummary(WireModel):
    """A topology's **Parameter spread** over its **Top 10**: the median over its parameters,
    the open state's pair left out, with their min, quartiles and max for the box (ADR-0021)."""

    median: float
    min: float
    q1: float
    q3: float
    max: float


class TopologySummary(WireModel):
    """A topology of a run, `#214/T12.3`, as Run detail lists it: one row of `topologies`, which
    its coordinator keeps as the topology's starts move."""

    graph: WireInt
    open_state: WireInt
    position: WireInt
    """Where it goes out among the run's topologies, from 0."""
    state: TopologyState
    provisional: bool
    """Still next or fitting: its best, near best and spread are "so far"."""
    starts: WireInt
    """How many starts it holds."""
    starts_finished: WireInt
    starts_failed: WireInt
    starts_running: WireInt
    best: TopologyBest | None
    """`null` until one of its starts has finished."""
    near_best: WireInt | None
    """How many finished starts are **Near best**; `null` without a best, or while the Best
    start's Train RMSE is "—" (ADR-0021)."""
    spread: SpreadSummary | None
    """`null` while its Top 10 holds fewer than 2 starts."""
    first_sent_at: str | None
    """When its first array went out, in UTC (ISO 8601), as are its other times."""
    last_ended_at: str | None
    """When one of its starts last ended: once it's complete or failed, when it did. Its pace
    and the run's ETA come from these."""


class TopologyList(WireModel):
    topologies: list[TopologySummary]
    """A page in the order asked for. A topology whose rank moves between pages is listed where
    it was then, twice or not at all; the `runs` change says to read it again."""
    ranked: WireInt
    """How many of the run's topologies rank: those with a Best start."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class ReadTopologyParams(WireModel):
    run: WireInt
    graph: WireInt
    open_state: WireInt


class TopStart(WireModel):
    """One of a topology's **Top 10**: its finished starts with the lowest Train RMSE."""

    start: WireInt
    train_rmse: float
    val_rmse: float | None
    best: list[float]
    """Its raw **Parameters** (ADR-0007): the desktop makes them canonical."""


class TopologyArray(WireModel):
    """An array of the topology's starts that went out: SLURM's array job, or This computer's
    job."""

    number: WireInt
    """The array's number in the run, from 1."""
    job_id: str | None
    """`null` until the scheduler is known to have taken it."""
    tasks: WireInt
    sent_at: str | None
    ended_at: str | None
    """When its last task ended; `null` while one is out."""


class Topology(TopologySummary):
    """A topology with what its page shows: its rank in its run and in its run's Ranking group,
    its starts by state, its arrays, each parameter's spread and its Top 10."""

    rank: WireInt | None
    """Its place among the run's topologies, from 1, by `rank` order; `null` without a best."""
    ranked: WireInt
    """How many of the run's topologies rank."""
    group_rank: WireInt | None
    """Its place in its run's **Ranking group**, from 1, as Results' leaderboard and its Best
    start's page (`read_group_rank`) rank it; `null` without a best."""
    group_ranked: WireInt
    """How many topologies the run's Ranking group ranks."""
    starts_queued: WireInt
    """Sent out and waiting at the scheduler."""
    starts_waiting: WireInt
    """Not sent out yet: waiting for room in the run's rolling window, or for a Resume."""
    parameter_spreads: list[float | None] | None
    """Each parameter's spread, in layout order, `null` for the open state's pair; `null` with
    the spread."""
    arrays: list[TopologyArray]
    """In the order they went out."""
    top_10: list[TopStart]
    """The lowest Train RMSE first; a start whose Train RMSE is "—" never enters (ADR-0021)."""
