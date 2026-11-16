"""Configs in the runs database, and `<data folder>/configs/<id>.json`, each one's projection
(ADR-0016).

A write (a save, a copy or a delete) goes in four steps, so every one that returns success has a
durable copy beside the database:

1. `claim` records an attempt at the write: the projection it will publish, under an attempt
   number the database never reuses, in the transaction that records its request. Attempts that
   haven't committed own nothing: several may stand at once, and one abandoned blocks nothing.
2. `stage` writes that projection to a file private to the attempt beside `<id>.json` and
   flushes it, leaving the old one intact.
3. `commit` checks the attempt is still there and uncommitted, that no committed attempt of the
   config is still publishing, and the revision it expected, then saves the row with a change
   row and marks the attempt committed: its projection is now pending. A config has at most one
   committed attempt, so its committed writes take turns.
4. `publish`, under the database's write lock, checks the row still has the attempt's revision
   and digest, replaces `<id>.json` with the stage, flushes the folder, and drops the attempt.

Normal reads use only the database. An attempt that never commits is invisible. A committed
attempt's projection is the row's, so whoever finds it pending, a retry, the config's next write
or the next agent's repair, publishes it; nothing ever takes an attempt over. An abandoned
attempt is garbage, removed once it's `ABANDONED_AFTER_S` old: should its writer still run, its
commit finds the attempt gone, and its request starts another.

`hello` repairs projections, so this module imports `secrets` only as a write needs it.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple

from icmm.db import append_change, now, reading
from icmm.durable import file_stamp, fsync_folder, replace_file

if TYPE_CHECKING:
    from icmm.wire.base import RunState

FOLDER = "configs"
TOPIC = "configs"
PAGE = 200
ABANDONED_AFTER_S = 24 * 3600.0
"""How old an attempt that hasn't committed, or a stage no attempt has, is before repair removes
it as abandoned. No write waits on it."""
MAX_NAME = 64
COPY = "-copy"
_ID_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789"
_STAGING = ".staging"
_MAX_SEQ = 2**63 - 1
"""SQLite's largest integer: a cursor's numbers past it were never given."""


class NotFoundError(Exception):
    """No config has this id, or it was deleted."""


class StaleRevisionError(Exception):
    """The config was saved elsewhere since the revision the edit started from."""


class NameTakenError(Exception):
    """Another config has this name, ignoring case."""


class DatasetGoneError(Exception):
    """The dataset the config names was deleted, or this platform never had it."""

    def __init__(self, name: str | None) -> None:
        super().__init__(name)
        self.name = name


class BusyError(Exception):
    """Another write of this config committed meanwhile, and its projection is still pending."""


class StaleCursorError(Exception):
    """More configs were saved since a list's first page than a page holds."""


class ProjectionMismatchError(Exception):
    """A committed claim's row isn't what it committed: changed outside these writes."""


@dataclass(frozen=True)
class Row:
    """A config's row: what its projection holds."""

    id: str
    revision: int
    format: int
    name: str
    dataset_id: str
    settings: dict[str, Any] | None
    """The config as it was saved, in its own format; `None` when it isn't JSON."""
    num_states: int | None
    topologies: int | None
    starts: int | None
    created_at: str
    modified_at: str
    deleted_at: str | None

    def body(self) -> dict[str, Any]:
        """The projection without its digest."""
        return {
            "id": self.id,
            "revision": self.revision,
            "format": self.format,
            "row": {
                "name": self.name,
                "dataset_id": self.dataset_id,
                "settings": self.settings,
                "num_states": self.num_states,
                "topologies": self.topologies,
                "starts": self.starts,
                "created_at": self.created_at,
                "modified_at": self.modified_at,
                "deleted_at": self.deleted_at,
            },
        }

    @staticmethod
    def of(body: dict[str, Any]) -> Row:
        return Row(id=body["id"], revision=body["revision"], format=body["format"], **body["row"])


def digest(body: dict[str, Any]) -> str:
    """The sha256 of a projection's body, written as canonical JSON."""
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


def render(row: Row) -> bytes:
    """`<id>.json`'s bytes for `row`: its body and digest."""
    body = row.body()
    return (
        json.dumps({**body, "digest": digest(body)}, indent=2, ensure_ascii=False) + "\n"
    ).encode()


