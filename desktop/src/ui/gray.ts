/**
 * Gray until the progress shows (#105), for actions whose progress shows
 * elsewhere rather than in a working state of their own (`working.ts`):
 * Connect, Trust and connect, Retry now (`connection/pressed.ts`) and Choose….
 * From the press the button keeps its words, and is `aria-disabled` in the
 * disabled look with a progress cursor, keeps focus and ignores presses,
 * until its progress shows; then it goes on as before.
 */
import { useCallback, useRef, useState } from "react";

/** The gray look: spread on the button, whose own `aria-disabled` it leaves alone at rest. */
export function grayProps(gray: boolean): { "aria-disabled"?: true; "data-wait"?: true } {
  return gray ? { "aria-disabled": true, "data-wait": true } : {};
}

export interface SystemDialog {
  /** Whether its button is gray: from the press until the dialog opens. */
  gray: boolean;
  /** Opens the dialog; while its button is gray, does nothing, and never settles. */
  open: <T>(dialog: () => Promise<T>) => Promise<T>;
}

/**
 * Choose…: gray from the press until the system dialog opens, which takes
 * the window's focus, or until it answers, wherever the window keeps focus.
 */
export function useSystemDialog(): SystemDialog {
  const [gray, setGray] = useState(false);
  /** Set from the press: a second press can come before anything renders. */
  const opening = useRef(false);
  const open = useCallback(async <T>(dialog: () => Promise<T>): Promise<T> => {
    if (opening.current) return new Promise<T>(() => {});
    opening.current = true;
    setGray(true);
    const opened = () => {
      window.removeEventListener("blur", opened);
      opening.current = false;
      setGray(false);
    };
    window.addEventListener("blur", opened);
    try {
      return await dialog();
    } finally {
      opened();
    }
  }, []);
  return { gray, open };
}
