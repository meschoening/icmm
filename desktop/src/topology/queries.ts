/**
 * What a topology's drawing asks the Active platform's agent: its state
 * graph's edges and open states (`read_state_graphs`), from the same lists
 * the engine fits from. The lists never change, so a read is kept as long as
 * the connection.
 */
import { useQueries } from "@tanstack/react-query";
import { agentKey, canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { StateGraph } from "../wire/types.gen";

/** The most state graphs one read names (`MAX_STATE_GRAPHS`): more are read in parts. */
const PER_READ = 1000;

/**
 * Each of `graphs`' state graphs with `numStates` states, by number, once
 * every read has answered; `undefined` while any hasn't. A graph the agent
 * couldn't read, twice more, is left out.
 */
export function useStateGraphs(
  numStates: number,
  graphs: number[],
): ReadonlyMap<number, StateGraph> | undefined {
  const c = useConnection();
  const sorted = [...new Set(graphs)].sort((a, b) => a - b);
  const parts = Array.from({ length: Math.ceil(sorted.length / PER_READ) }, (_, i) =>
    sorted.slice(i * PER_READ, (i + 1) * PER_READ),
  );
  return useQueries({
    queries: parts.map((part) => ({
      queryKey: agentKey(platformOf(c), "state_graphs", numStates, part.join(",")),
      queryFn: () => commands.read_state_graphs({ num_states: numStates, graphs: part }),
      enabled: canAsk(c),
      // A read is a few seeks: one that failed on a busy connection is worth asking again.
      retry: 2,
    })),
    combine: (results) =>
      results.some((r) => r.isPending)
        ? undefined
        : new Map(results.flatMap((r) => r.data?.state_graphs ?? []).map((g) => [g.graph, g])),
  });
}
