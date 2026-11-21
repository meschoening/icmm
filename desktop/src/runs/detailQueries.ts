/**
 * What Run detail reads beside `read_run` (#237): the run's topologies in
 * both orders (`list_topologies`: ranked for the table and the spread plot,
 * in the order they're sent for the grid and the chart; past 2,000, only
 * those fitting, next and failed, and its **Stretches** for the chart,
 * `run_stretches`, #312), the topology fitting now (`read_topology`, for its
 * array and queue), each failed topology's starts by cause (`list_starts`),
 * and its dataset revision (`read_dataset_revision`, for its protocols, or
 * that it can't be read). The topologies and stretches are kept under
 * `agentKey(…, "runs")`, so the change feed's `runs` reads them again; what
 * can't change (a failed topology's starts, a revision) is read once. A
 * disconnect forgets them all.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentKey, canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type {
  FailedStarts,
  StartCause,
  TopologyOrder,
  TopologyState,
  TopologySummary,
  WireError,
} from "../wire/types.gen";

/**
 * The most pages of topologies the page reads in either order: 2,000
 * topologies, at most 4 bounded queries (ADR-0013). A run holds at most
 * 100,000 starts, so this is every topology of a run at 50 starts or more each.
 */
export const TOPOLOGY_PAGES = 4;

export interface Topologies {
  topologies: TopologySummary[];
  /** How many of the run's topologies rank. */
  ranked: number;
  /** Whether the run has more than were read. */
  more: boolean;
}

async function readTopologies(
  run: number,
  order: TopologyOrder,
  state: TopologyState | null,
  pages: number,
): Promise<Topologies> {
  const topologies: TopologySummary[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let ranked = 0;
  for (let page = 0; page < pages; page++) {
    const list = await commands.list_topologies({ run, order, state, after });
    // A topology whose rank moved between pages can be listed twice: it keeps its first place.
    for (const t of list.topologies) {
      const key = `${t.graph}.${t.open_state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      topologies.push(t);
    }
    ranked = list.ranked;
    after = list.next;
    if (after === null) break;
  }
  return { topologies, ranked, more: after !== null };
}

/**
 * Run `run`'s topologies in `order`, only those in `state` if given (in the
 * order they're sent), up to `pages` pages.
 */
export function useTopologies(
  run: number | undefined,
  order: TopologyOrder,
  state: TopologyState | null = null,
  pages = TOPOLOGY_PAGES,
) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "topologies", run, order, state, pages),
    queryFn: () => readTopologies(run!, order, state, pages),
    enabled: run !== undefined && canAsk(c),
  });
}

/** Run `run`'s **Stretches**, for its progress chart past 2,000 topologies (#312). */
export function useRunStretches(run: number | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "stretches", run),
    queryFn: () => commands.run_stretches({ run: run! }),
    enabled: run !== undefined && canAsk(c),
  });
}

/** One topology of run `run` in full: its arrays, and its starts queued and waiting. */
export function useTopology(
  run: number | undefined,
  t: { graph: number; open_state: number } | undefined,
) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "topology", run, t?.graph, t?.open_state),
    queryFn: () =>
      commands.read_topology({ run: run!, graph: t!.graph, open_state: t!.open_state }),
    enabled: run !== undefined && t !== undefined && canAsk(c),
  });
}

/** The most failed topologies whose starts are read for their causes. */
const CAUSES_READ = 20;

/** Count causes a page at a time, publishing totals only after the last page succeeds. */
async function readFailedCauses(
  run: number,
  graph: number,
  open_state: number,
): Promise<FailedStarts[]> {
  const by = new Map<StartCause, number>();
  let after: string | null = null;
  do {
    const list = await commands.list_starts({ run, graph, open_state, after });
    for (const s of list.starts) {
      if (s.state === "failed" && s.cause !== null) by.set(s.cause, (by.get(s.cause) ?? 0) + 1);
    }
    after = list.next;
  } while (after !== null);
  return [...by].map(([cause, starts]) => ({ cause, starts })).sort((x, y) => y.starts - x.starts);
}

/**
 * Each of `failed`'s failed starts counted by cause, most first, by topology
 * key (`graph.open_state`), across every page of starts; a topology not
 * fully read yet is missing.
 */
export function useFailedCauses(
  run: number | undefined,
  failed: TopologySummary[],
): Map<string, FailedStarts[]> {
  const c = useConnection();
  const read = failed.slice(0, CAUSES_READ);
  return useQueries({
    queries: read.map((t) => ({
      // A failed topology's starts change only when a Resume sends them again, which moves its
      // last end and its failed count: `runs` changes otherwise leave them be.
      queryKey: agentKey(
        platformOf(c),
        "failed_starts",
        run,
        t.graph,
        t.open_state,
        t.starts_failed,
        t.last_ended_at,
      ),
      queryFn: () => readFailedCauses(run!, t.graph, t.open_state),
      enabled: run !== undefined && canAsk(c),
    })),
    combine: (results) => {
      const out = new Map<string, FailedStarts[]>();
      results.forEach((q, i) => {
        if (q.data === undefined) return;
        out.set(`${read[i].graph}.${read[i].open_state}`, q.data);
      });
      return out;
    },
  });
}

/** What Run detail says of the run's dataset revision. */
export interface Revision {
  protocols: number | undefined;
  /** Why it can't be read, where it can't. */
  unreadable: "missing" | "damaged" | "newer" | undefined;
}

/**
 * The run's dataset revision, for its protocols, or that it can't be read. A
 * revision never changes, so it's kept by its id as long as the connection.
 */
export function useRevision(dataset: { id: string; revision: number } | undefined): Revision {
  const c = useConnection();
  const q = useQuery({
    queryKey: agentKey(platformOf(c), "revision", dataset?.id, dataset?.revision),
    queryFn: () => commands.read_dataset_revision({ id: dataset!.id, revision: dataset!.revision }),
    enabled: dataset !== undefined && canAsk(c),
    staleTime: Infinity,
    retry: false,
  });
  const error = q.error as unknown as WireError | null;
  return {
    protocols: q.data?.content.protocols.length,
    unreadable: error?.code === "unreadable" ? error.data.problem : undefined,
  };
}
