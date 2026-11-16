/**
 * What Submit run's tiles, rows and stages say (LaptopSubmitRun): the work, its
 * time and where that comes from, what it writes, when it begins, and what
 * happens after it's submitted. Pure, so each state (still timing, couldn't
 * time, past the time limit, short of space, not connected) can be tested
 * without a platform. Nothing here divides by a count that may be missing: no
 * evaluations, no time per evaluation or no starts say "no estimate", never a
 * NaN or a "1 m".
 */
import { whole } from "../configs/words";
import { inSentence } from "../setup/form";
import { upTo } from "../setup/units";
import type {
  ConfigCheck,
  DatasetSummary,
  FolderChecks,
  JobDefaults,
  Run,
  RunSummary,
  RunTiming,
  SavedConfig,
  SavedPlatform,
  SearchSettings,
  WhichTopologies,
} from "../wire/types.gen";
import {
  BYTES_PER_START,
  durationWords,
  nearWords,
  estimate,
  freeWords,
  fromHost,
  fromRuns,
  overLimit,
  plural,
  sizeWords,
  type PerEvaluation,
} from "./estimate";
import { runEtaOf } from "../runs/detail";
import type { Forecast, Space } from "./forecast";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** Where the starts are processes: "here" on This computer, else "on {name}", the platform they run on. */
export const whereProcesses = (platform: Platform) =>
  platform.type === "local" ? "here" : `on ${platform.name}`;

// ── the work ─────────────────────────────────────────────────────────────────────────────────

/** What a run of the config fits: topologies, each with the config's starts. */
export interface Work {
  topologies: number;
  startsPerTopology: number;
  starts: number;
}

/**
 * The config's work: the engine's count of it when read, else the count its
 * save made. `undefined` until one of them says how many topologies there are.
 */
export function workOf(a: {
  search: Pick<SearchSettings, "starts_per_topology">;
  saved: Pick<SavedConfig, "topologies">;
  counts: Pick<ConfigCheck, "work"> | undefined;
}): Work | undefined {
  const topologies = a.counts?.work.topologies ?? a.saved.topologies;
  if (topologies === null || topologies === undefined || topologies < 1) return undefined;
  const startsPerTopology = a.search.starts_per_topology;
  const starts = a.counts?.work.starts ?? topologies * startsPerTopology;
  if (!(starts >= 1)) return undefined;
  return { topologies, startsPerTopology, starts };
}

// ── the time ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where the time per evaluation stands: known; the platform's finished starts
 * still being read; this computer timing a few evaluations (the finished starts
 * are read and none has timed this); couldn't be timed; or waiting for the platform.
 */
export type Timing =
  | { kind: "ready"; per: PerEvaluation }
  | { kind: "reading" }
  | { kind: "timing" }
  | { kind: "failed" }
  | { kind: "offline" };

/** This computer's own timing of the config, as far as it has got. */
export type HostTiming =
  | { kind: "ready"; secondsOneThread: number }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "offline" };

/**
 * The time per evaluation: from the platform's finished starts at this many
 * states and CPUs when it has some (`timings`, `undefined` while they are being
 * read), else from `host`, this computer's timing of a few evaluations.
 */
export function timingOf(a: {
  timings: RunTiming[] | undefined;
  numStates: number | null;
  cpus: number;
  host: HostTiming;
  /** The agent can be asked: what isn't read yet is being read. */
  live: boolean;
}): Timing {
  if (a.numStates === null) return { kind: "failed" };
  const row = a.timings === undefined ? undefined : fromRuns(a.timings, a.numStates, a.cpus);
  if (row !== undefined) return { kind: "ready", per: row };
  if (a.timings === undefined) return { kind: a.live ? "reading" : "offline" };
  switch (a.host.kind) {
    case "ready": {
      // Zero or not a number would make every duration "1 m" or NaN: that isn't a timing.
      const seconds = a.host.secondsOneThread;
      if (!(Number.isFinite(seconds) && seconds > 0)) return { kind: "failed" };
      return { kind: "ready", per: fromHost(seconds, a.cpus) };
    }
    case "pending":
      return { kind: "timing" };
    case "failed":
      return { kind: "failed" };
    case "offline":
      return { kind: "offline" };
  }
}

/**
 * Whether this computer must time the config: the platform's finished starts
 * are read and none has timed these states at these CPUs. One rule for the
 * read of the dataset and for the timing that follows it.
 */
