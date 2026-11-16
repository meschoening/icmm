/**
 * Focus on a page change (old ADR-0028): when the path changes, focus goes
 * to the new page's heading, whatever caused the change, so a screen reader
 * hears where it landed and the next Tab starts from the page.
 */
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/** Marks the page heading `usePageChangeFocus` moves focus to. */
export const PAGE_HEADING_ATTR = "data-page-heading";

/**
 * Focuses the new page's heading when the path changes. Not on the first
 * render, and not when only the query or hash changes: that is a filter
 * within a page.
 */
export function usePageChangeFocus(): void {
  // The resolved location, not `location`: the router moves `location`
  // before the new page renders, while the old heading is still there.
  const pathname = useRouterState({ select: (s) => s.resolvedLocation?.pathname ?? null });
  const last = useRef<string | null>(null);
  useEffect(() => {
    const previous = last.current;
    last.current = pathname;
    if (previous === null || pathname === null || previous === pathname) return;
    document.querySelector<HTMLElement>(`[${PAGE_HEADING_ATTR}]`)?.focus();
  }, [pathname]);
}
