/**
 * What Submit run says a run will take and write (LaptopSubmitRun): the time
 * of a start, of the whole run and of each topology, from a time per
 * evaluation; the words for a duration and a size; and whether a start runs
 * past the time limit.
 */
import { generationsOf, whole } from "../configs/words";
import { bytes } from "../setup/units";
import type { RunTiming } from "../wire/types.gen";

/** A count with its noun, grouped by thousands: "1 start", "1,500 starts". */
export const plural = (n: number, one: string, many: string) =>
  `${whole(n)} ${n === 1 ? one : many}`;

/**
 * What a start writes under the Output folder, its results and logs; mirrors
 * `OUTPUT_SIZE` in `setup/form.ts` ("about 30 KB a start").
 */
export const BYTES_PER_START = 30_000;

/**
 * The evaluations a start runs: its whole budget, its last generation whole
 * (ADR-0008), `ceil(budget / population) × population`; 0 without a population
 * of at least 2 or a budget of at least 1.
 */
export function evaluationsPerStart(budget: number, population: number): number {
  const generations = generationsOf(budget, population);
  return generations === null ? 0 : generations * population;
}

/** The time of one evaluation at a start's CPUs, and what it comes from. */
export type PerEvaluation = {
  seconds: number;
  from: { kind: "runs"; runs: number } | { kind: "host" };
};

/**
 * The time per evaluation the platform's finished starts took: their elapsed
 * time over their evaluations, from the row with exactly this number of states
 * and these CPUs per start (#229). `undefined` when none has finished here, or
 * when the row can't say (no evaluations, or no time, which would make every
 * duration a minute): it is then no row, and this computer's timing stands in.
 */
export function fromRuns(
  timings: RunTiming[],
  numStates: number,
  cpus: number,
): PerEvaluation | undefined {
  const row = timings.find(
    (t) =>
      t.num_states === numStates &&
      t.cpus_per_start === cpus &&
      t.evaluations > 0 &&
      Number.isFinite(t.evaluations) &&
      t.elapsed_s > 0 &&
      Number.isFinite(t.elapsed_s),
  );
  if (row === undefined) return undefined;
  return { seconds: row.elapsed_s / row.evaluations, from: { kind: "runs", runs: row.runs } };
}

/**
 * The time per evaluation this computer's own timing gives: one thread's time
 * for an evaluation, spread over a start's CPUs.
 */
export function fromHost(secondsOneThread: number, cpus: number): PerEvaluation {
  return { seconds: secondsOneThread / Math.max(1, cpus), from: { kind: "host" } };
}

/** How long a start, a whole run and each of its topologies take. */
export interface Estimate {
  perStartS: number;
  totalS: number;
  perTopologyS: number;
}

/**
 * The time of a run: its starts run in waves of the most that can run at once
 * (`cap`), each wave as long as one start, so `ceil(starts / cap)` waves make
 * the whole run, and each topology takes its share. A cap under 1 runs one at
 * a time; no topologies leave no time for each.
 */
export function estimate(a: {
  starts: number;
  topologies: number;
  evaluations: number;
  perEvaluationS: number;
  cap: number;
}): Estimate {
  const perStartS = a.evaluations * a.perEvaluationS;
  const waves = Math.ceil(a.starts / Math.max(1, a.cap));
  const totalS = waves * perStartS;
  return { perStartS, totalS, perTopologyS: a.topologies > 0 ? totalS / a.topologies : 0 };
}

/**
 * A duration as Submit writes it, in the one or two units that matter: "43 m",
 * "1 h 30 m", "23 h" (from 10 hours the minutes go, rounded to whole hours),
 * "1 d 2 h", "2 d" (days from 24 rounded hours). Under a minute says so (#324).
 */
export function durationWords(seconds: number): string {
  if (!(seconds >= 60)) return "under a minute";
  const minutes = Math.round(seconds / 60);
  // No-break spaces throughout: a duration never breaks between a number and its unit (#449).
  if (minutes < 600) {
    const hours = Math.floor(minutes / 60);
    return hours >= 1
      ? `${hours}\u00a0h` + (minutes % 60 ? `\u00a0${minutes % 60}\u00a0m` : "")
      : `${minutes}\u00a0m`;
  }
  // From 10 hours the minutes are noise: whole hours first, then days, so 23 h 40 m is "1 d".
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}\u00a0h`;
  return `${Math.floor(hours / 24)}\u00a0d` + (hours % 24 ? `\u00a0${hours % 24}\u00a0h` : "");
}

/** "about 9 m", or "under a minute", which needs no "about". */
export const aboutWords = (seconds: number) =>
  seconds < 60 ? "under a minute" : `about ${durationWords(seconds)}`;

/** "≈ 43 m", or "under a minute", which needs no "≈". */
export const nearWords = (seconds: number) =>
  seconds < 60 ? "under a minute" : `≈ ${durationWords(seconds)}`;

/** A pace a topology: "2 h 36 m", or under a minute its seconds, "23 s". */
export const paceWords = (seconds: number) =>
  seconds < 59.5 ? `${Math.max(1, Math.round(seconds))} s` : durationWords(Math.max(60, seconds));

/** Whether a start runs longer than the time limit (minutes), so SLURM would end it. */
export function overLimit(perStartS: number, limitMin: number): boolean {
  return perStartS > limitMin * 60;
}

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/** A size as it's shown in a unit: whole in KB and from 10, else to one decimal. */
function shownIn(value: number, unitIndex: number): number {
  return unitIndex === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

/**
 * A size in decimal units as Submit writes it: "30 KB" (whole, 1 at least),
 * "4.6 GB" (one decimal under 10, dropped when .0), "212 GB" (whole from 10).
 * A size that rounds up to 1000 is written in the next unit.
 */
export function sizeWords(n: number): string {
  let unit = 0;
  let value = n / 1000;
  let shown = shownIn(value, unit);
  while (shown >= 1000 && unit < SIZE_UNITS.length - 1) {
    unit += 1;
    value /= 1000;
    shown = shownIn(value, unit);
  }
  return `${unit === 0 ? Math.max(1, shown) : shown} ${SIZE_UNITS[unit]}`;
}

/**
 * Free space as Platform settings writes it (`bytes`: floored, "4.9 GB"), so a folder
 * reads the same in both places; one with none says "0 B", which `bytes` can't.
 */
export const freeWords = (free: number) => (free === 0 ? "0 B" : bytes(free));