export function needsHostTiming(
  timings: RunTiming[] | undefined,
  numStates: number | null,
  job: Pick<JobDefaults, "cpus_per_start"> | undefined,
): boolean {
  return (
    timings !== undefined &&
    numStates !== null &&
    job !== undefined &&
    fromRuns(timings, numStates, job.cpus_per_start) === undefined
  );
}

/** Whether the jobs go to a SLURM cluster: the settings say, else the platform's kind does. */
export function slurmOf(job: Pick<JobDefaults, "type"> | undefined, platform: Platform): boolean {
  return job === undefined ? platform.type === "ssh" : job.type === "slurm";
}

/** The Time tile, and the Each start and Each topology rows. */
export interface TimeView {
  /** "≈ 23 h", "≈ …" while it's timed, "—" when it can't be said. */
  big: string;
  /** After it: "at 16 running". */
  after: string | undefined;
  /** Under it: where the time comes from, or why there isn't one. */
  hint: string | undefined;
  /** Past the time limit (SLURM): in the hint's place, in red. */
  past: string | undefined;
  /** Each start's row: "≈ 43 m", "≈ …" or "—". */
  each: string;
  /** After Each start (SLURM): "time limit 24 h". */
  limit: string | undefined;
  /** Each start would run past the time limit. */
  over: boolean;
  /** Each topology's row. */
  topology: string;
}

const NOT_ESTIMATED = { each: "—", topology: "—" } as const;

export function timeView(a: {
  work: Work | undefined;
  /** What each start runs: `evaluationsPerStart`. */
  evaluations: number;
  /** The most starts running at once. */
  cap: number;
  /** The time limit of a start in minutes (SLURM); `null` where there is none. */
  limitMin: number | null;
  timing: Timing;
}): TimeView {
  const slurm = a.limitMin !== null;
  const limit = a.limitMin === null ? undefined : `time limit ${upTo(a.limitMin)}`;
  const base = { after: undefined, past: undefined, limit, over: false } as const;
  const { timing } = a;
  // The finished starts are still being read: nothing is being timed yet, so nothing says so.
  if (timing.kind === "reading") {
    return { ...base, big: "≈ …", hint: undefined, each: "≈ …", topology: "≈ …" };
  }
  if (timing.kind === "timing") {
    return {
      ...base,
      big: "≈ …",
      hint: "Timing a few evaluations on this computer…",
      each: "≈ …",
      topology: "≈ …",
    };
  }
  if (timing.kind === "failed") {
    return { ...base, big: "—", hint: "Couldn’t time it on this computer.", ...NOT_ESTIMATED };
  }
  if (timing.kind === "offline") {
    return { ...base, big: "—", hint: "Shows once connected", ...NOT_ESTIMATED };
  }
  const per = timing.per;
  // Nothing to run, or no time to run it in: there is no estimate to give.
  if (!(a.evaluations > 0) || !(Number.isFinite(per.seconds) && per.seconds > 0)) {
    return { ...base, big: "—", hint: undefined, ...NOT_ESTIMATED };
  }
  const perStartS = a.evaluations * per.seconds;
  const each = nearWords(perStartS);
  const over = a.limitMin !== null && overLimit(perStartS, a.limitMin);
  const source =
    per.from.kind === "runs"
      ? `From ${plural(per.from.runs, "finished run", "finished runs")} here`
      : "Timed on this computer";
  const wait = slurm
    ? "Not counting any wait for the cluster."
    : "Not counting the wait for runs ahead of it.";
  const past =
    over && a.limitMin !== null
      ? `Each start ${each}, past its ${upTo(a.limitMin)} time limit`
      : undefined;
  if (a.work === undefined) {
    return { ...base, big: "≈ …", hint: `${source}.`, each, topology: "≈ …", over };
  }
  const est = estimate({
    starts: a.work.starts,
    topologies: a.work.topologies,
    evaluations: a.evaluations,
    perEvaluationS: per.seconds,
    cap: a.cap,
  });
  return {
    big: est.totalS < 60 ? "< 1 m" : `≈ ${durationWords(est.totalS)}`,
    after: `at ${whole(a.cap)} running`,
    hint: over ? undefined : `${source}. ${wait}`,
    past,
    each,
    limit,
    over,
    topology: nearWords(est.perTopologyS),
  };
}

/** Why the Platform settings the time needs aren't there. */
export type SettingsGap = "loading" | "unset" | "failed" | "offline";

