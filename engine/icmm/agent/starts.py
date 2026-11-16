"""Topology's and the Start page's reads: a topology's starts and their Progress curves, a page at
a time, one start in full, its try's Start log and job log, paged, and `watch_start`, the live
Start page's watch on a running start's files (ADR-0009, ADR-0019).

Lists, curves and a start are one query over the rows the run's coordinator keeps. A log is one
query for where it is, then one read of at most a page. A watch stats two files every 5 s and
reads only what's new. Nothing is computed (ADR-0013).

`icmm.run_starts` is imported on first use, so the agent's start path stays as light as `hello`
needs.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import ValidationError

from icmm.agent.serve import AgentError, Push, subscription_ids
from icmm.db import RunsDb
from icmm.wire.errors import (
    BadRequestError,
    NotFoundData,
    NotFoundError,
    UnavailableData,
    UnavailableError,
    UnavailableSource,
)
from icmm.wire.start import (
    CoordinatingJobs,
    JobLogPage,
    ListCoordinatingJobsParams,
    ListStartsParams,
    LiveSnapshot,
    ReadCoordinatingJobLogParams,
    ReadJobLogParams,
    ReadStartLogParams,
    ReadStartParams,
    Start,
    StartList,
    StartLogPage,
    StartLogPoint,
    StartWatch,
    StartWatchEvent,
    TopologyProgress,
    TopologyProgressParams,
    WatchStartParams,
)

if TYPE_CHECKING:
    from icmm.run_starts import TryFiles

WATCH_EVERY_S = 5.0
"""How often a watch stats its start's files (ADR-0009)."""
LOG_PAGE_BYTES = 512 * 1024
"""How much of a Start log a page or an event reads: its points re-encode to about as much."""
JOB_LOG_PAGE_BYTES = 128 * 1024
"""How much of a job log a page reads: JSON may write a control character as 6 bytes."""
TAIL_BYTES = 8192
_RETRY_AFTER_MS = 5000


def list_starts(params: ListStartsParams, *, db: RunsDb) -> StartList:
    from icmm import run_starts

    try:
        page, next = run_starts.list_page(
            db.connection(), params.run, params.graph, params.open_state, params.after
        )
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None
    except run_starts.NotFoundError:
        from icmm.agent.topologies import topology_not_found

        raise AgentError(topology_not_found(params.run, params.graph, params.open_state)) from None
    return StartList(starts=page, next=next)


def topology_progress(params: TopologyProgressParams, *, db: RunsDb) -> TopologyProgress:
    from icmm import run_starts

    try:
        page, next = run_starts.progress_page(
            db.connection(), params.run, params.graph, params.open_state, params.after
        )
    except ValueError:
        raise AgentError(
            BadRequestError(code="bad_request", message="`after` isn't a page's `next`.")
        ) from None
    except run_starts.NotFoundError:
        from icmm.agent.topologies import topology_not_found

        raise AgentError(topology_not_found(params.run, params.graph, params.open_state)) from None
    return TopologyProgress(curves=page, next=next)


def read_start(params: ReadStartParams, *, db: RunsDb) -> Start:
    from icmm import run_starts

    try:
        return run_starts.read(
            db.connection(), params.run, params.graph, params.open_state, params.start
        )
    except run_starts.NotFoundError:
        raise AgentError(
            _start_not_found(params.run, params.graph, params.open_state, params.start)
        ) from None


def read_start_log(params: ReadStartLogParams, *, db: RunsDb) -> StartLogPage:
    _one_way(params.after, params.before)
    where = _try_files(db, params, params.try_number)
    if where.log is None:
        return StartLogPage(path=None, found=False, points=[], begins=0, next=0, size=0, skipped=0)
    if params.after is None:
        page = _points_before(where.log, params.before)
    else:
        page = _read_points(where.log, params.after)
    return StartLogPage(
        path=str(where.log),
        found=page.found,
        points=page.points,
        begins=page.begins,
        next=page.next,
        size=page.size,
        skipped=page.skipped,
    )


def read_job_log(params: ReadJobLogParams, *, db: RunsDb) -> JobLogPage:
    _one_way(params.after, params.before)
    where = _try_files(db, params, params.try_number)
    if not where.job_logs:
        return JobLogPage(path=None, found=False, text="", begins=0, next=0, size=0)
    path = where.job_logs[0]
    for candidate in where.job_logs:
        if _exists(candidate):
            path = candidate
            break
    return text_page(path, params.after, params.before)


