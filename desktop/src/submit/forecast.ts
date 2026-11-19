/**
 * What Submit run says about when a run begins (LaptopSubmitRun): the user's
 * SLURM jobs against the cluster's job limit, or This computer's slots, as
 * blocks of the runs holding them; whether the run can begin right away, is
 * held at the limit, waits for the runs ahead of it, is held for space, or
 * can't be told because the limit wasn't read; and each in-flight run's ETA.
 * No verdict here blocks a submit: the forecast only says what to expect.
 */
import { asSubject, inSentence } from "../setup/form";
import { clock } from "../ui/clock";
import type { JobCounts, RunSummary, SavedPlatform } from "../wire/types.gen";
import { plural, startSeconds } from "./estimate";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** One part of the bar of jobs or slots: a run's starts, jobs that aren't a run's starts, or free ones. */
export type Block =
  | { kind: "run"; run: number; starts: number; eta: number | undefined }
  | { kind: "other"; n: number }
  | { kind: "free"; n: number };

/** The Begins tile and the forecast panel under it. */
export interface Forecast {
  verdict: "held" | "right_away" | "after" | "space" | "unknown";
  /** The Begins tile: "Held", "Right away", "After #41", "Next in line", "Held for space" or "Unknown". */
  word: string;
  /** The status glyph beside the word; absent where nothing is forecast (a job limit nobody could read). */
  glyph?: "held" | "queued";
  /** The Begins tile's hint. */
  short: string;
  /** "Your SLURM jobs on general-cpu", "Your SLURM jobs" or "Starts on this computer" (or on the SSH platform's name). */
  head: string;
  count: number;
  of: number | null;
  /** After the count and its limit: " · limit", " · in use" or "". */
  tail: string;
  /** The runs holding jobs or slots, newest first, then others' jobs, then the free ones. */
  blocks: Block[];
  say: string;
  /** The scheduler's own reason, for a hold at the job limit. */
  raw?: string;
  hint?: string;
}

/** Whether either folder has room for the first batch and reserve; `free` is already in words (`freeWords`). */
export interface Space {
  role: "Output" | "Data";
  short: boolean;
  free: string;
  folder: string;
}

/** The in-flight runs holding starts, newest first, as the blocks that show them. */
function runBlocks(
  inFlight: RunSummary[],
  etas: Map<number, number | undefined>,
): Extract<Block, { kind: "run" }>[] {
  return inFlight
    .filter((r) => r.progress.starts_running > 0)
    .sort((a, b) => b.id - a.id)
    .map((r) => ({
      kind: "run",
      run: r.id,
      starts: r.progress.starts_running,
      eta: etas.get(r.id),
    }));
}

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** A count in words to ten, in digits above: "two", "11". */
const numberWords = (n: number) => NUMBER_WORDS[n - 1] ?? String(n);

/** A run that is short of space, held until its folders have room: it wins over any other verdict. */
function heldForSpace(forecast: Forecast, space: Space): Forecast {
  const held: Forecast = {
    ...forecast,
    verdict: "space",
    word: "Held for space",
    glyph: "held",
    short: `Only ${space.free} free`,
    say: `Only ${space.free} is free in ${space.folder}, less than the first batch needs with its 100 MB reserve, so it will be held for space.`,
    hint:
      space.role === "Data"
        ? "Free some space in the Data folder before you submit."
        : "Free some space, or choose another Output folder in Platform settings before you submit.",
  };
  delete held.raw;
  return held;
}

/** Jobs a run needs free under the limit: its coordinator and one start (ADR-0019). */
const JOBS_TO_BEGIN = 2;

/**
 * JOBS_TO_BEGIN in words: its coordinating job and one start. Every sentence about the jobs a run
 * needs takes them from here, so a change to JOBS_TO_BEGIN shows in the words beside it.
 */
const NEEDED_JOBS = {
  /** After "needs 2 free,". */
  split: "one for its coordinating job and one for a start",
  /** After "room for" and "can’t fit". */
  both: "this run’s coordinating job and a start",
};

/**
 * The forecast on SLURM: the user's running jobs against the cluster's job
 * limit. A run needs JOBS_TO_BEGIN jobs free under it, one for its coordinating
 * job and one for a start (the cap is a maximum its coordinator shares among its
 * arrays, sending more as slots free, and a run is running once any start runs:
 * ADR-0019), so with fewer free it is held. One free says another job must
 * finish; none free, or more running than the limit (squeue counts jobs outside
 * the partition too), says enough must, since how many isn't known. A limit
 * under JOBS_TO_BEGIN can't ever fit it, and says so. The hint counts each run's
 * coordinating job beside its `cap` starts. With room for both a run can begin
 * right away, never a promised start. With no limit read (`null`) nothing can
 * be told about a wait: "Unknown", with no glyph. No verdict blocks the submit.
 */
