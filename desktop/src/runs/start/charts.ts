/**
 * The Start page's drawings, laid out (LaptopStart, #196; built in #239):
 * Optimization progress beside its topology's finished starts, each
 * protocol's fit, a part's strip against the Top 10, and the Voltage
 * dependence curve. A finished start's fit inspector (#346) draws a
 * protocol's fit overlay large, and every sweep's open probability with its
 * voltage command on one time axis; Compare draws them too (#342). Each is
 * drawn in a fixed view box; the wide ones stretch to their column with
 * their labels laid over them in HTML, placed in % of the width so their
 * text never stretches.
 */
import { whole } from "../../configs/words";
import { decades, wideTicks } from "../../datasets/axes";
import { fixed, minus, short } from "../../datasets/format";
import type {
  ParameterRange,
  Point,
  Protocol,
  SimulatedPoint,
  StartCurve,
  StartLogPoint,
} from "../../wire/types.gen";
import { along as lineAt, quantile, type Drawn } from "../topology/progress";
import { evaluationsWords } from "../topology/words";
import { rmse } from "../words";

const f1 = (x: number) => x.toFixed(1);
const pc = (x: number, width: number) => `${((x / width) * 100).toFixed(3)}%`;

/** A label laid over a drawing. */
export interface Label {
  t: string;
  /** In % of the drawing's width. */
  left: string;
  top: number;
  /** Its anchor: centered on `left`, ending at it, or above and right of it. */
  align?: "mid" | "end" | "y" | "rise" | "back";
  /** An axis's unit, over it, or its title, under it; a sweep named on its voltage; a finished Best start's end. */
  kind?: "me" | "unit" | "now" | "best" | "title" | "sweep" | "mine";
}

// ── Optimization progress ─────────────────────────────────────────────────────────────────────

export const PROGRESS = { width: 1216, height: 320, left: 52, right: 150, top: 24, bottom: 24 };

export interface Progress {
  grid: string;
  vgrid: string;
  base: string;
  me: string;
  now: string;
  /**
   * The finished starts' middle 80 % and median, from `SPREAD_FROM` of them;
   * under that, each one's own thin line but the best's and this start's
   * (#539 U3); and the best start's line. Each is empty undrawn.
   */
  band: string;
  median: string;
  others: string;
  best: string;
  /** The finished starts drawn beside this start's line, band or lines: 0 when none is. */
  finished: number;
  /** How many of them `others` draws: "the other 2 finished". */
  otherCount: number;
  /** The latest point, in the view box. */
  dot: { x: number; y: number };
  labels: Label[];
  aria: string;
}

/** The topology's finished starts, beside a start's own line (#286's Progress curves). */
export interface Beside {
  /** Their Progress curves; this start's own is left out. */
  curves: StartCurve[];
  /** The best finished start by Train RMSE, `null` before one finishes. */
  best: { start: number; train: number } | null;
}

/** Where the finished starts' median and middle 80 % are read, across the evaluations. */
const SAMPLES = 120;

/**
 * From how many finished starts their median and middle 80 % are drawn:
 * under it, the middle 80 % is most of their range, and one stuck start
 * fills the chart, so each is a line of its own (#539 U3).
 */
export const SPREAD_FROM = 10;

/** "64 finished starts", "1 finished start". */
export const finishedWords = (n: number) => `${whole(n)} finished start${n === 1 ? "" : "s"}`;

