/**
 * A config's write, sent as one: the Config builder saves one
 * (`save_config`), and Configs' Duplicate saves a copy (`duplicate_config`)
 * and Delete commits a tombstone (`delete_config`). Each keeps one request
 * key per input until a proven refusal, so a retry is the same request and
 * lands once (ADR-0009), and shows its working state from the press.
 *
 * A write sent across a reconnect waits for it, its button working, then
 * says it couldn't confirm, and that doing it again is safe (#168), as
 * Dataset detail's writes do.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { keyFor, unconfirmedWords, type Unconfirmed } from "../requestKey";
import { agentKey } from "../setup/queries";
import { getConnection } from "../shell/connection";
import { useWorking, type Working } from "../ui/working";
import type { Config, Issue, WireError } from "../wire/types.gen";

export type ConfigOutcome<R> =
  | { ok: true; value: R }
  /** The config was deleted, here or on another computer. */
  | { ok: false; code: "not_found" }
  /** A save met another computer's: a newer revision, or a config with its name. */
  | { ok: false; code: "conflict"; reason: "stale_revision" | "name_taken" }
  /** A save's check failed, each issue at its path under the config. */
  | { ok: false; code: "invalid"; issues: Issue[] }
  /** Anything else: `message` says it. */
  | { ok: false; code: "other" };

export interface ConfigWrite {
  working: Working;
  /**
   * What the last save sent when its answer didn't come: it may have landed,
   * and the config showing it means it did.
   */
  unconfirmed: Config | null;
  /** What the last failure says; `undefined` once one succeeds. */
  message: string | undefined;
  setMessage: (message: string | undefined) => void;
  /**
   * Sends the write for `input` with its key: the key it had for the same
   * input, or a new one after a proven refusal. A press while one works does
   * nothing, and its promise never settles. An answer lost says what may have
   * happened (`lost`); a save's lost answer keeps what it sent (`sent`).
   */
  run: <R>(
    input: unknown,
    send: (requestKey: string) => Promise<R>,
    lost: Unconfirmed,
    sent?: Config,
  ) => Promise<ConfigOutcome<R>>;
}

export function useConfigWrite(platform: string): ConfigWrite {
  const working = useWorking();
  const queries = useQueryClient();
  const last = useRef<{ key: string; body: string } | null>(null);
  const [message, setMessage] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState<Config | null>(null);
  const run = async <R>(
    input: unknown,
    send: (requestKey: string) => Promise<R>,
    lost: Unconfirmed,
    sent?: Config,
  ) => {
    if (working.busy()) return new Promise<ConfigOutcome<R>>(() => {});
    setMessage(undefined);
    setUnconfirmed(null);
    last.current = keyFor(last.current, input);
    const key = last.current.key;
    /** The platform's configs read again: after a write, and after another computer's. */
    const readAgain = () => {
      const c = getConnection();
      void queries.invalidateQueries({
        queryKey: agentKey(c.status === "none" ? "" : c.platformId, "configs"),
      });
    };
    try {
      const value = await working.run(() => send(key));
      readAgain();
      return { ok: true, value } as const;
    } catch (error) {
      const e = error as Partial<WireError> & {
        data?: { kind?: string; reason?: string; issues?: Issue[] };
      };
      // The desktop's own codes, besides the agent's.
      const code = e.code as string | undefined;
      // A config that isn't there, a failed check, a stale revision and a taken name refuse
      // before the write is recorded; any other failure may leave it acting, so a retry keeps
      // its key (agent/configs.py).
      if (code === "not_found" && e.data?.kind === "config") {
        last.current = null;
        readAgain();
        return { ok: false, code: "not_found" } as const;
      }
      const reason = e.data?.reason;
      if (code === "conflict" && (reason === "stale_revision" || reason === "name_taken")) {
        last.current = null;
        // The feed may not have said yet: what's there now shows.
        readAgain();
        return { ok: false, code: "conflict", reason } as const;
      }
      if (code === "invalid") {
        last.current = null;
        return { ok: false, code: "invalid", issues: e.data?.issues ?? [] } as const;
      }
      if (sent !== undefined) setUnconfirmed(sent);
      if (code === "not_connected" || code === "timeout") {
        const offline = getConnection().status === "connected" ? undefined : platform;
        setMessage(unconfirmedWords(lost, offline));
      } else {
        setMessage(e.message ?? "Couldn’t save. Try again.");
      }
      return { ok: false, code: "other" } as const;
    }
  };
  return { working, unconfirmed, message, setMessage, run };
}
