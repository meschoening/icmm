/**
 * What Results reads (#341): a dataset's Ranking groups (`list_ranking_groups`)
 * for the Data menu and the Runs and States filters, a group's leaderboard a
 * page of 100 at a time (`list_leaderboard`), and each row's state graph, for
 * its parameter count (`read_state_graphs`). Both reads are kept under
 * `agentKey(…, "runs")`, so the change feed's `runs` (and `datasets`) read
 * them again.
 */
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { agentKey, canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { Leaderboard, ListLeaderboardParams, StateGraph } from "../wire/types.gen";

export function useRankingGroups(dataset: string | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "ranking_groups", dataset),
    queryFn: () => commands.list_ranking_groups({ dataset: dataset! }),
    enabled: dataset !== undefined && canAsk(c),
  });
}

/** A leaderboard's params, but the page: `after` is each page's. */
export type LeaderboardAsk = Omit<ListLeaderboardParams, "after">;

/** The group's leaderboard in `ask`'s order and filters, a page at a time; none without `ask`. */
export function useLeaderboard(ask: LeaderboardAsk | undefined) {
  const c = useConnection();
  return useInfiniteQuery({
    queryKey: agentKey(platformOf(c), "runs", "leaderboard", ask),
    queryFn: ({ pageParam }) => commands.list_leaderboard({ ...ask!, after: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Leaderboard) => last.next,
    enabled: ask !== undefined && canAsk(c),
    // A new sort or filter keeps the rows it reorders until its own first page comes, but only
    // in the same platform's same Ranking group: another's rows aren't this one's.
    placeholderData: (previous, query) => {
      const was = query?.queryKey;
      const same =
        was !== undefined &&
        was[1] === platformOf(c) &&
        (was[4] as LeaderboardAsk | undefined)?.dataset === ask?.dataset &&
        (was[4] as LeaderboardAsk | undefined)?.scoring_digest === ask?.scoring_digest;
      return same ? keepPreviousData(previous) : undefined;
    },
  });
}

/** The most state graphs one read names (`MAX_STATE_GRAPHS`). */
const PER_READ = 1000;

/** A topology's state graph's key: its number of states and graph. */
export const graphKey = (numStates: number, graph: number) => `${numStates}/${graph}`;

/**
 * The state graphs of `topologies`, which may have different numbers of
 * states, by `graphKey`, as each read answers. The lists never change, so
 * each is read once a connection, as Topology's drawing reads them.
 */
export function useStateGraphsOf(
  topologies: readonly { num_states: number; graph: number }[],
): ReadonlyMap<string, StateGraph> {
  const c = useConnection();
  const byStates = new Map<number, Set<number>>();
  for (const t of topologies) {
    byStates.set(t.num_states, (byStates.get(t.num_states) ?? new Set()).add(t.graph));
  }
  const reads = [...byStates].flatMap(([numStates, graphs]) => {
    const sorted = [...graphs].sort((a, b) => a - b);
    return Array.from({ length: Math.ceil(sorted.length / PER_READ) }, (_, i) => ({
      numStates,
      part: sorted.slice(i * PER_READ, (i + 1) * PER_READ),
    }));
  });
  return useQueries({
    queries: reads.map(({ numStates, part }) => ({
      queryKey: agentKey(platformOf(c), "state_graphs", numStates, part.join(",")),
      queryFn: () => commands.read_state_graphs({ num_states: numStates, graphs: part }),
      enabled: canAsk(c),
      retry: 2,
    })),
    combine: (results) =>
      new Map(
        results.flatMap((r, i) =>
          (r.data?.state_graphs ?? []).map((g) => [graphKey(reads[i].numStates, g.graph), g]),
        ),
      ),
  });
}