@dataclass(frozen=True)
class Claim:
    """A write of one config, recorded before it stages its projection."""

    attempt: int
    """The database's number for this claim, never reused: its commit checks the claim is still
    this one, and its stage is named by it."""
    config_id: str
    request_key: str
    expected_revision: int | None
    """The revision the write replaces; `None` for a new config."""
    row: Row
    """What the write publishes: the row, or its tombstone."""
    digest: str
    committed: bool
    """Whether the row is saved, and the projection pending."""
    claimed_at: str

    @property
    def staging(self) -> str:
        """Its stage's name in the configs folder."""
        return f".{self.config_id}.{self.attempt}{_STAGING}"


def projection_path(data_folder: Path, config_id: str) -> Path:
    return data_folder / FOLDER / f"{config_id}.json"


def new_id(conn: sqlite3.Connection) -> str:
    """A random id no config on the platform has had, deleted ones included, nor a write in
    progress will."""
    import secrets  # Not on the agent's start path, which `hello` keeps light.

    while True:
        candidate = "".join(secrets.choice(_ID_CHARACTERS) for _ in range(10))
        taken = conn.execute(
            "SELECT 1 FROM configs WHERE id = ? UNION ALL "
            "SELECT 1 FROM config_claims WHERE config_id = ?",
            (candidate, candidate),
        ).fetchone()
        if taken is None:
            return candidate


_COLUMNS = (
    "id, revision, format, name, dataset_id, settings, num_states, topologies, starts, "
    "created_at, modified_at, deleted_at"
)


def _row(values: tuple[Any, ...]) -> Row:
    id, revision, format, name, dataset_id, settings, *rest = values
    try:
        parsed = json.loads(settings)
    except ValueError:
        parsed = None  # Damaged: reading it says so, and nothing projects it.
    return Row(id, revision, format, name, dataset_id, parsed, *rest)


def row_of(conn: sqlite3.Connection, config_id: str) -> Row | None:
    """The config's row, its tombstone included; `None` if it was never saved."""
    found = conn.execute(f"SELECT {_COLUMNS} FROM configs WHERE id = ?", (config_id,)).fetchone()
    return None if found is None else _row(found)


def live_row(conn: sqlite3.Connection, config_id: str) -> Row:
    """The config's row; `NotFoundError` if it was deleted or never saved."""
    row = row_of(conn, config_id)
    if row is None or row.deleted_at is not None:
        raise NotFoundError
    return row


def check_name(conn: sqlite3.Connection, config_id: str, name: str) -> None:
    """`NameTakenError` if another live config has `name`, ignoring case."""
    taken = conn.execute(
        "SELECT 1 FROM configs WHERE name_key = ? AND id != ? AND deleted_at IS NULL",
        (name.casefold(), config_id),
    ).fetchone()
    if taken is not None:
        raise NameTakenError


def check_dataset(conn: sqlite3.Connection, dataset_id: str) -> None:
    """`DatasetGoneError` unless the dataset is on the platform: published and not deleted."""
    row = conn.execute(
        "SELECT name, current_revision IS NOT NULL AND deleted_at IS NULL FROM datasets "
        "WHERE id = ?",
        (dataset_id,),
    ).fetchone()
    if row is None or not row[1]:
        raise DatasetGoneError(None if row is None else row[0])


def copy_name(conn: sqlite3.Connection, name: str) -> str:
    """A free name for a copy of `name`: `<name>-copy`, or `-copy-2`, `-copy-3`… when a config
    has it, ignoring case, cut to fit 64 characters. An attempt that hasn't committed reserves no
    name: two copies that choose one at once meet at the commit, which keeps it unique."""
    rows = conn.execute("SELECT name_key FROM configs WHERE deleted_at IS NULL").fetchall()
    taken = {row[0] for row in rows}
    n = 1
    while True:
        end = COPY if n == 1 else f"{COPY}-{n}"
        candidate = name[: MAX_NAME - len(end)] + end
        if candidate.casefold() not in taken:
            return candidate
        n += 1


def claim(
    conn: sqlite3.Connection, request_key: str, row: Row, expected_revision: int | None
) -> Claim:
    """Records an attempt at writing `row` over `expected_revision`, in the caller's write
    transaction. It owns nothing until it commits: other attempts at the config may stand
    beside it."""
    body, at = row.body(), now()
    inserted = conn.execute(
        "INSERT INTO config_claims (config_id, request_key, expected_revision, "
        "revision, projection, digest, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            row.id,
            request_key,
            expected_revision,
            row.revision,
            json.dumps(body, separators=(",", ":"), ensure_ascii=False),
            digest(body),
            at,
        ),
    )
    assert inserted.lastrowid is not None
    return Claim(
        attempt=inserted.lastrowid,
        config_id=row.id,
        request_key=request_key,
        expected_revision=expected_revision,
        row=row,
        digest=digest(body),
        committed=False,
        claimed_at=at,
    )


