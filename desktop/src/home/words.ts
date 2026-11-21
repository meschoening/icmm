/**
 * What Home says (LaptopMain, #388): its summary line in Runs' counts, a
 * running card's lines in Runs' words, and its best-so-far sparkline from
 * the run's **Stretches**.
 */
import { whole } from "../configs/words";
import { etaDay, type Eta } from "../runs/detail";
import { inSentence } from "../setup/form";
import { durationWords, plural } from "../submit/estimate";
import { clock } from "../ui/clock";
import type { RunCounts, RunStretches, RunSummary, SavedPlatform } from "../wire/types.gen";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** The most runs Live shows as cards; the rest are one line (#386). */
export const LIVE_CARDS = 3;

/** Midnight at the start of yesterday, local time: what "since yesterday" counts from. */
export function yesterdayOf(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Whether a listed run ended at or after `cutoff`. */
export function endedSince(r: Pick<RunSummary, "ended_at">, cutoff: number): boolean {
  if (r.ended_at === null) return false;
  const at = Date.parse(r.ended_at);
  return !Number.isNaN(at) && at >= cutoff;
}

/**
 * Home's summary line (#388): "2 running with 32 starts on the cluster ·
 * 1 held · 3 ended since yesterday (1 failed)". The running clause counts
 * the running runs' starts, "on this computer" where it isn't SLURM's; the
 * ended clause, from Runs' list, drops when nothing ended since yesterday,
 * and "Nothing in flight" stands for the first when none is.
 */
export function summaryOf(a: {
  counts: RunCounts;
  /** The runs listed, in flight then ended, the latest end first. */
  runs: RunSummary[];
  platform: Platform;
  slurm: boolean;
  now: number;
}): string {
  const c = a.counts;
  const parts: string[] = [];
  if (c.running > 0) {
    const starts = a.runs
      .filter((r) => r.ended_at === null && r.state === "running" && r.canceling === null)
      .reduce((n, r) => n + r.progress.starts_running, 0);
    const where = a.slurm ? "the cluster" : inSentence(a.platform);
    parts.push(`${whole(c.running)} running with ${plural(starts, "start", "starts")} on ${where}`);
  }
  if (c.canceling > 0) parts.push(`${whole(c.canceling)} canceling`);
  if (c.queued > 0) parts.push(`${whole(c.queued)} queued`);
  if (c.held > 0) parts.push(`${whole(c.held)} held`);
  if (parts.length === 0) parts.push("Nothing in flight");
  const cutoff = yesterdayOf(a.now);
  const ended = a.runs.filter((r) => endedSince(r, cutoff));
  if (ended.length > 0) {
    const failed = ended.filter((r) => r.state === "failed").length;
    const canceled = ended.filter((r) => r.state === "canceled").length;
    const paren = [
      failed > 0 ? `${whole(failed)} failed` : "",
      canceled > 0 ? `${whole(canceled)} canceled` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    parts.push(`${whole(ended.length)} ended since yesterday${paren === "" ? "" : ` (${paren})`}`);
  }
  return parts.join(" · ");
}

/** "16 of 16 starts running"; without the cap, "16 starts running". */
export function runningLine(p: RunSummary["progress"], cap: number | undefined): string {
  return cap === undefined
    ? `${plural(p.starts_running, "start", "starts")} running`
    : `${whole(p.starts_running)} of ${whole(cap)} starts running`;
}

/**
 * A running card's ETA, as Runs has it: "ETA Fri, Aug 21, 6:40 AM · 8 d 21 h
 * left"; while stale, the one read when the connection went (`asOf`), with
 * no "left", which would count from now: "ETA Fri, Aug 21, 6:40 AM · as of
 * 10:41 AM" (#399, HF11). Submit's estimate is marked, "ETA about Fri, Aug
 * 21, Submit's estimate", until its first starts report their pace (#542); with
 * neither, before a topology ends, "ETA once its first starts report their
 * pace"; `undefined` while it's read.
 */
export function etaLine(
  eta: Eta | undefined,
  p: RunSummary["progress"],
  now: number,
  asOf?: number,
): string | undefined {
  if (eta !== undefined) {
    const asOfWords = asOf === undefined ? "" : ` · as of ${clock(asOf, now)}`;
    // Before its first starts report their pace, Submit's estimate, to the day (#542).
    if (eta.estimate) return `ETA about ${etaDay(eta.at, now)}, Submit’s estimate${asOfWords}`;
    return asOf === undefined
      ? `ETA ${clock(eta.at, now)} · ${durationWords(Math.max(0, (eta.at - now) / 1000))} left`
      : `ETA ${clock(eta.at, now)}${asOfWords}`;
  }
  return p.topologies_complete + p.topologies_failed === 0
    ? "ETA once its first starts report their pace"
    : undefined;
}

/** The sparkline's box, as LaptopMain draws it: 168 by 34. */
export const SPARK_W = 168;
export const SPARK_H = 34;

export interface Spark {
  /** The best's steps, from its first to now. */
  d: string;
  /** Where the line ends, at the right edge. */
  endY: number;
  /** The best it began at. */
  first: number;
  /** How many best-so-far values it steps through: under 2, it's flat (#399, HF06). */
  values: number;
}

/**
 * A running run's best so far as a sparkline (LaptopMain): a step at each
 * stretch its best moved, from its first array (`began`) to `stop` (now, or
 * when the connection went), its best on Val RMSE, or Train without
 * validation points. `undefined` before a best, or for a run submitted before
 * ICMM kept its stretches.
 */
export function sparkOf(
  s: RunStretches,
  a: { began: number; stop: number; validation: boolean },
): Spark | undefined {
  const length = s.stretch_s;
  if (length === null || Number.isNaN(a.began)) return undefined;
  const steps: { t: number; v: number }[] = [];
  for (const x of s.stretches) {
    const v = a.validation ? x.best_val_rmse : x.best_train_rmse;
    if (v === null || (steps.length > 0 && steps[steps.length - 1].v === v)) continue;
    steps.push({
      t: Math.min(a.began + (x.stretch + 1) * length * 1000, a.stop),
      v,
    });
  }
  if (steps.length === 0) return undefined;
  const values = steps.map((q) => q.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(a.stop - a.began, 60_000);
  const right = SPARK_W - 2;
  const X = (t: number) =>
    (2 + ((Math.min(Math.max(t, a.began), a.stop) - a.began) / span) * (right - 2)).toFixed(1);
  const Y = (v: number) => (max === min ? 16 : 4 + ((max - v) / (max - min)) * 24).toFixed(1);
  let d = `M${X(steps[0].t)} ${Y(steps[0].v)}`;
  for (const q of steps.slice(1)) d += ` H${X(q.t)} V${Y(q.v)}`;
  const last = steps[steps.length - 1].v;
  return {
    d: `${d} H${right}`,
    endY: Number(Y(last)),
    first: steps[0].v,
    values: steps.length,
  };
}
