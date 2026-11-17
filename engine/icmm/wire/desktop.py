"""Types of the desktop's own commands: implemented in Rust, never sent to the agent."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field

from icmm.wire.base import MAX_WIRE_INT, WireInt, WireModel
from icmm.wire.changes import FeedPosition
from icmm.wire.results import LeaderboardOrder


class LogLevel(StrEnum):
    ERROR = "error"
    WARN = "warn"
    INFO = "info"
    DEBUG = "debug"


class LogFrontendEventParams(WireModel):
    level: LogLevel
    message: str


class WebviewInfo(WireModel):
    version: str | None
    """WebKit, WebView2 or WebKitGTK version; `null` if the engine won't say."""
    os: str
    """`macos`, `windows` or `linux` (Rust's `std::env::consts::OS`)."""


class ConnectionStatus(StrEnum):
    NONE = "none"
    """No platform is set up."""
    NOT_CONNECTED = "not_connected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    """Was connected this session and lost it; trying again."""
    FAILED = "failed"
    """Couldn't connect, and won't try again on its own."""


class ConnectStep(StrEnum):
    """What a connect is doing."""

    SIGNING_IN = "signing_in"
    """Reaching the host over SSH and signing in."""
    ADDING_KEY = "adding_key"
    """Adding ICMM's key to a host that accepted no other, with the password the user gave;
    `signing_in` follows, with the key."""
    STARTING = "starting"
    """Checking that the platform has this app's **Engine bundle**, then starting the agent."""
    INSTALLING_ENGINE = "installing_engine"
    """Installing a missing **Engine bundle**; `starting` follows."""
    CHECKING = "checking"
    """The agent's `hello`: it finds the scheduler and checks the Data folder."""
    HANDING_OVER = "handing_over"
    """A `hello` that answered a **Hand-over** (ADR-0020) turns `checking` into this: the
    desktop asks again after `retry_after_ms`, for as long as the answer names one, then
    connects."""


class StepTime(WireModel):
    """One step of a connect, in Unix milliseconds."""

    step: ConnectStep
    started_at: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]
    ended_at: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)] | None
    """`null` while it's the step under way."""


class ConnectFailure(StrEnum):
    """What kind of failure stopped a connect."""

    SIGN_IN = "sign_in"
    """The host refused every key: set one up."""
    KEY_REFUSED = "key_refused"
    """The host no longer accepts the key ICMM made for it: add it again."""
    UNREACHABLE = "unreachable"
    """The host didn't answer, or didn't speak SSH: check how it's reached."""
    HOST_KEY_UNKNOWN = "host_key_unknown"
    HOST_KEY_CHANGED = "host_key_changed"
    HOST_KEY_REVOKED = "host_key_revoked"
    NO_SPACE = "no_space"
    """The engine doesn't fit where it goes."""
    UNSUPPORTED = "unsupported"
    """The platform can't run the engine: its system, its glibc, or no zstd."""
    DATA_FOLDER = "data_folder"
    """The agent refused the Data folder, or the engine's folder can't be made in it."""
    ENGINE = "engine"
    """The engine didn't start or answer, or speaks another protocol: the app's log says why."""
    OTHER = "other"


class ConnectFix(StrEnum):
    """A way forward a failed connect offers beside Retry now."""

    SET_UP_KEY = "set_up_key"
    """Ask for a key: add ICMM's with the password, or choose one."""
    ADD_KEY_AGAIN = "add_key_again"
    """Add ICMM's key again, with the password."""
    EDIT_PLATFORM = "edit_platform"
    USE_THIS_COMPUTER = "use_this_computer"
    """Connect to This computer instead, where the cluster can't be used."""
    REPORT = "report"
    """ICMM's own problem, for the user to report: Report a problem…"""


class Retry(WireModel):
    """The next reconnect attempt."""

    attempt: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]
    """Counted from 1 since the connection was lost."""
    at: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)] | None
    """When it starts, in Unix milliseconds; `null` while it runs."""


