"""The config RPCs (ADR-0016): `validate_config`'s check, and the configs the runs database
owns, listed, read, saved, copied and deleted.

Each write claims its config, stages its projection, commits its row with its outcome, then
publishes `<data folder>/configs/<id>.json` before it answers success (`icmm.config_store`).
A retry with the same `request_key` picks up where the first try stopped, so a write lands
once, and replaying a committed outcome publishes its projection first.

`icmm.config` and `icmm.config_store` are imported on first use, so the agent's start path
stays as light as `hello` needs.
"""

from __future__ import annotations

import errno
import os
import sqlite3
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from icmm.agent import requests
from icmm.agent.serve import AgentError, internal_error
from icmm.agent.storage import no_space
from icmm.db import NewerSchemaError, RunsDb
from icmm.durable import file_stamp
from icmm.topology import Lists
from icmm.wire import Method
from icmm.wire.config import (
    ConfigCheck,
    ConfigCount,
    ConfigDataset,
    ConfigDatasetName,
    ConfigList,
    ConfigRevision,
    ConfigRun,
    ConfigSummary,
    CountConfigsParams,
    DeleteConfigParams,
    DeletedConfig,
    DuplicateConfigParams,
    DuplicatedConfig,
    ListConfigsParams,
    ReadConfigParams,
    SaveConfigParams,
    SavedConfig,
    ValidateConfigParams,
)
from icmm.wire.errors import (
    BadRequestError,
    ConflictData,
    ConflictError,
    InvalidData,
    InvalidError,
    Issue,
    NoSpaceError,
    NotFoundData,
    NotFoundError,
    Severity,
    UnavailableData,
    UnavailableError,
    UnavailableSource,
    UnreadableData,
    UnreadableError,
    UnreadableProblem,
)

if TYPE_CHECKING:
    from icmm.config_store import Claim, Row

_NO_SPACE = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}
_RETRY_AFTER_MS = 1000


def validate_config(params: ValidateConfigParams, *, lists: Lists, db: RunsDb) -> ConfigCheck:
    """Parsing and arithmetic over the config, a few seeks into `lists`, and one query for its
    dataset's number of protocols, which sizes its Start logs (ADR-0013)."""
    from icmm import config

    return config.check(params.config, lists, protocols=_protocols(db, params.config.dataset_id))


def _protocols(db: RunsDb, dataset_id: str) -> int | None:
    """The dataset's current revision's number of protocols; `None` for one deleted or never
    saved, or while the runs database can't be read: the note it sizes can wait."""
    from icmm.dataset import store

    try:
        return store.protocol_count(db.connection(), dataset_id)
    except (sqlite3.Error, OSError, NewerSchemaError):
        return None


def list_configs(params: ListConfigsParams, *, db: RunsDb) -> ConfigList:
    """One query over the database: nothing is read from the configs folder."""
    from icmm import config_store as store
    from icmm.config import FORMAT

    try:
        page, next = store.list_page(db.connection(), params.after)
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None
    except store.StaleCursorError:
        raise AgentError(
            ConflictError(
                code="conflict",
                message="The configs changed too much since this list's first page. List them "
                "again.",
                data=ConflictData(reason="stale_cursor"),
            )
        ) from None
    return ConfigList(
        configs=[
            ConfigSummary(
                id=s.id,
                revision=s.revision,
                name=s.name,
                modified_at=s.modified_at,
                dataset=ConfigDatasetName(
                    id=s.dataset_id, name=s.dataset_name, deleted=s.dataset_deleted
                ),
                num_states=s.num_states,
                which=_which(s.which) if s.format <= FORMAT else None,
                topologies=s.topologies,
                starts=s.starts,
                unreadable=unreadable_newer(s.name, s.format) if s.format > FORMAT else None,
                latest_run=None
                if s.latest_run is None
                else ConfigRun(
                    id=s.latest_run.id, state=s.latest_run.state, ended_at=s.latest_run.ended_at
                ),
            )
            for s in page
        ],
        next=next,
    )


