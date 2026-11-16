/**
 * What ⌘K's Do asks a page to start through its URL (#412): Datasets'
 * `?start=import`, Dataset detail's `?start=export` and Settings'
 * `?connect=<id>`. The page starts it once it can, and drops it from the
 * URL, so Back doesn't ask again and the same ask works next time.
 */
import { useEffect, useRef } from "react";

export function useAsked<T>(
  asked: T | undefined,
  ready: boolean,
  start: (asked: T) => void,
  drop: () => void,
): void {
  const done = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (asked === undefined) {
      done.current = undefined;
      return;
    }
    if (!ready || done.current === asked) return;
    done.current = asked;
    drop();
    start(asked);
  });
}
