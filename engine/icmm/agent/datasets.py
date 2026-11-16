"""The dataset RPCs: list, read, check, save, duplicate, save as new and delete, and
Import/Export reads (ADR-0003, ADR-0009).

`icmm.dataset` builds its models as it's imported, so each handler imports it on first use:
the agent's start path stays as light as `hello` needs.
"""

from __future__ import annotations

import errno
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from icmm.agent import requests
from icmm.agent.serve import AgentError
from icmm.agent.storage import no_space
from icmm.db import RunsDb
from icmm.wire import Method
from icmm.wire.dataset import (
    DatasetContent,
    DatasetIssues,
    DatasetList,
    DatasetRevision,
    DatasetSummary,
    DeleteDatasetParams,
    DeletedDataset,
    DigestMatch,
    DigestMatches,
    DuplicateDatasetParams,
    DuplicatedDataset,
    FindScoringDigestParams,
    ListDatasetsParams,
    ProtocolSummary,
    ReadDatasetParams,
    RevisionFile,
    RevisionFiles,
    RevisionFilesParams,
    SaveAsNewDatasetParams,
    SavedAsNewDataset,
    SaveDatasetParams,
    SavedDataset,
    Template,
    ValidateDatasetParams,
)
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
    UnreadableData,
    UnreadableError,
    UnreadableProblem,
)
from icmm.wire.simulation import ReadDatasetRevisionParams

if TYPE_CHECKING:
    from icmm.dataset import Dataset
    from icmm.dataset import Issue as DatasetIssue
    from icmm.dataset.store import Intent

_UNSAVED_ID = "0000000000"
"""Stands in for a new dataset's id while its content is checked: the agent makes the real one
as it records the save."""
_NO_SPACE = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


def list_datasets(params: ListDatasetsParams, *, db: RunsDb, data_folder: Path) -> DatasetList:
    from icmm.dataset import store

    try:
        page, next = store.list_page(db.connection(), data_folder, params.after)
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None
    return DatasetList(
        datasets=[
            DatasetSummary(
                id=s.id,
                revision=s.revision,
                name=s.name,
                protocols=[
                    ProtocolSummary(
                        name=p.name, template=Template(p.template), points=p.points, steps=p.steps
                    )
                    for p in s.protocols
                ],
                modified_at=s.modified_at,
                validation=s.validation,
                interpolated=s.interpolated,
                unreadable=None
                if s.unreadable is None
                else unreadable(s.name, s.unreadable.problem, s.unreadable.details),
            )
            for s in page
        ],
        next=next,
    )


def read_dataset(params: ReadDatasetParams, *, db: RunsDb, data_folder: Path) -> SavedDataset:
    from icmm.dataset import store, template_of

    try:
        current = store.read_current(db.connection(), data_folder, params.id)
    except store.NotFoundError:
        raise AgentError(_not_found(params.id)) from None
    except store.UnreadableError as e:
        raise AgentError(unreadable(_name(db, params.id), e.problem, e.details)) from None
    return SavedDataset(
        id=current.id,
        revision=current.revision,
        modified_at=current.modified_at,
        content=_content(current.dataset),
        templates=[Template(template_of(p)) for p in current.dataset.protocols],
    )


def read_dataset_revision(
    params: ReadDatasetRevisionParams, *, db: RunsDb, data_folder: Path
) -> SavedDataset:
    """The revision a run fits, read as it was saved and checked against its digest, whatever
    happened to its dataset since: its revisions stay for its runs (ADR-0003)."""
    from icmm.dataset import store, template_of

    conn = db.connection()
    try:
        dataset = store.read_published(conn, data_folder, params.id, params.revision, live=False)
    except store.NotFoundError:
        raise AgentError(_revision_not_found(params.id, params.revision)) from None
    except store.UnreadableError as e:
        raise AgentError(unreadable(_name(db, params.id), e.problem, e.details)) from None
    (saved_at,) = conn.execute(
        "SELECT saved_at FROM dataset_revisions WHERE dataset_id = ? AND revision = ?",
        (params.id, params.revision),
    ).fetchone()
    return SavedDataset(
        id=params.id,
        revision=params.revision,
        modified_at=saved_at,
        content=_content(dataset),
        templates=[Template(template_of(p)) for p in dataset.protocols],
    )