/** The Time tile and rows without the platform's settings: the cap, CPUs and limit it is made from. */
export function timeGap(why: SettingsGap): TimeView {
  const none = { after: undefined, past: undefined, limit: undefined, over: false } as const;
  switch (why) {
    case "loading":
      return { ...none, big: "≈ …", hint: undefined, each: "≈ …", topology: "≈ …" };
    case "unset":
      return { ...none, big: "—", hint: "Needs Platform settings", ...NOT_ESTIMATED };
    case "failed":
      return { ...none, big: "—", hint: "Couldn’t read Platform settings", ...NOT_ESTIMATED };
    case "offline":
      return { ...none, big: "—", hint: "Shows once connected", ...NOT_ESTIMATED };
  }
}

// ── what it writes ───────────────────────────────────────────────────────────────────────────

/** The whole-run Output estimate, separate from the first batch’s admission check. */
export interface OutputView {
  big: string;
  hint: string;
}

export function outputView(a: {
  starts: number | undefined;
  /** The Output folder as the settings write it; `undefined` until they're read. */
  folder: string | undefined;
  /** Its free space; `null` when unreadable, `undefined` before it's read. */
  free: number | null | undefined;
  live: boolean;
  platform: Platform;
}): OutputView {
  const big = a.starts === undefined ? "≈ …" : `≈ ${sizeWords(a.starts * BYTES_PER_START)}`;
  if (!a.live) {
    return {
      big,
      hint: `free space shows once ${inSentence(a.platform)} is connected`,
    };
  }
  if (a.folder === undefined) return { big, hint: "" };
  if (a.free === null || a.free === undefined) return { big, hint: a.folder };
  const free = freeWords(a.free);
  const short = a.starts !== undefined && a.free < a.starts * BYTES_PER_START;
  return {
    big,
    hint: `${short ? "only " : ""}${free} free in ${a.folder}`,
  };
}

/** The coordinator's first-admission reserve (Coordinator._room, ADR-0014). */
const SPACE_RESERVE = 100_000_000;

/**
 * Starts sent in the first sweep: each topology splits at MaxArraySize, then
 * plan_window gives each array a share of the cap. Space is reserved for every
 * task in each admitted array, including the last array's throttled tasks.
 */
export function initialStarts(work: Work, cap: number, maxArraySize: number | null): number {
  let left = cap;
  let sending = 0;
  for (let topology = 0; topology < work.topologies && left > 0; topology++) {
    let waiting = work.startsPerTopology;
    while (waiting > 0 && left > 0) {
      const size = Math.min(waiting, maxArraySize ?? waiting);
      sending += size;
      left -= Math.min(size, left);
      waiting -= size;
    }
  }
  return sending;
}

/**
 * A new run's admission, before any space hold (so no release hysteresis):
 * reserve + the first batch's files, in both folders independently. An
 * unreadable folder is ignored, exactly as Coordinator._room ignores it.
 */
export function admissionSpace(a: {
  work: Work;
  cap: number;
  maxArraySize: number | null;
  bytesPerStart: number;
  folders: FolderChecks;
  outputFolder: string;
  dataFolder: string;
}): Space | null {
  const need = SPACE_RESERVE + initialStarts(a.work, a.cap, a.maxArraySize) * a.bytesPerStart;
  for (const [role, folder, check] of [
    ["Output", a.outputFolder, a.folders.output_folder],
    ["Data", a.dataFolder, a.folders.data_folder],
  ] as const) {
    if (check.free_bytes !== null && check.free_bytes < need) {
      return { short: true, role, free: freeWords(check.free_bytes), folder };
    }
  }
  return null;
}

// ── when it begins ───────────────────────────────────────────────────────────────────────────

/** The Begins tile, and what the forecast box in the Platform aside holds. */
export interface Begins {
  glyph: "held" | "queued" | undefined;
  /** "Held", "Right away", "After #41", "Next in line", "Unknown"; "—" or "…" where there's no forecast. */
  word: string;
  hint: string;
  /**
   * The forecast, or the one sentence the box says in its place; unread SLURM jobs, three lines
   * and Try again (#452); none while Submit run is blocked.
   */
  box:
    | { kind: "forecast"; forecast: Forecast }
    | { kind: "message"; text: string }
    | { kind: "jobs_failed"; what: string; next: string; raw: string | undefined }
    | { kind: "none" };
}

/** Why there is no forecast, or the forecast. */
export type BeginsFrom =
  | { kind: "offline" }
  | { kind: "reading" }
  | { kind: "space_unknown" }
  | { kind: "unset" }
  /** Something about the config blocks Submit run, which says what (#326). */
  | { kind: "blocked" }
  | { kind: "failed"; what: "settings" | "runs" }
  /** `raw`: the read's error as the raw line says it; none where SLURM answered it isn't there. */
  | { kind: "failed"; what: "jobs"; raw: string | undefined }
  | { kind: "forecast"; forecast: Forecast };

