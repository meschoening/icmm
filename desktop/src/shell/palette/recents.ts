/**
 * ⌘K's Recently opened (#408, #411): the last 5 pages opened on the Active
 * platform, kept on this computer per saved platform (`recently_opened`,
 * beside `run_marks.json`). A run's page, a topology, a start's page, a
 * dataset's page and a config in the builder each record themselves once
 * they've read their name (`useOpened`). The palette shows them on its empty
 * query, worded from its index; a recent topology or start takes the read its
 * page keeps, read as the palette opens like the index, never while it's open.
 */
import {
  useQueries,
  useQuery,
  useQueryClient,
  type FetchQueryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { canAsk, platformOf } from "../../setup/queries";
import { commands } from "../../wire/api.gen";
import type { OpenedPage, Start, Topology } from "../../wire/types.gen";
import { getConnection, useConnection } from "../connection";
import { startKey, topologyKey } from "./reads";
import { pageKey, type RecentRead } from "./search";

export const recentsKey = (platform: string) => ["desktop", "recently_opened", platform];

/** The pages last opened on the Active platform, newest first; `undefined` until read. */
export function useRecentlyOpened(): OpenedPage[] | undefined {
  const platform = platformOf(useConnection());
  return useQuery({
    queryKey: recentsKey(platform),
    queryFn: () => commands.recently_opened({ platform_id: platform }),
    enabled: platform !== "",
  }).data?.pages;
}

/**
 * Records `page` as opened on the Active platform, once it's known: a page passes `undefined`
 * until it has read its name. Opened again, or renamed while open, it records again, which
 * puts it first. A record that fails leaves Recently opened as it was.
 */
export function useOpened(page: OpenedPage | undefined): void {
  const client = useQueryClient();
  const key = page === undefined ? undefined : JSON.stringify(page);
  useEffect(() => {
    if (key !== undefined) recordOpened(client, JSON.parse(key) as OpenedPage);
  }, [client, key]);
}

/**
 * Records `page` as opened on the Active platform, as it is then. The palette records a recent
 * it opens too: not connected, its page may have nothing kept to name it by.
 */
export function recordOpened(client: QueryClient, page: OpenedPage): void {
  const platform = platformOf(getConnection());
  if (platform === "") return;
  commands.record_opened({ platform_id: platform, page }).then(
    () => void client.invalidateQueries({ queryKey: recentsKey(platform) }),
    () => undefined,
  );
}

type Ref = { run: number; graph: number; openState: number };

const refOf = (p: OpenedPage & { kind: "topology" | "start" }) => ({
  run: p.run,
  graph: p.graph,
  openState: p.open_state,
});

/**
 * The reads of the recent topologies and starts, under the keys their pages keep them at.
 * Each is read as the palette opens (or as the connection comes up while it's open), only if
 * it isn't read or went stale; its observers never fetch.
 */
export function useRecentReads(pages: OpenedPage[] | undefined): Map<string, RecentRead> {
  const c = useConnection();
  const platform = platformOf(c);
  const ask = canAsk(c);
  const client = useQueryClient();
  const read = (pages ?? []).filter(
    (p): p is OpenedPage & { kind: "topology" | "start" } =>
      p.kind === "topology" || p.kind === "start",
  );
  const options = read.map((p) => {
    const ref: Ref = refOf(p);
    const wire = { run: ref.run, graph: ref.graph, open_state: ref.openState };
    return p.kind === "topology"
      ? {
          queryKey: topologyKey(platform, ref),
          queryFn: (): Promise<Topology | Start> => commands.read_topology(wire),
        }
      : {
          queryKey: startKey(platform, { ...ref, start: p.start }),
          queryFn: (): Promise<Topology | Start> =>
            commands.read_start({ ...wire, start: p.start }),
        };
  });
  const keys = JSON.stringify(options.map((o) => o.queryKey));
  useEffect(() => {
    if (!ask) return;
    for (const o of options) void client.prefetchQuery(o as FetchQueryOptions);
    // `options` is new each render; `keys` says which reads they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ask, keys]);
  const results = useQueries({
    queries: options.map((o) => ({ ...o, enabled: false })),
  });
  return new Map(
    read.map((p, i) => [
      pageKey(p),
      {
        data: results[i].data,
        gone: (results[i].error as { code?: string } | null)?.code === "not_found",
      },
    ]),
  );
}