class Upload(WireModel):
    """The **Engine bundle**'s bytes on the platform, of its archive's."""

    sent: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]
    """Including what an earlier, cut upload left."""
    total: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]


class RecordedKey(WireModel):
    """The key known_hosts records for a host, at the line that records it."""

    algorithm: str
    """As OpenSSH names it in a fingerprint: `ED25519`, `ECDSA`, `RSA`."""
    fingerprint: str
    """`SHA256:` and the unpadded base64 of the key's SHA-256, as `ssh` shows it."""
    file: str
    """The known_hosts file, with the home folder written `~/`."""
    line: Annotated[int, Field(ge=1, le=MAX_WIRE_INT)]


class HostKey(WireModel):
    """A host's key that known_hosts doesn't vouch for."""

    host: str
    """As known_hosts names it: the host, or `[host]:port` on any port but 22."""
    algorithm: str
    fingerprint: str
    recorded: RecordedKey | None
    """The host's other key of the same algorithm on record, when the key changed; `null` when
    nothing is on record."""
    forgot: bool
    """Whether the user just forgot the host's old key, so this question is about its new
    one."""


class KeyOffer(StrEnum):
    """What a key question offers to do with ICMM's key, `~/.ssh/icmm_ed25519`: one per
    computer, added to each platform that needs it."""

    MAKE = "make"
    """This computer has no ICMM key yet: make one and add it."""
    ADD = "add"
    """ICMM's key is on this computer already: add it."""
    ADD_AGAIN = "add_again"
    """The host stopped accepting ICMM's key: add it again."""


class KeyQuestion(WireModel):
    """A sign-in no key got through, waiting for the user to add ICMM's key or choose a key."""

    host: str
    """The host that refused, as the platform names it: the login host, or a jump host before
    it."""
    user: str
    """The account there, whose password adds the key."""
    tried: list[str]
    """The keys it refused, as a sentence names them (`an ssh-agent ED25519 key`,
    `~/.ssh/id_ed25519`); empty when this computer has none."""
    offer: KeyOffer
    password: bool
    """Whether the host takes a password, so ICMM can add its key there itself."""
    public_key: str | None
    """ICMM's key's public line, for the user to add by hand where the host takes no password;
    `null` when it does."""


class ConnectionState(WireModel):
    """The desktop's link to the active platform, as the header's pill shows it."""

    status: ConnectionStatus
    platform_id: str | None
    """The Active platform's id; `null` when none is set up."""
    platform: str | None
    """The platform's name; `null` when none is set up."""
    reason: str | None
    """What happened, in plain words, naming the platform: why it failed; while reconnecting,
    how the connection ended, then what each failed try hit, the latest replacing the last.
    `null` otherwise."""
    next_step: str | None
    """While `failed`, the next step, worded so it says whose move it is: the user's, the
    cluster's admins', or ICMM's. `null` otherwise."""
    details: str | None
    """While `failed`, the raw line behind `reason`: a host and port, a path, what a command or
    the engine said. `null` when there's none, and otherwise."""
    fixes: list[ConnectFix]
    """While `failed`, the ways forward beside Retry now, in order; empty otherwise."""
    can_retry: bool
    """While `failed`, whether trying again can help, so Retry now shows; false otherwise."""
    since: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)] | None
    """When this status began, in Unix milliseconds; `null` when no platform is set up."""
    steps: list[StepTime]
    """The steps of the connect under way, in order: the one that connected while connected,
    up to the one it stopped at once failed, and while reconnecting the try's under way. Empty
    otherwise."""
    upload: Upload | None
    """While the engine uploads over SSH; `null` otherwise."""
    failure: ConnectFailure | None
    """What a failed connect needs; while reconnecting, what the try in `reason` hit (`null`
    when `reason` is the connection's end). `null` otherwise."""
    retry: Retry | None
    """While reconnecting; `null` otherwise."""
    host_key: HostKey | None
    """While `connecting`, a key the connect waits for the user to trust or not (`recorded` is
    `null`). While `failed` with `host_key_changed`, the key the host has now and the one on
    record. `null` otherwise."""
    key_question: KeyQuestion | None
    """While `connecting`, a sign-in no key got through, waiting for the user; `null`
    otherwise."""
    engine_version: str | None
    """The engine's version, from its `hello`, while `connected`; `null` otherwise."""
    heard_at: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)] | None
    """While `reconnecting`, when the desktop last heard from the agent on the connection it
    lost, in Unix milliseconds: what the pages read is as of then, which may be long before
    `since` when the computer slept. `null` otherwise."""