def text_page(path: Path, after: int | None, before: int | None) -> JobLogPage:
    """A page of a job log: forward from `after`, or else back from `before`, its end without
    one."""
    if after is None:
        return _text_before(path, before)
    chunk, size, found = _read_chunk(path, after, JOB_LOG_PAGE_BYTES)
    if found and after + len(chunk) < size:
        # More follows: end at a line's end, or else at a whole character.
        end = chunk.rfind(b"\n") + 1 or _whole_characters(chunk)
        chunk = chunk[:end]
    return JobLogPage(
        path=str(path),
        found=found,
        text=chunk.decode("utf-8", errors="replace"),
        begins=after,
        next=after + len(chunk),
        size=size,
    )


def _one_way(after: int | None, before: int | None) -> None:
    if after is not None and before is not None:
        raise AgentError(
            BadRequestError(
                code="bad_request", message="A page reads from `after` or back from `before`."
            )
        )


def list_coordinating_jobs(params: ListCoordinatingJobsParams, *, db: RunsDb) -> CoordinatingJobs:
    from icmm import run_store

    try:
        return CoordinatingJobs(jobs=run_store.coordinating_jobs(db.connection(), params.run))
    except run_store.NotFoundError:
        from icmm.agent.topologies import run_not_found

        raise AgentError(run_not_found(params.run)) from None


def read_coordinating_job_log(params: ReadCoordinatingJobLogParams, *, db: RunsDb) -> JobLogPage:
    from icmm import run_store

    _one_way(params.after, params.before)
    try:
        path = run_store.coordinator_log(db.connection(), params.run, params.generation)
    except run_store.NotFoundError:
        from icmm.agent.topologies import run_not_found

        raise AgentError(run_not_found(params.run)) from None
    except run_store.NoGenerationError:
        name = f"#{params.run} generation {params.generation}"
        raise AgentError(
            NotFoundError(
                code="not_found",
                message=f"{name} isn't on this platform: its coordinator never had it.",
                data=NotFoundData(kind="coordinating_job", id=name),
            )
        ) from None
    return text_page(path, params.after, params.before)


# The watch.


@dataclass
class _Watch:
    id: int
    start: tuple[int, int, int, int]
    """The run, the topology's graph and open state, and the start's index."""
    files: TryFiles
    offset: int
    stamp: tuple[int, int] | None
    """The Live snapshot's modification time and size when it was last read."""
    active: bool = False
    """Set once the reply naming it is out, so no event comes before it."""


class StartWatches:
    """The session's watch on one start, polled every `interval_s` from one thread, which pushes
    each change as a `StartWatchEvent`. A new watch ends the one before."""

    def __init__(
        self,
        db: RunsDb,
        *,
        interval_s: float = WATCH_EVERY_S,
        ids: Callable[[], int] | None = None,
    ) -> None:
        self.db = db
        self.interval_s = interval_s
        self.ids = ids or subscription_ids()
        self.watch_: _Watch | None = None
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._run, name="watch")
        self.push: Push | None = None

    def start(self, push: Push) -> None:
        self.push = push
        self.thread.start()

    def close(self, deadline: float) -> None:
        self.stop.set()
        self.wake.set()
        if self.thread.is_alive():
            self.thread.join(max(0.0, deadline - time.monotonic()))

    def watch(self, params: WatchStartParams) -> StartWatch:
        files = _try_files(self.db, params, None)
        offset = params.after
        if offset is None:
            offset = 0 if files.log is None else _end_of_lines(files.log)
        stamp = snapshot = None
        if files.snapshot is not None and not files.ended:
            stamp, snapshot = _read_snapshot(files.snapshot, None)
        where = (params.run, params.graph, params.open_state, params.start)
        watch = _Watch(self.ids(), where, files, offset, stamp)
        with self.lock:
            self.watch_ = watch
        return StartWatch(subscription=watch.id, try_number=files.try_number, snapshot=snapshot)

    def unwatch(self, _: None) -> None:
        with self.lock:
            self.watch_ = None

    def activate(self, reply: StartWatch) -> None:
        """The route's `on_sent`: the reply is out, so its events may follow, the first at once."""
        with self.lock:
            if self.watch_ is not None and self.watch_.id == reply.subscription:
                self.watch_.active = True
        self.wake.set()

    def _run(self) -> None:
        while not self.stop.is_set():
            self.wake.wait(self.interval_s)
            self.wake.clear()
            if self.stop.is_set():
                return
            self.poll()

    def poll(self) -> Exception | None:
        """One tick of the active watch, if there is one, and the error it logged, if any. The
        thread ticks every `interval_s` and when woken; a test may tick by hand instead, setting
        `push` and never starting it."""
        with self.lock:
            watch = self.watch_ if self.watch_ is not None and self.watch_.active else None
        if watch is None:
            return None
        try:
            self._tick(watch)
        except Exception as e:  # A file or the database briefly unreadable: ask next tick.
            print(f"watch {watch.id}: {e!r}", flush=True, file=sys.stderr)
            return e
        return None

    def _tick(self, watch: _Watch) -> None:
        """Pushes what's new in the watched try's files: its log's next page of new lines, then
        its snapshot if it was replaced. Once the try has ended and its log is read to the end,
        the last event says so and the watch ends.

        One page a tick: a watch from far back in a long log replays it at a page every
        `interval_s`, so what waits in the session's outgoing queue stays bounded however long
        the log is, on the login node's 768 MiB (ADR-0013). `read_start_log` pages the past
        faster."""
        files = watch.files
        ended = files.ended or self._ended(watch)
        snapshot = None
        if files.snapshot is not None and not ended:
            watch.stamp, snapshot = _read_snapshot(files.snapshot, watch.stamp)
        if files.log is not None:
            page = _read_points(files.log, watch.offset)
            if page.next != watch.offset:
                watch.offset = page.next
                ended = ended and page.next >= page.size  # the last page first
                if page.points:
                    event = StartWatchEvent(
                        points=page.points, next=page.next, snapshot=None, ended=False
                    )
                    if not self._push(watch, event):
                        return
        if snapshot is not None or ended:
            event = StartWatchEvent(points=[], next=watch.offset, snapshot=snapshot, ended=ended)
            if not self._push(watch, event):
                return
        if ended:
            with self.lock:
                if self.watch_ is watch:
                    self.watch_ = None

    def _ended(self, watch: _Watch) -> bool:
        """Whether the watched try has ended since, as the runs database has it now."""
        from icmm import run_starts

        try:
            now = run_starts.try_files(self.db.connection(), *watch.start, watch.files.try_number)
        except run_starts.NotFoundError:
            return True  # taken back: the scheduler never took its array
        return now.ended

    def _push(self, watch: _Watch, event: StartWatchEvent) -> bool:
        """Pushes the event, unless the watch was ended or replaced meanwhile."""
        with self.lock:
            if self.watch_ is not watch or self.push is None:
                return False
            self.push(watch.id, event)
        return True


