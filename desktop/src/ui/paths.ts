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

/**
 * What `shown`, a path as `shownPath` shows it, is written as: from `~/` with
 * forward slashes where it's in `home` (in any case, as Windows reads it),
 * else as it is. A field that shows a path takes it back this way, so a
 * folder the user leaves alone saves as it was (#505).
 */
export function storedPath(shown: string, home: string | null): string {
  if (home === null) return shown;
  // Windows reads either slash, in any case.
  const read = (path: string) => path.toLowerCase().replace(/\//g, "\\");
  const typed = read(shown);
  const at = read(home).replace(/\\+$/, "");
  if (typed === at) return "~";
  if (!typed.startsWith(`${at}\\`)) return shown;
  return `~/${shown.slice(at.length + 1).replace(/\\/g, "/")}`;
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

/** `useShownPath`, and its way back for a field the user types a path in. */
export function usePathField(platform: Pick<SavedPlatform, "type"> | undefined): {
  shown: (path: string) => string;
  stored: (shown: string) => string;
} {
  const home = useWindowsHome();
  const local = platform?.type === "local";
  return {
    shown: (path) => (local ? shownPath(path, home) : path),
    stored: (shown) => (local ? storedPath(shown, home) : shown),
  };
}
