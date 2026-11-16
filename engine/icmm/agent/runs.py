"""The run RPCs: Submit's `submit_run`, Run detail's `cancel_run`, `delete_run` and `resume_run`,
and the reads Submit and Runs make (ADR-0016, ADR-0019).

Each write is a lifecycle request (ADR-0009): it records what's asked with its request accepted,
in one transaction, and answers at once; the work follows. Submit's first coordinator and a
Resume's next one go out from the lifecycle dispatcher (`icmm.agent.lifecycle`); a cancel is the
run's coordinator's, or `icmm cleanup`'s where none carries it; a delete's jobs, files and rows go
in `icmm cleanup`. A retry with the same `request_key` answers what the first try recorded.

`icmm.config`, `icmm.config_store`, `icmm.dataset.store` and `icmm.run_store` are imported on
first use, so the agent's start path stays as light as `hello` needs.
"""

from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any

from icmm.agent import requests
from icmm.agent.serve import AgentError
from icmm.db import RunsDb, reading
from icmm.topology import Lists
from icmm.wire import Method
from icmm.wire.base import WireModel
from icmm.wire.changes import FeedPosition
from icmm.wire.errors import (
    BadRequestError,
    ConflictData,
    ConflictError,
    InvalidData,
    InvalidError,
    Issue,
    NotFoundData,
    NotFoundError,
    Severity,
    UnavailableData,
    UnavailableError,
    UnavailableSource,
)
from icmm.wire.run import (
    AcceptedRun,
    CancelingRun,
    CancelRunParams,
    DeletedRun,
    DeleteRunParams,
    EndedRuns,
    EndedRunsParams,
    JobCounts,
    ListRunsParams,
    ReadRunParams,
    ResumedRun,
    ResumeRunParams,
    Run,
    RunList,
    RunsOverview,
    RunStretches,
    RunStretchesParams,
    RunTimings,
    SubmitRunParams,
    UserJobs,
)

if TYPE_CHECKING:
    from icmm.run_store import Pinned
    from icmm.scheduler.slurm import SlurmCli

_TRIES = 3
"""How often Submit checks a config again when it, or its dataset, is saved as it's checked."""
_RETRY_AFTER_MS = 1000


def submit_run(
    params: SubmitRunParams,
    *,
    db: RunsDb,
    data_folder: Path,
    lists: Lists,
    method: Method,
    engine: str | None,
) -> AcceptedRun:
    """Checks the config as it was last saved, and its dataset's current revision, outside the
    write lock, then records the run in one transaction, if neither was saved meanwhile. A
    refusal isn't recorded, so a retry once it's fixed can submit. `engine` is the key of the
    engine bundle this agent runs from."""
    from icmm import run_store

    outcome = requests.recorded(db.connection(), method, params)
    for _ in range(_TRIES):
        if outcome is not None:
            break
        pinned = _pinned(
            params.config_id, db=db, data_folder=data_folder, lists=lists, engine=engine
        )
        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is None and run_store.still_current(conn, pinned):
                record = partial(_record, request_key=params.request_key, pinned=pinned)
                outcome = requests.admit(conn, method, params, record)
    if outcome is None:
        raise AgentError(
            UnavailableError(
                code="unavailable",
                message="This config was being saved as it was submitted. Try again in a moment.",
                data=UnavailableData(
                    source=UnavailableSource.DB, retry_after_ms=_RETRY_AFTER_MS, details=None
                ),
            )
        )
    return requests.answer(method, outcome)


def cancel_run(params: CancelRunParams, *, db: RunsDb, method: Method) -> CancelingRun:
    """Records the cancel; the run shows Canceling until its coordinator, or `icmm cleanup`,
    ends it canceled. A second cancel while it cancels is recorded beside the first, and
    succeeds with it."""
    from icmm import run_store

    def act(conn: sqlite3.Connection) -> CancelingRun:
        _in_state(params.id, lambda: run_store.cancel(conn, params.id), _CANCEL)
        return CancelingRun(id=params.id)

    return _lifecycle(params, db=db, method=method, act=act)


def delete_run(params: DeleteRunParams, *, db: RunsDb, method: Method) -> DeletedRun:
    """Records the run's tombstone, so it leaves every list at once; `icmm cleanup` removes its
    jobs, files and rows after, and records the request succeeded."""
    from icmm import run_store

    def act(conn: sqlite3.Connection) -> DeletedRun:
        _in_state(params.id, lambda: run_store.tombstone(conn, params.id), _DELETE)
        return DeletedRun(id=params.id)

    return _lifecycle(params, db=db, method=method, act=act)