# Files.


@dataclass(frozen=True)
class _Points:
    found: bool
    points: list[StartLogPoint]
    begins: int
    next: int
    size: int
    skipped: int


def _read_points(path: Path, after: int) -> _Points:
    """The whole lines of a Start log from byte `after`, up to `LOG_PAGE_BYTES`, parsed."""
    chunk, size, found = _read_chunk(path, after, LOG_PAGE_BYTES)
    end = chunk.rfind(b"\n") + 1
    if not end and len(chunk) == LOG_PAGE_BYTES:
        # A line longer than a page isn't a log point: past it.
        return _Points(found, [], after, after + len(chunk), size, 1)
    points, skipped = _parsed(chunk[:end])
    return _Points(found, points, after, after + end, size, skipped)


def _points_before(path: Path, before: int | None) -> _Points:
    """The whole lines of a Start log that end by `before`, its end without one, from at most
    `LOG_PAGE_BYTES` back, parsed. The line the page begins in is the page before's, and one
    still being written at the end is the next's; a line longer than a page is skipped, counted
    on the page its first byte is on."""
    w = _window(path, before, LOG_PAGE_BYTES)
    if w.first is None:
        return _Points(w.found, [], w.lo, w.end, w.size, 0)  # inside one line
    assert w.last is not None
    points, skipped = _parsed(w.chunk[w.first - w.lo : w.last - w.lo])
    if before is None:
        return _Points(w.found, points, w.first, w.last, w.size, skipped)
    # A line that goes on past `before` began here, and is longer than a page.
    return _Points(w.found, points, w.first, w.end, w.size, skipped + (w.last < w.end))


def _text_before(path: Path, before: int | None) -> JobLogPage:
    """Up to `JOB_LOG_PAGE_BYTES` of a job log back from `before`, its end without one,
    beginning at a line's start when one is in reach, or else at a whole character."""
    w = _window(path, before, JOB_LOG_PAGE_BYTES)
    begins = w.first if w.first is not None else w.end - _whole_characters_from(w.chunk)
    return JobLogPage(
        path=str(path),
        found=w.found,
        text=w.chunk[begins - w.lo :].decode("utf-8", errors="replace"),
        begins=begins,
        next=w.end,
        size=w.size,
    )


@dataclass(frozen=True)
class _Window:
    """At most a page of a file, from `lo` to `end`, and where the lines in it begin."""

    found: bool
    chunk: bytes
    lo: int
    end: int
    size: int
    first: int | None
    """Where the first line that begins before `end` begins; `None` inside one line."""
    last: int | None
    """Where the last whole line in it ends."""


