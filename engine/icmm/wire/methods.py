"""The registry: every method, once. The generators read it to write the Rust and TS sides.

A method is an agent RPC (a read or a write) or a desktop command, which Rust implements itself.
An RPC the UI calls becomes a Tauri command of the same name; `hello` doesn't, because the
desktop's Rust sends it while connecting.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from icmm.wire.base import WireModel
from icmm.wire.changes import Changes, SubscribeChangesParams, Subscription
from icmm.wire.config import (
    ConfigCheck,
    ConfigCount,
    ConfigList,
    ConfigRevision,
    CountConfigsParams,
    DeleteConfigParams,
    DeletedConfig,
    DuplicateConfigParams,
    DuplicatedConfig,
    ListConfigsParams,
    ReadConfigParams,
    SaveConfigParams,
    SavedConfig,
    ValidateConfigParams,
)
from icmm.wire.dataset import (
    DatasetContent,
    DatasetFile,
    DatasetIssues,
    DatasetList,
    DatasetRevision,
    DeleteDatasetParams,
    DeletedDataset,
    DigestMatches,
    DuplicateDatasetParams,
    DuplicatedDataset,
    FindScoringDigestParams,
    ListDatasetsParams,
    ProposeSplitParams,
    Protocol,
    ReadDatasetFileParams,
    ReadDatasetParams,
    RegenerateDatasetParams,
    RevisionFiles,
    RevisionFilesParams,
    SaveAsNewDatasetParams,
    SavedAsNewDataset,
    SaveDatasetParams,
    SavedDataset,
    ValidateDatasetParams,
    WriteDatasetFileParams,
    WrittenFile,
)
from icmm.wire.desktop import (
    AddPlatformParams,
    AddSshKeyParams,
    ChooseParams,
    Chosen,
    ConnectionState,
    EditPlatformParams,
    ExportFileParams,
    ExportFolderParams,
    ForgetHostKeyParams,
    GuardQuitParams,
    HomeFolder,
    LaunchPlatformParams,
    LogFrontendEventParams,
    LogsFolder,
    MarkRunsParams,
    NotificationParams,
    PlatformRef,
    Preferences,
    ReadWorkbookParams,
    RecentlyOpened,
    RecentlyOpenedParams,
    RecordOpenedParams,
    ReportPreview,
    ResetParams,
    RevealLogParams,
    RevealParams,
    RunMarks,
    RunMarksParams,
    SavedPlatforms,
    SavedReport,
    SaveReportParams,
    SshConfigHost,
    SshConfigHostParams,
    SshConfigHosts,
    SshKeys,
    TimeFormat,
    TrustHostKeyParams,
    UseSshKeyParams,
    WebviewInfo,
    Workbook,
    WriteExportFileParams,
    WriteFiguresParams,
)
from icmm.wire.errors import ErrorCode
from icmm.wire.export import WriteFitParams, WriteParametersParams, WrittenFit
from icmm.wire.handshake import HelloParams, HelloResult
from icmm.wire.parameters import (
    CanonicalParameters,
    CanonicalParametersParams,
    EdgeRates,
    EdgeRatesParams,
)
from icmm.wire.platform import (
    CheckFoldersParams,
    FolderChecks,
    PlatformSettingsResult,
    Revision,
    SavePlatformSettingsParams,
    SchedulerLookup,
)
from icmm.wire.results import (
    GroupRank,
    Leaderboard,
    ListLeaderboardParams,
    ListRankingGroupsParams,
    RankingGroups,
    ReadGroupRankParams,
)
from icmm.wire.run import (
    AcceptedRun,
    CancelingRun,
    CancelRunParams,
    DeletedRun,
    DeleteRunParams,
    EndedRuns,
    EndedRunsParams,
    EvaluationTime,
    ListRunsParams,
    ListTopologiesParams,
    ReadRunParams,
    ReadTopologyParams,
    ResumedRun,
    ResumeRunParams,
    Run,
    RunList,
    RunsOverview,
    RunStretches,
    RunStretchesParams,
    RunTimings,
    SubmitRunParams,
    TimeEvaluationsParams,
    Topology,
    TopologyList,
    UserJobs,
)
from icmm.wire.simulation import (
    ReadDatasetRevisionParams,
    ReadStartFitParams,
    SimulateStartParams,
    StartFit,
    StartSimulation,
)
from icmm.wire.start import (
    CoordinatingJobs,
    JobLogPage,
    ListCoordinatingJobsParams,
    ListStartsParams,
    ReadCoordinatingJobLogParams,
    ReadJobLogParams,
    ReadStartLogParams,
    ReadStartParams,
    Start,
    StartList,
    StartLogPage,
    StartWatch,
    StartWatchEvent,
    TopologyProgress,
    TopologyProgressParams,
    WatchStartParams,
)
from icmm.wire.topology import (
    MatchTopologyParams,
    ReadStateGraphsParams,
    StateGraphs,
    TopologyMatch,
)

type Kind = Literal["read", "write", "desktop"]

READ_TIMEOUT_MS = 30_000
WRITE_TIMEOUT_MS = 30_000
PING_TIMEOUT_MS = 10_000
"""How long the desktop waits for a `ping` before it replaces the agent as hung (ADR-0009)."""
LOG_ERRORS = (
    "not_found",
    "bad_request",
    "data_folder",
    "unavailable",
    "no_space",
    "db_corrupt",
    "internal",
)
"""What a read of a page of a log may answer."""


@dataclass(frozen=True)
class Method:
    name: str
    kind: Kind
    params: type[WireModel] | None
    result: type[WireModel] | None
    errors: tuple[ErrorCode, ...]
    timeout_ms: int | None
    """How long the desktop waits for the reply; `None` for desktop commands."""
    command: bool
    """Whether the UI calls it, as a Tauri command named like the method."""
    doc: str
    is_async: bool = True
    """Whether its Tauri command is async. Agent commands always are; a desktop command is when
    its body awaits, or takes long enough that it mustn't block the main thread."""
    event: type[WireModel] | None = None
    """For a subscription, the type of each event it pushes, as `{subscription, event}`."""


