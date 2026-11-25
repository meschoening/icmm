/**
 * Optimization progress (LaptopTopology, #233; built in #286), laid out: each
 * start's Progress curve, its best Train RMSE so far against CMA-ES
 * evaluations, as the coordinator keeps it (at most 64 points). Evaluations
 * run across, from 0 to what each start runs; Train RMSE runs down a log
 * scale whose gridlines bracket every line drawn, on 1s and 3s as the board
 * draws them. The finished starts' lines share one faint path, the running
 * ones' are cobalt with a dot where each is so far, the canceled ones' are
 * dashed, and the Best start's is drawn over them all; a failed start's never
 * counts, so it isn't drawn. The band view draws the finished starts' median
 * and their middle 80 % instead. In a 1216 × 236 view box that stretches to
 * its column, with its labels laid over it in HTML, placed in % of its width.
 */
import { whole } from "../../configs/words";
import type { FailedStarts, StartCurve } from "../../wire/types.gen";
import { rmse } from "../words";
import type { Stage } from "./words";

export const PROGRESS_WIDTH = 1216;
export const PROGRESS_HEIGHT = 236;
const X0 = 52;
const X1 = 1066;
const Y0 = 24;
const Y1 = 204;
/** Where the band's median and quantiles are read, across the evaluations. */
const SAMPLES = 120;

export interface ProgressLabel {
  t: string;
  /** Where it's placed, in % of the chart's width. */
  left: string;
  top: number;
  /** Its anchor: from `left`, centered on it, or ending at it. */
  align?: "mid" | "end";
  kind: "name" | "y" | "x" | "best" | "median";
}

export interface Progress {
  /** The horizontal gridlines, one a tick. */
  grid: string;
  /** Every finished start's line but the Best start's. */
  done: string;
  /** Canceled starts' lines, to where each stopped. */
  stopped: string;
  /** Running starts' lines, so far, and the dot each ends with. */
  live: string;
  liveEnds: string;
  /** The finished starts' middle 80 % and median, in the band view. */
  band: string;
  median: string;
  best: string;
  bestEnd: { x: number; y: number } | null;
  labels: ProgressLabel[];
  counts: { finished: number; running: number; canceled: number };
  aria: string;
}

/** Each starts' points, as drawn: x across the evaluations, y down the log scale. */
export type Drawn = { x: number; y: number }[];

const pct = (x: number) => `${((x / PROGRESS_WIDTH) * 100).toFixed(3)}%`;
const at = (n: number) => n.toFixed(1);

/** `m × 10ᵈ` for each `m` of `steps`, from the one at or under `lo` to the one at or over `hi`. */
function bracket(lo: number, hi: number, steps: number[]): number[] {
  const all: number[] = [];
  for (let d = Math.floor(Math.log10(lo)) - 1; d <= Math.ceil(Math.log10(hi)) + 1; d++) {
    for (const m of steps) all.push(Number((m * 10 ** d).toPrecision(6)));
  }
  const first = all.filter((v) => v <= lo).length - 1;
  const last = all.findIndex((v) => v >= hi);
  return all.slice(first, last + 1);
}

