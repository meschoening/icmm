/**
 * What Home's Best per dataset and Ended read (#391): the datasets, Runs'
 * overview (each dataset's runs, latest run and best; how many runs ended)
 * and the runs list read on past every run in flight to the latest 3 ended,
 * since `list_runs` lists those in flight first. Each is one bounded read
 * (ADR-0013), and Runs and Datasets read the same ones under the same keys.
 */
import { useMemo } from "react";
import { useDatasets } from "../datasets/queries";
import { useRunsOverview, useRunsUpTo } from "../runs/queries";
import type { DatasetSummary, RunsOverview, RunSummary } from "../wire/types.gen";
import { ENDED_SHOWN } from "./ended";

export interface BestEndedReads {
  datasets: DatasetSummary[];
  overview: RunsOverview;
  /** Every run in flight, then at least the latest ended ones Home shows, while there are. */
  runs: RunSummary[];
}

export function useBestEndedReads() {
  const datasets = useDatasets();
  // As Home's own: a failed read waits for Try again (#400).
  const overview = useRunsOverview(true, { retryOnMount: false });
  const counts = overview.data?.counts;
  const inFlight =
    counts === undefined ? 0 : counts.running + counts.canceling + counts.queued + counts.held;
  const list = useRunsUpTo(inFlight + ENDED_SHOWN, null);
  const pages = list.list.data?.pages;
  const placeholder = list.list.isPlaceholderData;
  // One array per answer, so a page that keeps its reads sees the same ones.
  const runs = useMemo(() => pages?.flatMap((p) => p.runs) ?? [], [pages]);
  const reads = useMemo<BestEndedReads | undefined>(
    () =>
      // A placeholder is the list before this one: another platform's, after a switch.
      datasets.data === undefined || overview.data === undefined || !list.done || placeholder
        ? undefined
        : { datasets: datasets.data, overview: overview.data, runs },
    [datasets.data, overview.data, list.done, placeholder, runs],
  );
  const error = datasets.error ?? overview.error ?? list.list.error ?? undefined;
  // The first that failed again, as Try again's "same error" reads it.
  const refetch = () =>
    Promise.all([datasets.refetch(), overview.refetch(), list.list.refetch()]).then((all) => ({
      error: all.find((r) => r.error !== null)?.error ?? undefined,
    }));
  const fetching = datasets.isFetching || overview.isFetching || list.list.isFetching;
  return { reads, error, refetch, fetching };
}