def read_config(params: ReadConfigParams, *, db: RunsDb, data_folder: Path) -> SavedConfig:
    from icmm import config_store as store

    conn = db.connection()
    try:
        row = store.live_row(conn, params.id)
    except store.NotFoundError:
        raise AgentError(not_found(params.id)) from None
    return SavedConfig(
        id=row.id,
        revision=row.revision,
        modified_at=row.modified_at,
        config=saved_settings(row),
        topologies=row.topologies,
        starts=row.starts,
        dataset=_dataset(conn, data_folder, row.dataset_id),
    )


def count_configs(params: CountConfigsParams, *, db: RunsDb) -> ConfigCount:
    from icmm import config_store as store

    return ConfigCount(configs=store.count_naming(db.connection(), params.dataset_id))


def save_config(
    params: SaveConfigParams,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
    lists: Lists,
) -> ConfigRevision:
    """Saves the config as `validate_config` would keep it, with the counts its check made, once
    it passes that check: issues aren't recorded, so a fixed retry can save. A request that hasn't
    finished checks again, since it may claim afresh."""
    from icmm import config
    from icmm import config_store as store

    checked: ConfigCheck | None = None

    def propose(conn: sqlite3.Connection) -> tuple[Row, int | None]:
        assert checked is not None
        current = None
        if params.id is None:
            if params.expected_revision is not None:
                raise store.StaleRevisionError
            config_id = store.new_id(conn)
        else:
            current = store.live_row(conn, params.id)
            if current.format > config.FORMAT:
                raise AgentError(unreadable_newer(current.name, current.format))
            if current.revision != params.expected_revision:
                raise store.StaleRevisionError
            config_id = params.id
        store.check_name(conn, config_id, checked.config.name)
        store.check_dataset(conn, checked.config.dataset_id)
        counts = (checked.config.topology.num_states, checked.work.topologies, checked.work.starts)
        settings = checked.config.model_dump(mode="json")
        return store.edited(current, config_id, settings, counts), params.expected_revision

    if requests.recorded(db.connection(), method, params) in (None, requests.ACTING):
        checked = config.check(params.config, lists)
        errors = [i for i in checked.issues if i.severity is Severity.ERROR]
        if errors:
            raise AgentError(_invalid(errors))
    return _written(
        params,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        subject=params.id,
        settles=True,
        propose=propose,
        needs_dataset=True,
        result_of=lambda held: ConfigRevision(id=held.row.id, revision=held.row.revision),
    )


def duplicate_config(
    params: DuplicateConfigParams,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
) -> DuplicatedConfig:
    """Saves a copy of the config as it was last saved, its name chosen as the copy is claimed
    and kept in the claim, so a retry publishes the same copy."""
    from icmm import config_store as store

    def propose(conn: sqlite3.Connection) -> tuple[Row, None]:
        source = store.live_row(conn, params.id)
        name = store.copy_name(conn, source.name)
        settings = {**saved_settings(source).model_dump(mode="json"), "name": name}
        counts = (source.num_states, source.topologies, source.starts)
        return store.edited(None, store.new_id(conn), settings, counts), None

    return _written(
        params,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        subject=params.id,
        settles=False,
        propose=propose,
        needs_dataset=False,
        result_of=lambda held: DuplicatedConfig(
            id=held.row.id, revision=held.row.revision, name=held.row.name
        ),
        taken="Another config took this copy's name as it saved. Duplicate again.",
    )


def delete_config(
    params: DeleteConfigParams, *, db: RunsDb, data_folder: Path, written: str, method: Method
) -> DeletedConfig:
    """Publishes the config's tombstone: its next revision, in its row and its projection, so a
    repair from the projections can't bring it back (ADR-0016)."""
    from icmm import config_store as store

    def propose(conn: sqlite3.Connection) -> tuple[Row, int]:
        current = store.live_row(conn, params.id)
        return store.tombstone(current), current.revision

    return _written(
        params,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        subject=params.id,
        settles=True,
        propose=propose,
        needs_dataset=False,
        result_of=lambda held: DeletedConfig(id=held.row.id),
    )


