"""Datasets on a platform: revision folders on disk, published through the runs database
(ADR-0003, ADR-0009).

A save goes in three steps. `intend` records which revision it will write, in the transaction
that records its request. `stage` writes that revision's folder beside its place, flushes it and
renames it in. `publish` then makes it current, in one transaction with the request's outcome
and a change row. Until then the folder is invisible: every reader finds revisions through the
database, so an interrupted save never lists, and a retry finishes it.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from icmm.dataset.checks import DatasetError, validate_dataset
from icmm.dataset.digest import scoring_digest
from icmm.dataset.files import (
    Facts,
    NewerFormatError,
    files_digest,
    read_revision,
    revision_facts,
    revision_files,
    write_revision,
)
from icmm.dataset.model import FORMAT, MAX_DATASET_NAME, Dataset
from icmm.dataset.templates import template_of
from icmm.db import append_change, now
from icmm.durable import fsync_folder

FOLDER = "datasets"
TOPIC = "datasets"
PAGE = 200
_ID_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789"


class NotFoundError(Exception):
    """No dataset has this id, or it was deleted."""


class StaleRevisionError(Exception):
    """The dataset was saved elsewhere since the revision the edit started from."""


class NameTakenError(Exception):
    """Another dataset has this name, ignoring case."""


class UnreadableError(Exception):
    def __init__(self, problem: str, details: str) -> None:
        super().__init__(details)
        self.problem = problem
        """`missing`, `damaged` or `newer`, as the wire's `UnreadableProblem`."""
        self.details = details


@dataclass(frozen=True)
class Intent:
    """The revision a save writes, recorded before it writes it."""

    dataset_id: str
    revision: int
    expected_revision: int | None
    files_digest: str


@dataclass(frozen=True)
class ProtocolSummary:
    name: str
    template: str
    points: int
    steps: int | None
    """`None` when the revision can't be read."""


@dataclass(frozen=True)
class Summary:
    id: str
    revision: int
    name: str
    protocols: list[ProtocolSummary]
    modified_at: str
    validation: int | None
    """How many of its points are validation points; `None` when `unreadable`."""
    interpolated: int | None
    """How many of its points interpolation added; `None` when `unreadable`."""
    unreadable: UnreadableError | None
    """Why its current revision can't be read, as reading it would find; `None` when it can."""


@dataclass(frozen=True)
class Current:
    id: str
    revision: int
    modified_at: str
    dataset: Dataset


def revision_folder(data_folder: Path, dataset_id: str, revision: int) -> Path:
    return data_folder / FOLDER / dataset_id / f"r{revision}"


def as_dataset(dataset_id: str, content: dict[str, Any]) -> Dataset:
    """`content`, the dataset's name and protocols, as dataset `dataset_id`; `DatasetError` if
    it fails its checks."""
    raw = {"format": FORMAT, "id": dataset_id, **content}
    try:
        return Dataset.model_validate(raw)
    except ValueError:
        raise DatasetError(validate_dataset(raw)) from None


def live_names(conn: sqlite3.Connection, *, except_id: str | None = None) -> list[str]:
    """The names of the platform's datasets, but `except_id`'s."""
    rows = conn.execute(
        "SELECT name FROM datasets WHERE current_revision IS NOT NULL AND deleted_at IS NULL "
        "AND id IS NOT ?",
        (except_id,),
    ).fetchall()
    return [row[0] for row in rows]


def is_live(conn: sqlite3.Connection, dataset_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM datasets WHERE id = ? AND current_revision IS NOT NULL "
        "AND deleted_at IS NULL",
        (dataset_id,),
    ).fetchone()
    return row is not None


