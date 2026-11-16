/**
 * What the Start page reads (#239): the start (`read_start`), its latest
 * try's Start log read whole (`read_start_log`, page after page), then
 * watched (`watch_start`) while it may still log, the end of its job log
 * once it failed (`read_job_log`), the Best start's rank N of M in its
 * Ranking group (`read_group_rank`, #341), and its rates on this computer's
 * engine (`edge_rates`). Each agent read is one bounded query (ADR-0013).
 *
 * The start is under the agent's `runs` key, so the change feed reads it
 * again as its coordinator moves it. Its log isn't: the watch brings what's
 * new, and a reconnect, which forgets every agent read, reads it again and
 * watches from its end. So does the watch's end, since the change feed can
 * say the start ended before the watch brings its last points.
 */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { inApp } from "../../ipc";
import { agentKey, canAsk, platformOf } from "../../setup/queries";
import { getConnection, useConnection } from "../../shell/connection";
import { commands } from "../../wire/api.gen";
import type {
  LiveSnapshot,
  Start,
  StartLogPoint,
  StartWatch,
  StartWatchEvent,
} from "../../wire/types.gen";

/** A start, written `#214/T12.3 start 37`. */
export interface StartRef {
  run: number;
  graph: number;
  openState: number;
  start: number;
}

const wire = (ref: StartRef) => ({
  run: ref.run,
  graph: ref.graph,
  open_state: ref.openState,
  start: ref.start,
});

export function useStart(ref: StartRef | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "start", ref),
    queryFn: () => commands.read_start(wire(ref!)),
    enabled: ref !== undefined && canAsk(c),
  });
}

/** The event each event of a page's own subscription comes as (`AGENT_EVENT`). */
const AGENT_EVENT = "agent_event";

interface Pushed {
  subscription: number;
  event: StartWatchEvent;
}

/** A try's Start log read whole: its points, and where it ends. */
interface ReadLog {
  points: StartLogPoint[];
  next: number;
}

/** Each page of the latest try's log from its start, one after another, until it's whole. */
async function readLog(ref: StartRef): Promise<ReadLog> {
  const points: StartLogPoint[] = [];
  let after = 0;
  for (;;) {
    const page = await commands.read_start_log({
      ...wire(ref),
      try_number: null,
      after,
      before: null,
    });
    points.push(...page.points);
    if (page.next <= after || page.next >= page.size) return { points, next: page.next };
    after = page.next;
  }
}

