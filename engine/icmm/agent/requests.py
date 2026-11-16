"""Write requests keyed by their `request_key` (ADR-0009).

The desktop makes a key once per user action and reuses it on every retry. The first try's
outcome is recorded in the runs database in the same transaction as its effect, so a retry after
a timeout or a reconnect gets that outcome back instead of acting again, and a key reused with
other inputs gets `conflict`.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable
from functools import cache
from typing import Any

from pydantic import TypeAdapter

from icmm.agent.serve import AgentError
from icmm.db import RunsDb, now
from icmm.wire import Method, WireError
from icmm.wire.base import WireModel
from icmm.wire.errors import ConflictData, ConflictError


def keyed[R: WireModel](
    db: RunsDb,
    method: Method,
    params: Any,
    act: Callable[[sqlite3.Connection], R],
    *,
    check: Callable[[], None] = lambda: None,
) -> R:
    """Runs `act` in a write transaction once per request key, recording its payload and
    outcome in the same transaction.

    This is for a write whose whole effect is in the database, so recording and acting commit
    together. A write with effects outside it (a scheduler launch, a file published) needs
    ADR-0009's accepted and acting statuses, recorded before it acts.

    A key already recorded answers its outcome and nothing runs. Otherwise `check` runs first,
    outside the transaction, and an `AgentError` from it isn't recorded, so a fixed retry can
    still act. An `AgentError` from `act` is an outcome: its writes are undone and the error is
    recorded. Any other exception records nothing, so a retry acts afresh.
    """
    key: str = params.request_key
    digest = _digest(params)
    outcome = _recorded(db.connection(), key, method, digest)
    if outcome is None:
        check()
        with db.write() as conn:
            outcome = _recorded(conn, key, method, digest)
            if outcome is None:
                outcome = _act(conn, act)
                status = "failed" if "error" in outcome else "succeeded"
                _insert(conn, method, params, status, outcome=outcome, finished=True)
    return answer(method, outcome)


ACTING: dict[str, Any] = {"acting": True}
"""What `recorded` answers for a request that was recorded but hasn't finished."""


def recorded(conn: sqlite3.Connection, method: Method, params: Any) -> dict[str, Any] | None:
    """The outcome recorded for this request's key: `None` if it has none, `ACTING` if it was
    recorded acting and hasn't finished; `conflict` if the key was used for other inputs."""
    return _recorded(conn, params.request_key, method, _digest(params))


def begin(
    conn: sqlite3.Connection,
    method: Method,
    params: Any,
    intend: Callable[[sqlite3.Connection], None],
) -> dict[str, Any]:
    """Records the request as acting, then runs `intend`, in the caller's write transaction:
    the first step of a write with effects outside the database (ADR-0009). An `AgentError`
    from `intend` is the request's outcome, recorded as it fails and answered as `recorded`
    would answer it.
    """
    _insert(conn, method, params, "acting")
    return _intend(conn, params, intend)


def admit[R: WireModel](
    conn: sqlite3.Connection,
    method: Method,
    params: Any,
    act: Callable[[sqlite3.Connection], R],
) -> dict[str, Any]:
    """Records a lifecycle request as accepted, then runs `act`, whose result is the reply its
    admission makes, in the caller's write transaction (ADR-0009). The request stays accepted,
    its work still to do, while a retry is answered that reply."""
    _insert(conn, method, params, "accepted")
    outcome = {"result": act(conn).model_dump(mode="json")}
    conn.execute(
        "UPDATE requests SET outcome = ? WHERE request_key = ?",
        (json.dumps(outcome, separators=(",", ":")), params.request_key),
    )
    return outcome


def resume(
    conn: sqlite3.Connection,
    method: Method,
    params: Any,
    intend: Callable[[sqlite3.Connection], None],
) -> dict[str, Any]:
    """Records a request recorded before, whose work was abandoned before it took effect, as
    acting again, then runs `intend`, in the caller's write transaction, as `begin` does."""
    conn.execute(
        "UPDATE requests SET status = 'acting' WHERE request_key = ? AND outcome IS NULL",
        (params.request_key,),
    )
    return _intend(conn, params, intend)


