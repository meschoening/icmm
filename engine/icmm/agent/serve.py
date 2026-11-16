"""The serve loop: NDJSON requests on stdin, replies on stdout (ADR-0009).

A pump thread reads raw bytes and splits lines; the calling thread parses and routes each one.
It answers `ping` and runs `hello` itself, hands reads to a pool of four threads and writes to
one serial lane, and a single writer thread encodes every reply and every event a feed pushes.
The loop ends on EOF, or after `idle_timeout_s` with no line, so an agent the desktop lost
can't linger on a login node.
"""

from __future__ import annotations

import itertools
import json
import os
import queue
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, BinaryIO, Protocol, TextIO

from pydantic import Field, ValidationError

from icmm.wire import Method
from icmm.wire.base import MAX_WIRE_INT, WireModel
from icmm.wire.envelope import MAX_LINE_BYTES
from icmm.wire.errors import BadRequestError, InternalData, InternalError, TooLargeError

READ_THREADS = 4
IDLE_TIMEOUT_S = 60.0
CLOSE_GRACE_S = 10.0
"""At the end, how long work already running gets to finish before `serve` returns anyway."""

type Handler = Callable[[Any], WireModel | None]
type Push = Callable[[int, WireModel], None]
"""Sends one event, `{subscription, event}`."""


class Feed(Protocol):
    """A source of events: started with the session's `Push`, closed when the session ends."""

    def start(self, push: Push) -> None: ...

    def close(self, deadline: float) -> None: ...


def subscription_ids() -> Callable[[], int]:
    """Numbers a session's subscriptions from 1, across every feed, so no two share one."""
    count = itertools.count(1)
    lock = threading.Lock()

    def next_id() -> int:
        with lock:
            return next(count)

    return next_id


class AgentError(Exception):
    """Raised by a handler to reply with this error (a `WireError` variant)."""

    def __init__(self, error: WireModel) -> None:
        super().__init__(error)
        self.error = error


@dataclass(frozen=True)
class Route:
    method: Method
    handler: Handler
    """Takes the validated params (`None` when the method has none) and returns the result."""
    on_sent: Callable[[Any], None] | None = None
    """Called with the result once its reply is written, on the writer's thread, so an event
    it lets a feed push follows the reply."""


@dataclass(frozen=True)
class _Reply:
    id: int | None
    method: str
    started: float
    result: WireModel | None = None
    error: WireModel | None = None
    on_sent: Callable[[Any], None] | None = None


@dataclass(frozen=True)
class _Event:
    subscription: int
    event: WireModel


_EOF = object()
_TOO_LONG = object()


def serve(
    stdin: BinaryIO,
    stdout: BinaryIO,
    routes: Mapping[str, Route],
    *,
    log: TextIO,
    feeds: Sequence[Feed] = (),
    idle_timeout_s: float = IDLE_TIMEOUT_S,
    close_grace_s: float = CLOSE_GRACE_S,
    hello_first: bool = True,
) -> None:
    """Serves until stdin ends or goes quiet. `stdin` is read with `read(n)`, like a raw file.

    With `hello_first`, a session's first request must be `hello`; the host engine, which the
    desktop runs from its own bundle, has none. Work still running after `close_grace_s` is left
    behind; the caller exits the process.
    """
    session = _Session(stdout, routes, log, feeds, greeted=not hello_first)
    lines: queue.Queue[Any] = queue.Queue()
    pump = threading.Thread(target=_pump, args=(stdin, lines.put), name="stdin", daemon=True)
    pump.start()
    try:
        while True:
            try:
                line = lines.get(timeout=idle_timeout_s)
            except queue.Empty:
                return
            if line is _EOF:
                return
            if line is _TOO_LONG:
                error = _bad_request(f"A line is longer than {MAX_LINE_BYTES >> 20} MiB.")
                session.writer.send(_Reply(None, "?", time.monotonic(), error=error))
            else:
                session.handle(line)
    finally:
        session.close(time.monotonic() + close_grace_s)


def _pump(stdin: BinaryIO, put: Callable[[Any], None]) -> None:
    """Splits stdin into lines, refusing one over the cap as soon as it passes it and dropping
    the rest of it. Daemon: a read blocked on the desktop can't be interrupted.
    """
    buf = bytearray()
    draining = False
    while chunk := stdin.read(65536):
        start = 0
        while (end := chunk.find(b"\n", start)) >= 0:
            if not draining:
                buf += chunk[start:end]
                put(bytes(buf) if len(buf) < MAX_LINE_BYTES else _TOO_LONG)
            buf.clear()
            draining = False
            start = end + 1
        if not draining:
            buf += chunk[start:]
            if len(buf) >= MAX_LINE_BYTES:
                put(_TOO_LONG)
                buf.clear()
                draining = True
    put(_EOF)


