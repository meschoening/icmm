/**
 * What a page keeps of its reads (#235). The agent's reads stay while the
 * connection is down and are read afresh once one is up again
 * (`useAgentDataFollowsConnection`), so the page goes on showing what it
 * last read, said to be as of when the connection went away, rather than
 * going blank; and a page opened again while it's down shows what its reads
 * kept, as of then too (RF15, #368). Reconnecting, the reads are read again
 * once it's back, but they're as old as the connection's end, so they're
 * as of then too (#326).
 */
import { useState } from "react";

/** Whether `a` and `b` hold the same reads, field by field. */
function sameReads(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const [x, y] = [a, b] as Record<string, unknown>[];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => Object.is(x[k], y[k]));
}

interface Snapshot<T> {
  value: T | undefined;
  /** The last moment the connection was up, once it isn't. */
  asOf: number | undefined;
  /** Whether the connection was up at the last render. */
  connected: boolean;
  /** The platform the reads are from. */
  platform: string;
}

/**
 * `reads` while the connection is live (up, or reconnecting); else what the
 * reads kept, or the last reads it was up with; once it isn't up, when it
 * went away: when the agent was last heard (`heardAt`, `heardAtOf`), or the
 * first render without it. A page passes reads whole or
 * not at all: `undefined` while they are still being read, so a view that
 * was cut short is never kept. The reads are compared field by field, so a
 * new object holding the same query results is the same view. `platform` is
 * the Active platform's id: reads kept from another one are dropped, since
 * they were never this platform's. `now` is the time of this render, from the
 * page's clock.
 */
export function useKept<T extends object>(
  reads: T | undefined,
  {
    connected,
    live,
    platform,
    heardAt = null,
  }: { connected: boolean; live: boolean; platform: string; heardAt?: number | null },
  now: number,
): { value: T | undefined; asOf: number | undefined } {
  const [kept, setKept] = useState<Snapshot<T>>({
    value: undefined,
    asOf: undefined,
    connected,
    platform,
  });
  if (kept.platform !== platform) {
    setKept({ value: undefined, asOf: undefined, connected, platform });
  } else if (connected) {
    if (!kept.connected || !sameReads(kept.value, reads)) {
      setKept({ value: reads, asOf: undefined, connected: true, platform });
    }
  } else if (kept.connected) {
    setKept({ ...kept, asOf: heardAt ?? now, connected: false });
  }
  if (live) return { value: reads, asOf: connected ? undefined : (kept.asOf ?? heardAt ?? now) };
  if (kept.platform !== platform) return { value: undefined, asOf: undefined };
  const value = reads ?? kept.value;
  return { value, asOf: value === undefined ? undefined : (kept.asOf ?? heardAt ?? now) };
}
