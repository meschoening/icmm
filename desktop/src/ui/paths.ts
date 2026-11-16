/**
 * This computer's paths as its OS writes them (#326). The engine and the
 * settings write a path from `~/`, which macOS and Linux show as it is; on
 * Windows, where `~` means nothing in File Explorer, it's shown in full from
 * the home folder, with Windows' backslashes. Another platform's paths are
 * its own, so they stay as they are.
 */
import { useQuery } from "@tanstack/react-query";
import { commands } from "../wire/api.gen";
import type { SavedPlatform } from "../wire/types.gen";

/** `path` from `~/`, in full from `home` with backslashes; as it is when `home` is `null`. */
export function shownPath(path: string, home: string | null): string {
  if (home === null) return path;
  const full = path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  return full.replace(/\//g, "\\");
}

/** This computer's home folder in full on Windows; `null` elsewhere, and until it's read. */
function useWindowsHome(): string | null {
  return (
    useQuery({
      queryKey: ["home_folder"],
      queryFn: () => commands.home_folder(),
      staleTime: Infinity,
    }).data?.path ?? null
  );
}

/** How `platform`'s paths are shown: This computer's as its OS writes them, any other's as they are. */
export function useShownPath(
  platform: Pick<SavedPlatform, "type"> | undefined,
): (path: string) => string {
  const home = useWindowsHome();
  return (path) => (platform?.type === "local" ? shownPath(path, home) : path);
}