def _window(path: Path, before: int | None, most: int) -> _Window:
    try:
        with path.open("rb") as f:
            size = os.fstat(f.fileno()).st_size
            end = size if before is None else min(before, size)
            lo = max(0, end - most)
            f.seek(max(0, lo - 1))
            chunk = f.read(end - max(0, lo - 1))
    except FileNotFoundError:
        return _Window(False, b"", 0, 0, 0, None, None)
    except OSError as e:
        raise AgentError(_folder_unavailable(path, e)) from None
    line_start = lo == 0 or chunk[:1] == b"\n"
    if lo > 0:
        chunk = chunk[1:]
    newline = chunk.find(b"\n")
    first = lo if line_start else None if newline < 0 else lo + newline + 1
    if first is not None and first >= end:
        first = None
    last = lo + chunk.rfind(b"\n") + 1 if newline >= 0 else lo if line_start else None
    return _Window(True, chunk, lo, end, size, first, last)


def _parsed(lines: bytes) -> tuple[list[StartLogPoint], int]:
    """A Start log's whole lines, parsed, and how many of them this engine can't read."""
    points, skipped = [], 0
    for line in lines.splitlines():
        if not line.strip():
            continue
        try:
            points.append(StartLogPoint.model_validate_json(line))
        except ValidationError:
            skipped += 1
    return points, skipped


def _read_chunk(path: Path, after: int, most: int) -> tuple[bytes, int, bool]:
    """Up to `most` bytes of the file from `after`, its size, and whether it's there."""
    try:
        with path.open("rb") as f:
            size = os.fstat(f.fileno()).st_size
            f.seek(after)
            return f.read(most), size, True
    except FileNotFoundError:
        return b"", 0, False
    except OSError as e:
        raise AgentError(_folder_unavailable(path, e)) from None


def _end_of_lines(path: Path) -> int:
    """Where a Start log's whole lines end now: past its last newline."""
    try:
        with path.open("rb") as f:
            size = os.fstat(f.fileno()).st_size
            f.seek(max(0, size - TAIL_BYTES))
            tail = f.read()
    except OSError:
        return 0
    return size - len(tail) + tail.rfind(b"\n") + 1


def _read_snapshot(
    path: Path, stamp: tuple[int, int] | None
) -> tuple[tuple[int, int] | None, LiveSnapshot | None]:
    """The Live snapshot's stamp now, and the snapshot if it was replaced since `stamp`; the
    worker replaces it whole, so a read sees one or the other."""
    try:
        stat = path.stat()
    except OSError:
        return None, None
    now = (stat.st_mtime_ns, stat.st_size)
    if now == stamp:
        return stamp, None
    try:
        return now, LiveSnapshot.model_validate_json(path.read_bytes())
    except (OSError, ValidationError):
        # A transient read failure must not acknowledge this replacement: retry the
        # same file next tick, even if the worker writes no further snapshots.
        return stamp, None


def _exists(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _whole_characters(chunk: bytes) -> int:
    """Where `chunk` ends at a whole UTF-8 character: before a lead byte whose character it cuts."""
    for back in range(1, min(4, len(chunk)) + 1):
        byte = chunk[-back]
        if byte & 0xC0 != 0x80:  # a lead byte, or ASCII
            width = 1 if byte < 0x80 else 2 if byte < 0xE0 else 3 if byte < 0xF0 else 4
            return len(chunk) if width <= back else len(chunk) - back
    return len(chunk)


def _whole_characters_from(chunk: bytes) -> int:
    """How much of `chunk`'s end is whole UTF-8 characters: past the continuation bytes it
    begins with, at most 3."""
    skip = 0
    while skip < min(3, len(chunk)) and chunk[skip] & 0xC0 == 0x80:
        skip += 1
    return len(chunk) - skip


def _try_files(
    db: RunsDb,
    params: ReadStartLogParams | ReadJobLogParams | WatchStartParams,
    try_number: int | None,
) -> TryFiles:
    from icmm import run_starts

    try:
        return run_starts.try_files(
            db.connection(), params.run, params.graph, params.open_state, params.start, try_number
        )
    except run_starts.NotFoundError:
        raise AgentError(
            _start_not_found(params.run, params.graph, params.open_state, params.start)
        ) from None


def _start_not_found(run: int, graph: int, open_state: int, start: int) -> NotFoundError:
    name = f"#{run}/T{graph}.{open_state} start {start}"
    return NotFoundError(
        code="not_found",
        message=f"{name} isn't on this platform: its run is gone, or doesn't hold it.",
        data=NotFoundData(kind="start", id=name),
    )


def _folder_unavailable(path: Path, error: OSError) -> UnavailableError:
    return UnavailableError(
        code="unavailable",
        message=f"ICMM can’t read {path} now: {error.strerror or error}. Try again in a moment.",
        data=UnavailableData(
            source=UnavailableSource.FILESYSTEM, retry_after_ms=_RETRY_AFTER_MS, details=None
        ),
    )