def resume_run(
    params: ResumeRunParams, *, db: RunsDb, data_folder: Path, method: Method, engine: str | None
) -> ResumedRun:
    """Puts the run back in flight, its unfinished starts waiting, and records its next
    generation for the lifecycle dispatcher to launch. `engine` is the key of the engine bundle
    this agent runs from, which the run fits on where its own is no longer installed."""
    from icmm import run_store

    def act(conn: sqlite3.Connection) -> ResumedRun:
        (own,) = conn.execute("SELECT engine FROM runs WHERE id = ?", (params.id,)).fetchone() or (
            None,
        )
        fits = _in_state(
            params.id, lambda: run_store.reopen(conn, params.id, engine, data_folder), _RESUME
        )
        return ResumedRun(id=params.id, engine=fits, replaced_engine=None if fits == own else own)

    return _lifecycle(params, db=db, method=method, act=act)


def _lifecycle[R: WireModel](
    params: Any, *, db: RunsDb, method: Method, act: Callable[[sqlite3.Connection], R]
) -> R:
    """Admits a lifecycle request once per key, in one write transaction with what it records
    (ADR-0009); a refusal isn't recorded, so a retry once it's fixed can act."""
    outcome = requests.recorded(db.connection(), method, params)
    if outcome is None:
        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is None:
                outcome = requests.admit(conn, method, params, act)
    return requests.answer(method, outcome)


_CANCEL = {"run_ended": "Run #{run} has already ended, so there's nothing to cancel."}
_DELETE = {"run_in_flight": "Run #{run} hasn't ended yet. Cancel it first, then delete it."}
_RESUME = {
    "run_in_flight": "Run #{run} is still going, so there's nothing to resume.",
    "run_completed": "Run #{run} completed, so there's nothing left to fit.",
}
"""Each request's words for a run not in a state it acts on."""


def _in_state[T](run: int, act: Callable[[], T], messages: dict[str, str]) -> T:
    """`act`'s answer, or its refusal as the wire's error: `not_found` for a run deleted or never
    submitted, `conflict` in `messages`' words for one not in a state to act on."""
    from icmm import run_store

    try:
        return act()
    except run_store.NotFoundError:
        raise AgentError(_run_not_found(run)) from None
    except run_store.StateError as e:
        message = messages[e.reason].format(run=run)
        raise AgentError(
            ConflictError(code="conflict", message=message, data=ConflictData(reason=e.reason))
        ) from None


def _record(conn: sqlite3.Connection, *, request_key: str, pinned: Pinned) -> AcceptedRun:
    from icmm import run_store

    return AcceptedRun(run=run_store.record(conn, request_key, pinned))


def _pinned(
    config_id: str, *, db: RunsDb, data_folder: Path, lists: Lists, engine: str | None
) -> Pinned:
    """What a run of the config would fit now, once it passes `validate_config`'s checks; the
    refusal, as the wire's error, if it doesn't."""
    import secrets

    from icmm import config, platform_settings, run_store
    from icmm import config_store as configs
    from icmm.agent import configs as config_rpcs
    from icmm.agent import datasets as dataset_rpcs
    from icmm.dataset import store as datasets

    conn = db.connection()
    try:
        row = configs.live_row(conn, config_id)
    except configs.NotFoundError:
        raise AgentError(config_rpcs.not_found(config_id)) from None
    if row.format > config.FORMAT:
        raise AgentError(config_rpcs.unreadable_newer(row.name, row.format))
    settings = config_rpcs.saved_settings(row)
    try:
        current = datasets.read_current(conn, data_folder, row.dataset_id)
    except datasets.NotFoundError:
        name = conn.execute("SELECT name FROM datasets WHERE id = ?", (row.dataset_id,)).fetchone()
        raise AgentError(_invalid([config_rpcs.dataset_gone(name and name[0])])) from None
    except datasets.UnreadableError as e:
        name = datasets.name_of(conn, row.dataset_id)
        raise AgentError(dataset_rpcs.unreadable(name, e.problem, e.details)) from None
    checked = config.check(settings, lists, protocols=len(current.dataset.protocols))
    errors = [i for i in checked.issues if i.severity is Severity.ERROR]
    if errors or checked.work.topologies is None or checked.work.starts is None:
        raise AgentError(_invalid(errors))
    saved = platform_settings.read(conn)
    if saved is None:
        message = "This platform's Platform settings aren't saved yet. Set them up in Settings."
        raise AgentError(_invalid([Issue(path=[], message=message, severity=Severity.ERROR)]))
    seed = settings.search.search_seed
    return run_store.Pinned(
        config_id=row.id,
        config_revision=row.revision,
        format=row.format,
        settings=json.dumps(row.settings, separators=(",", ":")),
        num_states=checked.config.topology.num_states or 0,
        topologies=checked.work.topologies,
        starts=checked.work.starts,
        dataset_id=row.dataset_id,
        dataset_revision=current.revision,
        has_validation=any(
            point.validation for p in current.dataset.protocols for point in p.points
        ),
        search_seed=secrets.randbelow(config.MAX_SEARCH_SEED + 1) if seed is None else seed,
        # The platform's own home, as the agent runs on the platform, in its own separators:
        # Windows would otherwise keep the desktop's `/` after the home it expands `~` to.
        output_folder=os.path.normpath(os.path.expanduser(saved.settings.output_folder)),
        engine=engine,
    )


