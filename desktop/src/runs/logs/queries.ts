/**
 * What the log view reads (#289): a log's last page first (`read_start_log`,
 * `read_job_log` or `read_coordinating_job_log` with neither offset), then
 * the pages before it as the reader scrolls up, each back from where the
 * last began. While its try or generation runs it follows: a Start log
 * through `watch_start` from where its last page ends, a job log read again
 * from there every 5 s, and once more as it ends. Copy reads every page.
 *
 * The log isn't under the agent's `runs` key, so a change to the run never
 * reads it again from its end; a reconnect, which forgets every agent read,
 * does, and follows from there.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentKey, canAsk, platformOf } from "../../setup/queries";
import { useConnection } from "../../shell/connection";
import { commands } from "../../wire/api.gen";
import type { StartLogPoint, WireError } from "../../wire/types.gen";
import { useStartWatch, type StartRef } from "../start/queries";
import { logHead, logLine } from "./words";

/** How often a running try's job log is read again, as the watch stats a Start log. */
export const FOLLOW_EVERY_MS = 5000;

/** A log the view reads: a try's Start log or job log, or a generation's coordinating job log. */
export type LogSource =
  | { kind: "start" | "job"; ref: StartRef; tryNumber: number }
  | { kind: "coordinator"; run: number; generation: number };

/** A page of any of them: a Start log's points, or a text log's text. */
interface Page {
  path: string | null;
  found: boolean;
  begins: number;
  next: number;
  size: number;
  points: StartLogPoint[];
  text: string;
}

async function readPage(
  source: LogSource,
  at: { after: number | null; before: number | null },
): Promise<Page> {
  if (source.kind === "coordinator") {
    const page = await commands.read_coordinating_job_log({
      run: source.run,
      generation: source.generation,
      ...at,
    });
    return { ...page, points: [] };
  }
  const where = {
    run: source.ref.run,
    graph: source.ref.graph,
    open_state: source.ref.openState,
    start: source.ref.start,
    try_number: source.tryNumber,
    ...at,
  };
  if (source.kind === "job") return { ...(await commands.read_job_log(where)), points: [] };
  return { ...(await commands.read_start_log(where)), text: "" };
}

/** A log as far as it's been read: from `begins` to `next`, of a file `size` long. */
export interface LogRead {
  path: string | null;
  found: boolean;
  begins: number;
  next: number;
  size: number;
  points: StartLogPoint[];
  text: string;
  /** How many of `points` came from pages read back from the last. */
  earlierPoints: number;
  /** How many of `text`'s lines came from pages read back from the last. */
  earlierLines: number;
}

export interface Log {
  read: LogRead | undefined;
  /** When it was last read or heard from, in Unix milliseconds. */
  readAt: number | undefined;
  error: Error | null;
  refetch: () => Promise<unknown>;
  /** The lines before what's read: whether they're being read, why they weren't, and a read. */
  earlier: { reading: boolean; error: WireError | undefined; read: () => void };
}

interface Added {
  base: Page | undefined;
  /** Pages read back from the last, the earliest first. */
  earlier: Page[];
  /** What following has read since, in order. */
  later: Page[];
  at: number | undefined;
}

/**
 * The log `source` names, read from its end, earlier pages as asked, and
 * while `live`, followed: a Start log only on its latest try, whose watch
 * `watch_start` keeps.
 */