class HomeFolder(WireModel):
    """What This computer's paths show for `~`."""

    path: str | None
    """The home folder in full on Windows, `C:\\Users\\<name>`, where This computer's paths are
    shown in Windows' own form; `null` on macOS and Linux, which show them from `~/`."""


class TimeFormat(WireModel):
    """How this computer shows the time of day."""

    twelve_hour: bool | None
    """Whether its settings set a 12-hour clock (true) or a 24-hour one (false); `null` when
    they leave it to the language and region."""


class TrustHostKeyParams(WireModel):
    fingerprint: str
    """The key the user was shown; a connect waiting on any other is left waiting."""


class ForgetHostKeyParams(WireModel):
    fingerprint: str
    """The recorded key the user was shown."""


class AddSshKeyParams(WireModel):
    password: str
    """The account's password on the host that asked: used once to add ICMM's key there, then
    dropped."""


class UseSshKeyParams(WireModel):
    identity_file: str
    """The key file to sign in to the host that asked with, written as chosen
    (`~/.ssh/id_ed25519`)."""


class JumpHost(WireModel):
    """A host a connect goes through first, as `ProxyJump` in `~/.ssh/config` names it."""

    host: str
    port: Annotated[int, Field(ge=1, le=65535)]
    user: str
    identity_file: str | None
    """As for the platform's own key."""


class SshPlatform(WireModel):
    """A saved platform reached over SSH: its Connection details, kept on this computer."""

    type: Literal["ssh"]
    id: str
    name: str
    host: str
    """The login host, as the user wrote it."""
    port: Annotated[int, Field(ge=1, le=65535)]
    user: str
    identity_file: str | None
    """The SSH key tried after the ssh-agent's, written as chosen (`~/.ssh/id_ed25519`); `null`
    tries `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`."""
    data_folder: str
    """On the host; a leading `~/` is the remote home."""
    jump: list[JumpHost]
    """The hosts a connect goes through first, in order, resolved from `~/.ssh/config` when the
    platform was filled in from it; empty to connect straight to the login host."""


class LocalPlatform(WireModel):
    """This computer: built in, exactly one, never removed. Only its Data folder can change."""

    type: Literal["local"]
    id: str
    name: str
    data_folder: str


type SavedPlatform = Annotated[SshPlatform | LocalPlatform, Field(discriminator="type")]


class PlatformsProblem(WireModel):
    """Why the saved platforms couldn't be read, as a note says it (#117): what happened, then
    the raw line."""

    reason: str
    """What happened, in a sentence: "ICMM couldn’t read the platforms you saved on this
    computer."."""
    details: str
    """The file and what went wrong with it, for the raw line."""
    moves_aside: bool
    """Whether the first save moves the file that couldn't be read aside and starts a new list."""


class SavedPlatforms(WireModel):
    platforms: list[SavedPlatform]
    """Newest first, then This computer."""
    active: str | None
    """The Active platform's id, connected or not; `null` until the first connect."""
    launch: str | None
    """The platform ICMM connects to when it opens, kept on this computer; `null` for Don't
    connect, and until the first connect, which sets it."""
    launch_set: bool
    """Whether a launch choice has been saved; false until a choice or the first connect."""
    problem: PlatformsProblem | None
    """Why the saved platforms couldn't be read. While it's set, only This computer is listed."""


class SshForm(WireModel):
    """An SSH platform's Connection details as the form holds them: checked by the desktop."""

    type: Literal["ssh"]
    name: str
    host: str
    port: str
    """As typed; a number from 1 to 65535."""
    user: str
    identity_file: str | None
    data_folder: str
    jump: list[JumpHost]