def _intend(
    conn: sqlite3.Connection, params: Any, intend: Callable[[sqlite3.Connection], None]
) -> dict[str, Any]:
    conn.execute("SAVEPOINT intend")
    try:
        intend(conn)
    except AgentError as e:
        conn.execute("ROLLBACK TO intend")
        conn.execute("RELEASE intend")
        return finish(conn, params, {"error": e.error.model_dump(mode="json")})
    conn.execute("RELEASE intend")
    return ACTING


def finish(
    conn: sqlite3.Connection, params: Any, outcome: dict[str, Any], *, acting: bool = False
) -> dict[str, Any]:
    """Records an acting request's outcome, in the caller's write transaction. With `acting`,
    the request stays acting: its outcome is committed, but an effect outside the database must
    land before it's answered (ADR-0016's projection), and `mark` records when it has."""
    conn.execute(
        "UPDATE requests SET status = ?, outcome = ?, finished_at = ? WHERE request_key = ?",
        (
            "acting" if acting else "failed" if "error" in outcome else "succeeded",
            json.dumps(outcome, separators=(",", ":")),
            None if acting else now(),
            params.request_key,
        ),
    )
    return outcome


def mark(conn: sqlite3.Connection, request_key: str, status: str) -> None:
    """Records a request whose outcome is committed as `succeeded` once its effect outside the
    database has landed, or `reconciliation_required` when it couldn't, in the caller's write
    transaction."""
    conn.execute(
        "UPDATE requests SET status = ?, finished_at = ? WHERE request_key = ? "
        "AND outcome IS NOT NULL",
        (status, now() if status == "succeeded" else None, request_key),
    )


def outcome_of[R: WireModel](
    conn: sqlite3.Connection, act: Callable[[sqlite3.Connection], R]
) -> dict[str, Any]:
    """`act`'s result, or its `AgentError` with its writes undone, as an outcome to record."""
    return _act(conn, act)


def answer(method: Method, outcome: dict[str, Any]) -> Any:
    """The reply a finished outcome makes: its result, or its error raised."""
    if "error" in outcome:
        raise AgentError(_errors().validate_json(json.dumps(outcome["error"])))
    assert method.result is not None
    return method.result.model_validate_json(json.dumps(outcome["result"]))


def _recorded(
    conn: sqlite3.Connection, key: str, method: Method, digest: str
) -> dict[str, Any] | None:
    """The outcome recorded for `key`, `ACTING` while it hasn't one, or `None`; `conflict` if
    the key was used for other inputs."""
    row = conn.execute(
        "SELECT method, params_digest, outcome FROM requests WHERE request_key = ?", (key,)
    ).fetchone()
    if row is None:
        return None
    if (row[0], row[1]) != (method.name, digest):
        raise AgentError(
            ConflictError(
                code="conflict",
                message="This request's key was already used for another request.",
                data=ConflictData(reason="request_key_reused"),
            )
        )
    return ACTING if row[2] is None else json.loads(row[2])


def _act[R: WireModel](
    conn: sqlite3.Connection, act: Callable[[sqlite3.Connection], R]
) -> dict[str, Any]:
    conn.execute("SAVEPOINT act")
    try:
        outcome = {"result": act(conn).model_dump(mode="json")}
    except AgentError as e:
        conn.execute("ROLLBACK TO act")
        outcome = {"error": e.error.model_dump(mode="json")}
    conn.execute("RELEASE act")
    return outcome


@cache
def _errors() -> TypeAdapter[Any]:
    """Built on first use: building it at import would cost the agent's start."""
    return TypeAdapter(WireError)


def _insert(
    conn: sqlite3.Connection,
    method: Method,
    params: Any,
    status: str,
    *,
    outcome: dict[str, Any] | None = None,
    finished: bool = False,
) -> None:
    """Records the request with `status`, and its outcome if it has one, in the caller's write
    transaction."""
    at = now()
    conn.execute(
        "INSERT INTO requests (request_key, method, params, params_digest, status, outcome, "
        "created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            params.request_key,
            method.name,
            _payload(params),
            _digest(params),
            status,
            None if outcome is None else json.dumps(outcome, separators=(",", ":")),
            at,
            at if finished else None,
        ),
    )


def _payload(params: WireModel) -> str:
    """The request's inputs without its key: the same action retried has the same payload."""
    return params.model_dump_json(exclude={"request_key"})


def _digest(params: WireModel) -> str:
    return hashlib.sha256(_payload(params).encode()).hexdigest()