export function useLog(source: LogSource | undefined, live: boolean): Log {
  const c = useConnection();
  const platform = platformOf(c);
  const connected = canAsk(c);
  const last = useQuery({
    queryKey: agentKey(platform, "log", source),
    queryFn: () => readPage(source!, { after: null, before: null }),
    enabled: source !== undefined && connected,
    // Opened again, it reads its end again: what it logged meanwhile, or how it ended.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const base = last.data;
  const [added, setAdded] = useState<Added>({ base, earlier: [], later: [], at: undefined });
  // A new read of its last page starts over what's been added to it.
  if (added.base !== base) setAdded({ base, earlier: [], later: [], at: undefined });

  const read = useMemo((): LogRead | undefined => {
    if (base === undefined || added.base !== base) return undefined;
    const pages = [...added.earlier, base, ...added.later];
    return {
      path: base.path,
      found: pages.some((p) => p.found),
      begins: pages[0].begins,
      next: pages[pages.length - 1].next,
      size: Math.max(...pages.map((p) => p.size)),
      points: pages.flatMap((p) => p.points),
      text: pages.map((p) => p.text).join(""),
      earlierPoints: added.earlier.reduce((n, p) => n + p.points.length, 0),
      earlierLines: added.earlier.reduce((n, p) => n + (p.text.match(/\n/g)?.length ?? 0), 0),
    };
  }, [base, added]);

  const append = useCallback(
    (from: Page | undefined, ...pages: Page[]) =>
      setAdded((a) =>
        a.base !== from ? a : { ...a, later: [...a.later, ...pages], at: Date.now() },
      ),
    [],
  );

  // A Start log follows through the watch, from where it's read to as the watch begins: a
  // watch begun again, as Follow comes back on, goes on from there.
  const startRef = source?.kind === "start" ? source.ref : undefined;
  const watching = live && source?.kind === "start" && read !== undefined;
  const [from, setFrom] = useState<{ base: Page | undefined; at: number }>();
  if (watching && (from === undefined || from.base !== base)) setFrom({ base, at: read.next });
  if (!watching && from !== undefined) setFrom(undefined);
  useStartWatch(startRef, from?.at, watching, (e) => {
    if (e.points.length === 0 || base === undefined) return;
    append(base, {
      path: base.path,
      found: true,
      begins: base.next,
      next: e.next,
      size: e.next,
      points: e.points,
      text: "",
    });
  });

  // A text log is read again from where it's read to every 5 s while it runs. Any log is read
  // to its end as its try ends, for what it wrote last: the change feed can say a try ended
  // before its watch brings its last lines. Those pages come in together: each changes `next`,
  // which ends this effect.
  const text = source !== undefined && source.kind !== "start";
  const next = read?.next;
  const wasLive = useRef(live);
  useEffect(() => {
    const ending = wasLive.current && !live;
    wasLive.current = live;
    if (source === undefined || next === undefined || !connected) return;
    if (!(live && text) && !ending) return;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      readPage(source, { after: next, before: null })
        .then((page) => {
          if (!over && page.next !== next) append(base, page);
        })
        .catch(() => {
          // Read again next tick; the log stays as read.
        })
        .finally(() => {
          // Nothing new keeps `next`, so this effect stays: it asks again itself.
          if (!over) timer = setTimeout(tick, FOLLOW_EVERY_MS);
        });
    };
    const toEnd = async () => {
      const pages: Page[] = [];
      for (let at = next; ;) {
        const page = await readPage(source, { after: at, before: null });
        if (page.next <= at) break;
        pages.push(page);
        if (page.next >= page.size) break;
        at = page.next;
      }
      if (!over && pages.length > 0) append(base, ...pages);
    };
    if (ending) {
      toEnd().catch(() => {
        // The log stays as read; opening it again reads its end.
      });
    } else timer = setTimeout(tick, FOLLOW_EVERY_MS);
    return () => {
      over = true;
      clearTimeout(timer);
    };
  }, [text, source, next, live, connected, base, append]);

  const [earlier, setEarlier] = useState<{ reading: boolean; error: WireError | undefined }>({
    reading: false,
    error: undefined,
  });
  const begins = read?.begins;
  const readEarlier = useCallback(() => {
    if (source === undefined || begins === undefined || begins <= 0 || !connected) return;
    if (earlier.reading) return;
    setEarlier({ reading: true, error: undefined });
    readPage(source, { after: null, before: begins })
      .then((page) => {
        setAdded((a) => (a.base !== base ? a : { ...a, earlier: [page, ...a.earlier] }));
        setEarlier({ reading: false, error: undefined });
      })
      .catch((e: WireError) => setEarlier({ reading: false, error: e }));
  }, [source, begins, connected, earlier.reading, base]);

  return {
    read,
    readAt: added.at ?? (last.dataUpdatedAt || undefined),
    error: last.error,
    refetch: last.refetch,
    earlier: { ...earlier, read: readEarlier },
  };
}

/** The whole log, every page from its first, as Copy copies it: a Start log in its columns. */
export async function readWhole(source: LogSource, validation: boolean): Promise<string> {
  const pages: Page[] = [];
  let after = 0;
  for (;;) {
    const page = await readPage(source, { after, before: null });
    pages.push(page);
    if (page.next <= after || page.next >= page.size) break;
    after = page.next;
  }
  if (source.kind !== "start") return pages.map((p) => p.text).join("");
  const lines = pages.flatMap((p) => p.points.map((point) => logLine(point, validation)));
  return [logHead(validation), ...lines].join("\n") + "\n";
}

/** A run's coordinating jobs that ran, the latest first, for the generation select. */
export function useCoordinatingJobs(run: number | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "coordinating_jobs", run),
    queryFn: () => commands.list_coordinating_jobs({ run: run! }),
    enabled: run !== undefined && canAsk(c),
  });
}
