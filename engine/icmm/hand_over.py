"""The hand-over (ADR-0020): before a migration raises the floor, the runs in flight go to the
engine applying it.

The newer agent records the floor it will raise to, and when it asked. Each older **Coordinator**
below it finishes the sweep it's in and stops, its generation having made progress, and none of
its engine claims a run since. A request no newer agent renews lapses after `LAPSES_AFTER`, so an
agent closed before it finished leaves the runs to their own engine meanwhile. Once no older
coordinator carries a run, the agent migrates, and in that transaction
the runs in flight become its engine's; each goes on from its next generation, launched as any
generation whose claimer has ended is (`icmm.agent.lifecycle`, `icmm.coordinator.recover`). The
starts it had out keep running, and the new generation collects them.
"""

from __future__ import annotations

import sqlite3
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from icmm.db import HandOverPendingError, NewerSchemaError, append_change, iso, transaction

if TYPE_CHECKING:
    from icmm.scheduler import Scheduler

KEY = "handing_over"
"""The `meta` key holding the floor a hand-over raises to and when it was asked, as
`<floor> <time>`, while one is under way."""
LAPSES_AFTER = timedelta(minutes=15)
"""How long a request holds older engines back without a newer agent asking again."""
WAIT_S = 12.0
"""How long the agent's `hello` waits for older coordinators to stop before it answers busy: a
coordinator on SLURM sweeps every 5 s by default, and the reply must beat hello's 20 s."""
CHECK_EVERY_S = 2.0


class AgentHandOver:
    """The agent's hand-over, for its `RunsDb` (`icmm.db.HandOver`)."""

    def __init__(
        self,
        scheduler: Callable[[], Scheduler | None],
        engine: str | None,
        *,
        wait_s: float = WAIT_S,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """`scheduler` makes the platform's scheduler, the first time a hand-over needs it;
        `engine` is the key of the engine bundle the agent runs from, which takes the runs."""
        self._make: Callable[[], Scheduler | None] | None = scheduler
        self._scheduler: Scheduler | None = None
        self._stopped: set[str] = set()
        """The claimers seen stopped: none claims again while the hand-over is asked for."""
        self.engine = engine
        self.wait_s = wait_s
        self.clock = clock
        self.sleep = sleep

    def ready(self, conn: sqlite3.Connection, floor: int) -> bool:
        """Asks for the runs, then waits up to `wait_s` for every older coordinator to stop."""
        request(conn, floor)
        deadline = self.clock() + self.wait_s

        def remaining() -> float:
            return deadline - self.clock()

        while carried(conn, self._scheduler_now(), stopped=self._stopped, remaining=remaining):
            if remaining() <= 0:
                return False
            self.sleep(min(CHECK_EVERY_S, max(0.0, remaining())))
        return True

    def finish(self, conn: sqlite3.Connection) -> None:
        """The runs in flight are this engine's, each going on from its next generation, and the
        hand-over is over."""
        from icmm import platform_settings, run_store
        from icmm.coordinator import files
        from icmm.db import feed_id
        from icmm.wire.platform import SlurmJobDefaults

        saved = platform_settings.read(conn)
        if saved is not None and isinstance(saved.settings.job_defaults, SlurmJobDefaults):
            # Refusal deletes the successor. Its replacement still needs the stopping reason
            # to drain the starts already out and finish the failure on this engine.
            missing = conn.execute(
                "SELECT r.id, r.generation + 1 FROM runs r INDEXED BY runs_in_flight "
                "JOIN coordinators c ON c.run_id = r.id AND c.generation = r.generation "
                "WHERE r.end_seq IS NULL AND r.deleted_at IS NULL "
                "AND r.canceling_since IS NULL AND c.claimed_by IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM coordinators n WHERE n.run_id = r.id "
                "AND n.generation > r.generation)"
            ).fetchall()
            feed = feed_id(conn)
            for run, generation in missing:
                conn.execute(
                    "INSERT INTO coordinators (run_id, generation, identity) VALUES (?, ?, ?)",
                    (run, generation, files.identity(feed, run, "c", generation)),
                )

        moved = conn.execute(
            "UPDATE runs SET engine = ? WHERE end_seq IS NULL AND deleted_at IS NULL "
            "AND engine IS NOT ? RETURNING id",
            (self.engine, self.engine),
        ).fetchall()
        for (run,) in moved:
            append_change(conn, run_store.TOPIC, str(run))
        conn.execute("DELETE FROM meta WHERE key = ?", (KEY,))

    def _scheduler_now(self) -> Scheduler | None:
        if self._make is not None:
            self._scheduler, self._make = self._make(), None
        return self._scheduler


def carried(
    conn: sqlite3.Connection,
    scheduler: Scheduler | None,
    *,
    stopped: set[str],
    remaining: Callable[[], float],
) -> bool:
    """Whether a coordinator may still carry a run in flight: the one that claimed it last runs,
    the scheduler doesn't answer, or the request's allowance is spent. Each claimer is asked
    about until it's seen stopped, then added to `stopped`; one neither the queue nor accounting
    knows any more ended long ago."""
    from icmm.scheduler import SchedulerUnavailableError

    claimers = [
        claimer
        for (claimer,) in conn.execute(
            "SELECT c.claimed_by FROM runs r INDEXED BY runs_in_flight JOIN coordinators c "
            "ON c.run_id = r.id AND c.generation = r.generation "
            "WHERE r.end_seq IS NULL AND r.deleted_at IS NULL AND c.claimed_by IS NOT NULL "
            "ORDER BY r.id"
        )
    ]
    waiting = [claimer for claimer in claimers if claimer not in stopped]
    if not waiting:
        return False
    if scheduler is None:
        return True
    budget_s = remaining()
    if budget_s <= 0:
        return True
    try:
        states = scheduler.alive_many(waiting, budget_s=budget_s)
    except SchedulerUnavailableError:
        return True
    if remaining() <= 0:
        return True
    stopped.update(claimer for claimer in waiting if not states[claimer])
    return any(states[claimer] for claimer in waiting)


def stop(error: NewerSchemaError | HandOverPendingError) -> int:
    """How a process other than the agent ends on the floor: below it, this engine has nothing
    left to do here; with a hand-over to come, the agent does it as it connects. Exits 0."""
    if isinstance(error, NewerSchemaError):
        said = "A newer version of ICMM set up this Data folder: this engine stops."
        print(said, file=sys.stderr)
    else:
        print(f"{error}: ICMM's agent hands them over as it connects.", file=sys.stderr)
    return 0


def request(conn: sqlite3.Connection, floor: int, *, at: datetime | None = None) -> None:
    """Asks every coordinator below `floor` to stop, as of `at` (now), in a write transaction of
    its own; a request for a higher floor stands."""
    asked = at or datetime.now(UTC)
    with transaction(conn):
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (KEY,)).fetchone()
        if row is not None and _parsed(row[0])[0] > floor:
            return
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE "
            "SET value = excluded.value",
            (KEY, f"{floor} {iso(asked)}"),
        )


def requested(conn: sqlite3.Connection, known: int, *, at: datetime | None = None) -> bool:
    """Whether a hand-over asks an engine that knows `known` migrations to stop, as of `at`
    (now)."""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (KEY,)).fetchone()
    if row is None:
        return False
    floor, asked = _parsed(row[0])
    return floor > known and (at or datetime.now(UTC)) - asked < LAPSES_AFTER


def _parsed(value: str) -> tuple[int, datetime]:
    floor, asked = value.split(" ")
    return int(floor), datetime.fromisoformat(asked.replace("Z", "+00:00"))
