"""A run's **Stretches** (#312): how many of its topologies completed in each stretch of its time
since its first array, beside the run's best at the stretch's end. Its coordinator keeps them as
it collects, so Run detail's progress chart reads at most `MOST` rows whatever the run's size,
never each topology (ADR-0013).

A stretch lasts a minute at first. Once the run's time passes `MOST` of them, they double in
length, each pair merging into one, so a run of any length keeps at most `MOST`. A run submitted
before migration 19 keeps none: what was collected before can't be placed, and a part would
undercount.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from icmm.wire.run import RunStretch, RunStretches

FIRST_S = 60
"""How long a new run's stretches last, in seconds."""
MOST = 500
"""The most stretches a run keeps: under 100 KB on the wire."""


class NotFoundError(Exception):
    """No such run: deleted, or never submitted."""


def record(conn: sqlite3.Connection, run: int, at: str, completed: int) -> None:
    """Counts `completed` topologies complete at `at` (as the database keeps times), beside the
    run's best now, in the caller's write transaction. A run that keeps no stretches, or that has
    sent nothing yet, is left as it is."""
    row = conn.execute(
        "SELECT stretch_s, first_array_at, best_train_rmse, best_val_rmse FROM runs WHERE id = ?",
        (run,),
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        return
    length, began, train, val = row
    n = _place(at, began, length)
    if n >= MOST:
        length, n = _lengthen(conn, run, length, n)
    conn.execute(
        "INSERT INTO run_stretches (run_id, stretch, topologies_complete, best_train_rmse, "
        "best_val_rmse) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, stretch) DO UPDATE SET "
        "topologies_complete = topologies_complete + excluded.topologies_complete, "
        "best_train_rmse = excluded.best_train_rmse, best_val_rmse = excluded.best_val_rmse",
        (run, n, completed, train, val),
    )


def take_back(conn: sqlite3.Connection, run: int, ended_at: str | None) -> None:
    """A topology complete at `ended_at` that a Resume fits again: its completion leaves its
    stretch, in the caller's write transaction, so the stretches add up to the run's topologies
    complete, and it counts again where it completes again."""
    row = conn.execute("SELECT stretch_s, first_array_at FROM runs WHERE id = ?", (run,)).fetchone()
    if row is None or row[0] is None or row[1] is None or ended_at is None:
        return
    conn.execute(
        "UPDATE run_stretches SET topologies_complete = MAX(0, topologies_complete - 1) "
        "WHERE run_id = ? AND stretch = ?",
        (run, _place(ended_at, row[1], row[0])),
    )


def read(conn: sqlite3.Connection, run: int) -> RunStretches:
    """The run's stretches, in one query over at most `MOST` rows; `NotFoundError` for a run
    deleted or never submitted."""
    rows = conn.execute(
        "SELECT r.stretch_s, s.stretch, s.topologies_complete, s.best_train_rmse, "
        "s.best_val_rmse FROM runs r LEFT JOIN run_stretches s ON s.run_id = r.id "
        "WHERE r.id = ? AND r.deleted_at IS NULL ORDER BY s.stretch LIMIT ?",
        (run, MOST),
    ).fetchall()
    if not rows:
        raise NotFoundError
    return RunStretches(
        stretch_s=rows[0][0],
        stretches=[
            RunStretch(
                stretch=n, topologies_complete=complete, best_train_rmse=train, best_val_rmse=val
            )
            for _, n, complete, train, val in rows
            if n is not None
        ],
    )


def _place(at: str, began: str, length: int) -> int:
    """The stretch `at` falls in: never before the first."""
    elapsed = (_time(at) - _time(began)).total_seconds()
    return max(0, int(elapsed // length))


def _time(at: str) -> datetime:
    return datetime.fromisoformat(at.replace("Z", "+00:00"))


def _lengthen(conn: sqlite3.Connection, run: int, length: int, n: int) -> tuple[int, int]:
    """Doubles the run's stretches until stretch `n` is among the first `MOST`, each pair merging
    into one: their counts added, and the later's best, the run's at the pair's end. Answers the
    new length and `n`'s new place."""
    shift = 0
    while n >> shift >= MOST:
        shift += 1
    merged: dict[int, list] = {}
    for stretch, complete, train, val in conn.execute(
        "SELECT stretch, topologies_complete, best_train_rmse, best_val_rmse FROM run_stretches "
        "WHERE run_id = ? ORDER BY stretch",
        (run,),
    ):
        into = merged.setdefault(stretch >> shift, [0, None, None])
        into[0] += complete
        into[1:] = train, val
    conn.execute("DELETE FROM run_stretches WHERE run_id = ?", (run,))
    conn.executemany(
        "INSERT INTO run_stretches (run_id, stretch, topologies_complete, best_train_rmse, "
        "best_val_rmse) VALUES (?, ?, ?, ?, ?)",
        [(run, stretch, *kept) for stretch, kept in merged.items()],
    )
    conn.execute("UPDATE runs SET stretch_s = ? WHERE id = ?", (length << shift, run))
    return length << shift, n >> shift