_CLAIM_COLUMNS = (
    "attempt, config_id, request_key, expected_revision, projection, digest, committed, claimed_at"
)


def _claim(values: tuple[Any, ...]) -> Claim:
    attempt, config_id, key, expected, projection, digest, committed, claimed_at = values
    row = Row.of(json.loads(projection))
    return Claim(attempt, config_id, key, expected, row, digest, bool(committed), claimed_at)


def pending_on(conn: sqlite3.Connection, config_id: str) -> Claim | None:
    """The config's committed attempt, whose projection is still to publish, if any."""
    found = conn.execute(
        f"SELECT {_CLAIM_COLUMNS} FROM config_claims WHERE config_id = ? AND committed = 1",
        (config_id,),
    ).fetchone()
    return None if found is None else _claim(found)


def attempt(conn: sqlite3.Connection, number: int) -> Claim | None:
    """Attempt `number`, if it's still there."""
    found = conn.execute(
        f"SELECT {_CLAIM_COLUMNS} FROM config_claims WHERE attempt = ?", (number,)
    ).fetchone()
    return None if found is None else _claim(found)


def claim_of(conn: sqlite3.Connection, request_key: str) -> Claim | None:
    """The request's claim, if it still has one."""
    found = conn.execute(
        f"SELECT {_CLAIM_COLUMNS} FROM config_claims WHERE request_key = ?", (request_key,)
    ).fetchone()
    return None if found is None else _claim(found)


def claims(conn: sqlite3.Connection) -> list[Claim]:
    rows = conn.execute(f"SELECT {_CLAIM_COLUMNS} FROM config_claims").fetchall()
    return [_claim(row) for row in rows]


def abandoned(held: Claim) -> bool:
    """Whether an attempt that hasn't committed is old enough to remove as abandoned."""
    return not held.committed and _age_s(held) >= ABANDONED_AFTER_S


def _age_s(held: Claim) -> float:
    # Each machine's own clock: a skewed one only removes an attempt early, which is safe.
    return (datetime.fromisoformat(now()) - datetime.fromisoformat(held.claimed_at)).total_seconds()


def abandon(conn: sqlite3.Connection, held: Claim) -> None:
    """Removes an abandoned attempt, in the caller's write transaction. Its request stays,
    accepted, so a retry with its key starts another attempt and other inputs under that key are
    still refused; should its writer still run, its commit finds the attempt gone."""
    conn.execute("DELETE FROM config_claims WHERE attempt = ?", (held.attempt,))
    conn.execute(
        "UPDATE requests SET status = 'accepted' WHERE request_key = ? AND outcome IS NULL",
        (held.request_key,),
    )


def drop(conn: sqlite3.Connection, held: Claim) -> None:
    """Drops a claim whose write was refused as it committed, in the caller's transaction."""
    conn.execute("DELETE FROM config_claims WHERE attempt = ?", (held.attempt,))


def stage(data_folder: Path, held: Claim) -> None:
    """Writes the claim's projection beside `<id>.json` and flushes it and its name. Each try
    of a request writes a file of its own and renames it to the stage, so one try never leaves
    another's stage part-written."""
    folder = _folder(data_folder)
    _put(folder / held.staging, render(held.row))
    fsync_folder(folder)


def discard(data_folder: Path, held: Claim) -> None:
    """Removes the claim's stage, if it's there."""
    discard_stage(data_folder, held.staging)


def discard_stage(data_folder: Path, name: str) -> None:
    """Removes the stage `name`, if it's there."""
    try:
        (data_folder / FOLDER / name).unlink(missing_ok=True)
    except OSError:
        pass  # Garbage either way: no reader looks at a stage, and repair removes it.


