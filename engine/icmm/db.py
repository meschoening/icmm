"""The runs database, `<data folder>/runs.db`: everything a platform reports (ADR-0009).

On a cluster it sits on NFS, where the agent on the login node and each run's owner job on a
compute node open it, so it keeps a rollback journal it truncates (WAL corrupts across hosts),
waits 15 s for a lock, and gives each thread its own connection. Its schema is a numbered chain
of migrations counted in `PRAGMA user_version`, and its ids never recycle.

Older engines share it with newer ones, since a run keeps its engine across updates (ADR-0020).
Each migration says whether it raises the **floor**, the fewest migrations an engine must know to
use the database: an engine at or above it carries on past migrations it doesn't know, and one
below it stops, at its next write if it opened the database before the floor rose. A migration
that raises the floor while runs are in flight waits for them to be handed to the engine applying
it (`HandOver`).
"""

from __future__ import annotations

import os
import sqlite3
import threading
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

FILE_NAME = "runs.db"
BUSY_TIMEOUT_MS = 15_000
"""How long a connection waits for another's lock, unless `ICMM_BUSY_TIMEOUT_MS` says otherwise:
tests set it beyond reach (ADR-0022). SQLite takes it as a 32-bit int, so at most 2³¹ − 1."""


@dataclass(frozen=True)
class Migration:
    """One step of the chain: its statements, run in one transaction, and whether it raises the
    floor. A new table, column or index doesn't: an engine that doesn't know it goes on without
    it. A change an older engine would misread or break does."""

    statements: tuple[str, ...]
    raises_floor: bool = False


def additive(*statements: str) -> Migration:
    return Migration(statements)


def raising_floor(*statements: str) -> Migration:
    return Migration(statements, raises_floor=True)