def read(
    name: str,
    params: type[WireModel] | None,
    result: type[WireModel] | None,
    *,
    errors: tuple[ErrorCode, ...],
    doc: str,
    timeout_ms: int = READ_TIMEOUT_MS,
    command: bool = True,
    event: type[WireModel] | None = None,
) -> Method:
    return Method(name, "read", params, result, errors, timeout_ms, command, doc, event=event)


def write(
    name: str,
    params: type[WireModel],
    result: type[WireModel],
    *,
    errors: tuple[ErrorCode, ...],
    doc: str,
    timeout_ms: int = WRITE_TIMEOUT_MS,
) -> Method:
    """A write's params carry a `request_key`, made once per user action and reused on retry."""
    return Method(name, "write", params, result, errors, timeout_ms, True, doc)


def desktop(
    name: str,
    params: type[WireModel] | None,
    result: type[WireModel] | None,
    *,
    doc: str,
    errors: tuple[ErrorCode, ...] = (),
    is_async: bool = False,
) -> Method:
    """A command Rust implements itself. With `errors`, it answers a `WireError` on failure."""
    return Method(name, "desktop", params, result, errors, None, True, doc, is_async)


METHODS: tuple[Method, ...] = (
    read(
        "hello",
        HelloParams,
        HelloResult,
        errors=(
            "bad_request",
            "version_mismatch",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        timeout_ms=20_000,
        command=False,
        doc="The handshake: the agent's protocol, engine, platform and host facts; `data_folder` "
        "when the Data folder can't hold the runs database here.",
    ),
    read(
        "ping",
        None,
        None,
        errors=(),
        timeout_ms=PING_TIMEOUT_MS,
        command=False,
        doc="Liveness: answered at once, before or after hello, however busy the agent is.",
    ),
    read(
        "subscribe_changes",
        SubscribeChangesParams,
        Subscription,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        command=False,
        event=Changes,
        doc="Pushes each change to the runs database after `after` as a `Changes` event, for "
        "the rest of the session; the desktop holds one, as it holds `hello`.",
    ),
    read(
        "scheduler_lookup",
        None,
        SchedulerLookup,
        errors=("internal",),
        doc="The platform's scheduler, the user's SLURM accounts and partitions with their "
        "limits, and the Platform settings that Platform setup proposes.",
    ),
    read(
        "check_folders",
        CheckFoldersParams,
        FolderChecks,
        errors=("internal",),
        doc="Each folder's free space, and why this platform can't use it, if it can't.",
    ),
    read(
        "platform_settings",
        None,
        PlatformSettingsResult,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="The Data folder's Platform settings with their revision; `null` before Platform "
        "setup.",
    ),
    write(
        "save_platform_settings",
        SavePlatformSettingsParams,
        Revision,
        errors=(
            "invalid",
            "data_folder",
            "conflict",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves the Platform settings over `expected_revision` and answers the new revision; "
        "a stale revision gets `conflict`.",
    ),
    read(
        "list_datasets",
        ListDatasetsParams,
        DatasetList,
        errors=("bad_request", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="The platform's datasets, the one saved last first, each with its protocols, their "
        "templates and point counts, as the current revision has them; a page at a time. Each "
        "current revision's files are checked against what was saved, so a dataset that can't be "
        "read says why. A `next` it didn't give is `bad_request`.",
    ),
    read(
        "read_dataset",
        ReadDatasetParams,
        SavedDataset,
        errors=(
            "not_found",
            "unreadable",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A dataset's current revision; `not_found` for one deleted or never saved, and "
        "`unreadable` when its files are missing, damaged or in a newer format.",
    ),
    read(
        "validate_dataset",
        ValidateDatasetParams,
        DatasetIssues,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="Every issue that would stop a save, each with its path and a sentence; a name another "
        "dataset has, ignoring case, is one.",
    ),
    write(
        "save_dataset",
        SaveDatasetParams,
        DatasetRevision,
        errors=(
            "invalid",
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves a new dataset, or a new revision of one over `expected_revision`, and answers "
        "its id and revision. Its checks are `validate_dataset`'s, as `invalid`; a stale revision "
        "gets `conflict`.",
    ),
    write(
        "duplicate_dataset",
        DuplicateDatasetParams,
        DuplicatedDataset,
        errors=(
            "not_found",
            "unreadable",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves a copy of a dataset's `revision` as a new dataset, with its own id, under a "
        "free name, and answers its id, revision and name. `not_found` for a dataset deleted or "
        "never saved, or a revision it hasn't; `unreadable` when that revision's files are "
        "missing, damaged or in a newer format.",
    ),
    write(
        "save_as_new_dataset",
        SaveAsNewDatasetParams,
        SavedAsNewDataset,
        errors=(
            "not_found",
            "unreadable",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves a dataset's `revision` again as a new dataset, with its own id and no runs, "
        "under the dataset's name, or `-2`, `-3`… when another dataset has it: how Dataset "
        "detail keeps a dataset another computer deleted, whose revisions stay. `not_found` for "
        "a dataset never saved, or a revision it hasn't; `unreadable` when that revision's files "
        "are missing, damaged or in a newer format.",
    ),
    write(
        "delete_dataset",
        DeleteDatasetParams,
        DeletedDataset,
        errors=(
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Deletes a dataset: it leaves every list at once and its name is free again, while "
        "every revision stays for the runs fit to it. `not_found` for a dataset already deleted "
        "or never saved.",
    ),
    read(
        "revision_files",
        RevisionFilesParams,
        RevisionFiles,
        errors=(
            "not_found",
            "unreadable",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A revision's files byte for byte, as they were saved and in whatever format, for "
        "Export; checked against their saved digest and never parsed. A deleted dataset's "
        "revisions stay, so they export too. `not_found` for a dataset never saved, or a revision "
        "it hasn't, and `unreadable` when its files are missing, damaged or in a newer format.",
    ),
    read(
        "find_scoring_digest",
        FindScoringDigestParams,
        DigestMatches,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="The platform's datasets with a stored revision of this scoring digest, which "
        "Import's file would rank with: one indexed query (ADR-0003).",
    ),
    read(
        "validate_config",
        ValidateConfigParams,
        ConfigCheck,
        errors=("internal",),
        doc="Every issue with a config, each with its path, a sentence and whether it stops a "
        "save; the config as a save would keep it, its Specific IDs normalized as the notes say; "
        "and its counts from this engine's topology lists. Parsing, a few seeks, and one query "
        "for its dataset's number of protocols, which sizes its Start logs (ADR-0013).",
    ),
    read(
        "read_state_graphs",
        ReadStateGraphsParams,
        StateGraphs,
        errors=("not_found", "internal"),
        doc="Each state graph's edges and open states from this engine's topology lists, for the "
        "drawings of the topologies Specific IDs names: a seek per graph in each of two files "
        "(ADR-0013). A number of states without a list, or a graph past it, is `not_found`.",
    ),
    read(
        "list_configs",
        ListConfigsParams,
        ConfigList,
        errors=(
            "bad_request",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="The platform's configs, newest modified first, a page at a time in the order the "
        "first page found, each with what its row on Configs shows: its dataset's name, its "
        "number of states, the topologies and starts its save counted, and its newest run. One "
        "bounded query (ADR-0016); a config a newer ICMM saved says so. A `next` it didn't give is "
        "`bad_request`; one with more configs saved since its first page than a page holds is "
        "`conflict` (`stale_cursor`): list them again from the first page.",
    ),
    read(
        "read_config",
        ReadConfigParams,
        SavedConfig,
        errors=(
            "not_found",
            "unreadable",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A config as it was last saved, with its dataset as it is now: deleted, or a current "
        "revision that can't be read, blocks Submit run. `not_found` for one deleted or never "
        "saved, and `unreadable` for one a newer ICMM saved.",
    ),
    write(
        "save_config",
        SaveConfigParams,
        ConfigRevision,
        errors=(
            "invalid",
            "not_found",
            "conflict",
            "unreadable",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves a new config, or a new revision of one over `expected_revision`, and answers "
        "its id and revision once its projection is on disk (ADR-0016). Its checks are "
        "`validate_config`'s, and its dataset must be on the platform, as `invalid`; a stale "
        "revision or a name another config has, ignoring case, gets `conflict`.",
    ),
    write(
        "duplicate_config",
        DuplicateConfigParams,
        DuplicatedConfig,
        errors=(
            "not_found",
            "unreadable",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Saves a copy of a config as a new one, with its own id, under a free name, and "
        "answers its id, revision and name. `not_found` for a config deleted or never saved; "
        "`unreadable` for one a newer ICMM saved.",
    ),
    write(
        "delete_config",
        DeleteConfigParams,
        DeletedConfig,
        errors=(
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Deletes a config: it leaves every list at once and its name is free again, while "
        "the runs submitted from it keep what they were submitted with. `not_found` for a config "
        "already deleted or never saved.",
    ),
    read(
        "count_configs",
        CountConfigsParams,
        ConfigCount,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="How many configs name a dataset, for Delete's confirm on Dataset detail: one "
        "indexed count.",
    ),
    write(
        "submit_run",
        SubmitRunParams,
        AcceptedRun,
        errors=(
            "invalid",
            "not_found",
            "unreadable",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Records a run of a config as it was last saved, Queued, and answers its number once "
        "it's recorded, before its first coordinator goes out (ADR-0009). The run pins the "
        "config's settings, the dataset's current revision, the Search seed (the config's, or "
        "drawn now), the Output folder in full and this engine's key (ADR-0016, ADR-0020). "
        "`validate_config`'s errors, a dataset deleted, and more starts than a run holds are "
        "`invalid`; a config deleted or never saved is `not_found`, and one a newer ICMM saved, "
        "or a dataset revision that can't be read, is `unreadable`.",
    ),
    write(
        "cancel_run",
        CancelRunParams,
        CancelingRun,
        errors=(
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Cancels a queued, held or running run: recorded, and answered once it is, while the "
        "run shows Canceling (ADR-0009). Its coordinator, or `icmm cleanup` where none carries "
        "it, cancels its jobs, keeps its running starts' best so far, and ends it canceled; its "
        "finished starts are kept, and Resume fits the rest. `not_found` for a run deleted or "
        "never submitted; `conflict` for one that has ended.",
    ),
    write(
        "delete_run",
        DeleteRunParams,
        DeletedRun,
        errors=(
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Deletes a run that has ended: its tombstone is recorded first, so it leaves every "
        "list at once, then `icmm cleanup` cancels any job of it left, removes its folder in the "
        "Output folder and its rows (ADR-0009, ADR-0020). `not_found` for a run already deleted "
        "or never submitted; `conflict` for one in flight.",
    ),
    write(
        "resume_run",
        ResumeRunParams,
        ResumedRun,
        errors=(
            "not_found",
            "conflict",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="Resumes a failed or canceled run as the same run: recorded, and answered once it "
        "is, the run Queued again with its failed and canceled starts waiting, and its next "
        "coordinator going out after (ADR-0009, ADR-0019). It fits only the starts it hasn't "
        "finished, each as its next try, on the run's own engine, or this one where that's no "
        "longer installed, under the Job defaults as they are now (ADR-0020). `not_found` for a "
        "run deleted or never submitted; `conflict` for one in flight or completed.",
    ),
    read(
        "list_runs",
        ListRunsParams,
        RunList,
        errors=(
            "bad_request",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="The platform's runs, a page at a time: in flight, newest first, then those that "
        "ended, the latest end first, each with what its row on Runs shows. One query, which "
        "walks an index from the cursor; a filter reads the platform's runs and their configs' "
        "and datasets' names, no file (ADR-0013). A `next` it didn't give is `bad_request`.",
    ),
    read(
        "runs_overview",
        None,
        RunsOverview,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="What Runs says of all the platform's runs, whatever page they're on: how many are "
        "in each state, and each dataset's runs and best run on its current data. One grouped "
        "query over the runs, no file (ADR-0013).",
    ),
    read(
        "ended_runs",
        EndedRunsParams,
        EndedRuns,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="The runs that ended since a feed position, the latest first, for the run-ended "
        "notifications: while connected after a `runs` change, and on reconnect for those that "
        "ended while away. Each run keeps its end's seq, so it's one indexed range, which a "
        "pruned feed doesn't shorten (ADR-0009, ADR-0013).",
    ),
    read(
        "run_timings",
        None,
        RunTimings,
        errors=("data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="The platform's finished starts' elapsed time and evaluations, summed by number of "
        "states and CPUs per start, for Submit's time estimate; the desktop does the arithmetic. "
        "Each run's coordinator keeps its sums as it collects its starts, so it's one query over a "
        "few rows per run (ADR-0013).",
    ),
    read(
        "user_jobs",
        None,
        UserJobs,
        errors=("unavailable", "internal"),
        doc="How many jobs the user has on the cluster, running and waiting, for Submit's held "
        "forecast: one `squeue` (ADR-0013). `null` without SLURM; a scheduler that doesn't "
        "answer is `unavailable`, to ask again.",
    ),
    read(
        "read_run",
        ReadRunParams,
        Run,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A run: what it fits, as pinned at submit, how far it has gone, and when each stage "
        "began. One query (ADR-0013). `not_found` for a run deleted or never submitted.",
    ),
    read(
        "run_stretches",
        RunStretchesParams,
        RunStretches,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A run's Stretches, for Run detail's progress chart past 2,000 topologies: how many "
        "topologies completed in each stretch of its time, beside its best at the stretch's end. "
        "Its coordinator keeps them as it collects, at most 500, so it's one query that reads no "
        "topology (ADR-0013). `not_found` for a run deleted or never submitted.",
    ),
    read(
        "read_start_fit",
        ReadStartFitParams,
        StartFit,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="What simulating a start needs: its raw best Parameters, its topology, its run's "
        "Dataset revision, and how its worker scored them, on which engine. One indexed query; "
        "the agent computes nothing, and the desktop simulates (ADR-0013). `not_found` for a run "
        "deleted or never submitted, or a start with no stored best yet.",
    ),
    read(
        "read_dataset_revision",
        ReadDatasetRevisionParams,
        SavedDataset,
        errors=(
            "not_found",
            "unreadable",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="One revision of a dataset, as `read_dataset` reads the current one: what a run fits. "
        "A revision never changes, so the desktop keeps it by its id; a deleted dataset's "
        "revisions stay for its runs. `not_found` for a dataset never saved, or a revision it "
        "hasn't; `unreadable` when its files are missing, damaged or in a newer format.",
    ),
    read(
        "list_topologies",
        ListTopologiesParams,
        TopologyList,
        errors=(
            "bad_request",
            "not_found",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A run's topologies, a page at a time, ranked by their Best start's Val RMSE (Train "
        "RMSE without validation points), or in the order they go out, for Run detail's table, "
        "grid and pace, or only those in one state in that order, for Run detail past 2,000 "
        "topologies; each with its state, start counts, best, near best, spread and times. "
        "One query, which walks an index from the cursor (ADR-0013). `not_found` for a run "
        "deleted or never submitted; a `next` it didn't give, one of the other order, or a "
        "state by rank is `bad_request`.",
    ),
    read(
        "read_topology",
        ReadTopologyParams,
        Topology,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A topology of a run, for its page: its row, its rank, its starts counted by state, "
        "its arrays, each parameter's spread and its Top 10 with their raw vectors. One query "
        "(ADR-0013). `not_found` for a run gone, or a topology it hasn't listed.",
    ),
    read(
        "list_ranking_groups",
        ListRankingGroupsParams,
        RankingGroups,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A dataset's Ranking groups, for Results' Data menu: its current data, even with no "
        "run, then each earlier data with runs, each named by when it was current and with its "
        "runs. A deleted dataset's are earlier data. Two indexed queries over its revisions and "
        "runs (ADR-0013). `not_found` for a dataset this platform never had.",
    ),
    read(
        "list_leaderboard",
        ListLeaderboardParams,
        Leaderboard,
        errors=("bad_request", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A Ranking group's leaderboard, for Results: its runs' topologies with a finished "
        "start, 100 a page in any order, each with its Val rank in the group, its run's name and "
        "state and its Best start (so far, while fitting), filtered by run, number of states, "
        "Max RMSE, Min near best and still fitting, with how many the filters keep and the group "
        "ranks. A page merges its runs' walks along their indexes, then counts its rows' ranks "
        "(ADR-0013). A `next` it didn't give, or one of another order, is `bad_request`.",
    ),
    read(
        "read_group_rank",
        ReadGroupRankParams,
        GroupRank,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A topology's rank N of M in its run's Ranking group, for its Best start's page, and "
        "whether the group is its dataset's current data. M from each run's count; N counts the "
        "group's topologies before it along an index (ADR-0013). `not_found` for a run gone, or "
        "a topology it hasn't listed.",
    ),
    read(
        "list_starts",
        ListStartsParams,
        StartList,
        errors=(
            "bad_request",
            "not_found",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A topology's starts by index, a page at a time, each with its state, try, cause, End "
        "reason, RMSEs (so far while it runs), raw best vector and what its latest try ran "
        "with. One query (ADR-0013). `not_found` for a run gone, or a topology it hasn't listed; "
        "a `next` it didn't give is `bad_request`.",
    ),
    read(
        "topology_progress",
        TopologyProgressParams,
        TopologyProgress,
        errors=(
            "bad_request",
            "not_found",
            "data_folder",
            "unavailable",
            "no_space",
            "db_corrupt",
            "internal",
        ),
        doc="A topology's Progress curves by start, a page at a time, for Optimization progress: "
        "each start's best Train RMSE so far against evaluations, at most 64 points its "
        "coordinator thinned from its latest try's Start log, with its state. One query, which "
        "walks the tries that have one (ADR-0013). `not_found` for a run gone, or a topology it "
        "hasn't listed; a `next` it didn't give is `bad_request`.",
    ),
    read(
        "read_start",
        ReadStartParams,
        Start,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A start in full: its row, its result's per-protocol sums, seed and start point, its "
        "Start log's path, and its topology's Top 10 for the bands. One query (ADR-0013). "
        "`not_found` for a run gone, or a start it doesn't hold.",
    ),
    read(
        "read_start_log",
        ReadStartLogParams,
        StartLogPage,
        errors=LOG_ERRORS,
        doc="A page of a try's Start log, forward from a byte offset or back from one, its last "
        "page with neither: its whole lines, parsed, up to about 512 KB of the file. One query "
        "for where it is, then one read. `not_found` for a run gone, or a start or try it "
        "doesn't hold; both offsets at once are `bad_request`; an Output folder that can't be "
        "read now is `unavailable`.",
    ),
    read(
        "read_job_log",
        ReadJobLogParams,
        JobLogPage,
        errors=LOG_ERRORS,
        doc="A page of what the scheduler kept of a try's output, forward from a byte offset or "
        "back from one, its last page with neither: up to 128 KB of text, for the log view. One "
        "query for where it is, then one read. `not_found` for a run gone, or a start or try it "
        "doesn't hold; both offsets at once are `bad_request`; an Output folder that can't be "
        "read now is `unavailable`.",
    ),
    read(
        "list_coordinating_jobs",
        ListCoordinatingJobsParams,
        CoordinatingJobs,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        doc="A run's coordinating jobs that began or ended, the latest first, for the log "
        "view's generation select: when each claimed the run and ended, its exit code, and "
        "whether it made progress. One query. `not_found` for a run gone.",
    ),
    read(
        "read_coordinating_job_log",
        ReadCoordinatingJobLogParams,
        JobLogPage,
        errors=LOG_ERRORS,
        doc="A page of a generation of a run's coordinator's own output, its coordinating job "
        "log, as `read_job_log` pages a try's. One query for where it is, then one read. "
        "`not_found` for a run gone, or a generation it hasn't had; both offsets at once are "
        "`bad_request`.",
    ),
    read(
        "watch_start",
        WatchStartParams,
        StartWatch,
        errors=("not_found", "data_folder", "unavailable", "no_space", "db_corrupt", "internal"),
        event=StartWatchEvent,
        doc="Watches a start's latest try for the live Start page: every 5 s it stats the try's "
        "Live snapshot and Start log, and pushes what's new as a `StartWatchEvent`, the log's "
        "lines read from the last offset (ADR-0009), until the try ends. A session watches one "
        "start: a new watch ends the one before.",
    ),
    read(
        "unwatch_start",
        None,
        None,
        errors=("internal",),
        doc="Ends the session's watch on a start, if it has one.",
    ),
    desktop(
        "regenerate_dataset",
        RegenerateDatasetParams,
        DatasetContent,
        errors=("invalid", "internal"),
        is_async=True,
        doc="The Dataset wizard's edit, on this computer's engine whatever the Active platform "
        "(ADR-0013): `after`, with each protocol whose measured points or interpolation differ "
        "from `before`'s interpolated afresh and its split proposed again (ADR-0011). A spline "
        "that can't be drawn is `invalid`, each issue at its path under `after`.",
    ),
    desktop(
        "propose_split",
        ProposeSplitParams,
        Protocol,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Redraw: the protocol with a fresh proposal of `share` of its points, rounded down, "
        "as validation points, on this computer's engine whatever the Active platform "
        "(ADR-0011, ADR-0013).",
    ),
    desktop(
        "match_topology",
        MatchTopologyParams,
        TopologyMatch,
        errors=("internal",),
        is_async=True,
        doc="Find custom topology: the id of a topology typed as transitions between states "
        "numbered however the user likes, with ICMM's number for each, or every rule it breaks, "
        "on this computer's engine whatever the Active platform (ADR-0013, #223). A topology "
        "within the rules that the lists don't hold means they're damaged: `internal`.",
    ),
    desktop(
        "time_evaluations",
        TimeEvaluationsParams,
        EvaluationTime,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Submit's time estimate for a config the platform's finished starts haven't timed "
        "at its CPUs per start, on this computer's engine whatever the Active platform "
        "(ADR-0013): about a second of a start's evaluations of the dataset at this many "
        "states, at its population and CPUs, as many at once as its starts run (#508). A dataset "
        "that fails its checks, a number of states without a list, or a population, CPUs or "
        "starts at once too few, is `invalid`.",
    ),
    desktop(
        "simulate_start",
        SimulateStartParams,
        StartSimulation,
        errors=("invalid", "internal"),
        is_async=True,
        doc="A start's curves, on this computer's engine whatever the Active platform "
        "(ADR-0013): each sweep's open probability over its measured step, at most 256 strided "
        "moments and its end, each point's value and each protocol's score, and the protocols "
        "whose scores drift from the stored ones beyond rounding, naming the engine that fit it "
        "and this one. A revision that fails this engine's checks, or a topology or vector it "
        "can't simulate, is `invalid`.",
    ),
    desktop(
        "canonical_parameters",
        CanonicalParametersParams,
        CanonicalParameters,
        errors=("invalid", "internal"),
        is_async=True,
        doc="A topology's raw best vectors as they're shown, on this computer's engine whatever "
        "the Active platform (ADR-0007, ADR-0013): each read relative to the open state, with "
        "b > 0, and the range each value can take in the run's box. A topology this engine "
        "has no list for, or a vector of another length, is `invalid`.",
    ),
    desktop(
        "edge_rates",
        EdgeRatesParams,
        EdgeRates,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Each edge's two rates at a voltage, in ms⁻¹, from a start's best vector, on this "
        "computer's engine whatever the Active platform (ADR-0013), for the Start page's Rates; "
        "a rate past what a number holds is `null`. A topology this engine has no list for, or "
        "a vector of another length, is `invalid`.",
    ),
    desktop(
        "log_frontend_event",
        LogFrontendEventParams,
        None,
        doc="Writes a report from the webview into the app log.",
    ),
    desktop(
        "connection_state",
        None,
        ConnectionState,
        doc="The connection now; each change after it comes as a `connection_state` event.",
    ),
    desktop(
        "time_format",
        None,
        TimeFormat,
        is_async=True,
        doc="Whether this computer's settings set a 12- or 24-hour clock, which the app shows "
        "times by.",
    ),
    desktop(
        "webview_info",
        None,
        WebviewInfo,
        doc="The web engine's version and the OS it runs on.",
    ),
    desktop(
        "platforms",
        None,
        SavedPlatforms,
        doc="The saved platforms, This computer last, and which is the Active platform.",
    ),
    desktop(
        "add_platform",
        AddPlatformParams,
        PlatformRef,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Saves a new SSH platform and connects to it, ending any other connection; answers "
        "its id.",
    ),
    desktop(
        "edit_platform",
        EditPlatformParams,
        None,
        errors=("invalid", "not_found", "internal"),
        is_async=True,
        doc="Saves a platform's Connection details; the Active platform reconnects if they "
        "changed how it's reached.",
    ),
    desktop(
        "remove_platform",
        PlatformRef,
        None,
        errors=("invalid", "not_found", "internal"),
        is_async=True,
        doc="Forgets a saved platform, disconnecting first; its files are left alone. When it's "
        "the launch choice, ICMM opens without connecting until another is chosen.",
    ),
    desktop(
        "connect_platform",
        PlatformRef,
        None,
        errors=("not_found", "internal"),
        is_async=True,
        doc="Makes a platform the Active one and connects, ending any other connection.",
    ),
    desktop(
        "disconnect_platform",
        None,
        None,
        errors=("internal",),
        is_async=True,
        doc="Ends the connection, whether connected, connecting or reconnecting, for now: the "
        "launch choice still connects when ICMM next opens.",
    ),
    desktop(
        "set_launch_platform",
        LaunchPlatformParams,
        None,
        errors=("not_found", "internal"),
        is_async=True,
        doc="Sets the platform ICMM connects to when it opens, or Don't connect; it applies at "
        "once, and nothing connects now.",
    ),
    desktop(
        "retry_connection",
        None,
        None,
        errors=("internal",),
        is_async=True,
        doc="Tries again at once: a failed connect starts over, and a reconnect stops waiting.",
    ),
    desktop(
        "trust_host_key",
        TrustHostKeyParams,
        None,
        errors=("conflict",),
        is_async=True,
        doc="Trusts the host key the connect waits on: adds it to `~/.ssh/known_hosts`, and the "
        "connect goes on. Any other key is a `conflict`.",
    ),
    desktop(
        "forget_host_key",
        ForgetHostKeyParams,
        None,
        errors=("conflict", "internal"),
        is_async=True,
        doc="Removes the line that recorded a changed host key's old key from known_hosts, and "
        "connects again, which asks about the key the host has now.",
    ),
    desktop(
        "set_up_ssh_key",
        None,
        None,
        errors=("conflict",),
        is_async=True,
        doc="Turns a refused sign-in (`sign_in` or `key_refused`) into the key question: add "
        "ICMM's key, or choose a key. Any other state is a `conflict`.",
    ),
    desktop(
        "add_ssh_key",
        AddSshKeyParams,
        None,
        errors=("conflict", "invalid"),
        is_async=True,
        doc="Makes ICMM's key if this computer hasn't one, signs in to the host that asked with "
        "the password, adds the key to its `~/.ssh/authorized_keys`, saves it as that host's key "
        "and connects with it. A wrong password is `invalid`, and the question stays; anything "
        "else that goes wrong fails the connect, saying why.",
    ),
    desktop(
        "use_ssh_key",
        UseSshKeyParams,
        None,
        errors=("conflict", "invalid", "internal"),
        is_async=True,
        doc="Saves a key file as the key for the host that asked, and connects again with it.",
    ),
    desktop(
        "open_logs_folder",
        None,
        None,
        errors=("internal",),
        doc="Opens the folder of the app's logs, which hold what each engine wrote, with the "
        "OS's file manager.",
    ),
    desktop(
        "report_preview",
        None,
        ReportPreview,
        is_async=True,
        doc="What a report would hold, for Report a problem…'s panel (#126): the versions, the "
        "platform's kind and the lines of the newest app and agent logs.",
    ),
    desktop(
        "save_report",
        SaveReportParams,
        SavedReport,
        errors=("internal",),
        is_async=True,
        doc="Saves a report as a plain text file in the Downloads folder, user names on this "
        "computer and its platforms written `user`, then opens ICMM's issue page in the OS's web "
        "browser, its form filled in from the link. A report saved but not opened is "
        "`internal`, and says where it was saved.",
    ),
    desktop(
        "open_releases_page",
        None,
        None,
        errors=("internal",),
        doc="Opens ICMM's releases page, where its newest version is, in the OS's web browser.",
    ),
    desktop(
        "logs_folder",
        None,
        LogsFolder,
        doc="Where the app's logs are, for Settings to show. They're kept for seven days.",
    ),
    desktop(
        "home_folder",
        None,
        HomeFolder,
        doc="What This computer's paths show for `~`: on Windows, its home folder in full.",
    ),
    desktop(
        "preferences",
        None,
        Preferences,
        doc="This computer's theme and notification choices; System and on until they're changed.",
    ),
    desktop(
        "set_preferences",
        Preferences,
        None,
        errors=("internal",),
        is_async=True,
        doc="Saves the theme and notification choices; the window's theme changes at once.",
    ),
    desktop(
        "run_marks",
        RunMarksParams,
        RunMarks,
        doc="What this computer remembers of a platform's runs: whether it has had one, and the "
        "change its ended runs have notified up to. Nothing for a platform it hasn't seen; a file "
        "that can't be read is nothing too.",
    ),
    desktop(
        "mark_runs",
        MarkRunsParams,
        None,
        errors=("internal",),
        doc="Records that a platform has had a run, or the change its ended runs have notified up "
        "to, beside what's recorded already. Reset forgets it all.",
    ),
    desktop(
        "recently_opened",
        RecentlyOpenedParams,
        RecentlyOpened,
        doc="The pages last opened on a platform, newest first, for ⌘K's Recently opened. None for "
        "a platform it hasn't seen; a file that can't be read is none too.",
    ),
    desktop(
        "record_opened",
        RecordOpenedParams,
        None,
        errors=("internal",),
        doc="Puts a page first in a platform's recently opened, keeping 5. Reset forgets them all, "
        "and removing the platform forgets its own.",
    ),
    desktop(
        "show_notification",
        NotificationParams,
        None,
        errors=("internal",),
        doc="Shows a run-ended notification from the computer, unless Notifications is off; the "
        "OS may ask permission first, or not show it.",
    ),
    desktop(
        "send_test_notification",
        None,
        None,
        errors=("internal",),
        doc="Shows a notification like a run's, so the user can check that they show; the OS "
        "may ask permission first.",
    ),
    desktop(
        "reset_app",
        ResetParams,
        None,
        errors=("internal",),
        is_async=True,
        doc="Forgets the app's state on this computer, as if just installed: deletes its logs "
        "(but empties the ones being written), then ICMM's key when asked to, disconnects, and "
        "forgets the saved platforms, the preferences and the window's size and place, in that "
        "order. Data folders, engines and the user's own keys in `~/.ssh` are left alone. A step "
        "that fails stops it, and the error says what's left; logs that couldn't go are named.",
    ),
    desktop(
        "guard_quit",
        GuardQuitParams,
        None,
        doc="Whether closing the window or quitting ICMM asks first, because the page has unsaved "
        "changes. While it does, a close or quit sends the page a `quit_requested` event instead, "
        "and the page asks. A page load clears it.",
    ),
    desktop(
        "quit_app",
        None,
        None,
        doc="Quits ICMM without asking: the page's answer to `quit_requested`.",
    ),
    desktop(
        "ssh_keys",
        None,
        SshKeys,
        doc="The private keys in `~/.ssh`, for the platform form's SSH key menu.",
    ),
    desktop(
        "ssh_config_hosts",
        None,
        SshConfigHosts,
        doc="The hosts `~/.ssh/config` names, for the platform form's fill-in menu.",
    ),
    desktop(
        "ssh_config_host",
        SshConfigHostParams,
        SshConfigHost,
        errors=("invalid",),
        is_async=True,
        doc="How `ssh` would reach a `~/.ssh/config` host, from `ssh -G` (or the file itself where "
        "there's no `ssh`); a host ICMM can't reach that way is `invalid`.",
    ),
    desktop(
        "choose_file",
        ChooseParams,
        Chosen,
        is_async=True,
        doc="Asks the user for a file with the OS's dialog.",
    ),
    desktop(
        "choose_folder",
        ChooseParams,
        Chosen,
        is_async=True,
        doc="Asks the user for a folder with the OS's dialog.",
    ),
    desktop(
        "choose_workbook",
        ChooseParams,
        Chosen,
        is_async=True,
        doc="Asks the user for an Excel workbook, an `.xlsx`, with the OS's dialog; with no folder "
        "given it opens in Downloads.",
    ),
    desktop(
        "choose_dataset_file",
        ChooseParams,
        Chosen,
        is_async=True,
        doc="Asks the user for a dataset file, a `.zip`, with the OS's dialog.",
    ),
    desktop(
        "read_dataset_file",
        ReadDatasetFileParams,
        DatasetFile,
        errors=("internal",),
        is_async=True,
        doc="Import's read, on this computer's engine whatever the Active platform (ADR-0013): "
        "the dataset in a `.zip` that Export saved, checked like any save but for its name, and "
        "its scoring digest; or why it can't be imported. The file is read in memory, never "
        "unpacked.",
    ),
    desktop(
        "choose_export_file",
        ExportFileParams,
        Chosen,
        is_async=True,
        doc="Asks the user where to save a file Export writes, with the OS's save dialog "
        "offering its formats; only a path it answers can be written or shown.",
    ),
    desktop(
        "write_dataset_file",
        WriteDatasetFileParams,
        WrittenFile,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Export's write, on this computer's engine: a revision's files as one `.zip`, "
        "replacing the file only once it's written in full; or the OS's words for why it "
        "couldn't. A path `choose_export_file` didn't answer, or files that don't match their "
        "digest, are `invalid`.",
    ),
    desktop(
        "choose_export_folder",
        ExportFolderParams,
        Chosen,
        is_async=True,
        doc="Asks the user where to save a folder of figures, with the OS's save dialog "
        "proposing its name; only a path it answers can be written or shown.",
    ),
    desktop(
        "write_figures",
        WriteFiguresParams,
        WrittenFile,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Export figures…'s write, on this computer's engine: each SVG in the folder "
        "`choose_export_folder` answered, made if it isn't there, each file replaced only once "
        "it's written in full; or the OS's words for why it couldn't. A folder the dialog didn't "
        "answer, or a figure not named as an SVG in it, is `invalid`.",
    ),
    desktop(
        "write_parameters",
        WriteParametersParams,
        WrittenFile,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Export parameters…'s write, on this computer's engine (#344): a start's topology, "
        "its parameters canonical and named (ADR-0007) with how to read them, its RMSEs and Cost "
        "as its worker stored them, and its run's settings, seed, engine and dataset revision, "
        "as JSON or, for a name ending `.csv`, CSV; replaced only once it's written in full; or "
        "the OS's words for why it couldn't. A path `choose_export_file` didn't answer, or a "
        "start this engine can't read, is `invalid`.",
    ),
    desktop(
        "write_fit",
        WriteFitParams,
        WrittenFit,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Export fit…'s write, on this computer's engine (#344): each point's data beside the "
        "start's simulated value, with its units, its normalization and whether a decay time is "
        "at its cap, and beside it a traces CSV of every recorded sweep's open probability and "
        "voltage at each moment its Time resolution records, simulated again (ADR-0013); each "
        "replaced only once it's written in full; or the OS's words for why it couldn't. A path "
        "`choose_export_file` didn't answer, or a start this engine can't simulate, is "
        "`invalid`.",
    ),
    desktop(
        "write_export_file",
        WriteExportFileParams,
        WrittenFile,
        errors=("invalid", "internal"),
        is_async=True,
        doc="Writes a file the desktop made whole, the leaderboard's CSV or a run's config "
        "(#344), on this computer's engine, replaced only once it's written in full; or the OS's "
        "words for why it couldn't. A path `choose_export_file` didn't answer is `invalid`.",
    ),
    desktop(
        "reveal_file",
        RevealParams,
        None,
        errors=("invalid", "internal"),
        doc="Shows what Export or Report a problem… saved in the OS's file manager: selected in "
        "Finder or Explorer, its folder elsewhere. A path `choose_export_file`, "
        "`choose_export_folder` or `save_report` didn't answer is `invalid`.",
    ),
    desktop(
        "reveal_log",
        RevealLogParams,
        None,
        errors=("invalid", "internal"),
        doc="Shows a run's log on This computer in the OS's file manager, for the log view's "
        "Show in Finder: selected in Finder or Explorer, its folder elsewhere. A path not named "
        "as a run's logs are, in its run's folder, is `invalid`.",
    ),
    desktop(
        "read_workbook",
        ReadWorkbookParams,
        Workbook,
        is_async=True,
        doc="Reads an `.xlsx` workbook's worksheets on this computer for the Dataset wizard (old "
        "ADR-0006), or says why it can't: another kind of file, one that won't open, or one over "
        "50 MB.",
    ),
)