def list_runs(params: ListRunsParams, *, db: RunsDb) -> RunList:
    """One query over the database: nothing is read from the Data or Output folders."""
    from icmm import run_store

    try:
        page, next = run_store.list_page(
            db.connection(),
            params.filter,
            params.after,
            dataset=params.dataset,
            config=params.config,
        )
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None
    return RunList(runs=page, next=next)


def runs_overview(_: None, *, db: RunsDb) -> RunsOverview:
    """One grouped query over the database: nothing is read from the Data or Output folders."""
    from icmm import run_store

    return run_store.overview(db.connection())


def read_run(params: ReadRunParams, *, db: RunsDb, data_folder: Path) -> Run:
    from icmm import run_store

    try:
        return run_store.read(db.connection(), params.id, data_folder)
    except run_store.NotFoundError:
        raise AgentError(_run_not_found(params.id)) from None


def run_stretches(params: RunStretchesParams, *, db: RunsDb) -> RunStretches:
    from icmm import stretches

    try:
        return stretches.read(db.connection(), params.run)
    except stretches.NotFoundError:
        raise AgentError(_run_not_found(params.run)) from None


def _run_not_found(run: int) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message=f"Run #{run} isn't on this platform any more.",
        data=NotFoundData(kind="run", id=str(run)),
    )


def ended_runs(params: EndedRunsParams, *, db: RunsDb) -> EndedRuns:
    from icmm import run_store

    conn = db.connection()
    with reading(conn):
        feed, latest, count, ended = run_store.ended_since(conn, params.after.seq)
    now = FeedPosition(feed=feed, seq=latest)
    if params.after.feed != feed or params.after.seq > latest:
        return EndedRuns(runs=[], count=0, reset=True, latest=now)
    return EndedRuns(runs=ended, count=count, reset=False, latest=now)


def run_timings(_: None, *, db: RunsDb) -> RunTimings:
    from icmm import run_store

    return RunTimings(timings=run_store.timings(db.connection()))


def user_jobs(
    _: None, *, slurm: Callable[[], SlurmCli | None] | None = None, user: str | None = None
) -> UserJobs:
    """`slurm` makes the `SlurmCli` this request asks with, answering `None` on a platform
    without SLURM, and `user` is whose jobs; by default, this platform's and the agent's user."""
    import getpass

    cli = (slurm or _platform_slurm)()
    if cli is None:
        return UserJobs(jobs=None)
    from icmm.scheduler import SchedulerUnavailableError

    try:
        running, pending = cli.user_jobs(user or getpass.getuser())
    except SchedulerUnavailableError as e:
        raise AgentError(
            UnavailableError(
                code="unavailable",
                message="SLURM didn't say how many jobs you have. Try again in a moment.",
                data=UnavailableData(
                    source=UnavailableSource.SCHEDULER,
                    retry_after_ms=_RETRY_AFTER_MS,
                    details=str(e),
                ),
            )
        ) from None
    return UserJobs(jobs=JobCounts(running=running, pending=pending))


def _platform_slurm() -> SlurmCli | None:
    from icmm import scheduler
    from icmm.scheduler.slurm import SlurmCli
    from icmm.wire.handshake import Scheduler

    return SlurmCli() if scheduler.detect() is Scheduler.SLURM else None


def _invalid(issues: list[Issue]) -> InvalidError:
    return InvalidError(
        code="invalid",
        message="This config can't be submitted yet.",
        data=InvalidData(issues=issues),
    )
