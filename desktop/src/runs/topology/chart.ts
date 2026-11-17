/**
 * "Where the finished starts ended" (LaptopTopology, #233), laid out: each
 * finished start's final Train RMSE as a dot on a log scale, stacked in
 * columns 1 % of the best wide, so the near-best starts make one column at
 * the band; +10 %, +50 % and +100 % guides; and nice ticks. In a 952 × 182
 * view box that stretches to its column, with its dots and labels laid over
 * it in HTML, placed in % of its width, so a dot stays round and can open its
 * start (#359).
 */
import { rmse } from "../words";

export const WIDTH = 952;
const X0 = 40;
const X1 = 932;
/** The baseline the dots stand on, and the most room a column has above it. */
const BASE = 130;
const ROOM = 104;
const STEP = 7.4;
const R = 3.2;
/**
 * The guides' labels, measured as drawn: a character of 11 px IBM Plex Mono is 6.6 px, and the
 * chart is at its narrowest NARROWEST px a view-box unit (a 1200 px window, 0.9 with a scrollbar
 * beside it); they keep LABEL_GAP px apart there, so wider they never touch.
 */
const LABEL_CH = 6.6;
const LABEL_GAP = 8;
const NARROWEST = 0.88;

export interface Label {
  t: string;
  /** Where it's placed, in % of the chart's width. */
  left: string;
  top: number;
  /** Its anchor: centered on `left`, or ending at it. */
  align?: "mid" | "end";
  kind?: "lead" | "best";
}

/** A finished start's dot. */
export interface Dot {
  start: number;
  /** Its center: across in % of the chart's width, down in px. */
  left: string;
  top: number;
  /** Its diameter in px: smaller in a column packed tight. */
  size: number;
  /** Within 1 % of the best, in cobalt. */
  near: boolean;
  /** The Best start's, ringed. */
  best: boolean;
  /** Which way its tooltip runs, so it stays over the chart: from the dot, centered on it, or to it. */
  tip: "start" | "mid" | "end";
}

export interface Dots {
  band: { x: number; width: number };
  lead: string;
  ticks: string;
  guides: string;
  /** Lowest Train RMSE first. */
  dots: Dot[];
  labels: Label[];
  aria: string;
}

/** Its 1-2-…-9 ticks between `lo` and `hi`, each decade's steps. */
function ticksBetween(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) {
    for (let m = 1; m <= 9; m++) {
      const v = Number((m * 10 ** d).toPrecision(6));
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

/**
 * The chart for the `finished` starts, each with its Train RMSE, and the Best
 * start's `best` (`start` its number): its dots, the near-best band, the
 * guides, the ticks and the labels.
 */
export function dotsOf(
  finished: { start: number; train: number }[],
  best: { start: number; train: number },
): Dots {
  const trains = finished.map((f) => f.train);
  // A log scale has no 0: an exact fit sits with the lowest positive RMSE, or at 1e-6.
  const floor = best.train > 0 ? best.train : Math.min(...trains.filter((v) => v > 0), 1e-6);
  const b0 = Math.max(best.train, floor);
  const max = Math.max(...trains, b0);
  const lo = Math.log(b0 * 0.976);
  const hi = Math.log(Math.max(max * 1.06, b0 * 1.25));
  const X = (v: number) => X0 + ((Math.log(Math.max(v, floor)) - lo) / (hi - lo)) * (X1 - X0);
  const pct = (x: number) => `${((x / WIDTH) * 100).toFixed(3)}%`;
  const bx = X(b0);
  const bw = X(b0 * 1.01) - bx;

  const column = (v: number) => Math.max(0, Math.floor((X(v) - bx) / bw));
  // Lowest first, ties by start, so the Best start stands at the foot of its column.
  const sorted = [...finished].sort(
    (a, b) => a.train - b.train || (a.start === best.start ? -1 : b.start === best.start ? 1 : 0),
  );
  const heights = new Map<number, number>();
  for (const { train } of sorted) {
    heights.set(column(train), (heights.get(column(train)) ?? 0) + 1);
  }
  // A tall column packs its dots closer, so it stays in its room.
  const step = Math.min(STEP, ROOM / Math.max(...heights.values(), 1));
  const size = Number((2 * Math.min(R, step * 0.45)).toFixed(2));
  const stacked = new Map<number, number>();
  let nNear = 0;
  const dots = sorted.map(({ start, train }): Dot => {
    const c = column(train);
    const h = stacked.get(c) ?? 0;
    stacked.set(c, h + 1);
    const cx = bx + (c + 0.5) * bw;
    const near = train <= best.train * 1.01 + 1e-12;
    if (near) nNear++;
    return {
      start,
      left: pct(cx),
      top: Number((BASE - h * step).toFixed(1)),
      size,
      near,
      best: start === best.start,
      tip: cx < WIDTH * 0.25 ? "start" : cx > WIDTH * 0.7 ? "end" : "mid",
    };
  });

  const lohi = [Math.exp(lo), Math.exp(hi)] as const;
  const values = ticksBetween(lohi[0], lohi[1]);
  const ticks = values.map((v) => `M${X(v).toFixed(1)} 137V142`).join("");
  // As many decimals as the smallest tick's decade needs: 0.05, 0.10, 0.008.
  const decimals = Math.max(2, -Math.floor(Math.log10(lohi[0])));
  const labels: Label[] = [];
  // The best's label takes the axis's left end: a tick's label keeps clear of it, and of the last.
  let clear = bx + 120;
  for (const v of values) {
    const x = X(v);
    if (x < clear || x > X1 - 70) continue;
    labels.push({ t: v.toFixed(decimals), left: pct(x), top: 149, align: "mid" });
    clear = x + 56;
  }
  // Each guide is drawn; its label only where it keeps clear of the ones kept before it, which
  // go in this order: "+100 % above best" says what the others count from (#469 R08).
  const guided = [
    [2, "+100 % above best"],
    [1.1, "+10 %"],
    [1.5, "+50 %"],
  ] as const;
  let guides = "";
  const kept: [number, number][] = [];
  for (const [f, words] of guided) {
    const x = X(b0 * f);
    if (x > X1) continue;
    guides += `M${x.toFixed(1)} 66V134`;
    const half = (words.length * LABEL_CH) / 2 / NARROWEST;
    const gap = LABEL_GAP / NARROWEST;
    if (kept.some(([a, b]) => x - half < b + gap && a - gap < x + half)) continue;
    kept.push([x - half, x + half]);
    labels.push({ t: words, left: pct(x), top: 52, align: "mid" });
  }
  const mid = bx + bw / 2;
  labels.push(
    { t: `${rmse(best.train)} · start ${best.start}`, left: pct(bx - 6), top: 149, kind: "best" },
    { t: "train RMSE", left: pct(X1), top: 170, align: "end" },
    {
      t: `within 1 % of best · ${nNear} of ${trains.length} starts`,
      left: pct(mid + 16),
      top: 6,
      kind: "lead",
    },
  );
  return {
    band: { x: bx, width: bw },
    lead: `M${mid.toFixed(1)} 24V12H${(mid + 12).toFixed(1)}`,
    ticks,
    guides,
    dots,
    labels,
    aria: `Final train RMSE of ${trains.length} finished starts. ${nNear} are within 1 % of the best train RMSE, start ${best.start}’s ${rmse(best.train)}.`,
  };
}