class LocalForm(WireModel):
    type: Literal["local"]
    data_folder: str


type PlatformForm = Annotated[SshForm | LocalForm, Field(discriminator="type")]


class AddPlatformParams(WireModel):
    form: PlatformForm
    """Always an `ssh` form: This computer is built in."""


class EditPlatformParams(WireModel):
    id: str
    form: PlatformForm
    """The platform's own type: an SSH platform takes an `ssh` form, This computer a `local` one."""


class PlatformRef(WireModel):
    id: str


class LaunchPlatformParams(WireModel):
    id: str | None
    """The platform to connect to when ICMM opens; `null` for Don't connect."""


class Theme(StrEnum):
    SYSTEM = "system"
    """Follows the OS's light or dark setting."""
    LIGHT = "light"
    DARK = "dark"


class Preferences(WireModel):
    """This computer's choices for the app, kept in its config folder."""

    theme: Theme
    notifications: bool
    """Whether a run that completes or fails shows a notification from the computer."""
    mark_still_improving: bool
    """Whether Run detail and Topology mark the finished starts **Still improving** at their
    end (#234): Mark still-improving starts, off by default."""
    leaderboard: LeaderboardSort
    """How Results sorts its leaderboard, kept from the last sort (#345): by the Val rank, `rank`
    ascending, at first."""
    drift_dismissed: list[DriftDismissal]
    """The starts whose Drift notice was dismissed on their page (#365), the latest last: each
    stays dismissed until a different engine draws it. None at first."""


class DriftDismissal(WireModel):
    """A start's Drift notice, dismissed: the start, and the engine that drew it then."""

    platform_id: str
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    engine: str | None
    """The key of the engine that drew it, as its drift's `drawn_engine` named it."""


class LeaderboardSort(WireModel):
    """A sort of Results' leaderboard: any column, either way (#339)."""

    order: LeaderboardOrder
    descending: bool


class RunMarksParams(WireModel):
    platform_id: str


class RunMarks(WireModel):
    """What this computer remembers of a platform's runs, beside its preferences (#236)."""

    first_run: bool
    """Whether the platform has had a run: First launch gives way to Home, and Results shows
    them, whether or not it's connected."""
    ended_seen: FeedPosition | None
    """The last change of its runs database whose ended runs have notified; `null` before its
    first connect."""


class MarkRunsParams(WireModel):
    platform_id: str
    first_run: bool
    """Records that the platform has had a run; `false` leaves it as it is."""
    ended_seen: FeedPosition | None
    """Records the change ended runs have notified up to; `null` leaves it as it is."""


class OpenedRun(WireModel):
    """A run's page, `/runs/214`."""

    kind: Literal["run"]
    run: WireInt
    name: str
    """Its config's name when it was opened: what ⌘K shows while it can't read the run."""


class OpenedTopology(WireModel):
    """A topology's page, `/runs/214/T12.3`."""

    kind: Literal["topology"]
    run: WireInt
    graph: WireInt
    open_state: WireInt
    name: str
    """Its run's config's name when it was opened."""


class OpenedStart(WireModel):
    """A start's page, `/runs/214/T12.3/37`."""

    kind: Literal["start"]
    run: WireInt
    graph: WireInt
    open_state: WireInt
    start: WireInt
    name: str
    """Its run's config's name when it was opened."""


class OpenedDataset(WireModel):
    """A dataset's page, Dataset detail."""

    kind: Literal["dataset"]
    id: str
    name: str
    """Its name when it was opened."""


class OpenedConfig(WireModel):
    """A config in the Config builder."""

    kind: Literal["config"]
    id: str
    name: str
    """Its name when it was opened."""


type OpenedPage = Annotated[
    OpenedRun | OpenedTopology | OpenedStart | OpenedDataset | OpenedConfig,
    Field(discriminator="kind"),
]


class RecentlyOpenedParams(WireModel):
    platform_id: str


