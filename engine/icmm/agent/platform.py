"""The Platform settings RPCs: what Platform setup proposes, and reading and saving them."""

from __future__ import annotations

import os
from pathlib import Path

from icmm import folders, platform_settings, scheduler
from icmm.agent.requests import keyed
from icmm.agent.serve import AgentError
from icmm.db import RunsDb
from icmm.folders import from_home
from icmm.wire import Method
from icmm.wire.errors import (
    ConflictData,
    ConflictError,
    InvalidData,
    InvalidError,
    Issue,
    Severity,
)
from icmm.wire.handshake import Scheduler
from icmm.wire.platform import (
    CheckFoldersParams,
    FolderCheck,
    FolderChecks,
    LocalJobDefaults,
    LocalLookup,
    PlatformSettings,
    PlatformSettingsResult,
    Revision,
    SavePlatformSettingsParams,
    SchedulerLookup,
)


def lookup(_: None, *, data_folder: str) -> SchedulerLookup:
    """`data_folder` as the agent was given it; the proposed Output folder writes the home
    folder `~`, as the desktop writes folders, since the desktop expands it to start the agent."""
    output_folder = from_home(os.path.join(data_folder, "output"))
    if scheduler.detect() is Scheduler.LOCAL:
        cores = os.cpu_count() or 1
        cpus = min(2, cores)
        return SchedulerLookup(
            scheduler=Scheduler.LOCAL,
            slurm=None,
            local=LocalLookup(cores=cores),
            proposed=PlatformSettings(
                output_folder=output_folder,
                job_defaults=LocalJobDefaults(
                    type="local", cpus_per_start=cpus, max_running_starts=max(1, cores // cpus)
                ),
            ),
        )
    import getpass

    from icmm.scheduler.slurm import SlurmCli, proposed_job_defaults
    from icmm.scheduler.slurm import lookup as slurm_lookup

    found = slurm_lookup(SlurmCli(), getpass.getuser())
    return SchedulerLookup(
        scheduler=Scheduler.SLURM,
        slurm=found,
        local=None,
        proposed=PlatformSettings(
            output_folder=output_folder, job_defaults=proposed_job_defaults(found)
        ),
    )


def check_folders(params: CheckFoldersParams, *, written: str) -> FolderChecks:
    """`written` is the Data folder as the agent was given it."""
    host = scheduler.detect()

    def check(folder: str, role: folders.Role) -> FolderCheck:
        refused = folders.check_folder(folder, role, host)
        return FolderCheck(
            free_bytes=folders.folder_space(folder),
            refusal=None if refused is None else refused.sentence,
        )

    return FolderChecks(
        data_folder=check(written, folders.Role.DATA),
        output_folder=check(params.output_folder, folders.Role.OUTPUT),
    )


def read(_: None, *, db: RunsDb) -> PlatformSettingsResult:
    return PlatformSettingsResult(saved=platform_settings.read(db.connection()))


def save(
    params: SavePlatformSettingsParams, *, db: RunsDb, data_folder: Path, method: Method
) -> Revision:
    def check() -> None:
        host = scheduler.detect()
        issues = platform_settings.check(params.settings, host)
        if not any(i.path == ["settings", "output_folder"] for i in issues):
            refused = folders.check_folder(params.settings.output_folder, folders.Role.OUTPUT, host)
            if refused is not None:
                issues.append(
                    Issue(
                        path=["settings", "output_folder"],
                        message=refused.sentence,
                        severity=Severity.ERROR,
                    )
                )
        if issues:
            raise AgentError(
                InvalidError(
                    code="invalid",
                    message="Some of these settings can't be saved.",
                    data=InvalidData(issues=issues),
                )
            )

    def act(conn) -> Revision:
        try:
            saved = platform_settings.save(conn, params.settings, params.expected_revision)
        except platform_settings.StaleRevisionError:
            raise AgentError(
                ConflictError(
                    code="conflict",
                    message="The Platform settings were changed elsewhere. Reload to see them.",
                    data=ConflictData(reason="stale_revision"),
                )
            ) from None
        return Revision(revision=saved.revision)

    revision = keyed(db, method, params, act, check=check)
    # The database already holds the save; a copy that can't be written now is repaired from
    # it when the next agent starts.
    try:
        platform_settings.repair_projection(data_folder, db)
    except OSError:
        pass
    return revision