class _Session:
    def __init__(
        self,
        stdout: BinaryIO,
        routes: Mapping[str, Route],
        log: TextIO,
        feeds: Sequence[Feed],
        *,
        greeted: bool,
    ) -> None:
        self.routes = routes
        self.greeted = greeted
        self.writer = _Writer(stdout, log)
        self.reads = _Lane("read", READ_THREADS)
        self.writes = _Lane("write", 1)
        self.feeds = feeds
        for feed in feeds:
            feed.start(self.writer.push)

    def handle(self, line: bytes) -> None:
        started = time.monotonic()
        if not line.strip():
            return
        try:
            id, method, params = _parse(line)
        except _Unreadable as e:
            self.writer.send(_Reply(e.id, "?", started, error=_bad_request(str(e))))
            return
        if method == "ping":
            self.writer.send(_Reply(id, method, started))
            return
        route = self.routes.get(method)
        if route is None:
            self.writer.send(
                _Reply(id, method, started, error=_bad_request(f"No method {method}."))
            )
            return
        if method == "hello":
            reply = _call(route, id, params, started)
            self.greeted = self.greeted or reply.error is None
            self.writer.send(reply)
        elif not self.greeted:
            error = _bad_request("The first line of a session must be hello.")
            self.writer.send(_Reply(id, method, started, error=error))
        else:
            lane = self.writes if route.method.kind == "write" else self.reads
            lane.submit(lambda: self.writer.send(_call(route, id, params, started)))

    def close(self, deadline: float) -> None:
        for feed in self.feeds:
            feed.close(deadline)
        self.reads.close(deadline)
        self.writes.close(deadline)
        self.writer.close(deadline)


class _Lane:
    """`threads` threads taking work in the order it came; one thread makes a serial lane.

    Not `concurrent.futures`: it imports `logging`, which the agent's start can't afford.
    """

    def __init__(self, name: str, threads: int) -> None:
        self.work: queue.Queue[Callable[[], None] | None] = queue.Queue()
        self.threads = [
            threading.Thread(target=self._run, name=f"{name}-{i}") for i in range(threads)
        ]
        for t in self.threads:
            t.start()

    def submit(self, work: Callable[[], None]) -> None:
        self.work.put(work)

    def close(self, deadline: float) -> None:
        """Finishes the work already submitted, waiting until `deadline` at most."""
        for _ in self.threads:
            self.work.put(None)
        for t in self.threads:
            t.join(max(0.0, deadline - time.monotonic()))

    def _run(self) -> None:
        while (work := self.work.get()) is not None:
            work()


class _Unreadable(Exception):
    def __init__(self, message: str, id: int | None = None) -> None:
        super().__init__(message)
        self.id = id


def _parse(line: bytes) -> tuple[int, str, Any]:
    try:
        request = json.loads(line)
    except ValueError:
        raise _Unreadable("The line isn't JSON.") from None
    if not isinstance(request, dict):
        raise _Unreadable("A request must be a JSON object.")
    id = request.get("id")
    if not isinstance(id, int) or isinstance(id, bool) or not 0 <= id <= MAX_WIRE_INT:
        raise _Unreadable("A request needs an integer `id`.")
    method = request.get("method")
    if not isinstance(method, str):
        raise _Unreadable("A request needs a string `method`.", id)
    unknown = set(request) - {"id", "method", "params"}
    if unknown:
        raise _Unreadable(f"A request has no field {sorted(unknown)[0]}.", id)
    return id, method, request.get("params")


def _call(route: Route, id: int, params: Any, started: float) -> _Reply:
    name = route.method.name
    model = route.method.params
    try:
        if model is None:
            if params is not None:
                raise ValueError(f"{name} takes no params")
            parsed = None
        else:
            # Validated from JSON text: strict mode takes an enum's value only from JSON.
            parsed = model.model_validate_json(json.dumps(params))
    except (ValidationError, ValueError) as e:
        return _Reply(id, name, started, error=_bad_request(f"Bad params for {name}: {e}"))
    try:
        return _Reply(id, name, started, result=route.handler(parsed), on_sent=route.on_sent)
    except AgentError as e:
        return _Reply(id, name, started, error=e.error)
    except Exception:
        return _Reply(id, name, started, error=internal_error())