def revision_files(params: RevisionFilesParams, *, db: RunsDb, data_folder: Path) -> RevisionFiles:
    from icmm.dataset import store

    try:
        stored = store.stored_files(db.connection(), data_folder, params.id, params.revision)
    except store.NotFoundError:
        raise AgentError(_not_found(params.id)) from None
    except store.UnreadableError as e:
        row = db.connection().execute("SELECT name FROM datasets WHERE id = ?", (params.id,))
        name = (row.fetchone() or ("This dataset",))[0]
        raise AgentError(unreadable(name, e.problem, e.details)) from None
    return RevisionFiles(
        name=stored.name,
        # `stored_files` decoded each as UTF-8 already, so the text is its bytes exactly.
        files=[RevisionFile(name=n, text=b.decode("utf-8")) for n, b in stored.files.items()],
        files_digest=stored.files_digest,
    )


def find_scoring_digest(params: FindScoringDigestParams, *, db: RunsDb) -> DigestMatches:
    from icmm.dataset import store

    matches = store.with_scoring_digest(db.connection(), params.scoring_digest)
    return DigestMatches(datasets=[DigestMatch(id=i, name=n) for i, n in matches])


def validate_dataset(params: ValidateDatasetParams, *, db: RunsDb) -> DatasetIssues:
    from icmm.dataset import template_of

    return DatasetIssues(
        issues=_issues(db, params.id, params.content),
        templates=[Template(template_of(p)) for p in params.content.protocols],
    )


def save_dataset(
    params: SaveDatasetParams, *, db: RunsDb, data_folder: Path, written: str, method: Method
) -> DatasetRevision:
    """Records the save and the revision it will write, stages that revision's folder, then
    publishes it with the save's outcome (ADR-0009). A retry with the same `request_key` picks
    up where the first try stopped, so the save lands once."""
    from icmm.dataset import store

    content = _raw(params.content)
    outcome = requests.recorded(db.connection(), method, params)
    if outcome is None:
        issues = _issues(db, params.id, params.content)
        if issues:
            raise AgentError(_invalid(issues))

        def intend(conn: Any) -> None:
            with _refusals(params.id):
                store.intend(conn, params.request_key, params.id, params.expected_revision, content)

        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is None:
                outcome = requests.begin(conn, method, params, intend)
    return _published(
        params,
        outcome,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        dataset_of=lambda intent: store.as_dataset(intent.dataset_id, content),
        result_of=lambda intent, _: DatasetRevision(id=intent.dataset_id, revision=intent.revision),
    )


def duplicate_dataset(
    params: DuplicateDatasetParams, *, db: RunsDb, data_folder: Path, written: str, method: Method
) -> DuplicatedDataset:
    """Saves a copy of the dataset's revision `params.revision` as a new dataset under a free
    name, as `save_dataset` saves one (ADR-0009). The name is chosen as the save is recorded and
    kept in the new dataset's row, and the revision copied never changes, so a retry stages the
    same files."""
    from icmm.dataset import store

    return _copied(
        params,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        live=True,
        name_for=store.copy_name,
        taken="Another dataset took this copy's name as it saved. Duplicate again.",
        result_of=lambda id, revision, name: DuplicatedDataset(id=id, revision=revision, name=name),
    )


def save_as_new_dataset(
    params: SaveAsNewDatasetParams, *, db: RunsDb, data_folder: Path, written: str, method: Method
) -> SavedAsNewDataset:
    """Saves the dataset's revision `params.revision` again as a new dataset, under its name, or
    `-2`, `-3`… once another dataset has it: a copy as `duplicate_dataset` makes one, of a
    dataset that may be deleted, whose revisions stay for its runs (ADR-0003)."""
    from icmm.dataset import store

    return _copied(
        params,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        live=False,
        name_for=store.again_name,
        taken="Another dataset took this name as it saved. Save as a new dataset again.",
        result_of=lambda id, revision, name: SavedAsNewDataset(id=id, revision=revision, name=name),
    )