def commit(conn: sqlite3.Connection, held: Claim, *, needs_dataset: bool) -> None:
    """Saves the claim's row with its change row, in the caller's write transaction, and marks
    the claim committed. `NotFoundError`, `StaleRevisionError`, `NameTakenError` or, with
    `needs_dataset`, `DatasetGoneError` if the config, its name or its dataset changed since;
    `BusyError` if another attempt committed meanwhile and its projection is still pending."""
    if pending_on(conn, held.config_id) is not None:
        raise BusyError
    row = held.row
    current = row_of(conn, row.id)
    if held.expected_revision is None:
        if current is not None:
            raise StaleRevisionError
    elif current is None or current.deleted_at is not None:
        raise NotFoundError
    elif current.revision != held.expected_revision:
        raise StaleRevisionError
    if row.deleted_at is None:
        check_name(conn, row.id, row.name)
        if needs_dataset:
            check_dataset(conn, row.dataset_id)
    seq = append_change(conn, TOPIC, row.id)
    conn.execute(
        f"INSERT INTO configs ({_COLUMNS}, name_key, digest, save_seq) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, format = excluded.format, "
        "name = excluded.name, dataset_id = excluded.dataset_id, settings = excluded.settings, "
        "num_states = excluded.num_states, topologies = excluded.topologies, "
        "starts = excluded.starts, modified_at = excluded.modified_at, "
        "deleted_at = excluded.deleted_at, name_key = excluded.name_key, "
        "digest = excluded.digest, save_seq = excluded.save_seq",
        (
            row.id,
            row.revision,
            row.format,
            row.name,
            row.dataset_id,
            json.dumps(row.settings, separators=(",", ":"), ensure_ascii=False),
            row.num_states,
            row.topologies,
            row.starts,
            row.created_at,
            row.modified_at,
            row.deleted_at,
            row.name.casefold(),
            held.digest,
            seq,
        ),
    )
    conn.execute("UPDATE config_claims SET committed = 1 WHERE attempt = ?", (held.attempt,))
    if row.deleted_at is None:
        conn.execute(
            "INSERT INTO config_saves (seq, config_id, modified_at) VALUES (?, ?, ?)",
            (seq, row.id, row.modified_at),
        )
    else:
        # No page lists a deleted config, whenever its first page was read.
        conn.execute("DELETE FROM config_saves WHERE config_id = ?", (row.id,))


def publish(conn: sqlite3.Connection, data_folder: Path, held: Claim) -> None:
    """Puts a committed claim's projection in place and drops the claim, in the caller's write
    transaction, whose lock keeps any other write of the config out meanwhile.

    The row must still have the claim's revision and digest, since nothing commits over a
    pending projection; if it hasn't, `ProjectionMismatchError`, and the claim stays for whoever
    can tell why. A `<id>.json` that already holds them is flushed again, since whoever replaced
    it may not have flushed it. The file's stamp is recorded, so repair can tell when it was
    replaced or changed since.
    """
    current = conn.execute(
        "SELECT revision, digest FROM configs WHERE id = ?", (held.config_id,)
    ).fetchone()
    if current is None or tuple(current) != (held.row.revision, held.digest):
        raise ProjectionMismatchError(
            f"{held.config_id}: the row has {None if current is None else tuple(current)}, its "
            f"claim committed {(held.row.revision, held.digest)}"
        )
    folder = _folder(data_folder)
    target = projection_path(data_folder, held.config_id)
    staged = folder / held.staging
    if _holds(target, held.digest):
        _flush(target)
    else:
        if not _holds(staged, held.digest):
            _put(staged, render(held.row))
        replace_file(staged, target)
    fsync_folder(folder)
    _record_stamp(conn, held.config_id, target)
    conn.execute("DELETE FROM config_claims WHERE attempt = ?", (held.attempt,))


def repair_projection(conn: sqlite3.Connection, data_folder: Path, config_id: str) -> None:
    """Makes `<id>.json` the row's projection again, in the caller's write transaction, unless a
    committed write's projection is pending: rewritten, through a stage of its own, when it's
    missing or isn't what the row's save published. Either way it's flushed, with the folder,
    before its stamp is recorded: a repair cut short may have renamed it in without flushing
    it, and the stamp stops later repairs looking again."""
    if pending_on(conn, config_id) is not None:
        return  # A committed write publishes it as it finishes.
    found = conn.execute(
        f"SELECT {_COLUMNS}, digest FROM configs WHERE id = ?", (config_id,)
    ).fetchone()
    if found is None:
        return
    row, saved = _row(found[:-1]), found[-1]
    target = projection_path(data_folder, config_id)
    folder = _folder(data_folder)
    if _holds(target, saved):
        _flush(target)
    elif digest(row.body()) != saved:
        return  # The row isn't what its save wrote: never copy that over a projection.
    else:
        _put(target, render(row), prefix=f".{config_id}.repair")
    fsync_folder(folder)
    _record_stamp(conn, config_id, target)