MIGRATIONS: tuple[Migration, ...] = (
    # 1: the database's identity, the change feed, recorded write requests, and the Platform
    # settings.
    additive(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "INSERT INTO meta (key, value) VALUES ('feed', lower(hex(randomblob(16))))",
        """CREATE TABLE changes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            topic TEXT NOT NULL,
            key TEXT,
            at TEXT NOT NULL
        )""",
        """CREATE TABLE requests (
            request_key TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            params TEXT NOT NULL,
            params_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN
                ('accepted', 'acting', 'reconciliation_required', 'succeeded', 'failed')),
            outcome TEXT,
            created_at TEXT NOT NULL,
            finished_at TEXT
        )""",
        """CREATE TABLE platform_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL,
            settings TEXT NOT NULL,
            saved_at TEXT NOT NULL
        )""",
    ),
    # 2: datasets (ADR-0003). A row is made when a dataset's first save is recorded, so its id is
    # never reused; it lists once a revision is published. Each save takes the next revision
    # number when it's recorded, so two saves never stage the same folder, and a save that loses
    # leaves a gap. Its intent lives until the save finishes (ADR-0009).
    additive(
        """CREATE TABLE datasets (
            id TEXT PRIMARY KEY,
            name TEXT,
            name_key TEXT,
            current_revision INTEGER,
            next_revision INTEGER NOT NULL,
            created_at TEXT,
            deleted_at TEXT
        )""",
        "CREATE UNIQUE INDEX datasets_name ON datasets (name_key) "
        "WHERE current_revision IS NOT NULL AND deleted_at IS NULL",
        "CREATE INDEX datasets_created ON datasets (created_at, id)",
        """CREATE TABLE dataset_revisions (
            dataset_id TEXT NOT NULL REFERENCES datasets (id),
            revision INTEGER NOT NULL,
            format INTEGER NOT NULL,
            protocols TEXT NOT NULL,
            scoring_digest TEXT NOT NULL,
            files_digest TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            PRIMARY KEY (dataset_id, revision)
        )""",
        """CREATE TABLE dataset_intents (
            request_key TEXT PRIMARY KEY REFERENCES requests (request_key),
            dataset_id TEXT NOT NULL REFERENCES datasets (id),
            revision INTEGER NOT NULL,
            expected_revision INTEGER,
            files_digest TEXT NOT NULL
        )""",
    ),
    # 3: Import's same-data check looks a scoring digest up among stored revisions (#147).
    additive("CREATE INDEX dataset_revisions_scoring ON dataset_revisions (scoring_digest)"),
    # 4: Datasets lists by Modified, when each dataset's current revision was saved (#167): kept
    # on its row at publish, so a page is one bounded query.
    additive(
        "ALTER TABLE datasets ADD COLUMN modified_at TEXT",
        "UPDATE datasets SET modified_at = (SELECT r.saved_at FROM dataset_revisions r "
        "WHERE r.dataset_id = datasets.id AND r.revision = datasets.current_revision)",
        "CREATE INDEX datasets_modified ON datasets (modified_at, id)",
    ),
    # 5: configs (ADR-0016). A row is made when a config's first save commits, so a save that
    # never does leaves nothing to list; a delete keeps it as a revision-tagged tombstone, so
    # its id is never reused and its name is free again. Each write is an attempt, numbered never
    # to be reused, which fences its commit and names its stage; attempts that haven't committed
    # may stand side by side, while a config has at most one committed attempt, the projection
    # still to publish, so its committed writes take turns. A live config's
    # saves are kept under their changes' seqs, so the list's later pages keep the order its
    # first page saw; a delete drops them.
    additive(
        """CREATE TABLE configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            revision INTEGER NOT NULL,
            format INTEGER NOT NULL,
            dataset_id TEXT NOT NULL,
            settings TEXT NOT NULL,
            num_states INTEGER,
            topologies INTEGER,
            starts INTEGER,
            digest TEXT NOT NULL,
            projected TEXT,
            save_seq INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            modified_at TEXT NOT NULL,
            deleted_at TEXT
        )""",
        "CREATE UNIQUE INDEX configs_name ON configs (name_key) WHERE deleted_at IS NULL",
        "CREATE INDEX configs_dataset ON configs (dataset_id) WHERE deleted_at IS NULL",
        "CREATE INDEX configs_listed ON configs (modified_at, save_seq) WHERE deleted_at IS NULL",
        "CREATE INDEX configs_saved ON configs (save_seq) WHERE deleted_at IS NULL",
        """CREATE TABLE config_claims (
            attempt INTEGER PRIMARY KEY AUTOINCREMENT,
            config_id TEXT NOT NULL,
            request_key TEXT NOT NULL UNIQUE REFERENCES requests (request_key),
            expected_revision INTEGER,
            revision INTEGER NOT NULL,
            projection TEXT NOT NULL,
            digest TEXT NOT NULL,
            committed INTEGER NOT NULL DEFAULT 0,
            claimed_at TEXT NOT NULL
        )""",
        "CREATE INDEX config_claims_config ON config_claims (config_id)",
        "CREATE UNIQUE INDEX config_claims_pending ON config_claims (config_id) "
        "WHERE committed = 1",
        """CREATE TABLE config_saves (
            seq INTEGER PRIMARY KEY,
            config_id TEXT NOT NULL REFERENCES configs (id),
            modified_at TEXT NOT NULL
        )""",
        "CREATE INDEX config_saves_config ON config_saves (config_id, seq)",
    ),
    # 6: runs (ADR-0016, ADR-0019). Submit records what a run fits, which nothing changes after;
    # its coordinator keeps the rest: its state, stage times and counts, its topologies, and its
    # starts, each with its tries. Each count and best on a run or topology is kept as its
    # starts change, so a list reads one row per run. A run's end takes a change row, whose seq
    # it keeps, so the runs that ended since a feed position are one indexed range.
    # `run_timings` sums the run's finished starts by the CPUs each ran on, for Submit's time
    # estimate.
    additive(
        """CREATE TABLE runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_key TEXT NOT NULL UNIQUE REFERENCES requests (request_key),
            config_id TEXT NOT NULL,
            config_revision INTEGER NOT NULL,
            dataset_id TEXT NOT NULL,
            dataset_revision INTEGER NOT NULL,
            format INTEGER NOT NULL,
            settings TEXT NOT NULL,
            num_states INTEGER NOT NULL,
            has_validation INTEGER NOT NULL,
            search_seed INTEGER NOT NULL,
            output_folder TEXT NOT NULL,
            engine TEXT,
            topologies INTEGER NOT NULL,
            starts INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN
                ('queued', 'held', 'running', 'completed', 'failed', 'canceled')),
            hold TEXT CHECK (hold IN ('scheduler', 'space')),
            hold_reason TEXT,
            held_since TEXT,
            failure TEXT,
            topologies_complete INTEGER NOT NULL DEFAULT 0,
            topologies_failed INTEGER NOT NULL DEFAULT 0,
            starts_finished INTEGER NOT NULL DEFAULT 0,
            starts_failed INTEGER NOT NULL DEFAULT 0,
            starts_running INTEGER NOT NULL DEFAULT 0,
            best_graph INTEGER,
            best_open_state INTEGER,
            best_train_rmse REAL,
            best_val_rmse REAL,
            submitted_at TEXT NOT NULL,
            claimed_at TEXT,
            topologies_listed_at TEXT,
            first_array_at TEXT,
            first_running_at TEXT,
            ended_at TEXT,
            end_seq INTEGER,
            deleted_at TEXT
        )""",
        "CREATE INDEX runs_in_flight ON runs (id) WHERE end_seq IS NULL AND deleted_at IS NULL",
        "CREATE INDEX runs_ended ON runs (end_seq) WHERE deleted_at IS NULL",
        "CREATE INDEX runs_config ON runs (config_id) WHERE deleted_at IS NULL",
        "CREATE INDEX runs_dataset ON runs (dataset_id) WHERE deleted_at IS NULL",
        """CREATE TABLE topologies (
            run_id INTEGER NOT NULL REFERENCES runs (id),
            graph INTEGER NOT NULL,
            open_state INTEGER NOT NULL,
            position INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('next', 'fitting', 'complete', 'failed')),
            starts_finished INTEGER NOT NULL DEFAULT 0,
            starts_failed INTEGER NOT NULL DEFAULT 0,
            starts_running INTEGER NOT NULL DEFAULT 0,
            best_start INTEGER,
            best_train_rmse REAL,
            best_val_rmse REAL,
            first_sent_at TEXT,
            last_ended_at TEXT,
            PRIMARY KEY (run_id, graph, open_state)
        )""",
        "CREATE UNIQUE INDEX topologies_order ON topologies (run_id, position)",
        """CREATE TABLE starts (
            run_id INTEGER NOT NULL,
            graph INTEGER NOT NULL,
            open_state INTEGER NOT NULL,
            start_index INTEGER NOT NULL,
            seed INTEGER,
            start_point TEXT,
            state TEXT NOT NULL CHECK (state IN
                ('pending', 'sent', 'running', 'finished', 'failed', 'canceled')),
            try INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (run_id, graph, open_state, start_index),
            FOREIGN KEY (run_id, graph, open_state)
                REFERENCES topologies (run_id, graph, open_state)
        )""",
        """CREATE TABLE start_tries (
            run_id INTEGER NOT NULL,
            graph INTEGER NOT NULL,
            open_state INTEGER NOT NULL,
            start_index INTEGER NOT NULL,
            try INTEGER NOT NULL,
            engine TEXT,
            job_id TEXT,
            array_job_id TEXT,
            array_task INTEGER,
            cpus INTEGER NOT NULL,
            memory_mb INTEGER,
            time_limit_min INTEGER,
            node TEXT,
            peak_memory_mb INTEGER,
            exit_code INTEGER,
            scheduler_state TEXT,
            cause TEXT CHECK (cause IN ('out_of_memory', 'error', 'time_limit', 'lost')),
            best TEXT,
            generations INTEGER,
            evaluations INTEGER,
            elapsed_s REAL,
            cost REAL,
            val_cost REAL,
            train_rmse REAL,
            val_rmse REAL,
            train_sse TEXT,
            train_points TEXT,
            train_failed TEXT,
            val_sse TEXT,
            val_points TEXT,
            val_failed TEXT,
            end_reason TEXT CHECK (end_reason IN ('budget', 'canceled', 'time_limit')),
            still_improving INTEGER,
            live_generation INTEGER,
            live_evaluations INTEGER,
            live_train_rmse REAL,
            live_val_rmse REAL,
            sent_at TEXT,
            started_at TEXT,
            ended_at TEXT,
            PRIMARY KEY (run_id, graph, open_state, start_index, try),
            FOREIGN KEY (run_id, graph, open_state, start_index)
                REFERENCES starts (run_id, graph, open_state, start_index)
        )""",
        """CREATE TABLE run_timings (
            run_id INTEGER NOT NULL REFERENCES runs (id),
            cpus INTEGER NOT NULL,
            starts INTEGER NOT NULL,
            evaluations INTEGER NOT NULL,
            elapsed_s REAL NOT NULL,
            PRIMARY KEY (run_id, cpus)
        )""",
    ),
    # 7: the coordinator (ADR-0019). A run holds the generation of the coordinator that claimed it
    # last, so an earlier one or a duplicate can't act; each generation records whether it made
    # progress, and the run how many in a row didn't, how many starts in a row failed, and why it
    # stopped sending, once it has. Each array is recorded with its launch identity before it goes
    # out (ADR-0009), and each try names its array and keeps what ranks its best. The lifecycle
    # dispatcher finds unfinished requests by an index, the window a topology's unsent starts by
    # another, and each sweep the tries and arrays still out by two more.
    additive(
        "ALTER TABLE runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN stalled_generations INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN failed_in_a_row INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN stopping TEXT",
        """CREATE TABLE coordinators (
            run_id INTEGER NOT NULL REFERENCES runs (id),
            generation INTEGER NOT NULL,
            identity TEXT NOT NULL UNIQUE,
            job_id TEXT,
            launched_at TEXT,
            claimed_by TEXT,
            claimed_at TEXT,
            progressed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (run_id, generation)
        )""",
        """CREATE TABLE arrays (
            run_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            graph INTEGER NOT NULL,
            open_state INTEGER NOT NULL,
            identity TEXT NOT NULL UNIQUE,
            generation INTEGER NOT NULL,
            tasks INTEGER NOT NULL,
            throttle INTEGER NOT NULL,
            job_id TEXT,
            sent_at TEXT,
            ended_at TEXT,
            PRIMARY KEY (run_id, number),
            FOREIGN KEY (run_id, graph, open_state)
                REFERENCES topologies (run_id, graph, open_state)
        )""",
        "CREATE INDEX arrays_out ON arrays (run_id, number) WHERE ended_at IS NULL",
        "ALTER TABLE start_tries ADD COLUMN array INTEGER",
        "ALTER TABLE start_tries ADD COLUMN penalized REAL",
        "CREATE INDEX start_tries_out ON start_tries (run_id, array) WHERE ended_at IS NULL",
        "CREATE INDEX starts_pending ON starts (run_id, graph, open_state, start_index) "
        "WHERE state = 'pending'",
        "CREATE INDEX requests_unfinished ON requests (method) "
        "WHERE status IN ('accepted', 'acting', 'reconciliation_required')",
    ),
    # 8: each topology's **Near best** count and its **Top 10**'s **Parameter spread**
    # (ADR-0021), which its coordinator works again from its finished starts each time one
    # finishes: the spread's median, min, quartiles and max, and each parameter's, as a JSON list
    # in layout order with the open state's pair null. Each is null until there's one to keep.
    additive(
        "ALTER TABLE topologies ADD COLUMN near_best INTEGER",
        "ALTER TABLE topologies ADD COLUMN spread REAL",
        "ALTER TABLE topologies ADD COLUMN spread_min REAL",
        "ALTER TABLE topologies ADD COLUMN spread_q1 REAL",
        "ALTER TABLE topologies ADD COLUMN spread_q3 REAL",
        "ALTER TABLE topologies ADD COLUMN spread_max REAL",
        "ALTER TABLE topologies ADD COLUMN parameter_spreads TEXT",
    ),
    # 9: the run's tasks waiting at the scheduler, as its coordinator last heard: those that could
    # start the moment resources free up, and those held (#248). Beside `starts_running`, they are
    # Run detail's.
    additive(
        "ALTER TABLE runs ADD COLUMN starts_queued INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN starts_held INTEGER NOT NULL DEFAULT 0",
    ),
    # 10: This computer's scheduler (ADR-0019). No daemon runs its jobs, so the runs database is
    # its queue: each array a coordinator sends is a job, and each of its tasks waits, runs or has
    # ended. A task runs only in a slot, taken in a write transaction, so every run here shares
    # one Running-starts cap. A running task names the coordinator that took its slot and its
    # worker, each by process id and start time, so one whose coordinator is gone is told from
    # one that's busy.
    additive(
        """CREATE TABLE local_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identity TEXT NOT NULL UNIQUE,
            run_id INTEGER NOT NULL REFERENCES runs (id),
            jobs TEXT NOT NULL,
            folder TEXT NOT NULL,
            tasks INTEGER NOT NULL,
            throttle INTEGER NOT NULL,
            threads INTEGER NOT NULL,
            submitted_at TEXT NOT NULL
        )""",
        """CREATE TABLE local_tasks (
            job_id INTEGER NOT NULL REFERENCES local_jobs (id),
            task INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('waiting', 'running', 'ended')),
            owner TEXT,
            process TEXT,
            ran INTEGER NOT NULL DEFAULT 0,
            canceled INTEGER NOT NULL DEFAULT 0,
            exit_code INTEGER,
            cause TEXT CHECK (cause IN ('out_of_memory', 'error', 'time_limit', 'lost')),
            started_at TEXT,
            ended_at TEXT,
            PRIMARY KEY (job_id, task)
        )""",
        "CREATE INDEX local_tasks_open ON local_tasks (state, job_id, task) WHERE state != 'ended'",
    ),
    # 11: Run detail's and Topology's reads (#251). A run's topologies rank by their **Best
    # start**'s Val RMSE, then its Train RMSE, "—" after every number, then those with no start
    # finished, in the order they go out (ADR-0006): a run without validation points has no Val
    # RMSE, so the one order serves both. A page walks this index from its cursor, and a
    # topology's rank counts along it. Topology lists its arrays by another, and its Top 10
    # walks its tries by Train RMSE, so it reads 10 starts' vectors, not all of them. Its
    # queued starts count along their own index, as its waiting ones do along `starts_pending`.
    additive(
        "CREATE INDEX topologies_ranked ON topologies (run_id, best_start IS NULL, "
        "best_val_rmse IS NULL, COALESCE(best_val_rmse, 0), best_train_rmse IS NULL, "
        "COALESCE(best_train_rmse, 0), position)",
        "CREATE INDEX arrays_topology ON arrays (run_id, graph, open_state, number)",
        "CREATE INDEX start_tries_top ON start_tries (run_id, graph, open_state, train_rmse, "
        "start_index, try) WHERE train_rmse IS NOT NULL",
        "CREATE INDEX starts_sent ON starts (run_id, graph, open_state, start_index) "
        "WHERE state = 'sent'",
    ),
    # 12: Cancel run, Delete run and Resume (#250). A run in flight records when a cancel was
    # accepted, and shows Canceling until it ends. A Resume records how the run had ended until a
    # coordinator takes it up, and the generation it launched, from which progress counts again.
    # A deleted run keeps its tombstone, `deleted_at`, until `icmm cleanup` has removed its jobs,
    # files and rows. Cleanup's work, the runs deleted and those canceling, is found by two
    # indexes.
    additive(
        "ALTER TABLE runs ADD COLUMN canceling_since TEXT",
        "ALTER TABLE runs ADD COLUMN resuming TEXT",
        "ALTER TABLE runs ADD COLUMN resumed_generation INTEGER",
        "CREATE INDEX runs_deleted ON runs (id) WHERE deleted_at IS NOT NULL",
        "CREATE INDEX runs_canceling ON runs (id) "
        "WHERE canceling_since IS NOT NULL AND end_seq IS NULL AND deleted_at IS NULL",
    ),
    # 13: what Runs says of a run waiting or running again (#236): a queued run's scheduler
    # reason and when its state last changed; for a hold for space, the fuller folder and its
    # free space when the hold began, and the free space it carries on at (ADR-0014); when This
    # computer last relaunched its coordinator. A run's fitting topologies count along their own
    # index, a few rows each, so a list page's summaries stay one query.
    additive(
        "ALTER TABLE runs ADD COLUMN queued_reason TEXT",
        "ALTER TABLE runs ADD COLUMN state_since TEXT",
        "ALTER TABLE runs ADD COLUMN space_folder TEXT",
        "ALTER TABLE runs ADD COLUMN space_free INTEGER",
        "ALTER TABLE runs ADD COLUMN space_carries_on INTEGER",
        "ALTER TABLE runs ADD COLUMN relaunched_at TEXT",
        "CREATE INDEX topologies_fitting ON topologies (run_id) WHERE state = 'fitting'",
    ),
    # 14: engine updates (ADR-0020). The floor, kept as text in `meta` beside the feed's
    # identity, rises with each migration that raises it, to that migration's number. It starts
    # at 14: an engine that knows fewer migrations refuses any newer database anyway, as it
    # knows no floor, so a run on one resumes on a newer engine. Each engine an agent serves from
    # is recorded with how many migrations it knows and when it last served, so housekeeping
    # keeps an engine in use and Resume can tell one below the floor. Housekeeping finds the
    # requests finished long ago by an index.
    additive(
        "INSERT INTO meta (key, value) VALUES ('floor', '14')",
        """CREATE TABLE engines (
            key TEXT PRIMARY KEY,
            migrations INTEGER NOT NULL,
            served_at TEXT NOT NULL
        )""",
        "CREATE INDEX requests_finished ON requests (finished_at) WHERE finished_at IS NOT NULL",
    ),
    # 15: Optimization progress (#286). Each try keeps its **Progress curve**, at most 64 points
    # its coordinator thins from its Start log (`icmm.progress`), as JSON, once it has read the
    # log; Topology's read walks the tries that have one by start.
    additive(
        "ALTER TABLE start_tries ADD COLUMN curve TEXT",
        "CREATE INDEX start_tries_curves ON start_tries (run_id, graph, open_state, start_index, "
        "try) WHERE curve IS NOT NULL",
    ),
    # 16: each run's finished starts **Still improving** at their end (#240), counted from the
    # tries recorded so far. A trigger keeps the count from each try's own `still_improving`, so
    # a run whose older engine knows nothing of it counts too (ADR-0020). Only a start that ran
    # its whole budget says, and that start has finished.
    additive(
        "ALTER TABLE runs ADD COLUMN starts_still_improving INTEGER NOT NULL DEFAULT 0",
        "UPDATE runs SET starts_still_improving = (SELECT COUNT(*) FROM start_tries t "
        "WHERE t.run_id = runs.id AND t.still_improving = 1)",
        """CREATE TRIGGER start_tries_still_improving
            AFTER UPDATE OF still_improving ON start_tries
            WHEN (NEW.still_improving IS 1) != (OLD.still_improving IS 1)
        BEGIN
            UPDATE runs SET starts_still_improving = starts_still_improving
                + (NEW.still_improving IS 1) - (OLD.still_improving IS 1)
            WHERE id = NEW.run_id;
        END""",
    ),
    # 17: when each generation of a run's coordinator ended, and its exit code, for its
    # coordinating job log (#289). A generation records its own as it stops; one killed outright
    # is recorded by whoever finds it gone, with the scheduler's exit code where it keeps one.
    additive(
        "ALTER TABLE coordinators ADD COLUMN ended_at TEXT",
        "ALTER TABLE coordinators ADD COLUMN exit_code INTEGER",
    ),
    # 18: how much each run's folder holds, for Delete run… (#313). Its coordinator adds up the
    # bytes of each try's result, Start log and job log as it collects the try, so the agent never
    # walks the folder (ADR-0013). A run submitted since starts at 0; one from before keeps
    # `NULL`, since what was collected before can't be counted, and a part would undercount.
    additive("ALTER TABLE runs ADD COLUMN folder_bytes INTEGER"),
    # 19: Run detail past 2,000 topologies (#312). Each run's **Stretches**: how many of its
    # topologies completed in each stretch of its time since its first array, beside its best at
    # the stretch's end, which its coordinator keeps as it collects (`icmm.stretches`); a stretch
    # lasts `stretch_s`. A run submitted since starts at a minute; one from before keeps `NULL`
    # and none, since what was collected before can't be placed. Run detail finds a run's
    # fitting, next and failed topologies in the order they go out along another index.
    additive(
        "ALTER TABLE runs ADD COLUMN stretch_s INTEGER",
        """CREATE TABLE run_stretches (
            run_id INTEGER NOT NULL REFERENCES runs (id),
            stretch INTEGER NOT NULL,
            topologies_complete INTEGER NOT NULL,
            best_train_rmse REAL,
            best_val_rmse REAL,
            PRIMARY KEY (run_id, stretch)
        )""",
        "CREATE INDEX topologies_state ON topologies (run_id, state, position)",
    ),
    # 20: each time a run ended and was resumed (#326), as a JSON list: how it ended, when, when
    # its Resume was accepted, and when the stretch of fitting it ended had begun (`ran_from`).
    # Resume moves that from `first_running_at`, which it clears, so the coordinator of any
    # engine sets it again when a start next runs. A run's fitting time, from which its ETA
    # comes, leaves out each stop. A run resumed before keeps none, since when it had stopped
    # wasn't kept.
    additive("ALTER TABLE runs ADD COLUMN stops TEXT NOT NULL DEFAULT '[]'"),
    # 21: how many starts its cancel stopped while they ran (#324), which Resume fits again from
    # the beginning; Resume moves it into the stop it records, with how far the run had got and
    # why it failed, so Run detail draws the stop as a stage. An older engine's coordinator
    # counts none, and an older engine's stops have none of these.
    additive("ALTER TABLE runs ADD COLUMN starts_stopped INTEGER NOT NULL DEFAULT 0"),
    # 22: Results' reads across runs (#341). Each run keeps its **Ranking group**: its dataset
    # and its pinned revision's scoring digest, which a trigger copies as the run is recorded,
    # whichever engine records it (ADR-0020). A dataset's runs list by group along an index, and
    # each run counts its topologies that rank, those with a Best start, by triggers too.
    # A group's leaderboard merges its runs' walks, each along one of six indexes of the run's
    # ranked topologies, one per order, so a page reads about its own rows whatever the group's
    # size. Each holds the Val rank's keys, so ties go by it, and Near best, so a filter on it
    # reads no row. "—" sorts after every number as a key that's infinity where its RMSE, near
    # best or spread is null.
    additive(
        "ALTER TABLE topologies ADD COLUMN rank_val REAL "
        "GENERATED ALWAYS AS (COALESCE(best_val_rmse, 9e999)) VIRTUAL",
        "ALTER TABLE topologies ADD COLUMN rank_train REAL "
        "GENERATED ALWAYS AS (COALESCE(best_train_rmse, 9e999)) VIRTUAL",
        "ALTER TABLE topologies ADD COLUMN near_key REAL "
        "GENERATED ALWAYS AS (COALESCE(near_best, 9e999)) VIRTUAL",
        "ALTER TABLE topologies ADD COLUMN spread_key REAL "
        "GENERATED ALWAYS AS (COALESCE(spread, 9e999)) VIRTUAL",
        "CREATE INDEX topologies_by_rank ON topologies "
        "(run_id, rank_val, rank_train, position, near_key) WHERE best_start IS NOT NULL",
        "CREATE INDEX topologies_by_train ON topologies "
        "(run_id, rank_train, rank_val, position, near_key) WHERE best_start IS NOT NULL",
        "CREATE INDEX topologies_by_near_best ON topologies "
        "(run_id, near_key, rank_val, rank_train, position) WHERE best_start IS NOT NULL",
        "CREATE INDEX topologies_by_spread ON topologies "
        "(run_id, spread_key, rank_val, rank_train, position, near_key) "
        "WHERE best_start IS NOT NULL",
        "CREATE INDEX topologies_by_starts ON topologies "
        "(run_id, starts_finished, rank_val, rank_train, position, near_key) "
        "WHERE best_start IS NOT NULL",
        "CREATE INDEX topologies_by_id ON topologies "
        "(run_id, graph, open_state, rank_val, rank_train, near_key) WHERE best_start IS NOT NULL",
        "ALTER TABLE runs ADD COLUMN topologies_ranked INTEGER NOT NULL DEFAULT 0",
        "UPDATE runs SET topologies_ranked = (SELECT COUNT(*) FROM topologies t "
        "WHERE t.run_id = runs.id AND t.best_start IS NOT NULL)",
        """CREATE TRIGGER topologies_ranked_insert AFTER INSERT ON topologies
            WHEN NEW.best_start IS NOT NULL
        BEGIN
            UPDATE runs SET topologies_ranked = topologies_ranked + 1 WHERE id = NEW.run_id;
        END""",
        """CREATE TRIGGER topologies_ranked_update AFTER UPDATE OF best_start ON topologies
            WHEN (NEW.best_start IS NULL) != (OLD.best_start IS NULL)
        BEGIN
            UPDATE runs SET topologies_ranked = topologies_ranked
                + (NEW.best_start IS NOT NULL) - (OLD.best_start IS NOT NULL)
            WHERE id = NEW.run_id;
        END""",
        """CREATE TRIGGER topologies_ranked_delete AFTER DELETE ON topologies
            WHEN OLD.best_start IS NOT NULL
        BEGIN
            UPDATE runs SET topologies_ranked = topologies_ranked - 1 WHERE id = OLD.run_id;
        END""",
        "ALTER TABLE runs ADD COLUMN scoring_digest TEXT",
        "UPDATE runs SET scoring_digest = (SELECT p.scoring_digest FROM dataset_revisions p "
        "WHERE p.dataset_id = runs.dataset_id AND p.revision = runs.dataset_revision)",
        """CREATE TRIGGER runs_scoring_digest AFTER INSERT ON runs
        BEGIN
            UPDATE runs SET scoring_digest = (SELECT p.scoring_digest FROM dataset_revisions p
                WHERE p.dataset_id = NEW.dataset_id AND p.revision = NEW.dataset_revision)
            WHERE id = NEW.id;
        END""",
        "CREATE INDEX runs_ranking ON runs (dataset_id, scoring_digest, id) "
        "WHERE deleted_at IS NULL",
    ),
    # 23: how far each try's Train RMSE fell over the last 10 % of its evaluations (#342), for
    # Compare's Still improving row. A try an older engine recorded keeps `NULL`, since its
    # worker didn't measure it.
    additive("ALTER TABLE start_tries ADD COLUMN still_improving_change REAL"),
    # 24: Results' "↓ N still improving" (RF20, #368) counts every row its filters keep, not a
    # page's. Each topology marks whether its Best start's try was **Still improving** at its
    # end, and each run counts its ranked topologies so marked, by triggers, so the marks follow
    # whichever engine's coordinator moves a Best start (ADR-0020). A topology's mark is set
    # when its Best start moves, or when that start's try says it was still improving.
    additive(
        "ALTER TABLE topologies ADD COLUMN best_still_improving INTEGER NOT NULL DEFAULT 0",
        "UPDATE topologies SET best_still_improving = COALESCE((SELECT a.still_improving "
        "FROM starts s JOIN start_tries a ON a.run_id = s.run_id AND a.graph = s.graph "
        "AND a.open_state = s.open_state AND a.start_index = s.start_index AND a.try = s.try "
        "WHERE s.run_id = topologies.run_id AND s.graph = topologies.graph "
        "AND s.open_state = topologies.open_state AND s.start_index = topologies.best_start), 0) "
        "WHERE best_start IS NOT NULL",
        """CREATE TRIGGER topologies_best_still_improving_insert AFTER INSERT ON topologies
            WHEN NEW.best_start IS NOT NULL
        BEGIN
            UPDATE topologies SET best_still_improving = COALESCE((SELECT a.still_improving
                FROM starts s JOIN start_tries a ON a.run_id = s.run_id AND a.graph = s.graph
                    AND a.open_state = s.open_state AND a.start_index = s.start_index
                    AND a.try = s.try
                WHERE s.run_id = NEW.run_id AND s.graph = NEW.graph
                    AND s.open_state = NEW.open_state AND s.start_index = NEW.best_start), 0)
            WHERE run_id = NEW.run_id AND graph = NEW.graph AND open_state = NEW.open_state;
        END""",
        """CREATE TRIGGER topologies_best_still_improving AFTER UPDATE OF best_start ON topologies
        BEGIN
            UPDATE topologies SET best_still_improving = COALESCE((SELECT a.still_improving
                FROM starts s JOIN start_tries a ON a.run_id = s.run_id AND a.graph = s.graph
                    AND a.open_state = s.open_state AND a.start_index = s.start_index
                    AND a.try = s.try
                WHERE s.run_id = NEW.run_id AND s.graph = NEW.graph
                    AND s.open_state = NEW.open_state AND s.start_index = NEW.best_start), 0)
            WHERE run_id = NEW.run_id AND graph = NEW.graph AND open_state = NEW.open_state;
        END""",
        """CREATE TRIGGER start_tries_best_still_improving
            AFTER UPDATE OF still_improving ON start_tries
        BEGIN
            UPDATE topologies SET best_still_improving = COALESCE(NEW.still_improving, 0)
            WHERE run_id = NEW.run_id AND graph = NEW.graph AND open_state = NEW.open_state
                AND best_start = NEW.start_index
                AND NEW.try = (SELECT s.try FROM starts s WHERE s.run_id = NEW.run_id
                    AND s.graph = NEW.graph AND s.open_state = NEW.open_state
                    AND s.start_index = NEW.start_index);
        END""",
        "ALTER TABLE runs ADD COLUMN topologies_still_improving INTEGER NOT NULL DEFAULT 0",
        "UPDATE runs SET topologies_still_improving = (SELECT COUNT(*) FROM topologies t "
        "WHERE t.run_id = runs.id AND t.best_start IS NOT NULL AND t.best_still_improving = 1)",
        """CREATE TRIGGER topologies_still_improving_update
            AFTER UPDATE OF best_start, best_still_improving ON topologies
            WHEN (NEW.best_start IS NOT NULL AND NEW.best_still_improving = 1)
                != (OLD.best_start IS NOT NULL AND OLD.best_still_improving = 1)
        BEGIN
            UPDATE runs SET topologies_still_improving = topologies_still_improving
                + (NEW.best_start IS NOT NULL AND NEW.best_still_improving = 1)
                - (OLD.best_start IS NOT NULL AND OLD.best_still_improving = 1)
            WHERE id = NEW.run_id;
        END""",
        """CREATE TRIGGER topologies_still_improving_delete AFTER DELETE ON topologies
            WHEN OLD.best_start IS NOT NULL AND OLD.best_still_improving = 1
        BEGIN
            UPDATE runs SET topologies_still_improving = topologies_still_improving - 1
            WHERE id = OLD.run_id;
        END""",
    ),
    # 25: a try whose CMA-ES overflowed (#468) ended **Finished** with its best so far. It keeps
    # `end_reason` 'budget', which here means it finished, so an older engine on the same
    # database reads it as the finished start it is (ADR-0020); `overflowed` is 1 for one that
    # ended so, which the reads say as the end reason "overflow".
    additive("ALTER TABLE start_tries ADD COLUMN overflowed INTEGER"),
    # 26: when the scheduler first said a try's task ended, while its result may still be on its
    # way (`result_grace_s`): from then it no longer counts running, so a start the scheduler runs
    # in its slot never takes the count past the cap (#469). A try an older engine coordinates
    # keeps `NULL`, counted running until it's collected, as that engine counts it.
    additive("ALTER TABLE start_tries ADD COLUMN task_ended_at TEXT"),
    # 27: the name of the dataset a dataset was duplicated from, as it was when the copy was made
    # (#530), which Dataset detail's facts say. Nothing updates it: the copy is independent. A
    # dataset saved, imported or saved again as a new one keeps `NULL`, and so does a copy an
    # older engine made.
    additive("ALTER TABLE datasets ADD COLUMN copied_from TEXT"),
    # 28: a running try's own pace (#542), as its coordinator last read its Start log: its time
    # for an evaluation between its first log point and its latest, so the worker's start-up
    # isn't counted, and when it ends at that pace, from when that point was read. `NULL` until
    # it has logged past its first point, and for a try an older engine coordinates: its run's
    # ETA then waits for a topology to end.
    additive(
        "ALTER TABLE start_tries ADD COLUMN live_seconds_per_evaluation REAL",
        "ALTER TABLE start_tries ADD COLUMN live_end TEXT",
    ),
)
"""Each migration, in order. Append only: never edit a shipped one.

A change to the shape of what a table stores as JSON (the Platform settings) is a migration
too, so an older engine refuses the database rather than misreading it: one that raises the
floor."""