def _copied[R](
    params: DuplicateDatasetParams | SaveAsNewDatasetParams,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
    live: bool,
    name_for: Callable[[Any, str], str],
    taken: str,
    result_of: Callable[[str, int, str], R],
) -> R:
    """Saves a copy of the dataset's revision `params.revision` as a new dataset, named by
    `name_for` as the save is recorded and kept in the new dataset's row, so a retry stages the
    same files; with `live`, of a dataset that isn't deleted. A name taken as it publishes is a
    `conflict` that says `taken`."""
    from icmm.dataset import store

    outcome = requests.recorded(db.connection(), method, params)
    if outcome is None:
        # Read before taking the write lock: the files may sit on NFS.
        source = _source(db, data_folder, params.id, params.revision, live=live)

        def intend(conn: Any) -> None:
            with _refusals(params.id):
                if live and not store.is_live(conn, params.id):
                    raise store.NotFoundError
                content = store.copy_content(source, name_for(conn, source.name))
                store.intend(conn, params.request_key, None, None, content)

        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is None:
                outcome = requests.begin(conn, method, params, intend)

    def dataset_of(intent: Intent) -> Dataset:
        # The source may be deleted since: its revisions stay, so the copy still finishes.
        source = _source(db, data_folder, params.id, params.revision, live=False)
        name = store.name_of(db.connection(), intent.dataset_id)
        return store.as_dataset(intent.dataset_id, store.copy_content(source, name))

    return _published(
        params,
        outcome,
        db=db,
        data_folder=data_folder,
        written=written,
        method=method,
        dataset_of=dataset_of,
        result_of=lambda intent, dataset: result_of(
            intent.dataset_id, intent.revision, dataset.name
        ),
        taken=taken,
    )


def _published[R](
    params: Any,
    outcome: dict[str, Any] | None,
    *,
    db: RunsDb,
    data_folder: Path,
    written: str,
    method: Method,
    dataset_of: Callable[[Intent], Dataset],
    result_of: Callable[[Intent, Dataset], R],
    taken: str | None = None,
) -> R:
    """A recorded save's outcome: an acting one's revision staged, then published with its
    outcome (ADR-0009), or a finished one's answer. A save whose name the agent chose says
    `taken` when that name was taken as it published."""
    from icmm.dataset import store

    intent = store.intent_of(db.connection(), params.request_key)
    if outcome is requests.ACTING and intent is None:
        # Another try of this request finished it meanwhile.
        outcome = requests.recorded(db.connection(), method, params)
    elif outcome is requests.ACTING and intent is not None:
        dataset = dataset_of(intent)
        try:
            store.stage(data_folder, intent, dataset)
        except OSError as e:
            if e.errno in _NO_SPACE:
                raise AgentError(no_space(data_folder, written)) from None
            raise

        def publish(conn: Any) -> Any:
            with _refusals(intent.dataset_id, taken=taken):
                store.publish(conn, intent, dataset)
            return result_of(intent, dataset)

        with db.write() as conn:
            outcome = requests.recorded(conn, method, params)
            if outcome is requests.ACTING:
                outcome = requests.finish(conn, params, requests.outcome_of(conn, publish))
                store.forget_intent(conn, params.request_key)
    assert outcome is not None
    return requests.answer(method, outcome)


def _source(
    db: RunsDb, data_folder: Path, dataset_id: str, revision: int, *, live: bool
) -> Dataset:
    """The revision a copy copies, its refusals as the wire's errors."""
    from icmm.dataset import store

    try:
        return store.read_published(db.connection(), data_folder, dataset_id, revision, live=live)
    except store.NotFoundError:
        raise AgentError(_not_found(dataset_id)) from None
    except store.UnreadableError as e:
        raise AgentError(unreadable(_name(db, dataset_id), e.problem, e.details)) from None


def delete_dataset(params: DeleteDatasetParams, *, db: RunsDb, method: Method) -> DeletedDataset:
    """Commits the dataset's tombstone and its change row, once per `request_key`; its revisions
    stay where they are (ADR-0009)."""
    from icmm.dataset import store

    def act(conn: Any) -> DeletedDataset:
        with _refusals(params.id):
            store.delete(conn, params.id)
        return DeletedDataset(id=params.id)

    return requests.keyed(db, method, params, act)


