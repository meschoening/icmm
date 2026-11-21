"""A dataset as it crosses the wire: the manifest's shape, without its limits (ADR-0003).

The desktop sends drafts, which may break any limit, so these types carry only the shape. The
limits live in `icmm.dataset`'s model, and reach the desktop as `validate_dataset`'s issues,
each beside its field. `tests/test_wire_dataset.py` keeps the two shapes equal.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from icmm.wire.base import WireInt, WireModel
from icmm.wire.errors import Issue, UnreadableError


class Peak(WireModel):
    kind: Literal["peak"]


class TimeToPeak(WireModel):
    kind: Literal["time_to_peak"]


class DecayTime(WireModel):
    """The time between two fractions of the peak; running upward, a rise (ADR-0010)."""

    model_config = ConfigDict(serialize_by_alias=True)

    kind: Literal["decay_time"]
    from_: float = Field(alias="from")
    """The fraction of the peak the time starts at, as the manifest's `from`."""
    to: float


type Measure = Annotated[Peak | TimeToPeak | DecayTime, Field(discriminator="kind")]


class Step(WireModel):
    voltage_mV: float | Literal["swept"]
    """`"swept"` takes each point's x."""
    duration_ms: float | Literal["swept"]
    """`"swept"` takes each point's x."""
    measure: Measure | None
    """Set on the one measured step; `null` on the others."""


class Interpolation(WireModel):
    enabled: bool
    points_per_gap: WireInt
    log_x: bool


class Source(WireModel):
    """Where the protocol's points were read from; shown, never read."""

    workbook: str
    sheet: str


class Point(WireModel):
    x: float
    """In mV or ms, by the swept quantity."""
    value: float
    """In its measure's unit (ADR-0010)."""
    sd: float | None
    validation: bool
    interpolated: bool


class Protocol(WireModel):
    name: str
    """The **Protocol name**, which also names its CSV."""
    source: Source | None
    """`null` when the points didn't come from a workbook."""
    holding_mV: float
    steps: list[Step]
    normalized: bool
    weight: float
    time_resolution_ms: float
    """Applied to the measured step, the only one recorded."""
    interpolation: Interpolation
    validation_share: float
    """How much of its points a proposal marks as validation points, from 0.05 to 0.5; the lab's
    is 0.2 (ADR-0011)."""
    points: list[Point]


class DatasetContent(WireModel):
    """What a user edits in a dataset: everything but its `format` and `id`, which the agent
    sets."""

    name: str
    protocols: list[Protocol]
    """In the order they're shown, which means nothing else."""


class Template(StrEnum):
    """The template whose structure a protocol has, or `custom` (ADR-0003)."""

    GV_ACTIVATION = "gv_activation"
    STEADY_STATE_INACTIVATION = "steady_state_inactivation"
    RECOVERY = "recovery"
    DECAY_TIME = "decay_time"
    TIME_TO_PEAK = "time_to_peak"
    CUSTOM = "custom"


class ListDatasetsParams(WireModel):
    after: str | None
    """The `next` of the page before; `null` for the first page."""


class ProtocolSummary(WireModel):
    name: str
    template: Template
    points: WireInt
    """Interpolated points included."""
    steps: WireInt | None
    """How many steps it has; `null` when the dataset is `unreadable`."""


class DatasetSummary(WireModel):
    id: str
    revision: WireInt
    """The current revision's number."""
    name: str
    protocols: list[ProtocolSummary]
    """In the order they're shown."""
    modified_at: str
    """When the current revision was saved, in UTC (ISO 8601)."""
    validation: WireInt | None
    """How many of its points are validation points (ADR-0011); `null` when `unreadable`."""
    interpolated: WireInt | None
    """How many of its points interpolation added (ADR-0011); `null` when `unreadable`."""
    unreadable: UnreadableError | None
    """Why its current revision can't be read: its files are missing, changed since they were
    saved, or in a newer format, with `read_dataset`'s problem and sentence. Its details can
    say less than `read_dataset`'s, since the list doesn't parse the files it checks. `null`
    when they're as saved."""


class DatasetList(WireModel):
    datasets: list[DatasetSummary]
    """Newest first, by when each dataset's current revision was saved."""
    next: str | None
    """Pass as `after` for the next page; `null` on the last."""


class ReadDatasetParams(WireModel):
    id: str


class SavedDataset(WireModel):
    """A dataset's current revision."""

    id: str
    revision: WireInt
    modified_at: str
    """When this revision was saved, in UTC (ISO 8601)."""
    content: DatasetContent
    """Each protocol's points in x order."""
    templates: list[Template]
    """Each protocol's template, in the order of `content.protocols`."""
    copied_from: str | None
    """The name of the dataset Duplicate copied it from, as that dataset was named then, never
    updated since; `null` for a dataset that isn't a copy."""


class ValidateDatasetParams(WireModel):
    id: str | None
    """The dataset being edited, whose own name is no clash; `null` for a new one."""
    content: DatasetContent


class DatasetIssues(WireModel):
    issues: list[Issue]
    """Every issue found, each with the path to its field under `content`; none when it can be
    saved."""
    templates: list[Template]
    """Each protocol's template as its steps are now, in the order of `content.protocols`, whether
    or not it passes its checks, so the Protocol builder can show it live."""


