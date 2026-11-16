/**
 * A run's writes (#250): Resume on a run that failed or was canceled, and
 * Cancel run and Delete run on Run detail (#237). A write keeps its request
 * key until it's recorded or refused, so a retry of one whose answer was lost
 * is the same request and lands once (ADR-0009); once recorded, the next
 * press is a new request. Its button works from the press until the
 * platform's runs are read again.
 *
 * A write sent across a reconnect waits for it, then says it couldn't
 * confirm, and that doing it again is safe (#168), as the configs' writes do.
 * A run that's gone, or no longer in a state the write allows, refuses before
 * anything is recorded: what's there now shows, and the write counts as done.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { keyFor, unconfirmedWords } from "../requestKey";
import { agentKey } from "../setup/queries";
import { getConnection } from "../shell/connection";
import { useWorking, type Working } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { ResumedRun, WireError } from "../wire/types.gen";

export type RunWriteKind = "resume" | "cancel" | "delete";

/** What each write did, and doing it again, for a lost answer. */
const WORDS: Record<RunWriteKind, { done: string; again: string; failed: string }> = {
  resume: { done: "resumed", again: "Resuming", failed: "Couldn’t resume. Try again." },
  cancel: { done: "canceled", again: "Canceling", failed: "Couldn’t cancel. Try again." },
  delete: { done: "deleted", again: "Deleting", failed: "Couldn’t delete. Try again." },
};

export interface RunWrite {
  working: Working;
  /** What the last failure says; `undefined` once one succeeds. */
  message: string | undefined;
  /**
   * Sends the write: `true` once it's recorded, or refused because the run
   * is gone or past it; `false` when it failed. A press while one works does
   * nothing.
   */
  send: () => Promise<boolean>;
  /** Forgets the last failure's words, as a confirm opens again. */
  clear: () => void;
  /** What the last write that was recorded answered: a Resume says which engine it fits on. */
  replied: ResumedRun | undefined;
}

/**
 * Write `kind` for run `id` on `platform`, named as the user knows it.
 * `onDone` runs once the write is recorded (or moot), before the runs are
 * read again: Delete leaves the run's page there, so it never shows it gone.
 */
export function useRunWrite(
  kind: RunWriteKind,
  id: number,
  platform: string,
  onDone?: () => void,
): RunWrite {
  const working = useWorking();
  const queries = useQueryClient();
  const last = useRef<{ key: string; body: string } | null>(null);
  const [message, setMessage] = useState<string>();
  const [replied, setReplied] = useState<ResumedRun>();
  /** The platform's runs read again: the run moves, changes or goes. */
  const readAgain = () => {
    const c = getConnection();
    return queries.invalidateQueries({
      queryKey: agentKey(c.status === "none" ? "" : c.platformId, "runs"),
    });
  };
  const send = async () => {
    if (working.busy()) return false;
    setMessage(undefined);
    last.current = keyFor(last.current, [kind, id]);
    const key = last.current.key;
    try {
      await working.run(async () => {
        const params = { request_key: key, id };
        if (kind === "resume") setReplied(await commands.resume_run(params));
        else if (kind === "cancel") await commands.cancel_run(params);
        else await commands.delete_run(params);
        // Recorded: the next press is another request (cancel, resume, cancel again).
        last.current = null;
        onDone?.();
        await readAgain();
      });
      return true;
    } catch (error) {
      const e = error as Partial<WireError>;
      // The desktop's own codes, besides the agent's.
      const code = e.code as string | undefined;
      // A run that's gone, or in a state the write doesn't allow, refuses before the request is
      // recorded (agent/runs.py): what's there now shows.
      if (code === "not_found" || code === "conflict") {
        last.current = null;
        onDone?.();
        await readAgain();
        return true;
      }
      const w = WORDS[kind];
      if (code === "not_connected" || code === "timeout") {
        const offline = getConnection().status === "connected" ? undefined : platform;
        setMessage(unconfirmedWords({ happened: `#${id} ${w.done}`, again: w.again }, offline));
      } else {
        setMessage(e.message ?? w.failed);
      }
      return false;
    }
  };
  return { working, message, send, clear: () => setMessage(undefined), replied };
}

export interface Resume {
  working: Working;
  /** What the last failure says; `undefined` once one succeeds. */
  message: string | undefined;
  /** Sends the resume; a press while one works does nothing. */
  resume: () => Promise<void>;
  /** What the last resume recorded answered: the engine it fits on, and any it replaced. */
  replied: ResumedRun | undefined;
}

/** Resume for run `id` on `platform`, named as the user knows it. */
export function useResume(id: number, platform: string): Resume {
  const w = useRunWrite("resume", id, platform);
  return {
    working: w.working,
    message: w.message,
    resume: async () => {
      await w.send();
    },
    replied: w.replied,
  };
}
