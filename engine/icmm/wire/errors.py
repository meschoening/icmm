"""The error replies (ADR-0009): `{code, message}`, plus a typed `data` for codes that carry one.

`unavailable` is the only code worth retrying. `timeout` and `not_connected` exist on the
desktop side only, so they aren't here.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field

from icmm.wire.base import WireInt, WireModel

type ErrorCode = Literal[
    "bad_request",
    "version_mismatch",
    "invalid",
    "not_found",
    "conflict",
    "too_large",
    "unavailable",
    "rejected",
    "no_space",
    "db_corrupt",
    "data_folder",
    "unreadable",
    "internal",
]


class BadRequestError(WireModel):
    """A request the agent can't read: a desktop bug, never the user's."""

    code: Literal["bad_request"]
    message: str


class VersionMismatchData(WireModel):
    protocol: str
    """The agent's protocol, `major.minor`."""


class VersionMismatchError(WireModel):
    """The desktop and the agent speak different protocols (major.minor)."""

    code: Literal["version_mismatch"]
    message: str
    data: VersionMismatchData


class Severity(StrEnum):
    """Whether an issue stops a save."""

    ERROR = "error"
    """It stops the save until it's fixed."""
    NOTE = "note"
    """It doesn't: it says what the save will change, or what to know before a run."""


class Issue(WireModel):
    path: list[str]
    """Keys from the top of the input down to the field; list indices written as decimals."""
    message: str
    """A sentence to show beside the field."""
    severity: Severity
    """`error` until it's fixed, a save waits; a `note` never stops one."""


class InvalidData(WireModel):
    issues: list[Issue]


class InvalidError(WireModel):
    """The user's input fails its checks: every issue found, each with where it is."""

    code: Literal["invalid"]
    message: str
    data: InvalidData


class NotFoundData(WireModel):
    kind: str
    id: str


class NotFoundError(WireModel):
    code: Literal["not_found"]
    message: str
    data: NotFoundData


class ConflictData(WireModel):
    reason: str


class ConflictError(WireModel):
    """A stale `expected_revision`, or a `request_key` reused with different inputs."""

    code: Literal["conflict"]
    message: str
    data: ConflictData


class TooLargeError(WireModel):
    """The reply would exceed the 16 MiB line cap."""

    code: Literal["too_large"]
    message: str


class UnavailableSource(StrEnum):
    DB = "db"
    FILESYSTEM = "filesystem"
    SCHEDULER = "scheduler"
    HAND_OVER = "hand_over"
    """A newer engine is taking the runs in flight over from the older coordinators (ADR-0020)."""


class UnavailableData(WireModel):
    source: UnavailableSource
    retry_after_ms: WireInt
    details: str | None
    """What the source said, as one line, where ICMM has its words: squeue's error for
    `user_jobs`. `null` otherwise."""


class UnavailableError(WireModel):
    """Something the agent needs is busy or down for now; the only retryable code."""

    code: Literal["unavailable"]
    message: str
    data: UnavailableData


class RejectedData(WireModel):
    stderr: str


class RejectedError(WireModel):
    """The scheduler refused, with what it said."""

    code: Literal["rejected"]
    message: str
    data: RejectedData


class NoSpaceData(WireModel):
    free_bytes: WireInt | None
    """What the folder has left, the smaller of its disk's free space and the user's quota;
    `null` when its disk can't be read."""


class NoSpaceError(WireModel):
    """The Data folder is full."""

    code: Literal["no_space"]
    message: str
    data: NoSpaceData


class DbCorruptData(WireModel):
    detail: str
    """What SQLite said."""


class DbCorruptError(WireModel):
    """The runs database is damaged, or isn't one; the agent won't change it."""

    code: Literal["db_corrupt"]
    message: str
    data: DbCorruptData


class DataFolderProblem(StrEnum):
    """Why the agent can't keep its runs database in the Data folder."""

    UNSHARED = "unshared"
    """It's on a machine's own disk, which the cluster's computers that run fits can't reach."""
    LOCKS = "locks"
    """It's on storage whose file locks stay on one machine, so the cluster's computers can't
    take turns saving."""
    NEWER = "newer"
    """A newer version of ICMM set it up."""
    SETTINGS = "settings"
    """Its Platform settings can't be read: a newer version saved them, or they're damaged."""
    READ_ONLY = "read_only"
    """The runs database there can't be opened for writing."""


class DataFolderData(WireModel):
    problem: DataFolderProblem
    storage: str | None
    """The mount point the folder is on, for `unshared` and `locks`; `null` otherwise."""
    details: str
    """The facts behind it, as one line: the folder's mount point and filesystem, the version
    that set it up, or what SQLite said."""
    suggestion: str | None
    """A Data folder that passes the same check here, written as the user would (`~/icmm`),
    for `unshared` and `locks`; `null` when none was found."""


class DataFolderError(WireModel):
    """The Data folder can't hold the runs database: storage the cluster can't use, a newer
    version's folder, or one ICMM can't write to."""

    code: Literal["data_folder"]
    message: str
    data: DataFolderData


class UnreadableProblem(StrEnum):
    """Why a saved file can't be read."""

    MISSING = "missing"
    """It's gone from the Data folder."""
    DAMAGED = "damaged"
    """It's there, but isn't what ICMM saved: changed by hand, or damaged."""
    NEWER = "newer"
    """A newer version of ICMM saved it, in a format this one can't read."""


class UnreadableData(WireModel):
    problem: UnreadableProblem
    details: str
    """What's wrong, as one line: the file and what reading it found."""


class UnreadableError(WireModel):
    """A file the runs database points at, such as a dataset's current revision, can't be read.
    Nothing is changed."""

    code: Literal["unreadable"]
    message: str
    data: UnreadableData


class InternalData(WireModel):
    log_ref: str
    """Tags the details in a log: the traceback in the agent's stderr log, or, for a desktop
    command, the app log's line."""


class InternalError(WireModel):
    """An agent bug, or a desktop command that failed for a reason the user can't fix from the
    app; the log holds the details under `log_ref`."""

    code: Literal["internal"]
    message: str
    data: InternalData


type WireError = Annotated[
    BadRequestError
    | VersionMismatchError
    | InvalidError
    | NotFoundError
    | ConflictError
    | TooLargeError
    | UnavailableError
    | RejectedError
    | NoSpaceError
    | DbCorruptError
    | DataFolderError
    | UnreadableError
    | InternalError,
    Field(discriminator="code"),
]