export function beginsOf(from: BeginsFrom, a: { slurm: boolean; platform: Platform }): Begins {
  const none = { glyph: undefined } as const;
  const where = inSentence(a.platform);
  // Where the starts are processes, whose runs they are: this computer's, or the SSH platform's.
  const runs = `${where}’s runs`;
  const jobs = a.slurm ? "your SLURM jobs" : runs;
  switch (from.kind) {
    case "offline":
      return {
        ...none,
        word: "—",
        hint: "Shows once connected",
        box: {
          kind: "message",
          text: a.slurm
            ? `Your SLURM jobs show once ${inSentence(a.platform)} is connected.`
            : `Starts on ${where} show once ${where} is connected.`,
        },
      };
    case "reading":
      return {
        ...none,
        word: "…",
        hint: a.slurm ? "Reading your jobs…" : "Reading your runs…",
        box: { kind: "message", text: `Reading ${jobs}…` },
      };
    case "space_unknown":
      return {
        ...none,
        word: "Unknown",
        hint: "Space estimate unavailable",
        box: {
          kind: "message",
          text: "ICMM couldn’t estimate the space needed to begin this run. You can still submit it.",
        },
      };
    case "blocked":
      return { ...none, word: "—", hint: "", box: { kind: "none" } };
    case "unset":
      return {
        ...none,
        word: "—",
        hint: "Needs Platform settings",
        box: {
          kind: "message",
          text: `Set up ${inSentence(a.platform)} in Platform settings to see when this run begins.`,
        },
      };
    case "failed": {
      if (from.what === "jobs") {
        // Nothing blocks submitting, so the box keeps its own gray, not a failure's red.
        return {
          ...none,
          word: "—",
          hint: "Couldn’t read your jobs",
          box: {
            kind: "jobs_failed",
            what: "Couldn’t read your SLURM jobs, so ICMM can’t say when this run begins.",
            next: "You can still submit; it waits its turn like any run.",
            raw: from.raw,
          },
        };
      }
      // The runs in flight are part of a cluster's forecast too, beside the jobs.
      const what =
        from.what === "settings"
          ? "Platform settings"
          : a.slurm
            ? "your runs and jobs"
            : "your runs";
      const box =
        from.what === "settings" ? "Platform settings" : a.slurm ? "your runs and jobs" : runs;
      return {
        ...none,
        word: "—",
        hint: `Couldn’t read ${what}`,
        box: {
          kind: "message",
          text: `Couldn’t read ${box}, so ICMM can’t say when this run begins.`,
        },
      };
    }
    case "forecast":
      return {
        // "Unknown" is drawn bare: a glyph would say a state the forecast doesn't know.
        glyph: from.forecast.glyph,
        word: from.forecast.word,
        hint: from.forecast.short,
        box: from,
      };
  }
}

/** One of the four tiles. */
export interface Tile {
  name: "Work" | "Time" | "Begins" | "Output";
  /** Its big words are in the mono face (the count of starts). */
  mono: boolean;
  glyph: "held" | "queued" | undefined;
  big: string;
  /** After the big words, in the text face. */
  unit: string | undefined;
  hint: string | undefined;
  /** In red, in place of the hint (Time, past the time limit). */
  past: string | undefined;
}

export function tilesOf(a: {
  work: Work | undefined;
  time: TimeView;
  begins: Begins;
  output: OutputView;
}): Tile[] {
  const { work, time, begins, output } = a;
  return [
    {
      name: "Work",
      mono: true,
      glyph: undefined,
      big: work === undefined ? "…" : whole(work.starts),
      unit: work?.starts === 1 ? "start" : "starts",
      hint:
        work === undefined
          ? undefined
          : `= ${plural(work.topologies, "topology", "topologies")} × ${whole(work.startsPerTopology)}`,
      past: undefined,
    },
    {
      name: "Time",
      mono: false,
      glyph: undefined,
      big: time.big,
      unit: time.after,
      hint: time.hint,
      past: time.past,
    },
    {
      name: "Begins",
      mono: false,
      glyph: begins.glyph,
      big: begins.word,
      unit: undefined,
      hint: begins.hint === "" ? undefined : begins.hint,
      past: undefined,
    },
    {
      name: "Output",
      mono: false,
      glyph: undefined,
      big: output.big,
      unit: undefined,
      hint: output.hint === "" ? undefined : output.hint,
      past: undefined,
    },
  ];
}