def _bad_request(message: str) -> WireModel:
    return BadRequestError(code="bad_request", message=message)


class _Internal(InternalError):
    """An `internal` error that carries its traceback to the log, never onto the wire."""

    trace: str = Field(exclude=True)


def internal_error() -> InternalError:
    """The exception being handled, as an `internal` error; call it from an `except`."""
    import traceback  # Only on failure: the agent's start path stays light.

    return _Internal(
        code="internal",
        message="Something went wrong in the engine.",
        data=InternalData(log_ref=os.urandom(4).hex()),
        trace=traceback.format_exc(),
    )


class _Writer:
    """The only thread that writes stdout: it encodes each reply and event, and logs each reply's
    outcome."""

    def __init__(self, stdout: BinaryIO, log: TextIO) -> None:
        self.stdout = stdout
        self.log = log
        self.queue: queue.Queue[_Reply | _Event | None] = queue.Queue()
        self.thread = threading.Thread(target=self._run, name="writer")
        self.thread.start()

    def send(self, reply: _Reply) -> None:
        self.queue.put(reply)

    def push(self, subscription: int, event: WireModel) -> None:
        self.queue.put(_Event(subscription, event))

    def close(self, deadline: float) -> None:
        self.queue.put(None)
        self.thread.join(max(0.0, deadline - time.monotonic()))

    def _run(self) -> None:
        while (reply := self.queue.get()) is not None:
            if isinstance(reply, _Event):
                self._send_event(reply)
                continue
            try:
                line = _encode(reply)
            except (ValueError, TypeError):
                reply = replace(reply, result=None, error=internal_error())
                line = _encode(reply)
            if len(line) > MAX_LINE_BYTES:
                message = f"The reply would be longer than {MAX_LINE_BYTES >> 20} MiB."
                reply = replace(
                    reply, result=None, error=TooLargeError(code="too_large", message=message)
                )
                line = _encode(reply)
            try:
                _write_all(self.stdout, line)
            except OSError:
                pass
            if reply.method != "ping":
                self._log(reply)
            if reply.error is None and reply.on_sent is not None:
                try:
                    reply.on_sent(reply.result)
                except Exception as e:
                    self._note(f"{reply.method} id={reply.id} after its reply: {e!r}")

    def _send_event(self, item: _Event) -> None:
        """Writes one event. One that can't be sent is logged and dropped: a feed's next event
        still carries its `seq`, so the desktop sees the gap."""
        envelope = {"subscription": item.subscription, "event": item.event.model_dump(mode="json")}
        try:
            line = _dumps(envelope)
        except (ValueError, TypeError) as e:
            self._note(f"event subscription={item.subscription} unencodable: {e}")
            return
        if len(line) > MAX_LINE_BYTES:
            self._note(f"event subscription={item.subscription} too large: {len(line)} bytes")
            return
        try:
            _write_all(self.stdout, line)
        except OSError:
            pass

    def _note(self, text: str) -> None:
        self.log.write(f"{_now()} {text}\n")
        self.log.flush()

    def _log(self, reply: _Reply) -> None:
        """One line per request (a `ping` aside): when, what, how long and how it ended."""
        ms = round((time.monotonic() - reply.started) * 1000)
        outcome = "ok" if reply.error is None else getattr(reply.error, "code", "error")
        self.log.write(f"{_now()} {reply.method} id={reply.id} {ms} ms {outcome}\n")
        if isinstance(reply.error, _Internal):
            self.log.write(f"log_ref={reply.error.data.log_ref}\n{reply.error.trace}")
        self.log.flush()


def _write_all(stdout: BinaryIO, line: bytes) -> None:
    """Writes all of `line`: a raw pipe or socket may take only part of it per write."""
    view = memoryview(line)
    while view:
        view = view[stdout.write(view) or 0 :]
    stdout.flush()


def _encode(reply: _Reply) -> bytes:
    envelope: dict[str, Any] = {"id": reply.id}
    if reply.error is not None:
        envelope["error"] = reply.error.model_dump(mode="json")
    else:
        envelope["result"] = (
            reply.result.model_dump(mode="json") if reply.result is not None else None
        )
    return _dumps(envelope)


def _dumps(envelope: dict[str, Any]) -> bytes:
    text = json.dumps(envelope, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
    return text.encode() + b"\n"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
