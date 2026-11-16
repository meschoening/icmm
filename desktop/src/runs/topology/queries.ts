/**
 * What Topology reads (#238): the topology (`read_topology`), every one of
 * its starts (`list_starts`, page after page) and their Progress curves
 * (`topology_progress`, #286), the topology ahead of one not sent yet, and
 * whether its run's revision can be read. Each is one bounded
 * query on the agent (ADR-0013), under the agent's `runs` key, so the change
 * feed's `runs` reads it again as the coordinator moves its starts.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { agentKey, canAsk, platformOf } from "../../setup/queries";
import { revisionQuery } from "../../simulation/queries";
import { useConnection } from "../../shell/connection";
import { commands } from "../../wire/api.gen";
import type { StartCurve, StartSummary, Topology, WireError } from "../../wire/types.gen";

/** A run's topology: `#214/T12.3` is run 214, graph 12, open state 3. */
export interface TopologyRef {
  run: number;
  graph: number;
  openState: number;
}

/** "T12.3" from a path: its graph and open state, or `undefined` when it isn't one. */
export function topologyOf(segment: string): { graph: number; openState: number } | undefined {
  const m = segment.match(/^T(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (m === null) return undefined;
  const graph = Number(m[1]);
  const openState = Number(m[2]);
  return Number.isSafeInteger(graph) && Number.isSafeInteger(openState)
    ? { graph, openState }
    : undefined;
}

/** "T12.3": a topology as its path writes it. */
export const segmentOf = (t: { graph: number; open_state: number }) =>
  `T${t.graph}.${t.open_state}`;

export function useTopology(ref: TopologyRef | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "topology", ref?.run, ref?.graph, ref?.openState),
    queryFn: () =>
      commands.read_topology({ run: ref!.run, graph: ref!.graph, open_state: ref!.openState }),
    enabled: ref !== undefined && canAsk(c),
  });
}

/**
 * Every start of the topology, by index, once every page has answered;
 * `starts` is `undefined` until then. Pages are walked one after another.
 */
export function useStarts(ref: TopologyRef | undefined, enabled: boolean) {
  const c = useConnection();
  const q = useInfiniteQuery({
    queryKey: agentKey(platformOf(c), "runs", "starts", ref?.run, ref?.graph, ref?.openState),
    queryFn: ({ pageParam }) =>
      commands.list_starts({
        run: ref!.run,
        graph: ref!.graph,
        open_state: ref!.openState,
        after: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: enabled && ref !== undefined && canAsk(c),
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = q;
  // Each page read asks for the next: two in a row can render alike but for how many there are.
  const pages = q.data?.pages.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, pages]);
  const data = q.data;
  const starts = useMemo<StartSummary[] | undefined>(
    () => (data === undefined || hasNextPage ? undefined : data.pages.flatMap((p) => p.starts)),
    [data, hasNextPage],
  );
  return { ...q, starts };
}

/**
 * The Progress curve of every start of the topology that has one, by index,
 * once every page has answered; `curves` is `undefined` until then. Pages are
 * walked one after another.
 */
export function useProgress(ref: TopologyRef | undefined, enabled: boolean) {
  const c = useConnection();
  const q = useInfiniteQuery({
    queryKey: agentKey(platformOf(c), "runs", "progress", ref?.run, ref?.graph, ref?.openState),
    queryFn: ({ pageParam }) =>
      commands.topology_progress({
        run: ref!.run,
        graph: ref!.graph,
        open_state: ref!.openState,
        after: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: enabled && ref !== undefined && canAsk(c),
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = q;
  const pages = q.data?.pages.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, pages]);
  const data = q.data;
  const curves = useMemo<StartCurve[] | undefined>(
    () => (data === undefined || hasNextPage ? undefined : data.pages.flatMap((p) => p.curves)),
    [data, hasNextPage],
  );
  return { ...q, curves };
}

/**
 * The topology that goes out just before one not sent yet, at `position`,
 * as its page reads it: from the first page of the run's topologies in the
 * order they go out. `null` when that page doesn't hold it.
 */
export function useAhead(run: number | undefined, position: number | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "ahead", run, position),
    queryFn: async (): Promise<Topology | null> => {
      const page = await commands.list_topologies({
        run: run!,
        order: "sent",
        state: null,
        after: null,
      });
      const ahead = page.topologies.find((t) => t.position === position! - 1);
      if (ahead === undefined) return null;
      return commands.read_topology({
        run: run!,
        graph: ahead.graph,
        open_state: ahead.open_state,
      });
    },
    enabled: run !== undefined && position !== undefined && position > 0 && canAsk(c),
  });
}

/**
 * Why the run's revision can't be read, if it can't: read as the Start
 * page's simulation reads it (`revisionQuery`), so the two share it.
 * `undefined` while it reads, and when it reads.
 */
export function useUnreadable(dataset: { id: string; revision: number } | undefined) {
  const c = useConnection();
  const q = useQuery({
    ...revisionQuery(platformOf(c), dataset),
    enabled: dataset !== undefined && canAsk(c),
  });
  const error = q.error as unknown as WireError | null;
  return error?.code === "unreadable" ? error.data.problem : undefined;
}