export function slurmForecast(a: {
  jobs: JobCounts;
  limit: number | null;
  cap: number;
  partition: string | null;
  inFlight: RunSummary[];
  etas: Map<number, number | undefined>;
  space: Space | null;
}): Forecast {
  const { running } = a.jobs;
  const runs = runBlocks(a.inFlight, a.etas);
  const blocks: Block[] = [...runs];
  const other = running - runs.reduce((sum, r) => sum + r.starts, 0);
  if (other > 0) blocks.push({ kind: "other", n: other });
  if (a.limit !== null && a.limit - running > 0) {
    blocks.push({ kind: "free", n: a.limit - running });
  }
  const base = {
    head: a.partition ? `Your SLURM jobs on ${a.partition}` : "Your SLURM jobs",
    count: running,
    of: a.limit,
    blocks,
  };

  let forecast: Forecast;
  if (a.limit === null) {
    forecast = {
      ...base,
      verdict: "unknown",
      word: "Unknown",
      short: `${running} of your jobs running · limit unknown`,
      tail: "",
      say: "ICMM found no job limit it could read, so it can’t tell whether this run will wait. You can still submit it.",
    };
  } else if (a.limit - running < JOBS_TO_BEGIN) {
    const k = runs.length;
    const free = a.limit - running;
    // A limit under JOBS_TO_BEGIN never has room, whatever is running. Otherwise one job short of
    // enough, or none free: with more running than the limit (squeue counts jobs outside the
    // partition too) how many must finish isn't known, so no count is promised.
    const tooSmall = a.limit < JOBS_TO_BEGIN;
    const say = tooSmall
      ? `Your limit of ${plural(a.limit, "job", "jobs")} can’t fit ${NEEDED_JOBS.both}, so it can’t begin on this partition.`
      : free > 0
        ? `${free} of your ${plural(a.limit, "job", "jobs")} is free. This run needs ${JOBS_TO_BEGIN}, ${NEEDED_JOBS.split}, so it’s held until another of your jobs finishes.`
        : `Your running jobs fill your limit of ${a.limit}. This run needs ${JOBS_TO_BEGIN} free, ${NEEDED_JOBS.split}, so it’s held until enough of your jobs finish.`;
    forecast = {
      ...base,
      verdict: "held",
      word: "Held",
      glyph: "held",
      short: `${running} of your ${plural(a.limit, "job", "jobs")} in use`,
      tail: running >= a.limit ? " · limit" : "",
      say,
      raw: "QOSMaxJobsPerUserLimit",
      ...(!tooSmall && k >= 1 && k * (a.cap + 1) >= a.limit
        ? {
            hint: `Each run takes up to ${plural(a.cap, "running start", "running starts")} plus its coordinating job, so ${numberWords(k)} ${k === 1 ? "run" : "runs"} can fill your ${a.limit}.`,
          }
        : {}),
    };
  } else {
    const free = a.limit - running;
    forecast = {
      ...base,
      verdict: "right_away",
      word: "Right away",
      glyph: "queued",
      short: `${running} of your ${plural(a.limit, "job", "jobs")} in use`,
      tail: "",
      say: `${free} of your ${a.limit} jobs are free, room for ${NEEDED_JOBS.both}, so it can begin right away.`,
    };
  }
  return a.space?.short ? heldForSpace(forecast, a.space) : forecast;
}

/** Starts of the run that no slot has been given yet: not finished, not failed, not running. */
const startsWaiting = (r: RunSummary) => {
  const { starts, starts_finished, starts_failed, starts_running } = r.progress;
  return Math.max(0, starts - starts_finished - starts_failed - starts_running);
};

/** How many runs ahead are named before the rest are counted: "#43, #42, #41 and 2 more". */
const NAMED_AHEAD = 3;

/** Run numbers, newest first, as a phrase: "#42", "#42 and #41", "#43, #42 and #41", "#45, #44, #43 and 2 more". */
function runList(ids: number[]): string {
  const named = ids.slice(0, NAMED_AHEAD).map((id) => `#${id}`);
  const more = ids.length - named.length;
  if (more > 0) return `${named.join(", ")} and ${more} more`;
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
}