def stamps(conn: sqlite3.Connection) -> list[tuple[str, str | None]]:
    """Each config's id, deleted ones included, with its projection's recorded stamp."""
    return conn.execute("SELECT id, projected FROM configs").fetchall()


def is_stage(name: str) -> bool:
    return name.startswith(".") and name.endswith(_STAGING)


def _record_stamp(conn: sqlite3.Connection, config_id: str, target: Path) -> None:
    conn.execute(
        "UPDATE configs SET projected = ? WHERE id = ?", (file_stamp(os.stat(target)), config_id)
    )


class LatestRun(NamedTuple):
    """A config's newest live run by number, as its row on Configs shows it."""

    id: int
    state: RunState
    ended_at: str | None


@dataclass(frozen=True)
class Summary:
    """A config as the list shows it: never its settings."""

    id: str
    revision: int
    format: int
    name: str
    modified_at: str
    dataset_id: str
    num_states: int | None
    which: str | None
    """Its Which topologies' `kind`, from its settings; `None` when they aren't JSON."""
    topologies: int | None
    starts: int | None
    dataset_name: str | None
    dataset_deleted: bool
    latest_run: LatestRun | None
    """`None` before its first run."""


def list_page(conn: sqlite3.Connection, after: str | None) -> tuple[list[Summary], str | None]:
    """A page of the platform's configs, newest modified first, and the next page's cursor; in
    one read transaction, so its bound, its stale check and its page see one state."""
    with reading(conn):
        return _page(conn, after)


def _page(conn: sqlite3.Connection, after: str | None) -> tuple[list[Summary], str | None]:
    """The first page fixes the order: its cursor carries the change feed's seq then, and each
    later page orders the configs by the save each had made by that seq, so a save between
    pages never moves a config across the cursor. A config made since isn't listed, and one
    deleted since is left out; each row holds what the config holds now. With more configs saved
    since than a page holds, `StaleCursorError`: the listing starts again. One query, which walks
    the live configs' index from the cursor, so a page's work doesn't grow with the configs it
    doesn't show, their earlier saves or the deleted; saves at one millisecond order by seq.
    """
    bound: tuple[int, str, int] | None = None
    if after is not None:
        try:
            seq, modified_at, last = after.split(" ")
            bound = (int(seq), modified_at, int(last))
        except ValueError:
            raise ValueError(f"not a cursor: {after!r}") from None
        if not all(0 <= n <= _MAX_SEQ for n in (bound[0], bound[2])):
            raise ValueError(f"not a cursor: {after!r}")
    # The first page's bound is the latest save now; a save after it waits for the next list.
    at = (
        conn.execute("SELECT COALESCE(MAX(seq), 0) FROM config_saves").fetchone()[0]
        if bound is None
        else bound[0]
    )
    if bound is not None:
        # Each config saved since the bound is placed by a look into its saves: past a page's
        # worth, the listing starts again rather than a page costing more.
        since = conn.execute(
            "SELECT COUNT(*) FROM (SELECT 1 FROM configs INDEXED BY configs_saved "
            "WHERE deleted_at IS NULL AND save_seq > ? LIMIT ?)",
            (at, PAGE + 1),
        ).fetchone()[0]
        if since > PAGE:
            raise StaleCursorError
    below = "" if bound is None else "AND (m, q) < (?, ?) "
    cursor = () if bound is None else bound[1:]
    # Live configs not saved since the bound list where they are now, walked through their
    # index from the cursor; the few saved since list where their save at the bound put them,
    # one indexed look into their saves each. No page reads earlier saves or deleted configs.
    # Of a listed config's settings, only its kind of topologies is read: damaged ones still list.
    # Its newest live run is one seek into `runs_config`, whose entries are (config_id, rowid)
    # and run ids are the rowid: the last of the config's entries, however many runs it has.
    rows = conn.execute(
        "WITH positioned (id, m, q) AS ("
        "SELECT * FROM (SELECT id, modified_at AS m, save_seq AS q "
        "FROM configs INDEXED BY configs_listed "
        f"WHERE deleted_at IS NULL AND save_seq <= ? {below}"
        "ORDER BY modified_at DESC, save_seq DESC LIMIT ?) "
        "UNION ALL "
        "SELECT * FROM (SELECT c.id, h.modified_at AS m, h.seq AS q "
        "FROM configs c INDEXED BY configs_saved JOIN config_saves h ON h.seq = "
        "(SELECT MAX(x.seq) FROM config_saves x WHERE x.config_id = c.id AND x.seq <= ?) "
        f"WHERE c.deleted_at IS NULL AND c.save_seq > ?) WHERE TRUE {below}"
        ") "
        "SELECT c.id, c.revision, c.format, c.name, c.modified_at, c.dataset_id, c.num_states, "
        "c.topologies, c.starts, d.name, "
        "d.id IS NULL OR d.current_revision IS NULL OR d.deleted_at IS NOT NULL, "
        "CASE WHEN json_valid(c.settings) THEN json_extract(c.settings, '$.topology.which.kind') "
        "END, lr.id, lr.state, lr.ended_at, p.m, p.q "
        "FROM positioned p JOIN configs c ON c.id = p.id "
        "LEFT JOIN datasets d ON d.id = c.dataset_id "
        "LEFT JOIN runs lr ON lr.id = (SELECT r.id FROM runs r INDEXED BY runs_config "
        "WHERE r.config_id = c.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) "
        "ORDER BY p.m DESC, p.q DESC LIMIT ?",
        (at, *cursor, PAGE + 1, at, at, *cursor, PAGE + 1),
    ).fetchall()
    page = [
        Summary(
            id=row[0],
            revision=row[1],
            format=row[2],
            name=row[3],
            modified_at=row[4],
            dataset_id=row[5],
            num_states=row[6],
            which=row[11] if isinstance(row[11], str) else None,
            topologies=row[7],
            starts=row[8],
            dataset_name=row[9],
            dataset_deleted=bool(row[10]),
            latest_run=None if row[12] is None else LatestRun(row[12], row[13], row[14]),
        )
        for row in rows[:PAGE]
    ]
    if len(rows) <= PAGE:
        return page, None
    *_, modified_at, seq = rows[PAGE - 1]
    return page, f"{at} {modified_at} {seq}"


