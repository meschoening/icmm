/**
 * Landing on a section (#398): a link that opens a page at one of its
 * sections names it in the hash (`/runs#ended`). The page's heading then
 * doesn't take focus (`PageHeading`'s `landing`); the section's heading
 * does, once, scrolled to the top, whenever it first renders, so a page
 * still reading lands when its section shows. It isn't a control, so it
 * draws no ring (`.lands`).
 */
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

/** Whether the location names `hash`: the page lands there, not on its heading. */
export function useLandsOn(hash: string): boolean {
  return useRouterState({ select: (s) => s.location.hash === hash });
}

/**
 * `at`, whether the page lands on `hash`, and `land`, the ref for the
 * heading it lands on. Call it where the page lives, not in the section,
 * so a section that renders again doesn't land again.
 */
export function useLanding(hash: string): { at: boolean; land: (el: HTMLElement | null) => void } {
  const at = useLandsOn(hash);
  const visit = useRouterState({
    select: (s) => s.location.state.__TSR_key ?? s.location.href,
  });
  const landed = useRef<string | undefined>(undefined);
  const land = useCallback(
    (el: HTMLElement | null) => {
      if (el === null || !at || landed.current === visit) return;
      landed.current = visit;
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    },
    [at, visit],
  );
  return { at, land };
}