def current_problem(
    conn: Any, data_folder: Path, dataset_id: str, name: str
) -> UnreadableError | None:
    """Why the dataset `name`'s current revision can't be read, with `read_dataset`'s problem
    and sentence, as the list checks it; `None` when it can be."""
    from icmm.dataset import store

    problem = store.current_problem(conn, data_folder, dataset_id)
    return None if problem is None else unreadable(name, problem.problem, problem.details)


@contextmanager
def _refusals(dataset_id: str | None, *, taken: str | None = None) -> Generator[None]:
    """The store's refusals as the wire's errors, for the dataset `dataset_id`; for a copy, whose
    name the agent chose, a name taken as it published is a `conflict` that says `taken`."""
    from icmm.dataset import store

    try:
        yield
    except store.NotFoundError:
        raise AgentError(_not_found(dataset_id or "")) from None
    except store.StaleRevisionError:
        raise AgentError(
            ConflictError(
                code="conflict",
                message="This dataset was changed elsewhere. Reload to see it.",
                data=ConflictData(reason="stale_revision"),
            )
        ) from None
    except store.NameTakenError:
        if taken is not None:
            raise AgentError(
                ConflictError(
                    code="conflict", message=taken, data=ConflictData(reason="name_taken")
                )
            ) from None
        name_taken = Issue(path=["name"], message=_NAME_TAKEN, severity=Severity.ERROR)
        raise AgentError(_invalid([name_taken])) from None


def _invalid(issues: list[Issue]) -> InvalidError:
    return InvalidError(
        code="invalid", message="This dataset can't be saved yet.", data=InvalidData(issues=issues)
    )


_NAME_TAKEN = "Another dataset already has this name."


def _issues(db: RunsDb, dataset_id: str | None, content: DatasetContent) -> list[Issue]:
    """Every issue with `content` as dataset `dataset_id`; `not_found` if there's no such
    dataset."""
    from icmm.dataset import store
    from icmm.dataset import validate_dataset as check
    from icmm.dataset.model import FORMAT

    conn = db.connection()
    if dataset_id is not None and not store.is_live(conn, dataset_id):
        raise AgentError(_not_found(dataset_id))
    raw = {"format": FORMAT, "id": dataset_id or _UNSAVED_ID, **_raw(content)}
    names = store.live_names(conn, except_id=dataset_id)
    return [_wire_issue(issue) for issue in check(raw, names_in_use=names)]


def _wire_issue(issue: DatasetIssue) -> Issue:
    """The dataset's issue as the wire writes it: list indices as decimals."""
    path = [str(key) for key in issue.path]
    return Issue(path=path, message=issue.message, severity=Severity.ERROR)


def _raw(content: DatasetContent) -> dict[str, Any]:
    return content.model_dump(mode="json")


def _content(dataset: Dataset) -> DatasetContent:
    manifest = dataset.model_dump(mode="json", by_alias=True)
    return DatasetContent.model_validate(
        {"name": manifest["name"], "protocols": manifest["protocols"]}
    )


def _name(db: RunsDb, dataset_id: str) -> str:
    """The dataset's name, for a sentence about it."""
    row = db.connection().execute("SELECT name FROM datasets WHERE id = ?", (dataset_id,))
    return (row.fetchone() or ("This dataset",))[0]


def _not_found(dataset_id: str) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message="This dataset isn't on this platform any more.",
        data=NotFoundData(kind="dataset", id=dataset_id),
    )


def _revision_not_found(dataset_id: str, revision: int) -> NotFoundError:
    return NotFoundError(
        code="not_found",
        message=f"This platform has no revision {revision} of this dataset.",
        data=NotFoundData(kind="dataset_revision", id=f"{dataset_id}/r{revision}"),
    )


_UNREADABLE = {
    "missing": "{name}’s data is missing from this platform’s Data folder, so ICMM can’t show it.",
    "damaged": "{name}’s data was changed or damaged since it was saved, so ICMM can’t show it.",
    "newer": "A newer version of ICMM saved {name}. Update ICMM on this computer to show it.",
}


def unreadable(name: str, problem: str, details: str) -> UnreadableError:
    return UnreadableError(
        code="unreadable",
        message=_UNREADABLE[problem].format(name=name),
        data=UnreadableData(problem=UnreadableProblem(problem), details=details),
    )
