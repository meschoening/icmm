/** Export's words and types (#147): where it saved, and what each outcome holds. */
import type { ReactNode } from "react";
import type { WireError, WrittenFile } from "../../wire/types.gen";
import type { Working } from "../../ui/working";

/** The dataset as the page shows it: the revision Export saves. */
export interface Shown {
  id: string;
  revision: number;
  name: string;
  protocols: number;
}

export type Outcome =
  | { kind: "written"; path: string }
  | { kind: "failed"; path: string; problem: WrittenFile["problem"]; detail: string | null }
  | { kind: "error"; path: string; error: Partial<WireError> };

export interface Export {
  working: Working;
  /** The header's Export button. */
  button: ReactNode;
  /** Presses it: ⌘K's Export <dataset>… (#412). */
  start: () => void;
  /** The note, or the red box, under the header; `null` before an export. */
  outcome: ReactNode;
}

/** The file's name and its folder's, from a path as the dialog answers it. */
export function fileAt(path: string): { file: string; folder: string } {
  const parts = path.split(/[/\\]/).filter((p) => p !== "");
  const file = parts.pop() ?? path;
  const folder = parts.pop();
  return { file, folder: folder === undefined || folder === "~" ? "your home folder" : folder };
}

/** Show in Finder, as each OS names its file manager. */
export function revealWords(os: string | undefined): string {
  return os === "windows"
    ? "Show in Explorer"
    : os === "linux"
      ? "Show in folder"
      : "Show in Finder";
}