class NewerSchemaError(Exception):
    """The database's floor is above this engine: a newer engine migrated it past what this one
    can use."""


class HandOverPendingError(Exception):
    """A migration that raises the floor waits for the runs in flight to be handed to this
    engine: their older coordinators are still finishing their sweeps."""


class HandOver(Protocol):
    """How a floor-raising migration hands the runs in flight to the engine applying it
    (ADR-0020)."""

    def ready(self, conn: sqlite3.Connection, floor: int) -> bool:
        """Asks every older coordinator to finish its sweep and stop, outside any transaction;
        whether none still carries a run."""
        ...

    def finish(self, conn: sqlite3.Connection) -> None:
        """In the migration's transaction, once it has run: the runs in flight are this
        engine's."""
        ...


class RunsDb:
    """The runs database of one Data folder, opened lazily, one connection per thread."""

    def __init__(
        self,
        data_folder: Path,
        *,
        busy_timeout_ms: int | None = None,
        hand_over: HandOver | None = None,
    ) -> None:
        """`busy_timeout_ms` by default is `ICMM_BUSY_TIMEOUT_MS`, else `BUSY_TIMEOUT_MS`.
        `hand_over` lets this engine raise the floor with runs in flight: the agent's. Without
        it, such a migration waits for an agent (`HandOverPendingError`)."""
        self.path = data_folder / FILE_NAME
        if busy_timeout_ms is None:
            busy_timeout_ms = int(os.environ.get("ICMM_BUSY_TIMEOUT_MS", BUSY_TIMEOUT_MS))
        self.busy_timeout_ms = busy_timeout_ms
        self.migrations = MIGRATIONS
        """The migrations this engine knows."""
        self.hand_over = hand_over
        self._local = threading.local()
        self._migrated = False
        self._lock = threading.Lock()

    def connection(self) -> sqlite3.Connection:
        """This thread's connection, the schema brought up to date on first use;
        `NewerSchemaError` once the floor has risen above this engine, so an engine that opened
        the database before reads nothing it would misread."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = _connect(self.path, self.busy_timeout_ms)
            self._local.conn = conn
        if not self._migrated:
            with self._lock:
                if not self._migrated:
                    migrate(conn, self.migrations, hand_over=self.hand_over)
                    self._migrated = True
                    return conn
        _check_floor(conn, self.known)
        return conn

    def close(self) -> None:
        """Closes this thread's connection, if it has one, without migrating: an engine that
        stops below the floor closes so."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    @property
    def known(self) -> int:
        """How many migrations this engine knows."""
        return len(self.migrations)

    @contextmanager
    def write(self) -> Generator[sqlite3.Connection]:
        """A transaction that takes the write lock at once, so its reads see what it writes over.
        `NewerSchemaError` once the floor has risen above this engine."""
        conn = self.connection()
        with transaction(conn):
            _check_floor(conn, self.known)  # again, now that no other write can come between
            yield conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Generator[None]:
    """`BEGIN IMMEDIATE` … `COMMIT`, rolled back on any failure, the commit's own included.

    A commit that fails (another machine's read outlasting the busy timeout) leaves SQLite's
    transaction open, holding its lock; a retry on this connection would then read its own
    uncommitted writes as saved. A failure SQLite already rolled back (a full disk) has nothing
    left to roll back.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def _connect(path: Path, busy_timeout_ms: int) -> sqlite3.Connection:
    # Autocommit: transactions are begun explicitly, so none is left open by a read.
    conn = sqlite3.connect(path, timeout=busy_timeout_ms / 1000, isolation_level=None)
    conn.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
    mode = conn.execute("PRAGMA journal_mode = TRUNCATE").fetchone()[0]
    if str(mode).lower() != "truncate":
        raise sqlite3.OperationalError(f"journal_mode is {mode}, not truncate")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migrate(
    conn: sqlite3.Connection,
    migrations: Sequence[Migration],
    *,
    hand_over: HandOver | None = None,
) -> None:
    """Runs each of `migrations` the database lacks, each in its own transaction; against a
    database a newer engine migrated, checks only the floor.

    Another process may migrate at the same moment, so each checks the version again once it
    holds the write lock. One that raises the floor while a run is in flight hands the runs over
    first with `hand_over`; without one, or until it's ready, `HandOverPendingError`.
    """
    if _version(conn) > len(migrations):
        _check_floor(conn, len(migrations))
        return
    for number, migration in enumerate(migrations, start=1):
        if _version(conn) >= number:
            continue
        handing_over = migration.raises_floor and _in_flight(conn)
        if handing_over and (hand_over is None or not hand_over.ready(conn, number)):
            raise HandOverPendingError(f"migration {number} waits for the runs in flight")
        with transaction(conn):
            if _version(conn) < number:
                # A run that came into flight since nothing was: it's handed over first.
                if migration.raises_floor and not handing_over and _in_flight(conn):
                    raise HandOverPendingError(f"migration {number} waits for the runs in flight")
                for statement in migration.statements:
                    conn.execute(statement)
                if migration.raises_floor:
                    conn.execute("UPDATE meta SET value = ? WHERE key = 'floor'", (str(number),))
                    if hand_over is not None:
                        hand_over.finish(conn)
                conn.execute(f"PRAGMA user_version = {number}")


def floor(conn: sqlite3.Connection) -> int:
    """The fewest migrations an engine must know to use the database. One migrated past this
    engine without a floor recorded is taken to need every migration it has."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'floor'").fetchone()
    return _version(conn) if row is None else int(row[0])


