/**
 * A change to a saved dataset, sent as one write (#146): Rename, Remove,
 * Edit protocol and New protocol save a new revision (`save_dataset`),
 * Duplicate copies one and Delete commits a tombstone. Each keeps one
 * request key per input until a proven refusal, so an unconfirmed or
 * unfinished change retries as the same request and lands once (ADR-0009).
 * Each shows its working state from the press.
 *
 * A write sent across a reconnect waits for it, its button working, then
 * says it couldn't confirm, and that doing it again is safe (#168), as
 * Settings and the wizard do; another computer's save and a delete are
 * each the caller's to show.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { keyFor, savedWords, unconfirmedWords, type Unconfirmed } from "../../requestKey";
import { agentKey } from "../../setup/queries";
import { getConnection } from "../../shell/connection";
import { useWorking, type Working } from "../../ui/working";
import type { DatasetContent, Issue, WireError } from "../../wire/types.gen";

export type WriteOutcome<R> =
  | { ok: true; value: R }
  /** Another computer saved the dataset first: the change is unsaved. */
  | { ok: false; code: "conflict" }
  /** The dataset was deleted. */
  | { ok: false; code: "not_found" }
  /** A check failed, each issue at its path under the content. */
  | { ok: false; code: "invalid"; issues: Issue[] }
  /** Anything else: `message` says it. */
  | { ok: false; code: "other" };

export interface DatasetWrite {
  working: Working;
  /**
   * What the last save sent when its answer didn't come: it may have landed,
   * and the dataset showing it (`landed`) means it did.
   */
  unconfirmed: DatasetContent | null;
  /** What the last failure says, under the action's buttons; `undefined` once one succeeds. */
  message: string | undefined;
  setMessage: (message: string | undefined) => void;
  /**
   * Sends the write for `input` with its key: the key it had for the same
   * input, or a new one after a proven refusal. A press while one works
   * does nothing, and its promise never settles. An answer lost says what
   * may have happened (`Lost`).
   */
  run: <R>(
    input: unknown,
    send: (requestKey: string) => Promise<R>,
    lost: Lost,
  ) => Promise<WriteOutcome<R>>;
}

/**
 * What a write may have done when its answer is lost: `content` saved, which
 * the dataset showing it (`landed`) confirms, or another action's `words`.
 */
export type Lost = { content: DatasetContent } | { words: Unconfirmed };

/** A dataset's content with its keys in one order and its points in x order, to compare. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const points = Array.isArray(o.points)
    ? [...(o.points as { x: number }[])].sort((a, b) => a.x - b.x)
    : undefined;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, canonical(k === "points" && points !== undefined ? points : o[k])]),
  );
}

/** Whether `latest` is what an unconfirmed save sent: it landed, and only its answer was lost. */
export function landed(latest: DatasetContent, sent: DatasetContent | null): boolean {
  return sent !== null && JSON.stringify(canonical(latest)) === JSON.stringify(canonical(sent));
}

export function useDatasetWrite(platform: string): DatasetWrite {
  const working = useWorking();
  const queries = useQueryClient();
  const last = useRef<{ key: string; body: string } | null>(null);
  const [message, setMessage] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState<DatasetContent | null>(null);
  const run = async <R>(input: unknown, send: (requestKey: string) => Promise<R>, lost: Lost) => {
    const content = "content" in lost ? lost.content : undefined;
    if (working.busy()) return new Promise<WriteOutcome<R>>(() => {});
    setMessage(undefined);
    setUnconfirmed(null);
    last.current = keyFor(last.current, input);
    const key = last.current.key;
    /** The platform's datasets read again: after a save, and after another computer's. */
    const readAgain = () => {
      const c = getConnection();
      void queries.invalidateQueries({
        queryKey: agentKey(c.status === "none" ? "" : c.platformId, "datasets"),
      });
    };
    try {
      const value = await working.run(() => send(key));
      readAgain();
      return { ok: true, value } as const;
    } catch (error) {
      const e = error as Partial<WireError> & { data?: unknown };
      const code = e.code as string | undefined;
      const data = e.data as { reason?: string; kind?: string } | undefined;
      // Dataset handler refusals happen before an intent or finish it with its
      // failed receipt (agent/datasets.py: _refusals, requests.finish). A new
      // action must not replay that refusal. Other errors can leave an intent
      // acting, even unreadable while re-reading a copy's source; keep its key.
      const refused =
        code === "invalid" ||
        (code === "not_found" && data?.kind === "dataset") ||
        (code === "conflict" &&
          (data?.reason === "stale_revision" || data?.reason === "name_taken"));
      if (refused) last.current = null;
      if (code === "conflict" && (e.data as { reason?: string })?.reason === "stale_revision") {
        // The feed may not have said yet: what's there now shows, and Reload takes it.
        readAgain();
        return { ok: false, code: "conflict" } as const;
      }
      if (code === "not_found") {
        readAgain();
        return { ok: false, code: "not_found" } as const;
      }
      if (code === "invalid") {
        const issues = (e.data as { issues?: Issue[] } | undefined)?.issues ?? [];
        return { ok: false, code: "invalid", issues } as const;
      }
      if (!refused && content !== undefined) setUnconfirmed(content);
      if (code === "not_connected" || code === "timeout") {
        const words = "words" in lost ? lost.words : savedWords(lost.content.name);
        const offline = getConnection().status === "connected" ? undefined : platform;
        setMessage(unconfirmedWords(words, offline));
      } else {
        setMessage(e.message ?? "Couldn’t save. Try again.");
      }
      return { ok: false, code: "other" } as const;
    }
  };
  return { working, unconfirmed, message, setMessage, run };
}
