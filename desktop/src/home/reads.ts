/**
 * What Home's frame and Live read (#390), each one bounded query (ADR-0013):
 * `runs_overview` for Runs' counts, `list_runs` in Runs' order (read on until
 * it reaches the runs that ended before yesterday, a page of 200 at a time),
 * the running cards' runs in full for their ETAs (`read_run`, with
 * `run_timings`), Platform settings for the cap, and the user's cluster jobs
 * for a held run's line. Kept as of when the connection went (`useKept`).
 */
import { useEffect, useMemo, useState } from "react";
import { useMinute, useRunsList, useRunsOverview } from "../runs/queries";
import { canAsk, usePlatformSettings, useReadAgain, useSchedulerLookup } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { useKept } from "../submit/kept";
import { slurmOf } from "../submit/plan";
import { useRuns, useRunTimings, useUserJobs } from "../submit/queries";
import type {
  JobDefaults,
  Run,
  RunsOverview,
  RunSummary,
  RunTiming,
  SavedPlatform,
  WireError,
} from "../wire/types.gen";
import { LIVE_CARDS, yesterdayOf } from "./words";

export interface HomeReads {
  overview: RunsOverview;
  /** In flight, newest first, then ended, the latest end first: at least those since yesterday. */
  runs: RunSummary[];
  /** The running cards' runs, and on This computer the runs a queued card waits on, for their ETAs; `undefined` while read. */
  details: Run[] | undefined;
  timings: RunTiming[] | undefined;
  job: JobDefaults | undefined;
  /** The user's running cluster jobs; `undefined` unread, or not SLURM's. */
  jobs: number | undefined;
  /** The Job defaults' partition; `null` for SLURM's default. */
  partition: string | null;
}

/**
 * `list_runs`, read on while its last run is in flight or ended at or after
 * `cutoff`; a page that failed waits for Try again, and nothing is read
 * while the connection is down.
 */
function useRunsSince(cutoff: number) {
  const c = useConnection();
  const list = useRunsList("", null);
  const runs = useMemo(() => list.data?.pages.flatMap((p) => p.runs), [list.data]);
  const last = runs?.at(-1);
  const short =
    last !== undefined &&
    list.hasNextPage &&
    (last.ended_at === null || Date.parse(last.ended_at) >= cutoff);
  const go = short && canAsk(c) && !list.isFetchingNextPage && !list.isFetchNextPageError;
  useEffect(() => {
    if (go) void list.fetchNextPage();
  }, [go, list]);
  return { list, runs: short ? undefined : runs };
}

/** `value`, or the one before when it holds the same, so the same answer is the same read. */
function useSame<T>(value: T): T {
  const [kept, setKept] = useState(value);
  const same = kept === value || JSON.stringify(kept) === JSON.stringify(value);
  if (!same) setKept(value);
  return same ? kept : value;
}

export function useHomeReads(platform: Pick<SavedPlatform, "type" | "name"> | undefined) {
  const c = useConnection();
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";
  // A failed read that opened Home in First launch's place waits for Try again (#400).
  const overviewQ = useRunsOverview(true, { retryOnMount: false });
  const { list: listQ, runs } = useRunsSince(yesterdayOf(now));
  const settingsQ = usePlatformSettings();
  const job = settingsQ.data?.saved?.settings.job_defaults;
  const slurm = platform === undefined ? false : slurmOf(job, platform);
  const jobsQ = useUserJobs(slurm);
  const lookupQ = useSchedulerLookup(slurm);
  const timingsQ = useRunTimings();
  const inFlight = (runs ?? []).filter((r) => r.ended_at === null);
  const cards = inFlight.slice(0, LIVE_CARDS);
  const running = cards.filter((r) => r.state === "running" && r.canceling === null);
  // A queued card on This computer says when the run holding the slots ends, a card or not (#399).
  const holding =
    !slurm && cards.some((r) => r.state === "queued")
      ? inFlight.filter((r) => r.progress.starts_running > 0 && !running.includes(r))
      : [];
  const details = useSame(useRuns([...running, ...holding].map((r) => r.id)));
  const partition =
    job?.type === "slurm"
      ? (job.partition ?? lookupQ.data?.slurm?.default_partition ?? null)
      : null;
  const reads: HomeReads | undefined =
    overviewQ.data === undefined || runs === undefined
      ? undefined
      : {
          overview: overviewQ.data,
          runs,
          details,
          timings: timingsQ.data?.timings,
          job,
          jobs: jobsQ.data?.jobs?.running,
          partition,
        };
  const kept = useKept(
    reads,
    {
      connected: c.status === "connected",
      live,
      platform: c.status === "none" ? "" : c.platformId,
      heardAt: heardAtOf(c),
    },
    now,
  );
  const failed = overviewQ.isError ? overviewQ.error : listQ.isError ? listQ.error : undefined;
  const read = useReadAgain(
    kept.value === undefined && failed !== undefined ? (failed as unknown as WireError) : undefined,
    () => Promise.all([overviewQ.refetch(), listQ.refetch()]),
  );
  return {
    reads: kept.value,
    asOf: kept.asOf,
    slurm,
    now,
    failure: read.failure,
    retry: read.retry,
    again: read.again,
    fetching: overviewQ.isFetching || listQ.isFetching,
  };
}