/**
 * The forecast where starts are processes, not jobs: This computer's, or an SSH
 * platform's without SLURM: its `cap` slots, shared by all its runs, which give
 * them to waiting starts earlier run first. A run with starts still waiting is
 * ahead of this one, so this one begins after the newest of them; with none
 * ahead but every slot in use, no run is ahead in the queue, and this one is
 * next in line for the first slot a start frees; with a slot free it can begin
 * right away. A run with no starts waiting and none running is never ahead.
 */
export function localForecast(a: {
  platform: Platform;
  cap: number;
  inFlight: RunSummary[];
  etas: Map<number, number | undefined>;
  space: Space | null;
}): Forecast {
  const runs = runBlocks(a.inFlight, a.etas);
  const count = runs.reduce((sum, r) => sum + r.starts, 0);
  const blocks: Block[] = [...runs];
  if (a.cap - count > 0) blocks.push({ kind: "free", n: a.cap - count });
  const subject = asSubject(a.platform);
  const base = {
    head: `Starts on ${inSentence(a.platform)}`,
    count,
    of: a.cap,
    blocks,
  };
  const capSentence = `${subject} runs up to ${plural(a.cap, "start", "starts")} at once for all its runs`;

  // Newest first: the first is the last one ahead in the queue.
  const ahead = a.inFlight
    .filter((r) => startsWaiting(r) > 0)
    .map((r) => r.id)
    .sort((x, y) => y - x);
  let forecast: Forecast;
  if (ahead.length > 0) {
    const one = ahead.length === 1;
    forecast = {
      ...base,
      verdict: "after",
      word: `After #${ahead[0]}`,
      glyph: "queued",
      short: one ? `#${ahead[0]} is ahead of it` : `${ahead.length} runs are ahead of it`,
      tail: count >= a.cap ? " · in use" : "",
      say: `${capSentence}, and ${runList(ahead)} still ${one ? "has" : "have"} starts waiting, which go first.`,
    };
  } else if (count >= a.cap && runs.length > 0) {
    forecast = {
      ...base,
      verdict: "after",
      word: "Next in line",
      glyph: "queued",
      short: `${subject}’s ${plural(a.cap, "slot", "slots")} ${a.cap === 1 ? "is" : "are"} in use`,
      tail: " · in use",
      say: `${capSentence}, and every slot is in use, so this run begins as their starts end.`,
    };
  } else {
    forecast = {
      ...base,
      verdict: "right_away",
      word: "Right away",
      glyph: "queued",
      short: `${count} of ${plural(a.cap, "slot", "slots")} in use`,
      tail: "",
      say: `${capSentence}, and ${a.cap - count} ${a.cap - count === 1 ? "is" : "are"} free, so this run can begin right away.`,
    };
  }
  return a.space?.short ? heldForSpace(forecast, a.space) : forecast;
}

/**
 * When a run's last start ends: its starts left (not finished, not failed) in
 * waves of `cap` at once, each as long as one start (`startSeconds`), from
 * `now` (ms). A cap under 1 runs one at a time; nothing left ends now.
 *
 * A running run counts the time it has spent fitting (`fittingS`, #507's
 * F12): its starts that don't fail take their waves from its first start
 * running, so its ETA holds while they run on time, rather than slipping a
 * minute a minute until one ends. Running late, it's never sooner than the
 * waves its waiting starts still need after those running.
 */
export function etaOf(a: {
  run: Pick<RunSummary, "progress">;
  evaluations: number;
  perEvaluationS: number;
  overheadS: number;
  cap: number;
  now: number;
  fittingS?: number;
}): number {
  const { starts, starts_finished, starts_failed, starts_running } = a.run.progress;
  const cap = Math.max(1, a.cap);
  const perStartS = startSeconds(a.evaluations, a.perEvaluationS, a.overheadS);
  const remaining = Math.max(0, starts - starts_finished - starts_failed);
  if (a.fittingS === undefined) return a.now + Math.ceil(remaining / cap) * perStartS * 1000;
  const due = Math.ceil(Math.max(0, starts - starts_failed) / cap) * perStartS - a.fittingS;
  const waiting = Math.max(0, remaining - starts_running);
  return a.now + Math.max(due, Math.ceil(waiting / cap) * perStartS) * 1000;
}

/** "ETA 6:30 AM" today, "ETA Thu, Aug 20, 6:30 AM" another day. */
export const etaWords = (eta: number, now: number) => `ETA ${clock(eta, now)}`;