def _check_floor(conn: sqlite3.Connection, known: int) -> None:
    """`NewerSchemaError` when a newer engine has raised the floor above `known`."""
    version = _version(conn)
    if version > known and (at := floor(conn)) > known:
        raise NewerSchemaError(f"schema {version}, floor {at}, this engine knows {known}")


def _in_flight(conn: sqlite3.Connection) -> bool:
    """Whether a run is in flight: one a coordinator may carry. A database without runs yet has
    none."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'runs'").fetchone() is None:
        return False
    return (
        conn.execute(
            "SELECT 1 FROM runs INDEXED BY runs_in_flight "
            "WHERE end_seq IS NULL AND deleted_at IS NULL LIMIT 1"
        ).fetchone()
        is not None
    )


@contextmanager
def reading(conn: sqlite3.Connection) -> Generator[None]:
    """A read transaction: its statements see one state of the database, and a commit elsewhere
    waits until it ends. Keep it short: on NFS that wait is every other agent's."""
    conn.execute("BEGIN")
    try:
        yield
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def _version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def append_change(conn: sqlite3.Connection, topic: str, key: str | None = None) -> int:
    """Adds a row to the change feed, in the caller's transaction; answers its `seq`."""
    cursor = conn.execute(
        "INSERT INTO changes (topic, key, at) VALUES (?, ?, ?)", (topic, key, now())
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def feed_id(conn: sqlite3.Connection) -> str:
    """The change feed's identity, made when the database was."""
    return conn.execute("SELECT value FROM meta WHERE key = 'feed'").fetchone()[0]


def now() -> str:
    return iso(datetime.now(UTC))


def iso(at: datetime) -> str:
    """`at`, in UTC, as the database keeps times, so they compare as text."""
    return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
