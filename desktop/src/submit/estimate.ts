/**
 * What Submit run says a run will take and write (LaptopSubmitRun): the time
 * of a start, of the whole run and of each topology, from a time per
 * evaluation; the words for a duration and a size; and whether a start runs
 * past the time limit.
 */
import { generationsOf, whole } from "../configs/words";
import { bytes } from "../setup/units";
import type { JobDefaults, RunTiming } from "../wire/types.gen";

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
  return {
    seconds: row.elapsed_s / row.evaluations,
    from: { kind: "runs", runs: row.runs },
  };
}

/**
 * The time per evaluation this computer's own timing gives (`time_evaluations`):
 * already at a start's CPUs, beside as many starts as run at once (#508).
 */
export function fromHost(seconds: number): PerEvaluation {
  return { seconds, from: { kind: "host" } };
}

/**
 * How many starts run at once as this computer times them (`time_evaluations`'
 * `running_starts`): This computer's Running-starts cap, its starts sharing
 * the computer; 1 on a cluster, whose starts each run on a node of their own.
 */
export function runningStartsOf(job: JobDefaults): number {
  return job.type === "local" ? Math.max(1, job.max_running_starts) : 1;
}

/**
 * How long a start's process takes to start, before its first evaluation:
 * Python, NumPy, CMA-ES and the core loading (#508): 0.2 s on a Mac, 1.5 s when
 * its files aren't cached; about the same on Windows (the CI VM) once warm.
 */
export const PROCESS_START_S = 1.5;

/**
 * How often This computer's coordinator sweeps: `SWEEP_EVERY_S` in
 * `engine/icmm/coordinator/sweep.py`. Its workers start and end only on a sweep.
 */
export const SWEEP_EVERY_S = 5;

/**
 * What a start takes beside its evaluations (#508): its process starting, and
 * on This computer's scheduler the wait for a sweep to see it end and start the
 * next, half a sweep on average. Measured, This computer's starts held their
 * slot about 4 s past their evaluations, on a Mac and on Windows alike. On SLURM
 * a task's slot passes to the next task of its array as it ends.
 */
export function startOverheadS(job: Pick<JobDefaults, "type">): number {
  return PROCESS_START_S + (job.type === "local" ? SWEEP_EVERY_S / 2 : 0);
}

/** A start's time: its evaluations, and what it takes beside them (`startOverheadS`). */
export const startSeconds = (evaluations: number, perEvaluationS: number, overheadS: number) =>
  evaluations * perEvaluationS + overheadS;

/** How long a start, a whole run and each of its topologies take. */
export interface Estimate {
  perStartS: number;
  totalS: number;
  perTopologyS: number;
}

/**
 * The time of a run: its starts run in waves of the most that can run at once
 * (`cap`), each wave as long as one start (`startSeconds`), so `ceil(starts /
 * cap)` waves make the whole run, and each topology takes its share. A cap
 * under 1 runs one at a time; no topologies leave no time for each.
 */
export function estimate(a: {
  starts: number;
  topologies: number;
  evaluations: number;
  perEvaluationS: number;
  overheadS: number;
  cap: number;
}): Estimate {
  const perStartS = startSeconds(a.evaluations, a.perEvaluationS, a.overheadS);
  const waves = Math.ceil(a.starts / Math.max(1, a.cap));
  const totalS = waves * perStartS;
  return {
    perStartS,
    totalS,
    perTopologyS: a.topologies > 0 ? totalS / a.topologies : 0,
  };
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

/**
 * How long something took, measured, as the clock times beside it read
 * (#538): from a minute to 10 in minutes and seconds, "4 m 35 s", so a run
 * fit from 3:27 to 3:31 never says a rounded "5 m"; otherwise as
 * `durationWords` says it, "under a minute" among them.
 */
export function elapsedWords(seconds: number): string {
  if (!(seconds >= 60) || seconds >= 600) return durationWords(seconds);
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m}\u00a0m` : `${m}\u00a0m\u00a0${s % 60}\u00a0s`;
}

/** "about 9 m", or "under a minute", which needs no "about". */
export const aboutWords = (seconds: number) =>
  seconds < 60 ? "under a minute" : `about ${durationWords(seconds)}`;

/** "≈ 43 m", or "under a minute", which needs no "≈". */
export const nearWords = (seconds: number) =>
  seconds < 60 ? "under a minute" : `≈ ${durationWords(seconds)}`;

/**
 * A duration in the one unit a rough guess needs (#542, LaptopSubmitRun's
 * `coarse`): under a minute in 5 s, to 10 m in minutes, to 90 m in 5 m, to
 * 36 h in hours, then in days.
 */
function coarse(seconds: number): [number, string] {
  const m = seconds / 60;
  if (m < 1) {
    const s = Math.max(5, Math.round(m * 12) * 5);
    return s >= 60 ? [1, "m"] : [s, "s"];
  }
  if (m < 10) return [Math.round(m), "m"];
  if (m < 90) return [Math.round(m / 5) * 5, "m"];
  if (m < 2160) return [Math.round(m / 60), "h"];
  return [Math.round(m / 1440), "d"];
}

/**
 * This computer's rough guess as a range, its timing ×0.6 to ×1.8 (#542):
 * "2–6 d" in one unit, else "40 m – 2 h"; "5 s" where both ends round alike.
 */
export function rangeWords(seconds: number): string {
  const [lo, loUnit] = coarse(seconds * 0.6);
  const [hi, hiUnit] = coarse(seconds * 1.8);
  // Ends that round to the same say it once: "5 s", not "5–5 s".
  if (lo === hi && loUnit === hiUnit) return `${lo}\u00a0${loUnit}`;
  return loUnit === hiUnit
    ? `${lo}–${hi}\u00a0${loUnit}`
    : `${lo}\u00a0${loUnit} – ${hi}\u00a0${hiUnit}`;
}

/** A pace a topology: "2 h 36 m", or under a minute its seconds, "23 s". */
export const paceWords = (seconds: number) =>
  seconds < 59.5
    ? `${Math.max(1, Math.round(seconds))}\u00a0s`
    : durationWords(Math.max(60, seconds));

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
