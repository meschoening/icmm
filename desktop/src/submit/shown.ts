/**
 * The config Submit run is on, as far as it has been read (#235): the
 * platform's configs, the one `?config=` names (else the one saved last),
 * and that config's own read. Pure, so the page can show it live or as it
 * kept it (`kept.ts`), and each state can be tested without a platform.
 */
import type {
  ConfigCheck,
  ConfigDataset,
  ConfigSummary,
  DatasetContent,
  DatasetSummary,
  PlatformSettingsResult,
  RunTiming,
  SavedConfig,
  UnreadableError,
  WireError,
} from "../wire/types.gen";

/** What the page has read. The fields are what the queries hold, so each keeps its identity. */
export interface Reads {
  /** The platform's configs, newest saved first; `undefined` until they are listed. */
  configs: ConfigSummary[] | undefined;
  /** Why the list could not be read. */
  listError: WireError | undefined;
  /** The config shown: `?config=`, else the one saved last. */
  id: string | undefined;
  /** That config as `read_config` answers. */
  saved: SavedConfig | undefined;
  /** Why that read failed. */
  error: WireError | undefined;
  /** The engine's counts for it (Which's "of 66,282"). */
  counts: ConfigCheck | undefined;
  /** How many protocols its dataset has. */
  protocols: number | undefined;
}

/**
 * `Reads`, and what the numbers under the head are made from: the platform's
 * settings, its finished starts' timings and the config's dataset (the content
 * this computer times, when no finished start has). Kept with the rest once the
 * connection goes away, so the estimate stays as it was.
 */
export interface Seen extends Reads {
  /** The platform's Platform settings; `saved` is `null` before it's set up. */
  settings: PlatformSettingsResult | undefined;
  /** By number of states and CPUs; `undefined` until read. */
  timings: RunTiming[] | undefined;
  /** The dataset's current revision, read only when no finished start can say the time. */
  content: DatasetContent | undefined;
  /** The dataset as Datasets lists it, for the points a run fits. */
  summary: DatasetSummary | undefined;
}

/** `SubmitConfig`, with what the card shows of each. */
export type Shown =
  | { kind: "none" }
  | { kind: "not_found" }
  | { kind: "loading"; name: string }
  | { kind: "failed"; name: string; error: WireError; task: "configs" | "config" }
  | { kind: "unreadable"; name: string; error: UnreadableError }
  | { kind: "ready"; name: string; dataset: ConfigDataset; saved: SavedConfig };

/** Shown where a config's name isn't known yet. */
const CONFIGS = "the configs";
const THIS = "this config";

export function shownOf(r: Reads): Shown {
  if (r.configs === undefined) {
    return r.listError === undefined
      ? { kind: "loading", name: CONFIGS }
      : { kind: "failed", name: CONFIGS, error: r.listError, task: "configs" };
  }
  if (r.configs.length === 0 || r.id === undefined) return { kind: "none" };
  const name = r.configs.find((c) => c.id === r.id)?.name ?? THIS;
  // The newest read is the truth: a config deleted or saved by a newer ICMM since it was read.
  if (r.error?.code === "not_found") return { kind: "not_found" };
  if (r.error?.code === "unreadable") return { kind: "unreadable", name, error: r.error };
  if (r.saved !== undefined) {
    return { kind: "ready", name: r.saved.config.name, dataset: r.saved.dataset, saved: r.saved };
  }
  if (r.error !== undefined) return { kind: "failed", name, error: r.error, task: "config" };
  return { kind: "loading", name };
}

/** Whether `shown` is a view worth keeping once the connection goes away. */
export const settled = (s: Shown): boolean =>
  s.kind === "none" || s.kind === "not_found" || s.kind === "unreadable" || s.kind === "ready";

/** The config's name, where it is known. */
export const nameOf = (s: Shown): string | undefined =>
  s.kind === "none" || s.kind === "not_found" ? undefined : s.name;
