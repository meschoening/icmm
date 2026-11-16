/**
 * The Protocol builder's words for its fields and checks: an issue's field
 * by its path, where a check goes, and the one swept quantity.
 */
import type { BuilderStep } from "./model";
import type { Swept } from "./charts";

/** A field's key in the builder, from an issue's path under its protocol. */
export function keyOf(rest: string[]): string {
  const [field, j, sub, last] = rest;
  if (field === "holding_mV") return "holding";
  if (field === "time_resolution_ms") return "resolution";
  if (field === "steps" && j !== undefined) {
    if (sub === "voltage_mV") return `v${j}`;
    if (sub === "duration_ms") return `d${j}`;
    if (sub === "measure" && (last === "from" || last === "to")) return `${last}${j}`;
    if (sub === "measure") return `m${j}`;
  }
  return field ?? "";
}

/** Where a key's field is, in words, for a check that names it. */
export function fieldWords(key: string): string {
  const step = key.match(/^([vdm]|from|to)(\d+)$/);
  if (step) {
    const what = { v: "voltage", d: "duration", m: "measure", from: "window", to: "window" }[
      step[1]
    ];
    return `Step ${Number(step[2]) + 1} ${what}`;
  }
  return (
    {
      holding: "Holding potential",
      weight: "Weight",
      resolution: "Time resolution",
      name: "Protocol name",
      normalized: "Normalize",
      interpolation: "Interpolate",
    }[key] ?? key
  );
}

/** Where a check goes in the Checks card, by the field its issue is at. */
export function rankOf(key: string): number {
  const order = ["sweep", "steps", "measure", "window", "step", "holding", "weight"];
  const more = ["resolution", "normalized", "interpolation", "points", "name"];
  const at = [...order, ...more].indexOf(
    /^(from|to|m)\d+$/.test(key) ? "window" : /^[vd]\d+$/.test(key) ? "step" : key,
  );
  return at < 0 ? 99 : at;
}

/** The one swept quantity, if exactly one is swept. */
export function sweptOf(steps: BuilderStep[]): { all: Swept[]; one: Swept | null } {
  const all = steps.flatMap((s, step): Swept[] => [
    ...(s.voltageSwept ? [{ step, kind: "voltage" as const }] : []),
    ...(s.durationSwept ? [{ step, kind: "duration" as const }] : []),
  ]);
  return { all, one: all.length === 1 ? all[0] : null };
}

/** "every 10" when the values step evenly, else nothing. */
export function every(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 3) return "";
  const gap = sorted[1] - sorted[0];
  const even = sorted.every((x, i) => i === 0 || Math.abs(x - sorted[i - 1] - gap) < 1e-9);
  return even && gap > 0 ? `every ${Number(gap.toPrecision(6))}` : "";
}
