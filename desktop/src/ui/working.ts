/**
 * A slow action's working state (#100). From the press, another press does
 * nothing, and nothing visible changes. From 150 ms after it, the button's
 * label becomes dots and what it's doing ("Saving…"), in its own colors and
 * at the width of the wider label, and it's `aria-busy` and `aria-disabled`
 * while keeping focus (old ADR-0027). Once shown, the working state stays at
 * least 400 ms, so a quick save never flickers. `WorkingButton` draws it,
 * and `BesideButton` is a button beside it.
 *
 * Actions whose progress shows elsewhere (Connect, Trust and connect, Retry
 * now, Choose…) don't use it: they're gray until it shows (`gray.ts`).
 */
import { useCallback, useRef, useState } from "react";

/** How long after the press the working state shows. */
export const WORKING_AFTER_MS = 150;
/** How long the working state stays once it shows. */
export const WORKING_HOLD_MS = 400;

export interface Working {
  /** Whether an action is under way, from its press until its button is back at rest. */
  busy: () => boolean;
  /** The same immediate state for rendering and effects, before the working state shows. */
  pending: boolean;
  /** Whether the working state shows. */
  shown: boolean;
  /**
   * Runs `work`, and settles as it does: at once on success, and on failure
   * once a shown working state has held. A call while one runs, or holds,
   * does nothing: its promise never settles.
   */
  run: <T>(work: () => Promise<T>) => Promise<T>;
}

export function useWorking(): Working {
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState(false);
  /** Set from the press: a second press can come before anything renders. */
  const running = useRef(false);
  const busy = useCallback(() => running.current, []);
  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    if (running.current) return new Promise<T>(() => {});
    running.current = true;
    setPending(true);
    let held: Promise<void> | undefined;
    const show = setTimeout(() => {
      held = new Promise((done) => setTimeout(done, WORKING_HOLD_MS));
      setShown(true);
    }, WORKING_AFTER_MS);
    /** Back to rest, once a shown working state has held. */
    const rest = async () => {
      clearTimeout(show);
      await held;
      running.current = false;
      setPending(false);
      setShown(false);
    };
    try {
      const value = await work();
      // A success's outcome replaces the button, so it doesn't wait.
      void rest();
      return value;
    } catch (error) {
      // A failure's error line comes as the button goes back to rest.
      await rest();
      throw error;
    }
  }, []);
  return { busy, pending, shown, run };
}

/**
 * The props of an action that isn't a button, beside a working one (a link,
 * or a control that needs a reason to be gray): from the press it does
 * nothing, and while the working state shows it's grayed, as a `BesideButton`
 * is, keeping its focus.
 */
export function besideProps(working: Working): {
  "aria-disabled"?: true;
  onClickCapture?: (e: React.MouseEvent) => void;
} {
  if (!working.pending) return {};
  return {
    ...(working.shown ? { "aria-disabled": true } : {}),
    onClickCapture: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