class RecentlyOpened(WireModel):
    """The pages last opened on a platform, for ⌘K's Recently opened (#411)."""

    pages: list[OpenedPage]
    """Newest first, at most 5, each once."""


class RecordOpenedParams(WireModel):
    platform_id: str
    page: OpenedPage
    """Goes first; an earlier opening of the same page, under any name, goes."""


class NotificationParams(WireModel):
    title: str
    body: str


class ResetParams(WireModel):
    delete_icmm_key: bool
    """Whether Reset also deletes ICMM's key, `~/.ssh/icmm_ed25519`, and its `.pub`, after the
    logs: for handing the computer to someone else. The user's own keys stay either way."""


class LogsFolder(WireModel):
    path: str
    """The folder of the app's logs, as Settings shows it: from `~/` on macOS and Linux, and in
    full on Windows."""


class ReportPreview(WireModel):
    """What a report holds, as Report a problem…'s panel lists it before it's saved (#126)."""

    versions: str
    """ICMM's version, the engine's and the OS's with its architecture: `ICMM 0.1.0 · engine
    0.1.0 · macOS 15.1 on arm64`. The engine's is left out while no engine has answered."""
    platform: str
    """The Active platform's kind: `SSH to a SLURM cluster` or `This computer`, or `No platform`
    before one is set up."""
    log_lines: Annotated[int, Field(ge=0, le=MAX_WIRE_INT)]
    """The lines of the newest app and agent logs, which the report holds."""


class ReportFailure(WireModel):
    """The failure a report is about, as the page shows it."""

    what: str
    """What happened."""
    next: str | None
    """The next step, when the page shows one."""
    raw: str | None
    """The raw line, when the page shows one."""


class ReportPage(WireModel):
    """The page a report is from (#470): a start, a topology, a run, or another page by its
    name."""

    kind: Literal["start", "topology", "run", "page"]
    name: str
    """`start 23 of #214/T12.3`, `#214/T12.3`, `#214 herg-wt-11state`, or another page's name:
    `Datasets`."""
    job_log: str | None
    """A start's: the end of its latest try's job log, as the log view reads it; `null` for any
    other page."""
    run: str | None
    """A start's, a topology's or a run's: its run as it was submitted, as JSON: its config's
    settings, search seed and engine; `null` for another page."""


class SaveReportParams(WireModel):
    stamp: str
    """When, on this computer's clock, written `2026-11-12-0914`: the file's name ends with it."""
    failure: ReportFailure | None
    """`null` for a report about no one failure: from Settings' Diagnostic logs, or from a
    page's ··· or ⌘K."""
    page: ReportPage | None
    """The page it's from: a failed start's, or the one Report a problem… opened on from its ···
    or ⌘K; `null` for a failure elsewhere and for Settings' Diagnostic logs."""


class SavedReport(WireModel):
    path: str
    """The report, in the Downloads folder, with the home folder written `~/`; `reveal_file`
    shows it."""
    file: str
    """Its name: `icmm-report-2026-11-12-0914.txt`."""


class GuardQuitParams(WireModel):
    guarded: bool
    """Whether the page has a form with unsaved changes, so closing the window or quitting asks
    first."""


class SshKeys(WireModel):
    keys: list[str]
    """The private keys in `~/.ssh`, each written `~/.ssh/<name>`, by name."""


class SshConfigHosts(WireModel):
    hosts: list[str]
    """The names `Host` lines give in `~/.ssh/config` and the files it includes, in file order and
    each once, leaving out patterns (`*`, `?`, `!`)."""


class SshConfigHostParams(WireModel):
    alias: str


class SshConfigHost(WireModel):
    """A `~/.ssh/config` host as `ssh` would reach it, read once: the platform keeps these values,
    not the alias."""

    host: str
    """Its `HostName`."""
    port: Annotated[int, Field(ge=1, le=65535)]
    user: str
    identity_file: str | None
    """Its first `IdentityFile`, written as `~/.ssh/<name>`; `null` when it names none."""
    jump: list[JumpHost]
    """Its `ProxyJump` hosts, each read the same way."""