/** The RMSE axis's ticks, lowest first: 1s and 3s, or 1s, 2s and 5s over a narrow span, or whole decades over a wide one. */
function ticksFor(lo: number, hi: number): number[] {
  for (const steps of [
    [1, 3],
    [1, 2, 5],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ]) {
    const ticks = bracket(lo, hi, steps);
    if (ticks.length > 7) return bracket(lo, hi, [1]);
    if (ticks.length >= 3) return ticks;
  }
  return bracket(lo, hi, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
}

/** A tick's words: "1", "0.3", "0.05". */
function tickWords(v: number): string {
  return v >= 1 ? String(v) : v.toFixed(-Math.floor(Math.log10(v) + 1e-9));
}

/** An evaluation count, short: "250k", "1.5 M". */
function short(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toPrecision(3))} M`;
  if (n >= 1_000) return `${Number((n / 1_000).toPrecision(3))}k`;
  return String(n);
}

/** What each start runs, as the axis ends it: "1" " M", or its whole number. */
export function budgetParts(perStart: number): { n: string; unit: string } {
  return perStart >= 1_000_000 && perStart % 100_000 === 0
    ? { n: String(perStart / 1_000_000), unit: " M" }
    : { n: whole(perStart), unit: "" };
}

/** The evaluations axis's ticks: a round step near a quarter of what each start runs. */
function evaluationTicks(perStart: number): number[] {
  const quarter = perStart / 4;
  const decade = 10 ** Math.floor(Math.log10(quarter));
  const step = [5, 2.5, 2, 1].map((m) => m * decade).find((s) => s <= quarter) ?? decade;
  const ticks: number[] = [];
  for (let v = 0; v <= perStart * (1 + 1e-9); v += step) ticks.push(v);
  return ticks;
}

/** The value at `x` along a line, read straight between its points, or `undefined` before it begins. */
export function along(line: Drawn, x: number): number | undefined {
  if (line.length === 0 || x < line[0].x) return undefined;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return line[line.length - 1].y;
}

/** The `f` quantile of sorted `xs`, read between its neighbors. */
export function quantile(xs: number[], f: number): number {
  const at = f * (xs.length - 1);
  const lo = Math.floor(at);
  return xs[lo] + (xs[Math.min(lo + 1, xs.length - 1)] - xs[lo]) * (at - lo);
}

/**
 * The chart for `curves`, of the topology `name` whose Best start is `best`
 * (by Train RMSE), each start running `perStart` evaluations; its band view
 * with `band`.
 */
export function progressOf(
  curves: StartCurve[],
  a: {
    best: { start: number; train: number } | null;
    perStart: number;
    band: boolean;
    name: string;
  },
): Progress {
  const shown = curves.filter(
    (c) => c.evaluations.length > 0 && ["finished", "running", "canceled"].includes(c.state),
  );
  // A loop, not a spread: thousands of starts' points outnumber what a call may take.
  let [lo, hi] = [Infinity, -Infinity];
  for (const c of shown) {
    for (const v of c.train_rmse) {
      if (v > 0) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    }
  }
  if (lo === Infinity) [lo, hi] = [0.01, 1];
  if (hi <= lo) [lo, hi] = [lo / 1.5, hi * 1.5];
  const ticks = ticksFor(lo, hi);
  const [bottom, top] = [Math.log(ticks[0]), Math.log(ticks[ticks.length - 1])];
  const X = (e: number) => X0 + (Math.min(e, a.perStart) / a.perStart) * (X1 - X0);
  // An exact fit, at 0, sits at the foot.
  const Y = (r: number) =>
    Y0 + ((top - Math.log(Math.max(r, ticks[0]))) / (top - bottom)) * (Y1 - Y0);
  const rmseAt = (y: number) => Math.exp(top - ((y - Y0) / (Y1 - Y0)) * (top - bottom));
  const drawnOf = (c: StartCurve): Drawn =>
    c.evaluations.map((e, i) => ({ x: X(e), y: Y(c.train_rmse[i]) }));
  const path = (line: Drawn) =>
    line.map((p, i) => `${i === 0 ? "M" : "L"}${at(p.x)} ${at(p.y)}`).join("");

  const isBest = (c: StartCurve) => a.best !== null && c.start === a.best.start;
  const finished = shown.filter((c) => c.state === "finished");
  const running = shown.filter((c) => c.state === "running");
  const canceled = shown.filter((c) => c.state === "canceled");
  const bestCurve = finished.find(isBest);
  const bestLine = bestCurve === undefined ? [] : drawnOf(bestCurve);
  const bestEnd = bestLine.length > 0 ? bestLine[bestLine.length - 1] : null;

  let liveEnds = "";
  const live = running
    .map((c) => {
      const line = drawnOf(c);
      const end = line[line.length - 1];
      liveEnds += `M${at(end.x - 2)} ${at(end.y)}a2 2 0 1 0 4 0a2 2 0 1 0 -4 0`;
      return path(line);
    })
    .join("");

  const labels: ProgressLabel[] = [{ t: "Train RMSE (log)", left: "0%", top: 0, kind: "name" }];
  for (const v of [...ticks].reverse()) {
    labels.push({ t: tickWords(v), left: pct(44), top: Y(v) - 6.5, align: "end", kind: "y" });
  }
  const xs = evaluationTicks(a.perStart);
  const ends = Math.abs(xs[xs.length - 1] - a.perStart) <= a.perStart * 1e-9;
  const exact = short(a.perStart) === `${budgetParts(a.perStart).n}${budgetParts(a.perStart).unit}`;
  for (const v of xs) {
    const last = ends && v === xs[xs.length - 1];
    if (last || (!ends && X(v) > X1 - 90)) continue;
    labels.push({
      t: short(v),
      left: pct(X(v)),
      top: 216,
      align: v === 0 ? undefined : "mid",
      kind: "x",
    });
  }
  labels.push({
    t: `${exact ? short(a.perStart) : whole(a.perStart)} evaluations`,
    left: pct(X1),
    top: 216,
    align: "end",
    kind: "x",
  });
  if (bestEnd !== null && a.best !== null) {
    labels.push({
      t: `start ${a.best.start} · ${rmse(a.best.train)}`,
      left: pct(X1 + 8),
      top: bestEnd.y - 7,
      kind: "best",
    });
  }

  let band = "";
  let median = "";
  if (a.band && finished.length > 0) {
    const lines = finished.map(drawnOf);
    const from = Math.min(...lines.map((l) => l[0].x));
    const up: string[] = [];
    const down: string[] = [];
    const mid: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const x = from + ((X1 - from) * i) / SAMPLES;
      // Each line is read where it's drawn, and its quantiles in RMSE, not on the log scale.
      const rs = lines
        .map((l) => along(l, x))
        .filter((y): y is number => y !== undefined)
        .map(rmseAt)
        .sort((p, q) => p - q);
      if (rs.length === 0) continue;
      up.push(`${at(x)} ${at(Y(quantile(rs, 0.9)))}`);
      mid.push(`${at(x)} ${at(Y(quantile(rs, 0.5)))}`);
      down.push(`${at(x)} ${at(Y(quantile(rs, 0.1)))}`);
    }
    band = `M${up.join("L")}L${down.reverse().join("L")}Z`;
    median = `M${mid.join("L")}`;
    const endY = Number(mid[mid.length - 1].split(" ")[1]);
    const bestTop = bestEnd === null ? undefined : bestEnd.y - 7;
    let top = endY - 15;
    if (bestTop !== undefined && Math.abs(top - bestTop) < 16) top = bestTop - 16;
    labels.push({
      t: `median of ${finished.length} finished`,
      left: pct(X1 + 8),
      top,
      kind: "median",
    });
  }

  const kinds = [
    `${finished.length} finished`,
    ...(running.length > 0 ? [`${running.length} running`] : []),
    ...(canceled.length > 0 ? [`${canceled.length} canceled`] : []),
  ];
  return {
    grid: ticks.map((v) => `M${X0} ${at(Y(v) + 0.5)}H${X1}`).join(""),
    done: a.band
      ? ""
      : finished
          .filter((c) => !isBest(c))
          .map((c) => path(drawnOf(c)))
          .join(""),
    stopped: a.band ? "" : canceled.map((c) => path(drawnOf(c))).join(""),
    live: a.band ? "" : live,
    liveEnds: a.band ? "" : liveEnds,
    band,
    median,
    best: path(bestLine),
    bestEnd,
    labels,
    counts: { finished: finished.length, running: running.length, canceled: canceled.length },
    aria:
      `Train RMSE so far against evaluations for ${a.name}’s starts: ${kinds.join(", ")}.` +
      (bestCurve !== undefined && a.best !== null
        ? ` The best start, ${a.best.start}, ends at ${rmse(a.best.train)}.`
        : ""),
  };
}

/**
 * What Optimization progress says in place of its chart, by the topology's
 * stage; `undefined` once a start has a line to draw. `ended` counts the
 * starts that finished or were canceled, which their coordinator keeps a
 * curve for unless an older engine fit them; `queued` those waiting at the
 * scheduler.
 */
export function progressWords(
  stage: Stage,
  a: {
    starts: number;
    queued: number;
    ended: number;
    curves: StartCurve[];
    causes: FailedStarts[];
  },
): { lead: string; meta: string } | undefined {
  const drawn = a.curves.some(
    (c) => c.evaluations.length > 0 && ["finished", "running", "canceled"].includes(c.state),
  );
  if (drawn && stage !== "failed") return undefined;
  const n = whole(a.starts);
  switch (stage) {
    case "failed": {
      const logged = a.curves.some((c) => c.evaluations.length > 0);
      return !logged && a.causes.length === 1 && a.causes[0].cause === "error"
        ? {
            lead: `No start logged a point: all ${n} stopped with an error before their first generation.`,
            meta: "",
          }
        : {
            lead: "No start finished, so there’s nothing to show here.",
            meta: `All ${n} failed. Each one’s cause and log are below.`,
          };
    }
    case "queued":
    case "held":
      if (a.queued === a.starts) {
        return { lead: `Nothing has run yet: all ${n} starts are queued.`, meta: "" };
      }
      return {
        lead: "Nothing has run yet.",
        meta: "Each start’s best so far draws here once it starts.",
      };
    case "next":
    case "waiting":
      return {
        lead: "Nothing has run yet.",
        meta: "Each start’s best so far draws here once it starts.",
      };
    case "not fitted":
      return { lead: "Nothing has run yet.", meta: "Resume fits it with the rest of the run." };
    default:
      if (a.ended > 0) {
        return {
          lead: "These starts’ progress wasn’t kept.",
          meta: "The engine that fit them didn’t keep it.",
        };
      }
      if (stage === "unfinished") {
        return { lead: "Nothing has run yet.", meta: "Resume fits it with the rest of the run." };
      }
      return {
        lead: "No start has logged its first point yet.",
        meta: "Each start’s best so far draws here once it does.",
      };
  }
}