def repair(db: RunsDb, data_folder: Path, written: str) -> None:
    """Finishes what writes cut short left behind, as an agent starts: publishes each pending
    projection, removes each attempt that never committed and was abandoned long ago, and each
    stage no attempt has once it's that old, and rewrites each `<id>.json` that's missing, or was
    replaced or changed since its save published it.

    Two queries and one listing of the configs folder find whether there's anything to do,
    comparing each projection's stamp with the one recorded as it was published; only then is the
    store imported, and the write lock taken.
    """
    folder = data_folder / "configs"
    try:
        # `os.stat`, as publication records it: a listing's stat has no inode on Windows.
        found = {name: os.stat(folder / name) for name in os.listdir(folder)}
    except FileNotFoundError:
        found = {}
    conn = db.connection()
    # Read after the folder: a stage it lists was made after its claim, so is claimed here.
    claimed = conn.execute("SELECT 1 FROM config_claims LIMIT 1").fetchone() is not None
    recorded = conn.execute("SELECT id, projected FROM configs").fetchall()
    changed = [
        id
        for id, stamp in recorded
        if (st := found.get(f"{id}.json")) is None or file_stamp(st) != stamp
    ]
    staged = [name for name in found if name.endswith(".staging")]
    if not claimed and not changed and not staged:
        return

    from icmm import config_store as store

    held = store.claims(conn)
    for claim in held:
        if claim.committed:
            try:
                _publish(db, data_folder, claim.config_id, written=written)
            except AgentError:
                pass  # Still pending: the config's next write or agent tries again.
        elif store.abandoned(claim):
            removed = False
            with db.write() as conn:
                again = store.attempt(conn, claim.attempt)
                if again is not None and store.abandoned(again):
                    store.abandon(conn, again)
                    removed = True
            # Only an attempt this repair removed: one that committed meanwhile needs its stage.
            if removed:
                store.discard(data_folder, claim)
    # A stage no attempt has is garbage once it's as old as an abandoned attempt: younger, it
    # may be a writer's, about to be renamed in as its attempt's stage.
    claimed_stages = {claim.staging for claim in store.claims(db.connection())}
    old = time.time() - store.ABANDONED_AFTER_S
    for name in staged:
        if store.is_stage(name) and name not in claimed_stages and found[name].st_mtime < old:
            store.discard_stage(data_folder, name)
    for id in changed:
        with db.write() as conn:
            store.repair_projection(conn, data_folder, id)


def _written[R](
    params: Any,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
    subject: str | None,
    settles: bool,
    propose: Callable[[sqlite3.Connection], tuple[Row, int | None]],
    needs_dataset: bool,
    result_of: Callable[[Claim], R],
    taken: str | None = None,
) -> R:
    """A config write, once per `request_key`, through ADR-0016's four steps.

    `subject` is the config the request names. `propose` answers, in the attempt's transaction,
    the row the write publishes and the revision it replaces; a store refusal there is the
    request's outcome. With `settles`, the subject's pending projection, if another write left
    one, is published before this write records its attempt. A copy, whose name the agent chose,
    says `taken` when that name was taken as it committed.
    """
    from icmm import config_store as store

    key = params.request_key

    def unclaimed(conn: sqlite3.Connection, outcome: dict[str, Any] | None) -> bool:
        """New, or recorded but its attempt removed as abandoned before it committed: it starts
        another."""
        return outcome is None or (outcome is requests.ACTING and store.claim_of(conn, key) is None)

    outcome = requests.recorded(db.connection(), method, params)
    if unclaimed(db.connection(), outcome):
        if settles and subject is not None:
            _publish(db, data_folder, subject, written=written)

        def intend(conn: sqlite3.Connection) -> None:
            with _refusals(subject, taken=taken):
                row, expected = propose(conn)
                store.claim(conn, key, row, expected)

        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is None:
                outcome = requests.begin(conn, method, params, intend)
            elif unclaimed(conn, outcome):
                outcome = requests.resume(conn, method, params, intend)
    if outcome is requests.ACTING:
        outcome = _committed(
            params,
            db=db,
            data_folder=data_folder,
            written=written,
            method=method,
            needs_dataset=needs_dataset,
            result_of=result_of,
            taken=taken,
        )
    assert outcome is not None
    pending = store.claim_of(db.connection(), key)
    if pending is not None and pending.committed:
        _publish(db, data_folder, pending.config_id, written=written)
    return requests.answer(method, outcome)


