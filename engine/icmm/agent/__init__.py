"""The agent: the engine program the desktop talks to, one per connection (ADR-0009).

It serves NDJSON on stdin and stdout and keeps nothing of its own; the data folder holds
everything it reports.
"""

from __future__ import annotations

import os
import sys
from functools import cache, partial
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn

from icmm.agent import (
    configs,
    datasets,
    platform,
    results,
    runs,
    simulation,
    starts,
    topologies,
    topology,
)
from icmm.agent.changes import ChangeFeed
from icmm.agent.hello import hello
from icmm.agent.lifecycle import Dispatcher
from icmm.agent.serve import IDLE_TIMEOUT_S, Route, serve, subscription_ids
from icmm.agent.storage import guarded
from icmm.bundle import own_bundle_key
from icmm.db import RunsDb
from icmm.hand_over import AgentHandOver
from icmm.topology import Lists
from icmm.wire import METHODS

if TYPE_CHECKING:
    from icmm.scheduler import Scheduler

__all__ = ["run"]


def run(data_folder: str) -> NoReturn:
    folder = Path(data_folder).expanduser()
    # The Data folder as the user wrote it, with the home folder as `~`, for the sentences.
    written = platform.from_home(data_folder)
    methods = {m.name: m for m in METHODS}
    # One scheduler for the session, made the first time it's needed.
    scheduler = cache(partial(_scheduler, folder))
    # Only an agent raises the floor with runs in flight: it hands them to its engine first.
    hand_over = AgentHandOver(scheduler, own_bundle_key())
    db = RunsDb(folder, hand_over=hand_over)
    ids = subscription_ids()
    changes = ChangeFeed(db, ids=ids)
    every = float(os.environ.get("ICMM_AGENT_WATCH_EVERY_S", starts.WATCH_EVERY_S))
    watches = starts.StartWatches(db, ids=ids, interval_s=every)
    dispatcher = Dispatcher(db, folder, scheduler=scheduler, engine=own_bundle_key())
    handlers = {
        "hello": partial(hello, data_folder=folder, written=written, db=db),
        "subscribe_changes": changes.subscribe,
        "scheduler_lookup": partial(platform.lookup, data_folder=data_folder),
        "check_folders": partial(platform.check_folders, written=written),
        "platform_settings": partial(platform.read, db=db),
        "save_platform_settings": partial(
            platform.save, db=db, data_folder=folder, method=methods["save_platform_settings"]
        ),
        "list_datasets": partial(datasets.list_datasets, db=db, data_folder=folder),
        "read_dataset": partial(datasets.read_dataset, db=db, data_folder=folder),
        "validate_dataset": partial(datasets.validate_dataset, db=db),
        "revision_files": partial(datasets.revision_files, db=db, data_folder=folder),
        "read_dataset_revision": partial(datasets.read_dataset_revision, db=db, data_folder=folder),
        "find_scoring_digest": partial(datasets.find_scoring_digest, db=db),
        "save_dataset": partial(
            datasets.save_dataset,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["save_dataset"],
        ),
        "duplicate_dataset": partial(
            datasets.duplicate_dataset,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["duplicate_dataset"],
        ),
        "save_as_new_dataset": partial(
            datasets.save_as_new_dataset,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["save_as_new_dataset"],
        ),
        "delete_dataset": partial(datasets.delete_dataset, db=db, method=methods["delete_dataset"]),
        "validate_config": partial(configs.validate_config, lists=Lists(), db=db),
        "read_state_graphs": partial(topology.read_state_graphs, lists=Lists()),
        "list_configs": partial(configs.list_configs, db=db),
        "read_config": partial(configs.read_config, db=db, data_folder=folder),
        "count_configs": partial(configs.count_configs, db=db),
        "save_config": partial(
            configs.save_config,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["save_config"],
            lists=Lists(),
        ),
        "duplicate_config": partial(
            configs.duplicate_config,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["duplicate_config"],
        ),
        "delete_config": partial(
            configs.delete_config,
            db=db,
            data_folder=folder,
            written=written,
            method=methods["delete_config"],
        ),
        "submit_run": partial(
            runs.submit_run,
            db=db,
            data_folder=folder,
            lists=Lists(),
            method=methods["submit_run"],
            engine=own_bundle_key(),
        ),
        "cancel_run": partial(runs.cancel_run, db=db, method=methods["cancel_run"]),
        "delete_run": partial(runs.delete_run, db=db, method=methods["delete_run"]),
        "resume_run": partial(
            runs.resume_run,
            db=db,
            data_folder=folder,
            method=methods["resume_run"],
            engine=own_bundle_key(),
        ),
        "list_runs": partial(runs.list_runs, db=db),
        "runs_overview": partial(runs.runs_overview, db=db),
        "read_run": partial(runs.read_run, db=db, data_folder=folder),
        "run_stretches": partial(runs.run_stretches, db=db),
        "ended_runs": partial(runs.ended_runs, db=db),
        "run_timings": partial(runs.run_timings, db=db),
        "read_start_fit": partial(simulation.read_start_fit, db=db),
        "user_jobs": runs.user_jobs,
        "list_topologies": partial(topologies.list_topologies, db=db),
        "read_topology": partial(topologies.read_topology, db=db),
        "list_ranking_groups": partial(results.list_ranking_groups, db=db),
        "list_leaderboard": partial(results.list_leaderboard, db=db),
        "read_group_rank": partial(results.read_group_rank, db=db),
        "list_starts": partial(starts.list_starts, db=db),
        "topology_progress": partial(starts.topology_progress, db=db),
        "read_start": partial(starts.read_start, db=db),
        "read_start_log": partial(starts.read_start_log, db=db),
        "read_job_log": partial(starts.read_job_log, db=db),
        "list_coordinating_jobs": partial(starts.list_coordinating_jobs, db=db),
        "read_coordinating_job_log": partial(starts.read_coordinating_job_log, db=db),
        "watch_start": watches.watch,
        "unwatch_start": watches.unwatch,
    }
    after = {
        "hello": dispatcher.activate,
        "subscribe_changes": changes.activate,
        "submit_run": dispatcher.wake,
        "cancel_run": dispatcher.clean_soon,
        "delete_run": dispatcher.clean_soon,
        "resume_run": dispatcher.wake,
        "watch_start": watches.activate,
    }
    routes = {
        name: Route(
            methods[name],
            guarded(handler, data_folder=folder, written=written),
            on_sent=after.get(name),
        )
        for name, handler in handlers.items()
    }
    stdin = open(0, "rb", buffering=0, closefd=False)
    stdout = open(1, "wb", buffering=0, closefd=False)
    idle = float(os.environ.get("ICMM_AGENT_IDLE_TIMEOUT_S", IDLE_TIMEOUT_S))
    serve(
        stdin,
        stdout,
        routes,
        log=sys.stderr,
        feeds=[changes, watches, dispatcher],
        idle_timeout_s=idle,
    )
    sys.stderr.flush()
    # Not a normal exit, which would wait on a handler stuck past serve's grace period: the
    # agent holds nothing that needs one, and a lingering agent eats the login node's memory.
    os._exit(0)


def _scheduler(folder: Path) -> Scheduler | None:
    from icmm import scheduler

    return scheduler.for_host(folder)
