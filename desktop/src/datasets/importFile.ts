/**
 * Import's words and types (#147): a file's read as the box takes it, and
 * what the red box says of one that can't be imported.
 */
import { newerWords } from "../newer";
import type { DatasetContent, DatasetFile, Issue, WireError } from "../wire/types.gen";
import { count } from "./format";
import { datasetName } from "./sheets";

/** The wizard's name rule, in its words. */
export const NAME_RULE = "Letters, digits, ., - and _, up to 64.";
export const NAME_TAKEN = "Another dataset already has this name.";

/** A file that can be imported, as read. */
export interface Read {
  path: string;
  file: DatasetFile & { content: DatasetContent; scoring_digest: string };
}

/** Why a file can't be imported: its read's problem, or the engine's error. */
export interface Failed {
  path: string;
  file: DatasetFile | null;
  error?: Partial<WireError>;
  /** The file's name, as the dialog answered. */
  name: string;
}

export interface Imported {
  id: string;
  name: string;
  file: string;
}

export type State =
  { kind: "idle" } | { kind: "read"; read: Read } | { kind: "failed"; failed: Failed };

export const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;
/** The dataset's name a file proposes: its own, else the file's name without `.zip`. */
export const baseName = (file: DatasetFile) =>
  file.name ?? datasetName(file.file.replace(/\.zip$/i, ""));

/**
 * An issue in a file, in the checks' words after where it is: "ssiE, point
 * 4: SD must be blank or at least 0.", or "peak: Weight must be a number
 * above 0.".
 */
export function issueWords(issue: Issue, names: string[]): string {
  const [top, i, part, k] = issue.path;
  if (top !== "protocols" || i === undefined) return issue.message;
  const n = Number(i);
  const protocol = names[n] || `Protocol ${n + 1}`;
  if ((part === "points" || part === "steps") && k !== undefined) {
    const what = part === "points" ? "point" : "step";
    return `${protocol}, ${what} ${Number(k) + 1}: ${issue.message}`;
  }
  return `${protocol}: ${issue.message}`;
}

/** What the red box says of a file that can't be imported, by why. */
export function failureWords(f: Failed): {
  what: string;
  next: string;
  items: string[];
  raw: string;
} {
  const file = f.name;
  const dataset = f.file === null ? file.replace(/\.zip$/i, "") : baseName(f.file);
  if (f.file === null || f.file.problem === null) {
    return {
      what: `ICMM couldn’t open ${file}.`,
      next: f.error?.message ?? "Try again.",
      items: [],
      raw: `${file} · ${f.error?.code ?? "error"}`,
    };
  }
  const raw = f.file.detail ?? file;
  switch (f.file.problem) {
    case "not_dataset":
      return {
        what: `${file} isn’t a dataset file.`,
        next: "Import reads the .zip that Export saves on a dataset’s page. To build a dataset from an Excel workbook, use New dataset.",
        items: [],
        raw,
      };
    case "damaged":
      return {
        what: `ICMM couldn’t open ${file}.`,
        next: `It may be damaged, or not finished downloading. Export ${dataset} again, or ask for a new copy.`,
        items: [],
        raw,
      };
    case "invalid":
      return {
        what: `${file} has ${count(f.file.issues.length, "problem")}, so ICMM can’t import it.`,
        next: `Its files were probably changed by hand after it was exported. Export ${dataset} again where it was made, then import the new file.`,
        items: f.file.issues.map((i) => issueWords(i, f.file!.protocol_names)),
        raw,
      };
    case "newer":
      return {
        // It names this ICMM's version, which can't read the file (#168).
        what: newerWords(file),
        next: "Update ICMM on this computer to import it.",
        items: [],
        raw,
      };
  }
}