class ChooseParams(WireModel):
    title: str
    folder: str | None
    """Where the dialog opens; `null` for the OS's choice. A leading `~/` is the home folder."""


class ExportFormat(StrEnum):
    """A kind of file Export saves, which the save dialog offers by its extension."""

    ZIP = "zip"
    """A **Dataset file**."""
    JSON = "json"
    CSV = "csv"


class ExportFileParams(WireModel):
    title: str
    name: str
    """The file's name the dialog proposes, ending in its first format's extension."""
    folder: str | None
    """Where the dialog opens; `null` for the OS's choice. A leading `~/` is the home folder."""
    formats: Annotated[list[ExportFormat], Field(min_length=1)]
    """The kinds of file it may be saved as, the one proposed first: a start's parameters are
    JSON or CSV, as the name chosen ends."""


class ExportFolderParams(WireModel):
    title: str
    name: str
    """The folder's name the dialog proposes."""
    folder: str | None
    """Where the dialog opens; `null` for the OS's choice. A leading `~/` is the home folder."""


class Figure(WireModel):
    """One figure Export writes: a chart drawn as SVG."""

    name: str
    """Its file's name in the folder, ending `.svg`."""
    svg: str


class WriteFiguresParams(WireModel):
    folder: str
    """Where to write them, as `choose_export_folder` answered; it's made if it isn't there. A
    leading `~/` is the home folder."""
    figures: list[Figure]


class WriteExportFileParams(WireModel):
    path: str
    """Where to write it, as `choose_export_file` answered. A leading `~/` is the home folder."""
    text: str
    """The whole file, as the desktop wrote it: the leaderboard's CSV, or a run's config."""


class RevealParams(WireModel):
    path: str
    """A file `choose_export_file` answered, a folder `choose_export_folder` did, or a report
    `save_report` saved. A leading `~/` is the home folder."""


class RevealLogParams(WireModel):
    path: str
    """A run's log on This computer, as a log read named it. A leading `~/` is the home
    folder."""


class Chosen(WireModel):
    path: str | None
    """What the user chose, with the home folder written `~/`; `null` when they canceled."""


class ReadWorkbookParams(WireModel):
    path: str
    """The workbook's file, as `choose_file` answers it or dropped on the window. A leading `~/`
    is the home folder."""


class WorkbookProblem(StrEnum):
    """Why the Dataset wizard can't read a file."""

    NOT_XLSX = "not_xlsx"
    """It isn't an `.xlsx` workbook: another Excel format, another kind of file, or a folder."""
    UNREADABLE = "unreadable"
    """An `.xlsx` that can't be opened: damaged, or gone."""
    PASSWORD = "password"
    """An `.xlsx` protected by a password, which Excel keeps in an encrypted OLE container, not
    a zip."""
    TOO_LARGE = "too_large"
    """More than 50 MB (50,000,000 bytes)."""


class WorkbookSheet(WireModel):
    """One worksheet's cells, row by row from its first used row and column."""

    name: str
    numbers: list[list[float | None]]
    """Each number cell's value; `null` for any other cell."""
    texts: list[list[str | None]]
    """The same cells' words: a text cell's text, and a TRUE or FALSE, a date or an error as the
    file holds it; `null` for a number or an empty cell."""
    rows: WireInt
    """How many rows it uses. `numbers` and `texts` hold the first 1,100 and 64 columns, more than
    a protocol's 1,000 points take."""
    columns: WireInt
    """How many columns it uses."""


class Workbook(WireModel):
    """A workbook the Dataset wizard read on this computer (old ADR-0006), or why it couldn't."""

    name: str
    """The file's name."""
    bytes: WireInt | None
    """Its size; `null` when there's no file to measure."""
    problem: WorkbookProblem | None
    """Why it can't be read; `null` when it was."""
    detail: str | None
    """With a problem, what was found: the file's kind, or the reader's own words."""
    sheets: list[WorkbookSheet]
    """Its worksheets in tab order; none with a problem."""
