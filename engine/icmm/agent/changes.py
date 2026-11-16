"""`subscribe_changes`: the runs database's change feed, polled once a second (ADR-0009).

Nothing on NFS can notify across hosts, so the agent polls: one indexed query per subscription
per second, and only while someone is subscribed.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from icmm.agent.serve import Push, subscription_ids
from icmm.db import NewerSchemaError, RunsDb, feed_id
from icmm.wire.changes import Change, Changes, ChangeTopic, SubscribeChangesParams, Subscription

POLL_INTERVAL_S = 1.0
MAX_CHANGES_PER_EVENT = 1000
_TOPICS = frozenset(ChangeTopic)


@dataclass
class _Subscriber:
    id: int
    last: int
    active: bool = False
    """Set once the reply naming it is out, so no event comes before it."""


class ChangeFeed:
    """Each subscriber's changes, pushed as `Changes` events from one polling thread."""

    def __init__(
        self,
        db: RunsDb,
        *,
        interval_s: float = POLL_INTERVAL_S,
        ids: Callable[[], int] | None = None,
    ) -> None:
        """`ids` numbers the session's subscriptions, shared with its other feeds."""
        self.db = db
        self.ids = ids or subscription_ids()
        self.interval_s = interval_s
        self.subscribers: list[_Subscriber] = []
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, name="changes")
        self.push: Push | None = None

    def start(self, push: Push) -> None:
        self.push = push
        self.thread.start()

    def close(self, deadline: float) -> None:
        self.stop.set()
        if self.thread.is_alive():
            self.thread.join(max(0.0, deadline - time.monotonic()))

    def activate(self, subscription: Subscription) -> None:
        """The route's `on_sent`: the reply is out, so its events may follow."""
        with self.lock:
            for subscriber in self.subscribers:
                if subscriber.id == subscription.subscription:
                    subscriber.active = True

    def subscribe(self, params: SubscribeChangesParams) -> Subscription:
        conn = self.db.connection()
        feed = feed_id(conn)
        latest, oldest = _bounds(conn)
        after = params.after
        # Another database's feed, a seq past the latest, or one whose successors were pruned
        # can't be resumed from.
        reset = after is not None and not (after.feed == feed and oldest - 1 <= after.seq <= latest)
        with self.lock:
            subscriber = _Subscriber(self.ids(), latest)
            if after is not None and not reset:
                subscriber.last = after.seq
            self.subscribers.append(subscriber)
        return Subscription(subscription=subscriber.id, feed=feed, seq=latest, reset=reset)

    def _run(self) -> None:
        while not self.stop.wait(self.interval_s):
            self.poll()

    def poll(self) -> None:
        """One tick: pushes each active subscriber what's new. The thread ticks every
        `interval_s`; a test may tick by hand, at a point it chooses."""
        with self.lock:
            subscribers = [s for s in self.subscribers if s.active]
        for subscriber in subscribers:
            try:
                changes = _since(self.db.connection(), subscriber.last)
            except (sqlite3.Error, NewerSchemaError):
                # Busy or briefly unreadable: the next tick asks again. Past the floor, the
                # desktop's next request hears why.
                return
            if not changes:
                continue
            subscriber.last = changes[-1][0]
            # A topic only a newer engine knows means nothing to this protocol's desktop.
            known = [
                Change(seq=seq, topic=ChangeTopic(topic), key=key)
                for seq, topic, key in changes
                if topic in _TOPICS
            ]
            if known and self.push is not None:
                self.push(subscriber.id, Changes(changes=known))


def _bounds(conn: sqlite3.Connection) -> tuple[int, int]:
    """The latest seq ever given out, and the oldest still kept (one past the latest when the
    feed is empty)."""
    row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").fetchone()
    latest = row[0] if row else 0
    oldest = conn.execute("SELECT MIN(seq) FROM changes").fetchone()[0]
    return latest, latest + 1 if oldest is None else oldest


def _since(conn: sqlite3.Connection, after: int) -> list[tuple[int, str, str | None]]:
    return conn.execute(
        "SELECT seq, topic, key FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
        (after, MAX_CHANGES_PER_EVENT),
    ).fetchall()
