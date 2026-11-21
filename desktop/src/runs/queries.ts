/**
 * What Runs reads (LaptopRuns): the platform's runs a page at a time, as a
 * filter and a dataset narrow them, and what it says of all of them
 * (`runs_overview`). Both are kept under `agentKey(…, "runs")`, so the change
 * feed's `runs` reads them again (`useAgentDataFollowsChanges`) and a
 * disconnect forgets them. What this computer remembers of each platform's
 * runs is the desktop's, so it's kept apart and a disconnect leaves it.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import { agentKey, canAsk, platformOf, usePlatformSettings } from "../setup/queries";
import { startOverheadS } from "../submit/estimate";
import { etasOf } from "../submit/plan";
import { useRuns, useRunTimings } from "../submit/queries";
import type { RunList, RunSummary } from "../wire/types.gen";

/** The platform's runs, in flight newest first then ended latest first, a page at a time. */
export function useRunsList(filter: string, dataset: string | null, config: string | null = null) {
  const c = useConnection();
  const text = filter.trim();
  return useInfiniteQuery({
    queryKey: agentKey(platformOf(c), "runs", "list", text, dataset, config),
    queryFn: ({ pageParam }) =>
      commands.list_runs({
        filter: text === "" ? null : text,
        dataset,
        config,
        after: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: RunList) => last.next,
    enabled: canAsk(c),
    // A new filter keeps the list it narrows until its own first page comes.
    placeholderData: keepPreviousData,
  });
}

/**
 * `useRunsList` with no filter, read on until it holds `want` runs or there
 * are no more: a narrowed page walks at most the agent's `SCAN` runs, so it
 * can come back short, or empty, with more to walk. `done` once it has.
 */
export function useRunsUpTo(want: number, dataset: string | null, config: string | null = null) {
  const list = useRunsList("", dataset, config);
  const runs = list.data?.pages.flatMap((p) => p.runs) ?? [];
  const short = list.data !== undefined && runs.length < want && list.hasNextPage;
  useEffect(() => {
    if (short && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [short, list]);
  return { list, runs, done: list.data !== undefined && !short };
}

/**
 * How many runs are in each state, and each dataset's runs and best, whatever page they're on.
 * `retryOnMount: false` leaves a failed read for its Try again, rather than reading again as
 * the page opens.
 */
export function useRunsOverview(enabled = true, { retryOnMount = true } = {}) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "overview"),
    queryFn: commands.runs_overview,
    enabled: enabled && canAsk(c),
    retryOnMount,
  });
}

/** The desktop's key for what it remembers of platform `id`'s runs. */
export const runMarksKey = (id: string) => ["desktop", "run_marks", id];

/** What this computer remembers of platform `id`'s runs: kept while it isn't connected. */
export function useRunMarks(id: string | undefined) {
  return useQuery({
    queryKey: runMarksKey(id ?? ""),
    queryFn: () => commands.run_marks({ platform_id: id! }),
    enabled: id !== undefined && id !== "",
    staleTime: Infinity,
  });
}

/** The time now, in Unix ms, read again each minute: ETAs and "left" move on with it. */
export function useMinute(): number {
  return useTick(60_000);
}

/**
 * The time now, in Unix ms, read again every `everyMs`: a run's page reads it
 * every few seconds while the run goes, so a minute-long run's pace and ETA
 * don't divide by a time up to a minute old (#538).
 */
export function useTick(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** A dataset's runs and best on this platform, as `runs_overview` counts them; `undefined` until read. */
export function useDatasetRuns(id: string | undefined) {
  const overview = useRunsOverview(id !== undefined);
  if (id === undefined || overview.data === undefined) return undefined;
  return (
    overview.data.datasets.find((d) => d.id === id) ?? {
      id,
      name: null,
      deleted: false,
      runs: 0,
      runs_earlier: 0,
      runs_in_flight: 0,
      // None: run ids start at 1.
      latest_run: 0,
      best_val: null,
      best_train: null,
    }
  );
}

/**
 * When each running run of `runs` ends: the one ETA Runs, Run detail and
 * Submit show (`etasOf`, #326).
 */
export function useEtas(runs: RunSummary[], now: number): Map<number, number | undefined> {
  const running = runs.filter((r) => r.ended_at === null && r.progress.starts_running > 0);
  const details = useRuns(running.map((r) => r.id));
  const timings = useRunTimings().data?.timings;
  const job = usePlatformSettings().data?.saved?.settings.job_defaults;
  if (details === undefined || job === undefined) return new Map();
  return etasOf(details, {
    timings: timings ?? [],
    cpus: job.cpus_per_start,
    cap: job.max_running_starts,
    overheadS: startOverheadS(job),
    now,
  });
}
