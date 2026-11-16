/**
 * Topology's Parameters across the top 10 starts (#41, #233; built in
 * #287): for each part, a strip over the range it can take, with every other
 * finished start's value in gray, the rest of the Top 10 in cobalt and the
 * Best start's as a tick; and beside it the part's spread over the Top 10.
 *
 * The strip is 502 × 18 in its own units and stretches to its column, as the
 * board draws it. Each start's dot sits at its own height, the same on every
 * render, so overlapping values stay apart.
 */
import { count, fixed } from "../../datasets/format";
import type { PartRef } from "../../parameters/rows";
import type { ParameterRange, TopStart } from "../../wire/types.gen";
import type { Part, Stage } from "./words";

export const STRIP_WIDTH = 502;
const PAD = 3;
const NEAR_R = 2.6;
const OTHER_R = 2.2;

/** A start's canonical values, by its index in the topology. */
export interface Shown {
  start: number;
  values: readonly number[];
}

/** The starts a topology's strips draw: its Top 10, the best first, and its other finished starts. */
export interface Drawn {
  top: Shown[];
  others: Shown[];
}

export interface Strip {
  /** Paths in the strip's units: the other finished starts' dots, the Top 10's, the best's tick. */
  others: string;
  near: string;
  tick: string;
  /** What the strip shows, as a sentence. */
  aria: string;
}

/** Where `v` sits across a strip over `range`, kept inside it. */
function xOf(v: number, { min, max }: ParameterRange): number {
  const at = max > min ? (Math.min(max, Math.max(min, v)) - min) / (max - min) : 0.5;
  return PAD + at * (STRIP_WIDTH - 2 * PAD);
}

/** A start's height in a part's strip, from 5.5 to 12.5: the same for it on every render. */
function yOf(start: number, index: number): number {
  let h = Math.imul(start + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return 9 + (((h >>> 0) % 1000) / 1000 - 0.5) * 7;
}

function dots(starts: Shown[], index: number, range: ParameterRange, r: number): string {
  return starts
    .map((s) => {
      const cx = xOf(s.values[index], range);
      const cy = yOf(s.start, index);
      return `M${(cx - r).toFixed(1)} ${cy.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    })
    .join("");
}

/** A value as a strip's sentence says it: ln units to 2 decimals, a and b to 1 in mV. */
export function valueWords(v: number, mV: boolean): string {
  return mV ? `${fixed(v, 1)} mV` : fixed(v, 2);
}

function spanWords(values: number[], mV: boolean): string {
  return `from ${valueWords(Math.min(...values), mV)} to ${valueWords(Math.max(...values), mV)}`;
}

/** Part `p`'s strip over `range`, the Top 10's best start first in `drawn.top`. */
export function stripOf(p: PartRef, range: ParameterRange, drawn: Drawn): Strip {
  const [best, ...rest] = drawn.top;
  const x = xOf(best.values[p.index], range);
  const values = (ss: Shown[]) => ss.map((s) => s.values[p.index]);
  const others =
    drawn.others.length === 0
      ? ""
      : `, ${count(drawn.others.length, "other finished start")} ${spanWords(values(drawn.others), p.mV)}`;
  return {
    others: dots(drawn.others, p.index, range, OTHER_R),
    near: dots(rest, p.index, range, NEAR_R),
    tick: `M${x.toFixed(1)} 1V17`,
    aria:
      `${p.name}: best start ${best.start} at ${valueWords(best.values[p.index], p.mV)}, ` +
      `the top 10 ${spanWords(values(drawn.top), p.mV)}${others}.`,
  };
}

/** A part's spread as its column says it: a number to 2 decimals, "—" without one. */
export function spreadWords(spread: number | null | undefined): string {
  return spread === null || spread === undefined ? "—" : fixed(spread, 2);
}

/** One entry of the strips' key: its swatch, if it has one, and its words, numbers in mono. */
export interface KeyEntry {
  swatch: "best" | "near" | "others" | null;
  parts: Part[];
}

/** The strips' key, in the order the board has it; other finished starts only when there are some. */
export function keyOf(drawn: Drawn): KeyEntry[] {
  const rest = drawn.top.length - 1;
  return [
    { swatch: "best", parts: [{ t: `best start (${drawn.top[0].start})` }] },
    {
      swatch: "near",
      parts: [
        { t: "the other " },
        { t: String(rest), cls: "n" },
        { t: ` top-10 ${rest === 1 ? "start" : "starts"}` },
      ],
    },
    ...(drawn.others.length > 0
      ? [
          {
            swatch: "others" as const,
            parts: [{ t: "other finished starts · for context, not in the spread" }],
          },
        ]
      : []),
    {
      swatch: null,
      parts: [{ t: "spread = SD of the top 10 by Train RMSE, as a share of the bound range" }],
    },
  ];
}

/**
 * What the section says while it has nothing to draw: its Top 10 holds fewer
 * than 2 starts. A topology still fitting will have them; an ended one won't.
 */
export function emptyParameters(stage: Stage, top: readonly TopStart[]): string {
  const live =
    stage !== "complete" && stage !== "failed" && stage !== "unfinished" && stage !== "not fitted";
  if (live)
    return "Once 2 starts have finished, where each of the top 10 put each parameter shows here.";
  return top.length === 1
    ? `Only start ${top[0].start} finished, so there’s nothing to compare its parameters with.`
    : "No start finished, so there are no parameters to compare.";
}
