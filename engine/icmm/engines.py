"""The **Engine bundles** a Data folder holds, as the runs database knows them (ADR-0020).

Each agent records the engine it serves from, with how many migrations it knows and when it last
served, as it starts dispatching and every hour after. That tells an engine below the floor,
which no coordinator can run on, and one an agent may still be running from, which housekeeping
keeps.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from icmm.db import floor, iso


def served(conn: sqlite3.Connection, key: str, known: int, at: datetime) -> None:
    """Records that an agent of engine `key`, knowing `known` migrations, serves at `at`, in the
    caller's write transaction."""
    conn.execute(
        "INSERT INTO engines (key, migrations, served_at) VALUES (?, ?, ?) ON CONFLICT (key) "
        "DO UPDATE SET migrations = excluded.migrations, served_at = excluded.served_at",
        (key, known, iso(at)),
    )


def below_floor(conn: sqlite3.Connection, key: str | None) -> bool:
    """Whether engine `key` knows fewer migrations than the floor. One no agent has recorded
    served before the floor last rose, so it's below any floor raised; an engine run from a
    checkout (`None`) never is."""
    at = floor(conn)
    if key is None or at == 0:
        return False
    row = conn.execute("SELECT migrations FROM engines WHERE key = ?", (key,)).fetchone()
    return row is None or row[0] < at
