/**
 * The compute platform connection, as the shell shows it: the desktop's
 * `connection_state`, then each `connection_state` event after it. The proto
 * harness answers both from the URL.
 */
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { commands } from "../wire/api.gen";
import type {
  ConnectFailure,
  ConnectFix,
  ConnectionStatus,
  ConnectionState as DesktopState,
  HostKey,
  KeyQuestion,
  Retry,
  StepTime,
  Upload,
} from "../wire/types.gen";

export type { ConnectionStatus };

/** A connection to a platform, connected or not: every status but `none`. */
export interface Connection {
  status: Exclude<ConnectionStatus, "none">;
  platform: string;
  platformId: string;
  /** What happened, in plain words (failed), or why it's reconnecting. */
  reason: string | null;
  /** A failure's next step, worded for whose move it is (failed). */
  next_step: string | null;
  /** The raw line behind a failure (failed). */
  details: string | null;
  /** The ways forward beside Retry now (failed). */
  fixes: ConnectFix[];
  /** Whether Retry now can help (failed). */
  can_retry: boolean;
  /** When this status began, in Unix milliseconds. */
  since: number | null;
  steps: StepTime[];
  upload: Upload | null;
  failure: ConnectFailure | null;
  retry: Retry | null;
  /** A host key the connect waits on (connecting), or failed on (failed). */
  host_key: HostKey | null;
  /** A sign-in no key got through, waiting for the user to add or choose a key (connecting). */
  key_question: KeyQuestion | null;
  /** The engine's version (connected). */
  engineVersion: string | null;
  /** When the lost connection's agent was last heard, in Unix milliseconds (reconnecting). */
  heardAt: number | null;
}

/** The desktop's state, as the app needs it: every status but `none` names its platform. */
export type ConnectionState = { status: "none" } | Connection;

/** How the pill shows each status: its glyph class and its words. */
export const STATUS_LOOK: Record<ConnectionStatus, { glyph: string; words: string }> = {
  none: { glyph: "g-off", words: "not connected" },
  not_connected: { glyph: "g-off", words: "not connected" },
  connecting: { glyph: "g-busy", words: "connecting…" },
  connected: { glyph: "g-on", words: "connected" },
  reconnecting: { glyph: "g-busy", words: "reconnecting…" },
  failed: { glyph: "g-failed", words: "couldn’t connect" },
};

let current: ConnectionState = { status: "none" };
const listeners = new Set<() => void>();

/**
 * When the last connection that was up went, and to which platform: its
 * agent last heard, if it was lost, else the moment it ended (RF15, #368).
 * A page opened while not connected shows what it read as of then.
 */
let went: { platformId: string; at: number } | null = null;

export function setConnection(next: ConnectionState): void {
  const before = current;
  if (next.status === "connected") {
    went = null;
  } else if (before.status === "connected") {
    const heard = next.status === "reconnecting" ? next.heardAt : null;
    went = { platformId: before.platformId, at: heard ?? Date.now() };
  }
  current = next;
  for (const l of listeners) l();
}

export function getConnection(): ConnectionState {
  return current;
}

/** Calls `listener` on every change, however close together; returns how to stop. */
export function watchConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const subscribe = watchConnection;

/** The event each new state comes as, named like the command that reads it. */
const EVENT = "connection_state";

/**
 * Follows the desktop's connection from now on; returns how to stop. It
 * listens before it asks, so no change falls between the two, and an event
 * that comes before the answer is newer than it.
 */
export async function followConnection(): Promise<() => void> {
  let heard = false;
  const stop = await listen<DesktopState>(EVENT, (e) => {
    heard = true;
    setConnection(fromDesktop(e.payload));
  });
  const now = await commands.connection_state();
  if (!heard) setConnection(fromDesktop(now));
  return stop;
}

function fromDesktop(s: DesktopState): ConnectionState {
  if (s.status === "none") return { status: "none" };
  return {
    status: s.status,
    platform: s.platform ?? "",
    platformId: s.platform_id ?? "",
    reason: s.reason,
    next_step: s.next_step,
    details: s.details,
    fixes: s.fixes,
    can_retry: s.can_retry,
    since: s.since,
    steps: s.steps,
    upload: s.upload,
    failure: s.failure,
    retry: s.retry,
    host_key: s.host_key,
    key_question: s.key_question,
    engineVersion: s.engine_version,
    heardAt: s.heard_at,
  };
}

/**
 * When the connection to the platform went, once it isn't up: while
 * reconnecting, when the lost connection's agent was last heard; not
 * connected, when the last connection it had went (RF15). `null` while
 * it's up, or when it never was this session.
 */
export const heardAtOf = (c: ConnectionState): number | null => {
  if (c.status === "reconnecting") return c.heardAt;
  if (c.status === "connected" || c.status === "none") return null;
  return went?.platformId === c.platformId ? went.at : null;
};

export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribe, getConnection);
}

/**
 * Why the platform's pages are closed, or `undefined` when they're open.
 * Reconnecting keeps them open: they still show what the session loaded.
 */
export function connectionBlocker(state: ConnectionState): string | undefined {
  return state.status === "connected" || state.status === "reconnecting"
    ? undefined
    : "Opens once you’re connected";
}