def _committed(
    params: Any,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
    needs_dataset: bool,
    result_of: Callable[[Claim], Any],
    taken: str | None,
) -> dict[str, Any]:
    """Stages the request's attempt, then commits its row with its outcome; the outcome recorded,
    if another try of the request got there first. A committed write of the config whose
    projection is still pending is published first: committed writes take turns."""
    from icmm import config_store as store

    key = params.request_key
    claim = store.claim_of(db.connection(), key)
    refused = False
    if claim is not None and not claim.committed:
        try:
            store.stage(data_folder, claim)
        except OSError as e:
            raise AgentError(_file_error(e, data_folder, written)) from None
        _publish(db, data_folder, claim.config_id, written=written)

        def commit(conn: sqlite3.Connection) -> Any:
            with _refusals(claim.config_id, taken=taken):
                store.commit(conn, claim, needs_dataset=needs_dataset)
            return result_of(claim)

        try:
            with db.write() as conn:
                current = store.claim_of(conn, key)
                # Gone, or a retry's fresh attempt: this one was removed as abandoned meanwhile.
                # Committed: another try of this attempt got there first.
                refused = current is None or current.attempt != claim.attempt
                if not refused and current is not None and not current.committed:
                    outcome = requests.outcome_of(conn, commit)
                    refused = "error" in outcome
                    if refused:
                        store.drop(conn, current)
                    requests.finish(conn, params, outcome, acting=not refused)
        except store.BusyError:
            # Another write committed since this one published its projection: its retry
            # publishes that one first.
            raise AgentError(_busy()) from None
        if refused:
            store.discard(data_folder, claim)
    outcome = requests.recorded(db.connection(), method, params)
    if outcome is None or outcome is requests.ACTING:
        # Its attempt was removed as abandoned before it committed: a retry starts another.
        raise AgentError(_busy())
    return outcome


def _publish(db: RunsDb, data_folder: Path, config_id: str, *, written: str) -> None:
    """Publishes the config's pending projection, if a write left one, and records its request
    as succeeded; a file error leaves it pending, its request needing reconciliation."""
    from icmm import config_store as store

    if store.pending_on(db.connection(), config_id) is None:
        return  # Nothing pending: no need for the write lock.
    try:
        with db.write() as conn:
            held = store.pending_on(conn, config_id)
            if held is None:
                return
            store.publish(conn, data_folder, held)
            requests.mark(conn, held.request_key, "succeeded")
    except (OSError, store.ProjectionMismatchError) as e:
        with db.write() as conn:
            held = store.pending_on(conn, config_id)
            if held is not None:
                requests.mark(conn, held.request_key, "reconciliation_required")
        if isinstance(e, OSError):
            raise AgentError(_file_error(e, data_folder, written)) from None
        raise AgentError(internal_error()) from None


@contextmanager
def _refusals(config_id: str | None, *, taken: str | None) -> Generator[None]:
    """The store's refusals as the wire's errors, for the config `config_id`."""
    from icmm import config_store as store

    try:
        yield
    except store.NotFoundError:
        raise AgentError(not_found(config_id or "")) from None
    except store.StaleRevisionError:
        raise AgentError(
            ConflictError(
                code="conflict",
                message="This config was changed elsewhere. Reload to see it.",
                data=ConflictData(reason="stale_revision"),
            )
        ) from None
    except store.NameTakenError:
        raise AgentError(
            ConflictError(
                code="conflict",
                message=taken or "Another config already has this name.",
                data=ConflictData(reason="name_taken"),
            )
        ) from None
    except store.DatasetGoneError as e:
        raise AgentError(_invalid([dataset_gone(e.name)])) from None


