/**
 * What ⌘K searches (#408): every page of `list_runs`, `list_datasets` and
 * `list_configs`, and `runs_overview`, read on the palette's first open in
 * a connection and kept in the query cache, under the keys their pages keep
 * them at where they share one. The cache keeps an answer until the change
 * feed marks it stale (`useAgentDataFollowsChanges`); the next open reads it
 * again, so typing never waits on the platform. Until its read of the runs
 * is in, and while the connection is down, it searches the runs Runs and Home
 * hold (their first pages), "so far" while its own read is out (KF03). While
 * the connection is down, it searches what was read, as of when it went. A topology
 * or start typed whole takes one `read_topology` or `read_start`, under the
 * keys Topology and the Start page keep them at.
 */
import {
  useQuery,
  useQueryClient,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
  type InfiniteData,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { allConfigs } from "../../configs/queries";
import { allDatasets } from "../../datasets/queries";
import { agentKey, canAsk, platformOf } from "../../setup/queries";
import { commands } from "../../wire/api.gen";
import type { RunList, RunSummary } from "../../wire/types.gen";
import { useConnection } from "../connection";
import type { GroupKind, Index } from "./search";

/** Every run on the platform, in Runs' order: in flight newest first, then ended latest first. */
export async function allRuns(): Promise<RunSummary[]> {
  const all: RunSummary[] = [];
  let after: string | null = null;
  do {
    const page: RunList = await commands.list_runs({
      filter: null,
      dataset: null,
      config: null,
      after,
    });
    all.push(...page.runs);
    after = page.next;
  } while (after !== null);
  return all;
}

/**
 * A read's state, for its group: in; still being read, with what pages hold searched meanwhile
 * ("so far"); still being read, which Try again asks again (KF04); failed; or not read and can't
 * be.
 */
export type ReadState =
  | { kind: "in" }
  | { kind: "so far" }
  | { kind: "reading"; retry: () => void }
  | { kind: "failed"; error: unknown; retry: () => void }
  | { kind: "none" };

function stateOf(q: UseQueryResult<unknown>, ask: boolean, again: () => void): ReadState {
  if (q.data !== undefined) return { kind: "in" };
  if (q.isError && !q.isFetching) {
    return { kind: "failed", error: q.error, retry: () => void q.refetch() };
  }
  return ask ? { kind: "reading", retry: again } : { kind: "none" };
}

/**
 * Asks `q` again: a refetch alone would wait on the read already asked, so it's dropped first,
 * as Home's Try again does (#399, HF12).
 */
const askAgain = (client: QueryClient, q: UseQueryResult<unknown>, queryKey: QueryKey) => () =>
  void client.cancelQueries({ queryKey, exact: true }).then(() => q.refetch());

/** The palette's index, and the state of each group's reads. */
export function usePaletteIndex(): { index: Index; reads: Record<GroupKind, ReadState> } {
  const c = useConnection();
  const platform = platformOf(c);
  const ask = canAsk(c);
  const client = useQueryClient();
  const reads = [
    { queryKey: agentKey(platform, "runs", "all"), queryFn: allRuns },
    { queryKey: agentKey(platform, "runs", "overview"), queryFn: commands.runs_overview },
    { queryKey: agentKey(platform, "datasets", "all"), queryFn: allDatasets },
    { queryKey: agentKey(platform, "configs", "all"), queryFn: allConfigs },
  ] as const;
  // Read once as the palette opens, or as the connection comes up while it's open: only what
  // isn't read or went stale. Its own observers never fetch, so a change the feed reports while
  // it's open (a running run's, every sweep) waits for the next open (#408).
  useEffect(() => {
    if (!ask) return;
    for (const read of reads) void client.prefetchQuery(read as FetchQueryOptions);
    // `reads` is new each render; its keys follow `platform`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ask, platform]);
  const runs = useQuery({ ...reads[0], enabled: false });
  const overview = useQuery({ ...reads[1], enabled: false });
  const datasets = useQuery({ ...reads[2], enabled: false });
  const configs = useQuery({ ...reads[3], enabled: false });
  // Until the palette's own read is in, the runs Runs and Home read (their first pages) are
  // searched: "so far" while its read is out, and, not connected, what was read.
  const listedPages = client.getQueryData<InfiniteData<RunList>>(
    agentKey(platform, "runs", "list", "", null, null),
  )?.pages;
  const listed = listedPages?.flatMap((p) => p.runs);
  const state = (q: UseQueryResult<unknown>, i: number) =>
    stateOf(q, ask, askAgain(client, q, reads[i].queryKey));
  const own = state(runs, 0);
  const runsRead = runs.data ?? (own.kind === "failed" ? undefined : listed);
  const runsState: ReadState =
    runs.data !== undefined
      ? { kind: "in" }
      : runsRead === undefined
        ? own
        : own.kind === "reading"
          ? { kind: "so far" }
          : { kind: "in" };
  const overviewState = state(overview, 1);
  const datasetsState = state(datasets, 2);
  // A result needs the overview and the datasets, and the runs to match by them and name them:
  // without the runs, which Runs shows failed, results match by their dataset's name alone.
  const needs =
    runsState.kind === "failed"
      ? [overviewState, datasetsState]
      : [runsState, overviewState, datasetsState];
  const pending = needs.filter((x) => x.kind === "reading");
  const results: ReadState = needs.find((x) => x.kind === "failed") ??
    // Its Try again asks again for each of its reads still out.
    (pending.length > 0
      ? { kind: "reading", retry: () => pending.forEach((x) => x.retry()) }
      : undefined) ??
    needs.find((x) => x.kind === "none") ??
    needs.find((x) => x.kind === "so far") ?? { kind: "in" };
  return {
    index: {
      runs: runsRead,
      runsPartial: runs.data === undefined && listedPages?.at(-1)?.next != null,
      overview: overview.data,
      datasets: datasets.data,
      configs: configs.data,
    },
    reads: {
      runs: runsState,
      results,
      datasets: datasetsState,
      configs: state(configs, 3),
    },
  };
}

/** Where Topology keeps a topology's read, and the palette with it. */
export const topologyKey = (
  platform: string,
  ref: { run: number; graph: number; openState: number } | undefined,
) => agentKey(platform, "runs", "topology", ref?.run, ref?.graph, ref?.openState);

/** Where the Start page keeps a start's read, and the palette with it. */
export const startKey = (
  platform: string,
  ref: { run: number; graph: number; openState: number; start: number } | undefined,
) =>
  agentKey(
    platform,
    "runs",
    "start",
    ref === undefined
      ? undefined
      : { run: ref.run, graph: ref.graph, openState: ref.openState, start: ref.start },
  );

/** A topology or start typed whole, read once; neither asks anything without its `ref`. */
export function useTypedReads(
  topology: { run: number; graph: number; openState: number } | undefined,
  start: { run: number; graph: number; openState: number; start: number } | undefined,
) {
  const c = useConnection();
  const platform = platformOf(c);
  const ask = canAsk(c);
  const client = useQueryClient();
  const t = useQuery({
    queryKey: topologyKey(platform, topology),
    queryFn: () =>
      commands.read_topology({
        run: topology!.run,
        graph: topology!.graph,
        open_state: topology!.openState,
      }),
    enabled: topology !== undefined && ask,
  });
  const s = useQuery({
    queryKey: startKey(platform, start),
    queryFn: () =>
      commands.read_start({
        run: start!.run,
        graph: start!.graph,
        open_state: start!.openState,
        start: start!.start,
      }),
    enabled: start !== undefined && ask,
  });
  return {
    topology:
      topology === undefined
        ? undefined
        : {
            data: t.data,
            state: stateOf(t, ask, askAgain(client, t, topologyKey(platform, topology))),
          },
    start:
      start === undefined
        ? undefined
        : { data: s.data, state: stateOf(s, ask, askAgain(client, s, startKey(platform, start))) },
  };
}
