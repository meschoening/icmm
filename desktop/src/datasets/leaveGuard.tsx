/**
 * Section 1's leave guard on the pages that change a saved dataset (#146):
 * while a change is unsaved, or its save waits for the connection, leaving
 * the page, closing the window or quitting ICMM asks first (Keep editing ·
 * Discard and leave), as Settings and the wizard do. Whoever asked gets
 * focus back on Keep editing.
 */
import { useBlocker } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inApp } from "../ipc";
import { usePlatforms } from "../settings/commands";
import { leavingWords } from "../shell/leaving";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { commands } from "../wire/api.gen";

export interface LeaveGuard {
  /** The question, while it's asked. */
  dialog: ReactNode;
  /** Lets the next way out go without asking: the change was saved or deliberately dropped. */
  pass: () => void;
}

export function useLeaveGuard({
  asks,
  waiting,
  what,
}: {
  /** Whether leaving asks now. */
  asks: boolean;
  /** Whether a save waits for the connection, rather than a change being unsaved. */
  waiting: boolean;
  /** What leaving loses, as the question's sentences name it: "Your change to herg-wt". */
  what: { one: boolean; text: string };
}): LeaveGuard {
  const asking = useRef(asks);
  const passing = useRef(false);
  const showing = useRef(false);
  const initiator = useRef<HTMLElement | null>(null);
  const [quitting, setQuitting] = useState(false);
  const platforms = usePlatforms();
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      // The same page with a new search opens it afresh: New config with an id (#222). An ask
      // the page starts in place, ⌘K's `?start=export` (#412), isn't leaving it.
      const kept = (search: object) => JSON.stringify({ ...search, start: undefined });
      const same = current.pathname === next.pathname && kept(current.search) === kept(next.search);
      if (passing.current || same) return false;
      initiator.current = document.activeElement as HTMLElement | null;
      return true;
    },
    disabled: !asks,
    enableBeforeUnload: false,
    withResolver: true,
  });
  useEffect(() => {
    asking.current = asks;
    showing.current = quitting || blocker.status === "blocked";
  }, [asks, quitting, blocker.status]);
  useEffect(() => {
    if (inApp()) void commands.guard_quit({ guarded: asks }).catch(() => {});
  }, [asks]);
  useEffect(() => {
    if (!inApp()) return;
    const stop = listen("quit_requested", () => {
      // Answering at once tells the desktop the page is here to ask.
      const guarded = asking.current && !passing.current;
      void commands.guard_quit({ guarded }).catch(() => {});
      if (!guarded) {
        void commands.quit_app().catch(() => {});
        return;
      }
      if (showing.current) return;
      initiator.current = document.activeElement as HTMLElement | null;
      showing.current = true;
      setQuitting(true);
    });
    return () => {
      void commands.guard_quit({ guarded: false }).catch(() => {});
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const answer = (leave: boolean) => {
    if (quitting) {
      if (leave) void commands.quit_app().catch(() => {});
      else {
        setQuitting(false);
        initiator.current?.focus();
      }
      return;
    }
    if (leave) blocker.proceed?.();
    else {
      blocker.reset?.();
      initiator.current?.focus();
    }
  };

  const question = quitting || blocker.status === "blocked";
  const doing = quitting
    ? "Quitting"
    : blocker.status === "blocked"
      ? leavingWords(blocker.next, platforms.data?.platforms)
      : "Leaving";
  // Quitting ends only the app: the platform's runs go on without it.
  const runs = quitting ? " Your runs keep going." : "";
  const it = what.one ? "it" : "they";
  const said = waiting
    ? `${what.text} ${what.one ? "is" : "are"} waiting for it to reconnect. ${doing} stops the wait, so ${it} may not be saved.${runs}`
    : `${what.text} ${what.one ? "isn’t" : "aren’t"} saved. ${doing} discards ${what.one ? "it" : "them"}.${runs}`;
  return {
    dialog: question && (
      <ConfirmDialog
        title={quitting ? "Discard changes and quit ICMM?" : "Discard changes and leave?"}
        keep={waiting ? "Keep waiting" : "Keep editing"}
        confirm={quitting ? "Discard and quit" : "Discard and leave"}
        onKeep={() => answer(false)}
        onConfirm={() => answer(true)}
      >
        {said}
      </ConfirmDialog>
    ),
    pass: () => {
      passing.current = true;
    },
  };
}
