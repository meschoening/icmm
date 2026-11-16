"""The change feed (ADR-0009): what changed in the runs database, pushed to subscribers.

The desktop holds one subscription per session and turns each change into query
invalidations; after a reconnect it subscribes again from the last `seq` it saw.
"""

from __future__ import annotations

from enum import StrEnum

from icmm.wire.base import WireInt, WireModel


class ChangeTopic(StrEnum):
    PLATFORM_SETTINGS = "platform_settings"
    DATASETS = "datasets"
    """A dataset was saved or deleted; the key is its id."""
    CONFIGS = "configs"
    """A config was saved or deleted; the key is its id."""
    RUNS = "runs"
    """A run was submitted, moved on or ended; the key is its number."""


class Change(WireModel):
    seq: WireInt
    """The change's place in the feed; never reused."""
    topic: ChangeTopic
    key: str | None
    """Which one changed, for a topic with many; `null` for one with a single value."""


class Changes(WireModel):
    """An event: the changes since the last event, oldest first."""

    changes: list[Change]


class FeedPosition(WireModel):
    feed: str
    """The runs database's feed, which a rebuilt or swapped Data folder doesn't share."""
    seq: WireInt


class SubscribeChangesParams(WireModel):
    after: FeedPosition | None
    """The last change the desktop saw; `null` for changes from now on."""


class Subscription(WireModel):
    subscription: WireInt
    """Tags this subscription's events."""
    feed: str
    seq: WireInt
    """The latest change now. Events carry the changes after `after`, or after this one when
    `after` is `null` or `reset` is set."""
    reset: bool
    """`after` isn't in this feed any more, or never was: refetch everything."""
