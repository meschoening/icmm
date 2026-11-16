/**
 * What the Active platform's agent says about its Data folder's setup, as
 * queries keyed by the platform: its Platform settings, the scheduler lookup
 * and folder checks. Each connection fetches them afresh, and while it's
 * down, reconnecting or not connected, the pages keep showing what the
 * session last read (`useAgentDataFollowsConnection`).
 * A change the runs database's feed reports, from this computer or another,
 * reads its topic again (`useAgentDataFollowsChanges`).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { inApp } from "../ipc";
import { useEffect, useState } from "react";
import {
  getConnection,
  useConnection,
  watchConnection,
  type ConnectionState,
} from "../shell/connection";
import { commands } from "../wire/api.gen";
import { sameFailure } from "./form";
import type { ChangeTopic, Changes, SavedPlatformSettings, WireError } from "../wire/types.gen";

/** Every agent query's key starts with this and the platform's id. */
export const agentKey = (platformId: string, ...rest: unknown[]) => ["agent", platformId, ...rest];

/** The platform an agent query asks, by id; "" with none. */
export const platformOf = (c: ConnectionState) => (c.status === "none" ? "" : c.platformId);

/**
 * Keeps the agent queries to the connection they came from. While it's
 * down they stay, so a page left and opened again shows what it read, as
 * of when the connection went (RF15, #368). A connection that comes back
 * from reconnecting refetches them; any other that comes up forgets them
 * first, since it may reach another Data folder, even on the same platform.
 * It watches the store itself, so no change is lost to a batched render.
 */
export function useAgentDataFollowsConnection(): void {
  const queries = useQueryClient();
  useEffect(() => {
    let was = getConnection().status;
    return watchConnection(() => {
      const before = was;
      const now = getConnection().status;
      was = now;
      if (now === before || now !== "connected") return;
      if (before === "reconnecting") {
        void queries.invalidateQueries({ queryKey: ["agent"] });
      } else {
        queries.removeQueries({ queryKey: ["agent"] });
      }
    });
  }, [queries]);
}

/** The event each change in the Active platform's runs database comes as. */
const CHANGES_EVENT = "agent_changes";

/**
 * What else each topic's change touches: a config names its dataset as it is
 * now (its name, deleted, a revision ICMM can't read), so a dataset's change
 * reads the configs again. Config validation also uses its dataset’s protocol
 * count for file and Start log estimates, so that answer follows dataset changes
 * too. Each config lists its newest run, so a run’s change re-reads configs.
 * A run names its dataset and config as they are now, and whether it was fit
 * to the dataset's current data, which ranks it: their changes re-read runs.
 */
const ALSO: Partial<Record<ChangeTopic, (ChangeTopic | "validate_config")[]>> = {
  datasets: ["configs", "validate_config", "runs"],
  configs: ["runs"],
  runs: ["configs"],
};

/**
 * Reads again what each change the feed reports touches: the Active
 * platform's queries of its topic, and of the topics that show it (`ALSO`).
 * A feed that can't resume needs nothing more, since a reconnect reads
 * everything again.
 */
export function useAgentDataFollowsChanges(): void {
  const queries = useQueryClient();
  useEffect(() => {
    // Outside the app (plain `npm run dev`, tests without the IPC mock) there's no feed.
    if (!inApp()) return;
    const stop = listen<Changes>(CHANGES_EVENT, (e) => {
      const platform = platformOf(getConnection());
      const topics = e.payload.changes.flatMap((c) => [c.topic, ...(ALSO[c.topic] ?? [])]);
      for (const topic of new Set(topics)) {
        const filter = { queryKey: agentKey(platform, topic) };
        if (topic === "validate_config") {
          // Invalidation alone reuses an initial pending request with no cached data.
          // Cancel it first: its old protocol count must not become an infinitely fresh answer.
          void queries.cancelQueries(filter).then(() => queries.invalidateQueries(filter));
        } else {
          void queries.invalidateQueries(filter);
        }
      }
    }).catch(() => undefined);
    return () => {
      // A test's IPC mock may be gone by the time the page unmounts.
      void stop.then((unlisten) => unlisten?.()).catch(() => {});
    };
  }, [queries]);
}

/** Whether the agent can be asked now. */
export function canAsk(c: ConnectionState): boolean {
  return c.status === "connected";
}

export function usePlatformSettings() {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "platform_settings"),
    queryFn: commands.platform_settings,
    enabled: canAsk(c),
  });
}

export function useSchedulerLookup(enabled: boolean) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "scheduler_lookup"),
    queryFn: commands.scheduler_lookup,
    enabled: enabled && canAsk(c),
  });
}

/** The Output folder's free space and refusal, once `folder` is set. */
export function useFolderCheck(folder: string) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "check_folders", folder),
    queryFn: () => commands.check_folders({ output_folder: folder }),
    enabled: folder !== "" && canAsk(c),
    staleTime: 60_000,
  });
}

/**
 * The Active platform's setup, as First launch and the header need it:
 * `offline` until it can be asked, `needed` while its Data folder has no
 * Platform settings, `done` with them.
 */
export type Setup =
  | { kind: "offline" }
  | { kind: "loading" }
  | { kind: "error"; error: WireError; retry: () => Promise<unknown>; again?: number }
  | { kind: "needed" }
  | { kind: "done"; saved: SavedPlatformSettings };

export function useSetup(): Setup {
  const c = useConnection();
  const q = usePlatformSettings();
  const read = useReadAgain(q.isError ? (q.error as unknown as WireError) : undefined, q.refetch);
  const live = c.status === "connected" || c.status === "reconnecting";
  if (!live) return { kind: "offline" };
  if (q.data !== undefined) {
    return q.data.saved === null ? { kind: "needed" } : { kind: "done", saved: q.data.saved };
  }
  if (read.failure !== undefined) {
    return { kind: "error", error: read.failure, retry: read.retry, again: read.again };
  }
  return { kind: "loading" };
}

/**
 * A failed read, and Try again. A query that has no data forgets its error
 * once it asks again, so this keeps the failure until the answer: its note,
 * and Try again with focus and "Reading…", stay put instead of giving way to
 * a Reading line. `again` is when a retry last failed the same way.
 */
export function useReadAgain<E>(
  failure: E | undefined,
  refetch: () => Promise<{ error?: unknown } | unknown>,
) {
  const [kept, setKept] = useState<E>();
  const [again, setAgain] = useState<number>();
  // "Tried again" goes with the failure it was about: a later one wasn't retried.
  const failing = failure !== undefined || kept !== undefined;
  const [wasFailing, setWasFailing] = useState(failing);
  if (failing !== wasFailing) {
    setWasFailing(failing);
    if (!failing) setAgain(undefined);
  }
  return {
    failure: failure ?? kept,
    again: failing ? again : undefined,
    retry: async () => {
      setKept(failure);
      try {
        const answer = (await refetch()) as { error?: unknown } | undefined;
        const error = answer?.error ?? undefined;
        setAgain(error !== undefined && sameFailure(failure, error) ? Date.now() : undefined);
      } finally {
        setKept(undefined);
      }
    },
  };
}