def count_naming(conn: sqlite3.Connection, dataset_id: str) -> int:
    """How many configs name the dataset."""
    return conn.execute(
        "SELECT COUNT(*) FROM configs WHERE dataset_id = ? AND deleted_at IS NULL", (dataset_id,)
    ).fetchone()[0]


def tombstone(row: Row) -> Row:
    """`row` deleted: its next revision, the same settings, and when."""
    at = now()
    return replace(row, revision=row.revision + 1, modified_at=at, deleted_at=at)


def edited(
    current: Row | None,
    config_id: str,
    settings: dict[str, Any],
    counts: tuple[int | None, int | None, int | None],
) -> Row:
    """The row a save of `settings` publishes: revision 1 of a new config `config_id`, or the
    next revision of `current`. `counts` are its states, topologies and starts."""
    at = now()
    num_states, topologies, starts = counts
    return Row(
        id=config_id,
        revision=1 if current is None else current.revision + 1,
        format=settings["format"],
        name=settings["name"],
        dataset_id=settings["dataset_id"],
        settings=settings,
        num_states=num_states,
        topologies=topologies,
        starts=starts,
        created_at=at if current is None else current.created_at,
        modified_at=at,
        deleted_at=None,
    )


def _holds(path: Path, expected: str) -> bool:
    """Whether `path` is a projection with the digest `expected`."""
    try:
        held = json.loads(path.read_bytes())
        body = {key: held[key] for key in ("id", "revision", "format", "row")}
        # Hashed inside the guard: parsed JSON can still hold text that won't encode.
        return held.get("digest") == expected and digest(body) == expected
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _folder(data_folder: Path) -> Path:
    """The configs folder, made if it isn't there, its name flushed into the Data folder every
    time: whoever made it may have died before flushing it."""
    folder = data_folder / FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    fsync_folder(data_folder)
    return folder


def _put(path: Path, data: bytes, *, prefix: str | None = None) -> None:
    """Writes `path` whole: through a file only this call made beside it (named `prefix`… or
    after `path`, as a stage), flushed and closed, then renamed over it, so no reader or other
    writer sees it part-written, and nothing writes into it once it has the name."""
    import tempfile  # Not on the agent's start path, which `hello` keeps light.

    start = prefix or f"{path.name.removesuffix(_STAGING)}-"
    fd, name = tempfile.mkstemp(prefix=start, suffix=_STAGING, dir=path.parent)
    os.close(fd)
    part = Path(name)
    try:
        _write(part, data)
        replace_file(part, path)
    finally:
        part.unlink(missing_ok=True)


def _write(path: Path, data: bytes) -> None:
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def _flush(path: Path) -> None:
    # Opened for writing: Windows flushes only a handle that may write.
    with open(path, "r+b") as f:
        os.fsync(f.fileno())
