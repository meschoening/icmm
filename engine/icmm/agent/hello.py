"""`hello`: the version gate, and what the agent knows about its engine, platform and host."""

from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

from icmm import __version__, platform_settings, scheduler
from icmm.agent import configs
from icmm.agent.serve import AgentError
from icmm.agent.storage import data_folder_error
from icmm.bundle import own_bundle_key
from icmm.db import RunsDb
from icmm.folders import Role, check_folder
from icmm.topology import Lists
from icmm.wire import PROTOCOL_VERSION
from icmm.wire.errors import VersionMismatchData, VersionMismatchError
from icmm.wire.handshake import HelloParams, HelloResult, HostFacts, Platform, Scheduler


def hello(params: HelloParams, data_folder: Path, written: str, db: RunsDb) -> HelloResult:
    """Refuses a Data folder this platform can't keep its runs database in, before opening it.
    `written` is the Data folder as the agent was given it, for the sentences."""
    if _major_minor(params.protocol) != _major_minor(PROTOCOL_VERSION):
        raise AgentError(
            VersionMismatchError(
                code="version_mismatch",
                message=f"This engine speaks protocol {PROTOCOL_VERSION}; "
                f"the app needs {params.protocol}.",
                data=VersionMismatchData(protocol=PROTOCOL_VERSION),
            )
        )
    host_scheduler = scheduler.detect()
    refused = check_folder(written, Role.DATA, host_scheduler)
    if refused is not None:
        raise AgentError(
            data_folder_error(
                refused.problem,
                refused.sentence,
                details=refused.details,
                storage=refused.storage,
                suggestion=refused.suggestion,
            )
        )
    saved = platform_settings.read(db.connection())
    # A save cut short before its copy was written leaves `platform.json` behind the database.
    try:
        platform_settings.repair_projection(data_folder, db)
    except OSError:
        pass
    # And a config's write cut short leaves its projection pending (ADR-0016). Whatever stops
    # the repair, busy or a projection it can't fix, waits for the config's next write or the
    # next agent: it never stops the connection.
    try:
        configs.repair(db, data_folder, written)
    except Exception as e:
        sys.stderr.write(f"config repair stopped: {e!r}\n")
    return HelloResult(
        protocol=PROTOCOL_VERSION,
        engine_version=__version__,
        bundle_key=own_bundle_key(),
        platform=None
        if saved is None
        else Platform(
            output_folder=saved.settings.output_folder,
            scheduler=Scheduler(saved.settings.job_defaults.type),
        ),
        facts=HostFacts(
            host=socket.gethostname(),
            scheduler=host_scheduler,
            cpus=os.cpu_count() or 1,
            cache_ns=Lists().numbers_of_states(),
        ),
    )


def _major_minor(protocol: str) -> tuple[str, ...]:
    return tuple(protocol.split(".")[:2])