export interface Live {
  points: StartLogPoint[];
  /** Its best so far, simulated as scored; `null` while it has none, or once it ended. */
  snapshot: LiveSnapshot | null;
  /** When its log was last read or heard from, in Unix milliseconds. */
  readAt: number | undefined;
  /** Whether the log has been read through once. */
  read: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * The start's latest try's Start log and Live snapshot: read whole, then,
 * while `watching`, kept up by the watch's events. A watch's last event
 * reads the start again, which says how it ended. `ref` stays the same
 * object while it names the same start, as the page keeps it.
 */
export function useStartLive(
  ref: StartRef | undefined,
  start: Start | undefined,
  watching: boolean,
): Live {
  const c = useConnection();
  const platform = platformOf(c);
  const tryNumber = start?.try_number ?? 0;
  const log = useQuery({
    queryKey: agentKey(platform, "start_log", ref, tryNumber, watching),
    queryFn: () => readLog(ref!),
    enabled: ref !== undefined && tryNumber > 0 && canAsk(c),
    placeholderData: keepPreviousData,
  });
  const base = log.data;
  const [heard, setHeard] = useState<{
    base: ReadLog | undefined;
    points: StartLogPoint[];
    snapshot: LiveSnapshot | null;
    at: number | undefined;
  }>({ base: undefined, points: [], snapshot: null, at: undefined });
  // A new read of the log starts over what the watch has added to it.
  if (heard.base !== base) setHeard({ base, points: [], snapshot: null, at: undefined });

  const from = base?.next;
  useStartWatch(
    ref,
    from,
    watching,
    (e) => {
      setHeard((h) =>
        h.base !== base
          ? h
          : {
              base,
              points: e.points.length > 0 ? [...h.points, ...e.points] : h.points,
              snapshot: e.snapshot ?? h.snapshot,
              at: Date.now(),
            },
      );
    },
    (w) => setHeard((h) => (h.base !== base ? h : { ...h, snapshot: w.snapshot, at: Date.now() })),
  );

  const added = heard.points;
  const points = useMemo(
    () => (base === undefined ? NONE : added.length > 0 ? [...base.points, ...added] : base.points),
    [base, added],
  );
  return {
    points,
    snapshot: heard.snapshot,
    readAt: heard.at ?? (log.dataUpdatedAt || undefined),
    read: base !== undefined,
    error: log.error,
    refetch: log.refetch,
  };
}

const NONE: StartLogPoint[] = [];

/** The session's watch, which `unwatch_start` ends: one at a time (`watch_start`). */
const watched: { current: number | undefined } = { current: undefined };

/**
 * Watches the start's latest try from byte `from` of its Start log while
 * `enabled` and connected (`watch_start`): `begun` hears the watch's reply,
 * with its snapshot now, and `hear` each event after it. The watch's last
 * event reads the runs again, which say how the start ended. Leaving, or a
 * new `from`, ends it.
 */
export function useStartWatch(
  ref: StartRef | undefined,
  from: number | undefined,
  enabled: boolean,
  hear: (e: StartWatchEvent) => void,
  begun?: (w: StartWatch) => void,
) {
  const c = useConnection();
  const platform = platformOf(c);
  const queries = useQueryClient();
  const heard = useEffectEvent((e: StartWatchEvent) => hear(e));
  const began = useEffectEvent((w: StartWatch) => begun?.(w));
  const connected = c.status === "connected";
  useEffect(() => {
    if (!inApp() || ref === undefined || from === undefined || !enabled || !connected) return;
    let subscription: number | undefined;
    let over = false;
    const early: Pushed[] = [];
    const hear = (e: StartWatchEvent) => {
      if (over) return;
      heard(e);
      if (e.ended) void queries.invalidateQueries({ queryKey: agentKey(platform, "runs") });
    };
    const stop = listen<Pushed>(AGENT_EVENT, ({ payload }) => {
      if (subscription === undefined) early.push(payload);
      else if (payload.subscription === subscription) hear(payload.event);
    });
    void stop
      .then(() => commands.watch_start({ ...wire(ref), after: from }))
      .then((w) => {
        if (over) return;
        subscription = w.subscription;
        watched.current = w.subscription;
        began(w);
        for (const p of early) if (p.subscription === subscription) hear(p.event);
      })
      .catch(() => {
        // The read of the start says why, if anything's wrong; the log stays as read.
      });
    return () => {
      over = true;
      void stop.then((unlisten) => unlisten()).catch(() => {});
      const mine = subscription;
      // A new watch ends this one; with none started after it, end it here.
      setTimeout(() => {
        if (mine !== undefined && watched.current === mine && canAsk(getConnection())) {
          watched.current = undefined;
          void commands.unwatch_start().catch(() => {});
        }
      });
    };
  }, [ref, from, enabled, connected, platform, queries]);
}

/** How much of the job log's end to read: a page. */
/**
 * The topology's rank N of M in its run's Ranking group, which its Best
 * start's page shows; none while `enabled` is false.
 */
export function useGroupRank(
  ref: Pick<StartRef, "run" | "graph" | "openState"> | undefined,
  enabled: boolean,
) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "group_rank", ref?.run, ref?.graph, ref?.openState),
    queryFn: () =>
      commands.read_group_rank({ run: ref!.run, graph: ref!.graph, open_state: ref!.openState }),
    enabled: enabled && ref !== undefined && canAsk(c),
  });
}

const JOB_LOG_TAIL = 128 * 1024;

/** The end of the start's latest try's job log, for a start that failed: its last page. */
export function useJobLogTail(ref: StartRef | undefined, tryNumber: number, enabled: boolean) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "job_log", ref, tryNumber),
    queryFn: async () => {
      const first = await commands.read_job_log({
        ...wire(ref!),
        try_number: null,
        after: 0,
        before: null,
      });
      if (!first.found || first.next >= first.size) return first;
      const after = Math.max(first.next, first.size - JOB_LOG_TAIL);
      return commands.read_job_log({ ...wire(ref!), try_number: null, after, before: null });
    },
    enabled: enabled && ref !== undefined && tryNumber > 0 && canAsk(c),
  });
}

/** Each edge's rates at `voltage` mV, from `vector`, on this computer's engine. */
export function useEdgeRates(
  topology: { numStates: number; graph: number; openState: number } | undefined,
  vector: readonly number[] | undefined,
  voltage: number | undefined,
) {
  return useQuery({
    queryKey: ["host", "edge_rates", topology, vector, voltage],
    queryFn: () =>
      commands.edge_rates({
        num_states: topology!.numStates,
        graph: topology!.graph,
        open_state: topology!.openState,
        vector: [...vector!],
        voltage_mV: voltage!,
      }),
    enabled: topology !== undefined && vector !== undefined && voltage !== undefined,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