def intend(
    conn: sqlite3.Connection,
    request_key: str,
    dataset_id: str | None,
    expected_revision: int | None,
    content: dict[str, Any],
) -> Intent:
    """Records the revision a save will write, in the caller's write transaction: revision 1 of
    a new dataset with a fresh id, or the next revision of `dataset_id`."""
    if dataset_id is None:
        if expected_revision is not None:
            raise StaleRevisionError
        dataset_id = _new_id(conn)
        revision = 1
        # Its name, unlisted until it publishes: a copy's retry finds the name it chose here.
        conn.execute(
            "INSERT INTO datasets (id, name, next_revision) VALUES (?, ?, 2)",
            (dataset_id, content.get("name")),
        )
    else:
        row = conn.execute(
            "SELECT current_revision, next_revision FROM datasets "
            "WHERE id = ? AND current_revision IS NOT NULL AND deleted_at IS NULL",
            (dataset_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError
        if row[0] != expected_revision:
            raise StaleRevisionError
        revision = row[1]
        conn.execute(
            "UPDATE datasets SET next_revision = ? WHERE id = ?", (revision + 1, dataset_id)
        )
    intent = Intent(
        dataset_id, revision, expected_revision, files_digest(as_dataset(dataset_id, content))
    )
    conn.execute(
        "INSERT INTO dataset_intents (request_key, dataset_id, revision, expected_revision, "
        "files_digest) VALUES (?, ?, ?, ?, ?)",
        (request_key, dataset_id, revision, expected_revision, intent.files_digest),
    )
    return intent


def intent_of(conn: sqlite3.Connection, request_key: str) -> Intent | None:
    """The intent of an unfinished save; `None` once it has finished, or if it never had one."""
    row = conn.execute(
        "SELECT dataset_id, revision, expected_revision, files_digest FROM dataset_intents "
        "WHERE request_key = ?",
        (request_key,),
    ).fetchone()
    return None if row is None else Intent(*row)


def forget_intent(conn: sqlite3.Connection, request_key: str) -> None:
    """Drops the intent once its save has finished, published or not."""
    conn.execute("DELETE FROM dataset_intents WHERE request_key = ?", (request_key,))


def stage(data_folder: Path, intent: Intent, dataset: Dataset) -> None:
    """Puts the intended revision's folder in place, written in full and flushed first.

    A folder already there with the intended files is kept, since a retry, or the same save
    running on another connection, put it there; one with other files is discarded, since no
    reader can have seen an unpublished revision.
    """
    if files_digest(dataset) != intent.files_digest:
        raise ValueError(f"{dataset.id} r{intent.revision}: not the files this save intended")
    target = revision_folder(data_folder, intent.dataset_id, intent.revision)
    if target.is_dir():
        if _holds(target, intent):
            fsync_folder(target.parent)
            return
        shutil.rmtree(target)
    _make_folders(data_folder, target.parent)
    staging = target.parent / f".r{intent.revision}-{secrets.token_hex(4)}.staging"
    try:
        write_revision(staging, dataset, flush=True)
        os.rename(staging, target)
    except OSError:
        if not (target.is_dir() and _holds(target, intent)):
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    fsync_folder(target.parent)


def publish(conn: sqlite3.Connection, intent: Intent, dataset: Dataset) -> None:
    """Makes the intended revision current, in the caller's write transaction, with its change
    row; raises if the dataset was deleted or saved elsewhere meanwhile, or its name taken."""
    row = conn.execute(
        "SELECT current_revision, deleted_at FROM datasets WHERE id = ?", (intent.dataset_id,)
    ).fetchone()
    if row is None or row[1] is not None:
        raise NotFoundError
    if row[0] != intent.expected_revision:
        raise StaleRevisionError
    name_key = dataset.name.casefold()
    taken = conn.execute(
        "SELECT 1 FROM datasets WHERE name_key = ? AND id != ? AND current_revision IS NOT NULL "
        "AND deleted_at IS NULL",
        (name_key, intent.dataset_id),
    ).fetchone()
    if taken is not None:
        raise NameTakenError
    at = now()
    conn.execute(
        "UPDATE datasets SET name = ?, name_key = ?, current_revision = ?, "
        "created_at = COALESCE(created_at, ?), modified_at = ? WHERE id = ?",
        (dataset.name, name_key, intent.revision, at, at, intent.dataset_id),
    )
    protocols = [
        {"name": p.name, "template": template_of(p), "points": len(p.points)}
        for p in dataset.protocols
    ]
    conn.execute(
        "INSERT INTO dataset_revisions (dataset_id, revision, format, protocols, scoring_digest, "
        "files_digest, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            intent.dataset_id,
            intent.revision,
            dataset.format,
            json.dumps(protocols, separators=(",", ":")),
            scoring_digest(dataset),
            intent.files_digest,
            at,
        ),
    )
    append_change(conn, TOPIC, intent.dataset_id)


COPY = "-copy"


def copy_name(conn: sqlite3.Connection, name: str) -> str:
    """A free name for a copy of `name`, within the 64 characters a name has: `<name>-copy`, or
    `-copy-2`, `-copy-3`… when a dataset has it, ignoring case, or a save in progress will.
    In the caller's write transaction, so no other copy can take it meanwhile."""
    return _free_name(conn, name, lambda n: COPY if n == 1 else f"{COPY}-{n}")


def again_name(conn: sqlite3.Connection, name: str) -> str:
    """A free name for a dataset saved again as a new one: `name`, or `-2`, `-3`… when a dataset
    has it, ignoring case, or a save in progress will, within 64 characters. In the caller's
    write transaction, as `copy_name`."""
    return _free_name(conn, name, lambda n: "" if n == 1 else f"-{n}")


def _free_name(conn: sqlite3.Connection, name: str, suffix: Callable[[int], str]) -> str:
    """`name` with the first `suffix(1)`, `suffix(2)`… that no dataset has, ignoring case, nor a
    save in progress will, cut to fit 64 characters."""
    rows = conn.execute(
        "SELECT name FROM datasets WHERE deleted_at IS NULL AND name IS NOT NULL "
        "AND (current_revision IS NOT NULL "
        "OR id IN (SELECT dataset_id FROM dataset_intents))"
    ).fetchall()
    taken = {row[0].casefold() for row in rows}
    n = 1
    while True:
        end = suffix(n)
        candidate = name[: MAX_DATASET_NAME - len(end)] + end
        if candidate.casefold() not in taken:
            return candidate
        n += 1


def read_published(
    conn: sqlite3.Connection, data_folder: Path, dataset_id: str, revision: int, *, live: bool
) -> Dataset:
    """The dataset's revision `revision`, read from its folder and checked against what was
    saved. `NotFoundError` for a revision never published, or with `live`, for a dataset
    deleted; `UnreadableError` as `read_current`."""
    row = conn.execute(
        "SELECT r.files_digest, d.deleted_at FROM dataset_revisions r "
        "JOIN datasets d ON d.id = r.dataset_id WHERE r.dataset_id = ? AND r.revision = ?",
        (dataset_id, revision),
    ).fetchone()
    if row is None or (live and row[1] is not None):
        raise NotFoundError
    with _reading(data_folder, dataset_id, revision) as folder:
        dataset = read_revision(folder, expected_digest=row[0])
    if dataset.id != dataset_id:
        shown = f"{FOLDER}/{dataset_id}/r{revision}"
        raise UnreadableError("damaged", f"{shown}: its files changed since they were saved")
    return dataset


def copy_content(source: Dataset, name: str) -> dict[str, Any]:
    """`source`'s protocols under `name`, as a save's content."""
    manifest = source.model_dump(mode="json", by_alias=True)
    return {"name": name, "protocols": manifest["protocols"]}


def name_of(conn: sqlite3.Connection, dataset_id: str) -> str:
    """The name the dataset's row holds: a copy's, from the moment its save was recorded."""
    return conn.execute("SELECT name FROM datasets WHERE id = ?", (dataset_id,)).fetchone()[0]


def delete(conn: sqlite3.Connection, dataset_id: str) -> None:
    """Deletes the dataset, in the caller's write transaction, with its change row: it leaves
    every list and its name is free again. Its revisions stay for the runs fit to them, and a
    save of it that hasn't published yet is refused as it publishes (ADR-0009)."""
    deleted = conn.execute(
        "UPDATE datasets SET deleted_at = ? WHERE id = ? AND current_revision IS NOT NULL "
        "AND deleted_at IS NULL",
        (now(), dataset_id),
    )
    if deleted.rowcount == 0:
        raise NotFoundError
    append_change(conn, TOPIC, dataset_id)


def list_page(
    conn: sqlite3.Connection, data_folder: Path, after: str | None
) -> tuple[list[Summary], str | None]:
    """A page of the platform's datasets in immutable first-save order, and the next cursor.

    An edit must not move an unseen dataset across the cursor. The desktop sorts the complete
    list by `modified_at`, newest first, after reading all pages.

    One query over the database, which holds what each save wrote at publish, then a check of
    each current revision's files: their bytes against the digest saved with them, and the
    validation marks counted (`revision_facts`). Nothing is parsed into a dataset.
    """
    bound: tuple[str, str] | None = None
    if after is not None:
        created_at, _, dataset_id = after.partition(" ")
        if not created_at or not dataset_id:
            raise ValueError(f"not a cursor: {after!r}")
        bound = (created_at, dataset_id)
    rows = conn.execute(
        "SELECT d.id, d.current_revision, d.name, r.protocols, r.saved_at, d.created_at, "
        "r.files_digest "
        "FROM datasets d JOIN dataset_revisions r "
        "ON r.dataset_id = d.id AND r.revision = d.current_revision "
        "WHERE d.current_revision IS NOT NULL AND d.deleted_at IS NULL "
        "AND (? IS NULL OR (d.created_at, d.id) < (?, ?)) "
        "ORDER BY d.created_at DESC, d.id DESC LIMIT ?",
        (after, *(bound or (None, None)), PAGE + 1),
    ).fetchall()
    page = []
    for row in rows[:PAGE]:
        facts: Facts | None = None
        unreadable: UnreadableError | None = None
        try:
            with _reading(data_folder, row[0], row[1]) as folder:
                facts = revision_facts(folder, expected_digest=row[6])
        except UnreadableError as e:
            unreadable = e
        page.append(
            Summary(
                id=row[0],
                revision=row[1],
                name=row[2],
                protocols=[
                    ProtocolSummary(
                        **p, steps=None if facts is None else facts.steps.get(p["name"])
                    )
                    for p in json.loads(row[3])
                ],
                modified_at=row[4],
                validation=None if facts is None else facts.validation,
                interpolated=None if facts is None else facts.interpolated,
                unreadable=unreadable,
            )
        )
    last = rows[PAGE - 1] if len(rows) > PAGE else None
    return page, None if last is None else f"{last[5]} {last[0]}"


def read_current(conn: sqlite3.Connection, data_folder: Path, dataset_id: str) -> Current:
    """The dataset's current revision, read from its folder and checked against what was saved.

    `NotFoundError` for a dataset deleted or never published; `UnreadableError` when its files
    are gone, damaged, changed since they were saved, or in a newer format.
    """
    row = conn.execute(
        "SELECT d.current_revision, r.saved_at FROM datasets d "
        "JOIN dataset_revisions r ON r.dataset_id = d.id AND r.revision = d.current_revision "
        "WHERE d.id = ? AND d.deleted_at IS NULL",
        (dataset_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError
    revision, saved_at = row
    dataset = read_published(conn, data_folder, dataset_id, revision, live=True)
    return Current(dataset_id, revision, saved_at, dataset)


def protocol_count(conn: sqlite3.Connection, dataset_id: str) -> int | None:
    """How many protocols the dataset's current revision has, from its saved summary; `None` for
    a dataset deleted or never published."""
    row = conn.execute(
        "SELECT r.protocols FROM datasets d "
        "JOIN dataset_revisions r ON r.dataset_id = d.id AND r.revision = d.current_revision "
        "WHERE d.id = ? AND d.deleted_at IS NULL",
        (dataset_id,),
    ).fetchone()
    return None if row is None else len(json.loads(row[0]))


def current_problem(
    conn: sqlite3.Connection, data_folder: Path, dataset_id: str
) -> UnreadableError | None:
    """Why the dataset's current revision can't be read, checked as the list checks it: its
    bytes against the digest saved with them, never parsed. `None` when it can be, or the dataset
    is deleted or was never published."""
    row = conn.execute(
        "SELECT d.current_revision, r.files_digest FROM datasets d "
        "JOIN dataset_revisions r ON r.dataset_id = d.id AND r.revision = d.current_revision "
        "WHERE d.id = ? AND d.deleted_at IS NULL",
        (dataset_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        with _reading(data_folder, dataset_id, row[0]) as folder:
            revision_facts(folder, expected_digest=row[1])
    except UnreadableError as e:
        return e
    return None


@dataclass(frozen=True)
class Stored:
    """A revision's files as they were saved, which Export writes."""

    name: str
    """The dataset's name now."""
    files: dict[str, bytes]
    files_digest: str


def stored_files(
    conn: sqlite3.Connection, data_folder: Path, dataset_id: str, revision: int
) -> Stored:
    """Revision `revision` of the dataset, byte for byte, checked against the digest saved with
    it and never parsed; in an older format, as it was saved (ADR-0003). A deleted dataset's
    revisions stay for its runs, so a page that showed one can still export it.

    `NotFoundError` for a dataset never published, or a revision it doesn't have;
    `UnreadableError` when its files are gone, damaged or changed since they were saved.
    """
    row = conn.execute(
        "SELECT d.name, r.files_digest FROM datasets d "
        "JOIN dataset_revisions r ON r.dataset_id = d.id AND r.revision = ? "
        "WHERE d.id = ? AND d.current_revision IS NOT NULL",
        (revision, dataset_id),
    ).fetchone()
    if row is None:
        raise NotFoundError
    name, digest = row
    with _reading(data_folder, dataset_id, revision) as folder:
        files = revision_files(folder, expected_digest=digest)
    return Stored(name, files, digest)


def with_scoring_digest(conn: sqlite3.Connection, digest: str) -> list[tuple[str, str]]:
    """The id and name of each of the platform's datasets with a revision of scoring digest
    `digest`, the one whose current revision has it first, then newest first; at most 20."""
    return conn.execute(
        "SELECT d.id, d.name FROM dataset_revisions r JOIN datasets d ON d.id = r.dataset_id "
        "WHERE r.scoring_digest = ? AND d.current_revision IS NOT NULL AND d.deleted_at IS NULL "
        "GROUP BY d.id ORDER BY MAX(r.revision = d.current_revision) DESC, d.created_at DESC, "
        "d.id DESC LIMIT 20",
        (digest,),
    ).fetchall()


@contextmanager
def _reading(data_folder: Path, dataset_id: str, revision: int) -> Generator[Path]:
    """The folder of the dataset's revision `revision`, to read; what goes wrong reading it as
    `UnreadableError`: its manifest missing, its files changed or damaged, or a newer format."""
    folder = revision_folder(data_folder, dataset_id, revision)
    shown = f"{FOLDER}/{dataset_id}/r{revision}"
    # `os.path.isfile` is False for a folder it can't open, where `Path.is_file` raises, so one
    # revision's permissions fail only its own row of a list.
    if not os.path.isfile(folder / "dataset.json"):
        raise UnreadableError("missing", f"{shown}/dataset.json is missing")
    try:
        yield folder
    except NewerFormatError as e:
        raise UnreadableError("newer", f"{shown}: {e}") from None
    except DatasetError as e:
        raise UnreadableError("damaged", f"{shown}: {e}") from None


def _new_id(conn: sqlite3.Connection) -> str:
    """A random id no dataset on the platform has had, deleted ones included."""
    while True:
        candidate = "".join(secrets.choice(_ID_CHARACTERS) for _ in range(10))
        if conn.execute("SELECT 1 FROM datasets WHERE id = ?", (candidate,)).fetchone() is None:
            return candidate


def _holds(folder: Path, intent: Intent) -> bool:
    try:
        read_revision(folder, expected_digest=intent.files_digest)
        return True
    except DatasetError:
        return False


def _make_folders(data_folder: Path, folder: Path) -> None:
    """Makes `folder` and the folders above it in the Data folder, each made one durable."""
    made = []
    for parent in (folder, *folder.parents):
        if parent.is_dir() or parent == data_folder:
            break
        made.append(parent)
    for parent in reversed(made):
        parent.mkdir(exist_ok=True)
        fsync_folder(parent.parent)