class SaveDatasetParams(WireModel):
    request_key: str
    id: str | None
    """The dataset to save a new revision of; `null` to make a new dataset."""
    expected_revision: WireInt | None
    """The revision the edit started from; `null` with a new dataset."""
    content: DatasetContent


class DatasetRevision(WireModel):
    id: str
    revision: WireInt


class DeleteDatasetParams(WireModel):
    request_key: str
    id: str


class DeletedDataset(WireModel):
    id: str


class DuplicateDatasetParams(WireModel):
    request_key: str
    id: str
    """The dataset to copy."""
    revision: WireInt
    """The revision to copy: the one the page shows, whatever has been saved since."""


class DuplicatedDataset(WireModel):
    id: str
    """The copy's own id."""
    revision: WireInt
    name: str
    """The free name the copy was saved under: `<name>-copy`, or `-copy-2`, `-copy-3`… when
    another dataset has it, ignoring case."""


class SaveAsNewDatasetParams(WireModel):
    request_key: str
    id: str
    """The dataset to save again: on Dataset detail, one another computer deleted."""
    revision: WireInt
    """The revision to save: the one the page shows."""


class SavedAsNewDataset(WireModel):
    id: str
    """The new dataset's own id."""
    revision: WireInt
    name: str
    """The name it was saved under: the dataset's own, or `-2`, `-3`… when another dataset has
    it, ignoring case."""


class RegenerateDatasetParams(WireModel):
    before: DatasetContent | None
    """The dataset before the edit; `null` for one just read from a workbook, whose every
    protocol is made afresh."""
    after: DatasetContent
    """Each redrawn protocol's proposal marks its own `validation_share` of its points."""


class ProposeSplitParams(WireModel):
    protocol: Protocol
    """Its proposal marks its `validation_share` of its points."""


class RevisionFilesParams(WireModel):
    id: str
    revision: WireInt
    """The revision to export: the one the page shows, which may no longer be current."""


class RevisionFile(WireModel):
    name: str
    """`dataset.json`, or a protocol's `<protocol name>.csv`."""
    text: str
    """Its bytes, which are UTF-8, as text."""


class RevisionFiles(WireModel):
    """A revision's files as they were saved, never parsed (ADR-0003): what Export writes."""

    name: str
    """The dataset's name now."""
    files: list[RevisionFile]
    """The manifest first, then each protocol's CSV."""
    files_digest: str
    """The sha256 of their names and bytes that the platform saved with them."""


class FindScoringDigestParams(WireModel):
    scoring_digest: str


class DigestMatch(WireModel):
    id: str
    name: str


class DigestMatches(WireModel):
    datasets: list[DigestMatch]
    """The platform's datasets with a revision of this scoring digest, the one whose current
    revision has it first, then newest first; at most 20."""


class ReadDatasetFileParams(WireModel):
    path: str
    """The file, as `choose_dataset_file` answers it. A leading `~/` is the home folder."""


class DatasetFileProblem(StrEnum):
    """Why Import can't take a file."""

    NOT_DATASET = "not_dataset"
    """It isn't a dataset file: a zip without a `dataset.json`, or no zip of one."""
    DAMAGED = "damaged"
    """It can't be opened: it isn't a whole zip archive, or a file in it is damaged."""
    INVALID = "invalid"
    """Its dataset fails the checks a save makes, beyond its name, which the user gives."""
    NEWER = "newer"
    """A newer ICMM saved it, in a format this one can't read."""


class DatasetFile(WireModel):
    """A dataset file that Import read on this computer, or why it can't be imported."""

    file: str
    """The file's name."""
    problem: DatasetFileProblem | None
    """Why it can't be imported; `null` when it can."""
    detail: str | None
    """With a problem, what was found, in raw words."""
    issues: list[Issue]
    """With `invalid`, each issue at its path in the dataset, in the checks' words."""
    protocol_names: list[str]
    """Each protocol's name in the file, in order, which its issues' paths count by; an
    unnamed one's is empty. None when the manifest can't be read."""
    format: WireInt | None
    """The dataset format its manifest names; `null` when it names none."""
    name: str | None
    """The dataset's name in the file; `null` when there's none a dataset can have."""
    content: DatasetContent | None
    """The dataset to save, its name the file's or empty; `null` with a problem."""
    templates: list[Template]
    """Each protocol's template, in the order of `content.protocols`."""
    scoring_digest: str | None
    """Its scoring digest, which the platform's runs rank by (ADR-0003); `null` with a
    problem."""


class WriteDatasetFileParams(WireModel):
    path: str
    """Where to save it, as `choose_export_file` answered."""
    files: list[RevisionFile]
    files_digest: str
    """`revision_files`'s digest, which the files must still match."""


class WriteProblem(StrEnum):
    NO_SPACE = "no_space"
    """The disk is full."""
    DENIED = "denied"
    """The OS didn't let ICMM write there: no permission, or a read-only disk."""
    FAILED = "failed"
    """Anything else the OS refused."""


class WrittenFile(WireModel):
    problem: WriteProblem | None
    """Why the file wasn't written; `null` when it was."""
    detail: str | None
    """With a problem, the OS's words."""