def saved_settings(row: Row) -> Any:
    """The row's config in this engine's format; `unreadable` if it can't be read."""
    from icmm import config

    try:
        return config.read_config(row.settings)
    except config.UnreadableConfig as e:
        raise AgentError(_unreadable(row.name, e.problem, e.details)) from None


def _dataset(conn: sqlite3.Connection, data_folder: Path, dataset_id: str) -> ConfigDataset:
    """The dataset as it is now, its current revision's files checked as the list checks them."""
    from icmm.agent import datasets

    row = conn.execute(
        "SELECT name, current_revision, deleted_at FROM datasets WHERE id = ?", (dataset_id,)
    ).fetchone()
    if row is None or row[1] is None or row[2] is not None:
        name = None if row is None else row[0]
        return ConfigDataset(id=dataset_id, name=name, deleted=True, revision=None, unreadable=None)
    name, revision, _ = row
    return ConfigDataset(
        id=dataset_id,
        name=name,
        deleted=False,
        revision=revision,
        unreadable=datasets.current_problem(conn, data_folder, dataset_id, name),
    )


def _invalid(issues: list[Issue]) -> InvalidError:
    return InvalidError(
        code="invalid", message="This config can't be saved yet.", data=InvalidData(issues=issues)
    )


def dataset_gone(name: str | None) -> Issue:
    """The issue with a config whose dataset `name` was deleted, or never on the platform."""
    gone = "This platform has no such dataset." if name is None else f"{name} was deleted."
    return Issue(
        path=["dataset_id"], message=f"{gone} Choose another dataset.", severity=Severity.ERROR
    )


def not_found(config_id: str) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message="This config isn't on this platform any more.",
        data=NotFoundData(kind="config", id=config_id),
    )


def _busy() -> UnavailableError:
    return UnavailableError(
        code="unavailable",
        message="This config was being saved on another computer. Try again in a moment.",
        data=UnavailableData(
            source=UnavailableSource.DB, retry_after_ms=_RETRY_AFTER_MS, details=None
        ),
    )


def _file_error(e: OSError, data_folder: Path, written: str) -> UnavailableError | NoSpaceError:
    """A file error publishing a projection: the Data folder full, or a retry's to finish it."""
    if e.errno in _NO_SPACE:
        return no_space(data_folder, written)
    return UnavailableError(
        code="unavailable",
        message="ICMM couldn't write this config's copy in the Data folder. Try again in a moment.",
        data=UnavailableData(
            source=UnavailableSource.FILESYSTEM, retry_after_ms=_RETRY_AFTER_MS, details=None
        ),
    )


_UNREADABLE = {
    UnreadableProblem.NEWER: "A newer version of ICMM saved {name}. Update ICMM on this "
    "computer to use it.",
    UnreadableProblem.DAMAGED: "{name} was changed or damaged since it was saved, so ICMM "
    "can’t show it.",
    UnreadableProblem.MISSING: "{name} is missing from this platform’s runs database.",
}


def _unreadable(name: str, problem: UnreadableProblem, details: str) -> UnreadableError:
    return UnreadableError(
        code="unreadable",
        message=_UNREADABLE[problem].format(name=name),
        data=UnreadableData(problem=problem, details=details),
    )


def unreadable_newer(name: str, format: int) -> UnreadableError:
    from icmm.config import FORMAT

    details = f"Saved in format {format}; this ICMM reads up to format {FORMAT}."
    return _unreadable(name, UnreadableProblem.NEWER, details)


_KINDS: tuple[Literal["all", "sample", "ids"], ...] = ("all", "sample", "ids")


def _which(kind: str | None) -> Literal["all", "sample", "ids"] | None:
    """A listed config's kind of topologies, as its row names it; `None` for none this reads."""
    return next((k for k in _KINDS if k == kind), None)