/** 1, 3, 10, 30…: the log axis's ticks across lo…hi. */
function oneThrees(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(Math.log10(lo)) - 1; d <= Math.ceil(Math.log10(hi)); d++) {
    for (const m of [1, 3]) {
      const v = Number((m * 10 ** d).toPrecision(6));
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

/** A log axis's ends: the 1-3 ticks at or past `lo` and `hi`. */
function logEnds(lo: number, hi: number): [number, number] {
  const down = (v: number) => {
    const d = 10 ** Math.floor(Math.log10(v));
    return v >= 3 * d ? 3 * d : d;
  };
  const up = (v: number) => {
    const d = 10 ** Math.floor(Math.log10(v));
    return v <= d * (1 + 1e-9) ? d : v <= 3 * d ? 3 * d : 10 * d;
  };
  const a = down(lo);
  const b = up(hi);
  return b > a ? [a, b] : [a, a * 3];
}

/**
 * The start's best Train RMSE so far against evaluations, over its whole
 * budget, on a log scale, with where it is now. `end` names that line:
 * "now", "time limit", "canceled" or "as of 10:44 AM". `beside` adds its
 * topology's finished starts: their median and middle 80 %, read in RMSE
 * from `SPREAD_FROM` of them on, else each one's own thin line, and the
 * best start's line. A `finished` start is one of them, its line drawn to
 * its end and named there, with no now.
 */
export function progressOf(
  points: StartLogPoint[],
  budget: number,
  a: { start: number; end: string; beside?: Beside; finished?: { best: boolean } },
): Progress | undefined {
  const scored = points.filter((p) => p.train_rmse !== null && p.train_rmse > 0);
  const latest = scored[scored.length - 1];
  if (latest === undefined || !(budget > 0)) return undefined;
  const { width: W, height: H, left, right, top, bottom } = PROGRESS;
  const X0 = left;
  const X1 = W - right;
  const Y0 = H - bottom;
  const Y1 = top;
  // Each finished start's line, evaluations against ln RMSE: read straight on the log scale.
  const done = a.finished;
  const lines = (a.beside?.curves ?? []).flatMap((c): { start: number; line: Drawn }[] => {
    if (c.state !== "finished" || (c.start === a.start && done === undefined)) return [];
    const line = c.evaluations.flatMap((e, i) =>
      c.train_rmse[i] > 0 ? [{ x: e, y: Math.log(c.train_rmse[i]) }] : [],
    );
    return line.length > 0 ? [{ start: c.start, line }] : [];
  });
  const best = a.beside?.best ?? null;
  // The Best start's own line is its "me": no second line under it.
  const bestLine =
    done?.best === true
      ? []
      : (lines.find((l) => best !== null && l.start === best.start)?.line ?? []);
  const spread = lines.length >= SPREAD_FROM;
  // Under SPREAD_FROM, every finished start but this one and the best is its own line: the
  // best's only where its line is drawn, so a start the scan names best is never drawn nowhere.
  const others = spread
    ? []
    : lines.filter(
        (l) => l.start !== a.start && (bestLine.length === 0 || l.start !== best?.start),
      );
  /** The finished starts' 10th, 50th and 90th percentiles at `e`; `undefined` before any begins. */
  const spreadAt = (e: number) => {
    const rs = lines
      .map((l) => lineAt(l.line, e))
      .filter((y): y is number => y !== undefined)
      .map(Math.exp)
      .sort((p, q) => p - q);
    return rs.length === 0 ? undefined : [0.1, 0.5, 0.9].map((f) => quantile(rs, f));
  };
  const samples: { e: number; q: number[] }[] = [];
  if (spread) {
    const from = Math.min(...lines.map((l) => l.line[0].x));
    for (let i = 0; i <= SAMPLES; i++) {
      const e = from + ((budget - from) * i) / SAMPLES;
      const q = spreadAt(e);
      if (q !== undefined) samples.push({ e, q });
    }
  }
  const trains = scored.map((p) => p.train_rmse!);
  // The axis brackets every line drawn: its own, the best start's, and the band's edges.
  let [low, high] = [Math.min(...trains), Math.max(...trains)];
  for (const v of [
    ...bestLine.map((p) => Math.exp(p.y)),
    ...others.flatMap((l) => l.line.map((p) => Math.exp(p.y))),
    ...samples.flatMap((s) => [s.q[0], s.q[2]]),
  ]) {
    [low, high] = [Math.min(low, v), Math.max(high, v)];
  }
  const [lo, hi] = logEnds(low, high);
  const tx = (e: number) => X0 + (Math.min(e, budget) / budget) * (X1 - X0);
  const ty = (v: number) => Y0 - (Math.log10(v / lo) / Math.log10(hi / lo)) * (Y0 - Y1);
  const xt = progressTicks(budget);
  const yt = oneThrees(lo, hi);
  const labels: Label[] = [
    ...xt.map((e, i): Label => ({
      t:
        i === xt.length - 1
          ? `${evaluationsWords(e)} evaluations`
          : e === 0
            ? "0"
            : evaluationsWords(e),
      left: pc(tx(e), W),
      top: Y0 + 6,
      align: i === xt.length - 1 ? "end" : "mid",
    })),
    ...yt.map((v): Label => ({ t: String(v), left: pc(X0 - 6, W), top: ty(v), align: "y" })),
    { t: "Train RMSE so far (log)", left: "0%", top: 0, kind: "unit" },
  ];
  const nx = tx(latest.evaluations);
  const ny = ty(latest.train_rmse!);
  const mine = `start ${a.start} · ${rmse(latest.train_rmse!)}`;
  if (done?.best === true) {
    labels.push({ t: mine, left: pc(X1 + 8, W), top: ny, kind: "mine" });
  } else if (done !== undefined) {
    labels.push({ t: mine, left: pc(nx - 10, W), top: ny - 10, align: "back", kind: "me" });
  } else {
    labels.push(
      {
        t: `train ${rmse(latest.train_rmse!)}`,
        left: pc(nx + 8, W),
        top: ny - 9,
        align: "rise",
        kind: "me",
      },
      {
        t: `${a.end} · ${evaluationsWords(latest.evaluations)}`,
        left: pc(nx + 6, W),
        top: Y1 - 12,
        kind: "now",
      },
    );
  }
  const bestEnd = bestLine[bestLine.length - 1];
  if (bestEnd !== undefined && best !== null) {
    labels.push({
      t: `start ${best.start} · ${rmse(best.train)}`,
      left: pc(X1 + 8, W),
      top: ty(Math.exp(bestEnd.y)),
      kind: "best",
    });
  }
  const at = (e: number, r: number) => `${f1(tx(e))} ${f1(ty(r))}`;
  const q = spread ? spreadAt(latest.evaluations) : undefined;
  const side =
    q === undefined
      ? undefined
      : latest.train_rmse! < q[0]
        ? "below"
        : latest.train_rmse! > q[2]
          ? "above"
          : "inside";
  const drawnBeside = samples.length > 0 || others.length > 0 || bestLine.length > 0;
  const where =
    side !== undefined
      ? `, ${side} the middle 80 % of the ${finishedWords(lines.length)} at that point`
      : !spread && drawnBeside
        ? `, beside the ${finishedWords(lines.length)}`
        : "";
  const ends = others.map((l) => Math.exp(l.line[l.line.length - 1].y)).sort((p, q) => p - q);
  const bestSaid = bestEnd !== undefined && best !== null;
  // "the other 2 ended between 0.0466 and 0.5200", after the best start; one number when they round alike.
  const [first, last] = [rmse(ends[0] ?? 0), rmse(ends[ends.length - 1] ?? 0)];
  const who = bestSaid
    ? `the other${ends.length === 1 ? "" : ` ${whole(ends.length)}`}`
    : ends.length === 1
      ? "it"
      : "they";
  const theOthers =
    ends.length === 0
      ? ""
      : `${bestSaid ? ", and " : "; "}${who} ended ` +
        (first === last ? `at ${first}` : `between ${first} and ${last}`);
  return {
    grid: yt.map((v) => `M${X0} ${f1(ty(v))}H${X1}`).join(""),
    vgrid: xt.map((e) => `M${f1(tx(e))} ${Y1}V${Y0}`).join(""),
    base: `M${X0} ${f1(Y0)}H${X1}`,
    me: scored
      .map((p, i) => `${i ? "L" : "M"}${f1(tx(p.evaluations))} ${f1(ty(p.train_rmse!))}`)
      .join(""),
    now: done === undefined ? `M${f1(nx)} ${Y1}V${Y0}` : "",
    band:
      samples.length === 0
        ? ""
        : `M${samples.map((s) => at(s.e, s.q[2])).join("L")}` +
          `L${[...samples]
            .reverse()
            .map((s) => at(s.e, s.q[0]))
            .join("L")}Z`,
    median: samples.map((s, i) => `${i ? "L" : "M"}${at(s.e, s.q[1])}`).join(""),
    others: others
      .map((l) => l.line.map((p, i) => `${i ? "L" : "M"}${at(p.x, Math.exp(p.y))}`).join(""))
      .join(""),
    best: bestLine.map((p, i) => `${i ? "L" : "M"}${at(p.x, Math.exp(p.y))}`).join(""),
    finished: drawnBeside ? lines.length : 0,
    otherCount: others.length,
    dot: { x: nx, y: ny },
    labels,
    aria:
      done !== undefined
        ? `Best train RMSE so far against evaluations, on a log scale. Start ${a.start} ended at ` +
          `${rmse(latest.train_rmse!)} after its ${evaluationsWords(latest.evaluations)} evaluations` +
          (done.best
            ? `, the best of the ${finishedWords(lines.length)}.`
            : bestEnd !== undefined && best !== null
              ? `; the best start, start ${best.start}, ended at ${rmse(best.train)}.`
              : ".")
        : `Best train RMSE so far against evaluations, on a log scale. Start ${a.start} is at ` +
          `${rmse(latest.train_rmse!)} after ${evaluationsWords(latest.evaluations)} of ` +
          `${evaluationsWords(budget)} evaluations${where}` +
          (bestSaid
            ? `; the best start, start ${best.start}, finished at ${rmse(best.train)}`
            : "") +
          `${theOthers}.`,
  };
}

// ── a protocol's fit ──────────────────────────────────────────────────────────────────────────

export const FIT = { width: 227, height: 156, left: 37, right: 6, top: 8, bottom: 20 };
const R = 2.3;
/** The fit inspector's overlay of one start's fit, its axes titled (#346), and its points' radius. */
export const INSPECTOR = { width: 452, height: 320, left: 44, right: 10, top: 24, bottom: 40 };
export const INSPECTOR_R = 3;

export interface Fit {
  grid: string;
  base: string;
  whiskers: string;
  dots: string;
  rings: string;
  diamonds: string;
  hollow: string;
  model: string;
  labels: Label[];
}

/** A circle as a path, centered on (x, y). */
const circle = (x: number, y: number, r: number) =>
  `M${f1(x - r)} ${f1(y)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

/** A drawing's box, in its view box's units: its size and the margins its axes keep. */
export interface Box {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The round steps a fit chart's value axis takes, as `wideTicks` takes them. */
const STEPS = [1, 2, 2.5, 3, 4, 5];

/**
 * A fit chart's value axis across `values` (#362): up to five round ticks.
 * Values within 0…1, give or take a tenth, read 0 · 0.25 · 0.5 · 0.75 · 1,
 * the axis reaching past 1 to hold a line that tops it between the points.
 * Any others take the smallest round step that reaches past them in five
 * ticks from 0, or below it, and the top tick is the axis's top.
 */
function valueAxis(values: readonly number[]): { lo: number; hi: number; ticks: number[] } {
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  if (hi <= 1.1 && lo >= -0.1) {
    return { lo: lo < -0.02 ? -0.1 : 0, hi: Math.max(1, hi), ticks: [0, 0.25, 0.5, 0.75, 1] };
  }
  const round = (v: number) => Number(v.toPrecision(12));
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / 5));
  for (const step of [...STEPS, ...STEPS.map((m) => 10 * m), 100].map((m) => m * mag)) {
    const from = lo < 0 ? -step * Math.ceil(-lo / step - 1e-9) : 0;
    const to = step * Math.ceil(hi / step - 1e-9);
    const n = Math.round((to - from) / step);
    if (n + 1 <= 5) {
      return {
        lo: round(from),
        hi: round(to),
        ticks: Array.from({ length: n + 1 }, (_, k) => round(from + k * step)),
      };
    }
  }
  return { lo, hi, ticks: [lo, hi] };
}

/**
 * A chart's axes across `xs` and `ys` in `box`: where values go, its ticks, grid and base.
 * `ends` labels only the value axis's ends, its grid at its middle and top (Home's, #391).
 */
function frameOf(
  box: Box,
  xs: readonly number[],
  ys: readonly number[],
  logx: boolean,
  ends = false,
) {
  const { width: W, height: H, left, right, top, bottom } = box;
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const log = logx && xLo > 0;
  const axis = valueAxis(ys.length > 0 ? ys : [0, 1]);
  const [yLo, yHi] = [axis.lo, axis.hi];
  const pad = (xHi - xLo) * 0.05 || 1;
  const [x0, x1] = log ? [xLo / 1.4, xHi * 1.4] : [xLo - pad, xHi + pad];
  const lg = (v: number) => (log ? Math.log10(v) : v);
  const X0 = left;
  const X1 = W - right;
  const Y0 = H - bottom;
  const Y1 = top;
  const tx = (v: number) => X0 + ((lg(v) - lg(x0)) / (lg(x1) - lg(x0))) * (X1 - X0);
  const ty = (v: number) => Y0 - ((v - yLo) / (yHi - yLo || 1)) * (Y0 - Y1);
  const xt = log ? decades(xLo, xHi) : wideTicks(xLo, xHi, 4);
  const all = axis.ticks;
  const yt = ends ? [all[0], all[all.length - 1]] : all;
  const lines =
    ends && all.length % 2 === 1 ? [all[(all.length - 1) / 2], all[all.length - 1]] : yt;
  const grid = lines.map((v) => `M${X0} ${f1(ty(v))}H${X1}`).join("");
  const labels: Label[] = [
    ...xt.map((v): Label => ({
      t: minus(short(v)),
      left: pc(tx(v), W),
      top: Y0 + 6,
      align: "mid",
    })),
    ...yt.map((v): Label => ({ t: minus(short(v)), left: pc(X0 - 5, W), top: ty(v), align: "y" })),
  ];
  return {
    tx,
    ty,
    yLo,
    yHi,
    labels,
    grid,
    base: `M${X0} ${f1(Y0)}H${X1}`,
  };
}

/**
 * Points as a fit chart draws them: train filled, validation hollow,
 * interpolated as diamonds, each of radius `r`. Without validation points
 * (`validation` false) every point is a train point (#340).
 */
function pointsOf(
  points: readonly Point[],
  tx: (v: number) => number,
  ty: (v: number) => number,
  { r = R, validation = true }: { r?: number; validation?: boolean } = {},
): Pick<Fit, "whiskers" | "dots" | "rings" | "diamonds" | "hollow"> {
  let whiskers = "";
  let dots = "";
  let rings = "";
  let diamonds = "";
  let hollow = "";
  const q = r * 1.3;
  for (const p of points) {
    const x = tx(p.x);
    const y = ty(p.value);
    const held = p.validation && validation;
    if (p.interpolated) {
      const d = `M${f1(x)} ${f1(y - q)}l${q} ${q}l${-q} ${q}l${-q} ${-q}Z`;
      if (held) hollow += d;
      else diamonds += d;
      continue;
    }
    if (p.sd !== null && p.sd > 0)
      whiskers += `M${f1(x)} ${f1(ty(p.value - p.sd))}V${f1(ty(p.value + p.sd))}`;
    if (held) rings += circle(x, y, r);
    else dots += circle(x, y, r);
  }
  return { whiskers, dots, rings, diamonds, hollow };
}

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

/**
 * The open probability axis' ticks in one format. Tiny ones, under 0.001,
 * share the top tick's power of ten, "1.2 × 10⁻⁶ · 0.9 × 10⁻⁶ … 0", where
 * each read shortest ("0.0000012" beside "9e-7", a hyphen for its minus).
 */
export function openTicks(ticks: readonly number[]): string[] {
  const top = Math.max(...ticks.map(Math.abs));
  if (!(top > 0) || top >= 1e-3) return ticks.map((v) => minus(short(v)));
  const e = Math.floor(Math.log10(top));
  const power = `10${[...String(e)].map((c) => SUPERSCRIPT[c]).join("")}`;
  return ticks.map((v) =>
    v === 0 ? "0" : `${minus(String(Number((v / 10 ** e).toPrecision(6))))} × ${power}`,
  );
}

/** Whether an evaluation count reads exactly as `evaluationsWords` writes it: "25k", not 12.5k's "13k". */
const readsExactly = (n: number) =>
  n < 1000 || (n < 1_000_000 ? n % 1000 === 0 : n % 100_000 === 0);

/**
 * Optimization progress's x ticks: 0, round steps of evaluations, and the
 * budget, where quarters of it read rounded ("13k · 25k · 38k" of 50k). The
 * step is the largest of 1, 2, 2.5 and 5 × 10ⁿ giving at least four, each
 * reading exactly; ticks stop at 80 % of the budget so none crowds the
 * budget's own label. A budget no step fits keeps its quarters.
 */
export function progressTicks(budget: number): number[] {
  const steps = [5, 2.5, 2, 1].flatMap((m) => {
    const k = Math.floor(Math.log10(budget / 4));
    return [m * 10 ** k, m * 10 ** (k - 1)];
  });
  const step = steps
    .filter((st) => Number.isInteger(st) && st > 0 && budget / st >= 4)
    .sort((p, q) => q - p)
    .find((st) => {
      for (let t = st; t <= budget * 0.8; t += st) if (!readsExactly(t)) return false;
      return true;
    });
  if (step === undefined) return [0, 0.25, 0.5, 0.75, 1].map((k) => k * budget);
  const ticks = [0];
  for (let t = step; t <= budget * 0.8 + 1e-9; t += step) ticks.push(t);
  return [...ticks, budget];
}

/** Half the width of the tick a lone model value is drawn as: a run of one has no line to draw. */
const TICK = 6;

/**
 * A model's values as a line, by x, broken where a sweep failed; each clamped
 * to lo…hi. A value alone in its run (a protocol of one sweep, or a sweep
 * between failed ones) is a short level tick at its x, since a path of one
 * point draws nothing (F09).
 */
function lineOf(
  model: readonly { x: number; value: number | null }[],
  tx: (v: number) => number,
  ty: (v: number) => number,
  lo: number,
  hi: number,
): string {
  const sorted = [...model].sort((m, n) => m.x - n.x);
  const runs: [number, number][][] = [[]];
  for (const m of sorted) {
    if (m.value === null || !Number.isFinite(m.value)) {
      if (runs[runs.length - 1].length > 0) runs.push([]);
      continue;
    }
    runs[runs.length - 1].push([tx(m.x), ty(Math.min(hi, Math.max(lo, m.value)))]);
  }
  return runs
    .filter((run) => run.length > 0)
    .map((run) => {
      if (run.length === 1) {
        const [[x, y]] = run;
        return `M${f1(x - TICK)} ${f1(y)}L${f1(x + TICK)} ${f1(y)}`;
      }
      return run.map(([x, y], k) => `${k === 0 ? "M" : "L"}${f1(x)} ${f1(y)}`).join("");
    })
    .join("");
}

const valuesOf = (points: readonly Point[]) =>
  points.flatMap((p) => (p.sd === null ? [p.value] : [p.value - p.sd, p.value + p.sd]));

/**
 * A protocol's points as its dataset holds them (train filled, validation
 * hollow, interpolated as diamonds, measured ones with their SD) and the
 * model's value at each point's x as a line, broken where a sweep failed.
 * In a larger `box` (the inspector's, `INSPECTOR`) its points are of radius
 * `r` and `titles` names its axes: y over the plot, x under it. Without
 * validation points every point is a train point.
 */
export function fitOf(
  points: readonly Point[],
  model: readonly { x: number; value: number | null }[],
  logx: boolean,
  o: {
    box?: Box;
    r?: number;
    validation?: boolean;
    titles?: { x: string; y: string };
    /** Label only the value axis's ends, "0" and "1" (Home's glance, #391). */
    ends?: boolean;
  } = {},
): Fit {
  const box = o.box ?? FIT;
  const ys = [...valuesOf(points), ...model.flatMap((m) => (m.value === null ? [] : [m.value]))];
  const f = frameOf(
    box,
    points.map((p) => p.x),
    ys,
    logx,
    o.ends,
  );
  const labels = [...f.labels];
  if (o.titles !== undefined) {
    const X0 = box.left;
    const X1 = box.width - box.right;
    labels.push(
      { t: o.titles.y, left: "0%", top: 0, kind: "unit" },
      {
        t: o.titles.x,
        left: pc((X0 + X1) / 2, box.width),
        top: box.height - box.bottom + 25,
        align: "mid",
        kind: "unit",
      },
    );
  }
  return {
    grid: f.grid,
    base: f.base,
    ...pointsOf(points, f.tx, f.ty, { r: o.r, validation: o.validation }),
    model: lineOf(model, f.tx, f.ty, f.yLo, f.yHi),
    labels,
  };
}

// ── several starts' fits over one protocol's points (Compare, #342) ──────────────────────────

/** A protocol's overlay on Compare, and the strip of each model against its data under it. */
export const OVERLAY = { width: 212, height: 120, left: 37, right: 8, top: 6, bottom: 20 };
export const STRIP = { width: 212, height: 34, left: 37, right: 8, top: 2, bottom: 2 };

/** A start's line on an overlay. */
export interface OverlayLine {
  /** Its model's value at each point's x of its own data; `null` for a failed sweep. */
  model: readonly { x: number; value: number | null }[];
  /** Its model along its own data's x, as `simulate_start`'s line draws it (#367). */
  line: readonly { x: number; value: number | null }[];
  /** Its own data's points, in the order `model` has them: what its strip is measured from. */
  data: readonly { x: number; value: number }[];
}

export interface Overlay extends Omit<Fit, "model"> {
  /** Each start's line, in the order given; empty for one that has none. */
  models: string[];
  strip: {
    box: string;
    zero: string;
    /** Each start's model − its own data, in the order given; empty for one that has none. */
    lines: string[];
    /** How far from 0 the strip reaches, either way, in the data's units. */
    lim: number;
    labels: Label[];
  };
}

/**
 * Each start's fit over one protocol's `points`, the ones the chart shows,
 * on one pair of axes that holds every line; and under it, each start's
 * model minus its own data, about zero. A start may be fit to other data
 * (another dataset, or its earlier data), so its line and strip go by its
 * own points' x.
 */
export function overlayOf(
  points: readonly Point[],
  lines: readonly (OverlayLine | undefined)[],
  logx: boolean,
  size: { overlay: Box; strip: Box } = { overlay: OVERLAY, strip: STRIP },
): Overlay {
  const drawn = lines.filter((l): l is OverlayLine => l !== undefined);
  const xs = [...points.map((p) => p.x), ...drawn.flatMap((l) => l.model.map((m) => m.x))];
  const ys = [
    ...valuesOf(points),
    ...drawn.flatMap((l) => l.line.flatMap((m) => (m.value === null ? [] : [m.value]))),
  ];
  const f = frameOf(size.overlay, xs.length > 0 ? xs : [0, 1], ys, logx);
  // Each start's model − its own data at each of its points.
  const gaps = lines.map((l) =>
    l === undefined
      ? []
      : l.model.map((m, k) => ({
          x: m.x,
          value: m.value === null || l.data[k] === undefined ? null : m.value - l.data[k].value,
        })),
  );
  const widest = Math.max(
    0,
    ...gaps.flatMap((g) => g.flatMap((d) => (d.value === null ? [] : [Math.abs(d.value)]))),
  );
  const lim = widest > 0 ? widest * 1.1 : (f.yHi - f.yLo) * 0.05 || 1;
  const { height: H, top, bottom, left: X0, width: W, right } = size.strip;
  const X1 = W - right;
  const Y0 = H - bottom;
  const sy = (v: number) => Y0 - ((v + lim) / (2 * lim)) * (Y0 - top);
  return {
    grid: f.grid,
    base: f.base,
    ...pointsOf(points, f.tx, f.ty),
    models: lines.map((l) => (l === undefined ? "" : lineOf(l.line, f.tx, f.ty, f.yLo, f.yHi))),
    labels: f.labels,
    strip: {
      box: `M${X0} ${top}H${X1}V${Y0}H${X0}Z`,
      zero: `M${X0} ${f1(sy(0))}H${X1}`,
      lines: gaps.map((g) => lineOf(g, f.tx, sy, -lim, lim)),
      lim,
      labels: [{ t: "0", left: pc(X0 - 5, W), top: sy(0), align: "y" }],
    },
  };
}

// ── every sweep on one time axis ──────────────────────────────────────────────────────────────

/** The simulated open probability's view box, over the voltage command's: one time axis. */
export const RESPONSE = { width: 724, height: 184, left: 52, right: 16, top: 24, bottom: 8 };
export const VOLTAGE = { width: 724, height: 150, left: 52, right: 16, top: 26, bottom: 38 };

/** A sweep drawn: its line, and whether it's the one highlighted. */
export interface SweepLine {
  d: string;
  hi: boolean;
}

export interface SweepFrame {
  grid: string;
  vgrid: string;
  base: string;
  /** Every sweep's line, the highlighted one last, to draw over the rest. */
  curves: SweepLine[];
  labels: Label[];
  aria: string;
}

/** A sweep's voltage, step by step from its start: each step's start and end, and its voltage. */
function stepsOf(
  p: Protocol,
  x: number,
): { from: number; to: number; v: number; measured: boolean }[] {
  let t = 0;
  return p.steps.map((s) => {
    const from = t;
    t += s.duration_ms === "swept" ? x : s.duration_ms;
    return {
      from,
      to: t,
      v: s.voltage_mV === "swept" ? x : s.voltage_mV,
      measured: s.measure !== null,
    };
  });
}

/**
 * Every measured sweep of `p`, on one time axis from each sweep's start:
 * above, its open probability over its measured step (`simulated`, by
 * point, as `simulate_start` answers), and below, its voltage command. The
 * measured sweep `hi`, by its place among them, is highlighted and named
 * `label` ("0 mV") at its peak and its swept step. `peak` scales each sweep
 * to its own peak. An interpolated point isn't a recorded sweep, so it
 * isn't drawn; a failed sweep's line breaks where it isn't a number.
 */
export function sweepsOf(
  p: Protocol,
  simulated: readonly SimulatedPoint[],
  o: { hi: number; label: string; peak: boolean },
): { response: SweepFrame; voltage: SweepFrame } {
  const sweeps = p.points.flatMap((q, i) =>
    q.interpolated || simulated[i] === undefined ? [] : [{ x: q.x, sim: simulated[i] }],
  );
  const hi = Math.min(Math.max(0, o.hi), sweeps.length - 1);
  const drawn = sweeps.map((s) => {
    const steps = stepsOf(p, s.x);
    const from = steps.find((st) => st.measured)?.from ?? 0;
    const top = Math.max(0, ...s.sim.open_probability.filter((v): v is number => v !== null));
    const scale = o.peak && top > 0 ? 1 / top : 1;
    const open = s.sim.open_probability.map((v) =>
      v === null || !Number.isFinite(v) ? null : v * scale,
    );
    const measured = steps.find((st) => st.measured);
    return { x: s.x, steps, from, to: measured?.to ?? from, open, time: s.sim.time_ms };
  });
  // The time the measured steps span, which is all the open probability covers, and a quarter
  // of that before them, for what led into them; from the sweeps' start, when it's the first step.
  const lo = Math.min(...drawn.map((s) => s.from));
  const T = Math.max(lo + 1, ...drawn.map((s) => s.to));
  const T0 = lo <= 0 ? 0 : Math.max(0, lo - (T - lo) / 4);
  const { left: X0, width: W } = RESPONSE;
  const X1 = W - RESPONSE.right;
  const tx = (t: number) => X0 + ((Math.min(T, Math.max(T0, t)) - T0) / (T - T0)) * (X1 - X0);
  // A sweep's name sits above and right of its place, or left of it near the plot's right edge.
  const beside = (x: number, gap: number): Pick<Label, "left" | "align"> =>
    x + gap + 8 * (o.label.length + 1) > W
      ? { left: pc(x - gap, W), align: "back" }
      : { left: pc(x + gap, W), align: "rise" };
  const xt = wideTicks(T0, T, 7);
  const vgrid = xt.map((t) => `M${f1(tx(t))} `);

  // The open probability: 0 to 1 scaled to each peak, else to a round number past the highest.
  const highest = Math.max(
    0,
    ...drawn.flatMap((s) => s.open.filter((v): v is number => v !== null)),
  );
  const yt = o.peak ? [0, 0.5, 1] : highest > 0 ? wideTicks(0, highest, 4) : [0, 1];
  const step = yt.length > 1 ? yt[1] - yt[0] : 1;
  const yMax = o.peak
    ? 1
    : yt[yt.length - 1] < highest
      ? yt[yt.length - 1] + step
      : yt[yt.length - 1];
  if (!o.peak && yt[yt.length - 1] < yMax) yt.push(Number(yMax.toPrecision(12)));
  const R0 = RESPONSE.height - RESPONSE.bottom;
  const R1 = RESPONSE.top;
  const ry = (v: number) => R0 - (v / (yMax * 1.06 || 1)) * (R0 - R1);
  const lineOf = (s: (typeof drawn)[number]) => {
    let d = "";
    let on = false;
    s.time.forEach((t, k) => {
      const v = s.open[k];
      if (v === null) {
        on = false;
        return;
      }
      d += `${on ? "L" : "M"}${f1(tx(s.from + t))} ${f1(ry(v))}`;
      on = true;
    });
    return d;
  };
  const order = <T>(lines: T[]) => [...lines.filter((_, i) => i !== hi), lines[hi]];
  const responseCurves = order(drawn.map((s, i) => ({ d: lineOf(s), hi: i === hi })));
  const h = drawn[hi];
  const peakAt = h.open.reduce<number>(
    (b, v, k) => (v !== null && (h.open[b] === null || v > h.open[b]!) ? k : b),
    0,
  );
  const response: SweepFrame = {
    grid: yt.map((v) => `M${X0} ${f1(ry(v))}H${X1}`).join(""),
    vgrid: vgrid.map((m) => `${m}${R1}V${R0}`).join(""),
    base: `M${X0} ${f1(R0)}H${X1}`,
    curves: responseCurves,
    labels: [
      ...openTicks(yt).map((t, k): Label => ({
        t,
        left: pc(X0 - 6, W),
        top: ry(yt[k]),
        align: "y",
      })),
      { t: o.peak ? "P open ÷ peak" : "P open", left: "0%", top: 0, kind: "unit" },
      ...(h.open[peakAt] == null
        ? []
        : [
            {
              t: o.label,
              ...beside(tx(h.from + h.time[peakAt]), 8),
              top: ry(h.open[peakAt]!) - 4,
              kind: "me",
            } satisfies Label,
          ]),
    ],
    aria: `Simulated open probability for every sweep of ${p.name}${o.peak ? ", each scaled to its own peak" : ""}`,
  };

  // The voltage command, round numbers past the steps' voltages.
  const volts = [p.holding_mV, ...drawn.flatMap((s) => s.steps.map((st) => st.v))];
  const vLo = Math.min(-125, Math.min(...volts) - 15);
  const vHi = Math.max(55, Math.max(...volts) + 15);
  const V0 = VOLTAGE.height - VOLTAGE.bottom;
  const V1 = VOLTAGE.top;
  const vy = (v: number) => V0 - ((v - vLo) / (vHi - vLo)) * (V0 - V1);
  const vt = wideTicks(vLo, vHi, 4).filter((v) => v % 50 === 0 || v === 0);
  // Each sweep's steps across the axis, then back at the holding potential to its end.
  const voltageOf = (s: (typeof drawn)[number]) => {
    const last = s.steps[s.steps.length - 1]?.to ?? 0;
    const held = last < T ? [{ from: last, to: T, v: p.holding_mV }] : [];
    return [...s.steps, ...held]
      .filter((st) => st.to > T0 && st.from < T)
      .map(
        (st, k) =>
          `${k ? "L" : "M"}${f1(tx(st.from))} ${f1(vy(st.v))}L${f1(tx(st.to))} ${f1(vy(st.v))}`,
      )
      .join("");
  };
  const swept = p.steps.findIndex((st) => st.voltage_mV === "swept" || st.duration_ms === "swept");
  const named = h.steps[Math.max(0, swept)];
  const voltage: SweepFrame = {
    grid: vt.map((v) => `M${X0} ${f1(vy(v))}H${X1}`).join(""),
    vgrid: vgrid.map((m) => `${m}${V1}V${V0}`).join(""),
    base: `M${X0} ${f1(V0)}H${X1}`,
    curves: order(drawn.map((s, i) => ({ d: voltageOf(s), hi: i === hi }))),
    labels: [
      ...xt.map((t, i): Label => ({
        t: short(t),
        left: pc(tx(t), W),
        top: V0 + 6,
        align: i === xt.length - 1 && tx(t) > X1 - 20 ? "end" : "mid",
      })),
      ...vt.map((v): Label => ({
        t: minus(short(v)),
        left: pc(X0 - 6, W),
        top: vy(v),
        align: "y",
      })),
      { t: "mV", left: "0%", top: 0, kind: "unit" },
      { t: "Time (ms)", left: pc((X0 + X1) / 2, W), top: V0 + 25, align: "mid", kind: "title" },
      ...(named === undefined
        ? []
        : [
            {
              t: o.label,
              ...beside(tx(named.to), 6),
              top: vy(named.v) - 3,
              kind: "sweep",
            } satisfies Label,
          ]),
    ],
    aria: `Voltage command for every sweep of ${p.name}`,
  };
  return { response, voltage };
}

// ── a part's strip against the Top 10 ─────────────────────────────────────────────────────────

export interface Band {
  /** In % of the strip: the Top 10's range, the best start's tick and this start's dot. */
  band?: { left: number; width: number };
  tick?: number;
  me: number;
  /** Whether this start's value sits outside the Top 10's range. */
  outside: boolean;
}

/** Where `v` sits across `range`, in % of the strip, kept inside it. */
function along(v: number, { min, max }: ParameterRange): number {
  if (!(max > min)) return 50;
  return ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
}

/**
 * A part's strip: the start's value `me` against the Top 10's `top` values,
 * the best start's first. A value outside the Top 10's range by more than
 * its rounding is outside.
 */
export function bandOf(me: number, top: readonly number[], range: ParameterRange): Band {
  if (top.length === 0) return { me: along(me, range), outside: false };
  const lo = Math.min(...top);
  const hi = Math.max(...top);
  const slack = (range.max - range.min) * 1e-6;
  return {
    band: { left: along(lo, range), width: along(hi, range) - along(lo, range) },
    tick: along(top[0], range),
    me: along(me, range),
    outside: me < lo - slack || me > hi + slack,
  };
}

// ── the Voltage dependence curve ──────────────────────────────────────────────────────────────

export const CURVE = { width: 340, height: 104 };

/** A voltage to a tenth, always signed: "+5.9", "−19.6"; "0.0" for none (#360, RF23). */
export function signedMv(v: number): string {
  const t = Math.abs(v).toFixed(1);
  return Number(t) === 0 ? t : `${v < 0 ? "−" : "+"}${t}`;
}

export interface Curve {
  curve: string;
  axis: string;
  mid: string;
  band: string;
  labels: Label[];
  aria: string;
}

/**
 * tanh((V + a)/b) across the voltages that show it, from −120 to +60 mV or
 * wider to hold its middle: half-way at −a, most of its change within −a ± b.
 */
export function curveOf(a: number, b: number): Curve {
  const half = -a;
  const step = 20;
  const lo = Math.min(-120, Math.floor((half - b) / step) * step);
  const hi = Math.max(60, Math.ceil((half + b) / step) * step);
  const X0 = 8;
  const X1 = CURVE.width - 8;
  const tx = (v: number) => X0 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (X1 - X0);
  const ty = (t: number) => 48 - 26 * t;
  const tanh = (v: number) => (b === 0 ? Math.sign(v + a) : Math.tanh((v + a) / b));
  const n = 90;
  const curve = Array.from({ length: n + 1 }, (_, k) => lo + ((hi - lo) * k) / n)
    .map((v, k) => `${k ? "L" : "M"}${f1(tx(v))} ${f1(ty(tanh(v)))}`)
    .join("");
  const mV = (v: number) => minus(fixed(v, 1));
  const tick = (v: number, t: string, align: Label["align"]): Label => ({
    t,
    left: `${f1(tx(v))}px`,
    top: 100,
    align,
  });
  // A label centered on the middle, unless that would run it past the box: then it keeps to the side.
  const placed = (x: number, half: number): Pick<Label, "left" | "align"> =>
    x - half < 0
      ? { left: "0px" }
      : x + half > CURVE.width
        ? { left: `${CURVE.width}px`, align: "end" }
        : { left: `${f1(x)}px`, align: "mid" };
  const middle = tx(half);
  return {
    curve,
    axis: `M${X0} 74.5H${X1}`,
    mid: `M${f1(middle)} 14V74`,
    band: `M${f1(tx(half - b))} 20H${f1(tx(half + b))}V74H${f1(tx(half - b))}Z`,
    labels: [
      { t: `half-way · −a = ${signedMv(half)} mV`, ...placed(middle, 70), top: 2, kind: "now" },
      {
        t: `most of the change: ${mV(half - b)} to ${mV(half + b)} mV`,
        ...placed(middle, 118),
        top: 82,
        kind: "unit",
      },
      tick(lo, minus(String(lo)), undefined),
      tick(0, "0", "mid"),
      tick(hi, `${hi > 0 ? "+" : ""}${minus(String(hi))} mV`, "end"),
    ],
    aria:
      `The voltage dependence curve tanh((V + a)/b): half-way at −a = ${signedMv(half)} mV, most of its ` +
      `change between ${mV(half - b)} and ${mV(half + b)} mV.`,
  };
}
