/**
 * What a leave question says leaving starts (#424 KF20), one rule for the
 * wizard's, the edit pages' (`datasets/leaveGuard.tsx`) and Settings': a
 * header page by its name ("Going to Runs"), and ⌘K's asks by what the
 * next page starts (`shell/asked.ts`): Import dataset… "Importing a
 * dataset", Export "Exporting a dataset", Switch platform "Switching to
 * This computer". A page with no name is "Leaving".
 */
import type { SavedPlatform } from "../wire/types.gen";

/** The header's pages, by path, as a leave question names them. */
const PAGE_NAMES: Record<string, string> = {
  "/": "Home",
  "/datasets": "Datasets",
  "/configs": "Configs",
  "/runs": "Runs",
  "/results": "Results",
  "/settings": "Settings",
};

export function leavingWords(
  next: { pathname: string; search: object },
  platforms: SavedPlatform[] | undefined,
  unnamed = "Leaving",
): string {
  const search = next.search as { start?: unknown; connect?: unknown };
  if (next.pathname === "/datasets" && search.start === "import") return "Importing a dataset";
  if (/^\/datasets\/[^/]+$/.test(next.pathname) && search.start === "export") {
    return "Exporting a dataset";
  }
  if (next.pathname === "/settings" && search.connect !== undefined) {
    const to = platforms?.find((p) => p.id === search.connect);
    if (to !== undefined) return `Switching to ${to.name}`;
  }
  const name = PAGE_NAMES[next.pathname];
  return name === undefined ? unnamed : `Going to ${name}`;
}