/**
 * When each in-flight run's last start ends, by run: the one ETA Runs and
 * Run detail show too (`runEtaOf`, #326). A run with none isn't in it.
 */
export function etasOf(
  runs: Run[],
  a: { timings: RunTiming[]; cpus: number; cap: number; now: number },
): Map<number, number | undefined> {
  const etas = new Map<number, number | undefined>();
  for (const run of runs) {
    const eta = runEtaOf(run, a);
    if (eta !== undefined) etas.set(run.id, eta.at);
  }
  return etas;
}

/**
 * The in-flight runs an ETA can come for, before any of them is read: those
 * with a topology ended, which time themselves, and those whose states and
 * CPUs (the current ones) a finished start has timed. Until the finished
 * starts are read (`undefined`), any could be.
 */
export function etaDueOf(
  runs: Pick<RunSummary, "id" | "num_states" | "progress">[],
  a: { timings: RunTiming[] | undefined; cpus: number },
): Set<number> {
  return new Set(
    runs
      .filter(
        (r) =>
          r.progress.topologies_complete + r.progress.topologies_failed > 0 ||
          a.timings === undefined ||
          fromRuns(a.timings, r.num_states, a.cpus),
      )
      .map((r) => r.id),
  );
}

// ── what happens after it's submitted ────────────────────────────────────────────────────────

/** A stage and what happens in it. */
export type Stage = [name: string, what: string];

/** The dataset's points as the datasets list counts them; `undefined` where it can't say. */
export interface Points {
  train: number;
  validation: number;
}

export function stagesOf(a: {
  platform: Platform;
  slurm: boolean;
  /** The partition jobs go to; `null` for the cluster's default. */
  partition: string | null;
  cap: number;
  which: WhichTopologies;
  states: number | null;
  /** Every topology with that many states, from the engine's count. */
  all: number | undefined;
  work: Work | undefined;
  dataset: string;
  points: Points | undefined;
}): Stage[] {
  const states = a.states === null ? "its states" : plural(a.states, "state", "states");
  const of = a.all === undefined ? "" : `${whole(a.all)} `;
  let topologies: string;
  switch (a.which.kind) {
    case "sample":
      topologies = `Draws ${whole(a.which.count)} of the ${of}topologies with ${states}`;
      break;
    case "all":
      topologies = `Fits all ${of}topologies with ${states}`;
      break;
    case "ids":
      topologies =
        a.work === undefined
          ? `Fits its specific topologies with ${states}`
          : `Fits ${plural(a.work.topologies, "specific topology", "specific topologies")} with ${states}`;
      break;
  }
  const one = a.work?.starts === 1;
  const lead = a.work === undefined ? "Each start" : plural(a.work.starts, "start", "starts");
  const [fit, score] = a.work === undefined || one ? ["fits", "scores"] : ["fit", "score"];
  const finish = "results appear on the run page as they finish";
  let fitting: string;
  if (a.points === undefined) {
    fitting = `${lead} ${fit} ${a.dataset}; ${finish}`;
  } else {
    const train = plural(a.points.train, "train point", "train points");
    const validation =
      a.points.validation > 0
        ? ` and ${score} its ${plural(a.points.validation, "validation point", "validation points")}`
        : "";
    fitting = `${lead} ${fit} ${a.dataset}’s ${train}${validation}; ${finish}`;
  }
  return [
    [
      "queued",
      a.slurm
        ? `The run’s coordinating job waits for a slot on ${a.partition ?? "the cluster’s default partition"}`
        : `Waits for a free slot on ${inSentence(a.platform)}`,
    ],
    ["topologies", topologies],
    [
      "submitting",
      a.slurm
        ? `Sends each topology’s starts as one job array, at most ${whole(a.cap)} running at once`
        : `Hands starts to processes ${whereProcesses(a.platform)}, at most ${whole(a.cap)} at once`,
    ],
    ["fitting", fitting],
  ];
}

/** A dataset's points as its summary counts them: all, less the validation points; `undefined` where it can't say. */
export function pointsOf(summary: DatasetSummary | undefined): Points | undefined {
  if (summary === undefined || summary.unreadable !== null || summary.validation === null) {
    return undefined;
  }
  const total = summary.protocols.reduce((sum, p) => sum + p.points, 0);
  return { train: total - summary.validation, validation: summary.validation };
}
