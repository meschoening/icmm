/** How the Dataset wizard writes numbers, sizes and lists. */

/** True minus. */
export const minus = (s: string) => s.replace(/^-/, "−");

/** A file's size: "14 KB", "1.2 MB", "212 MB". */
export function size(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Decimals enough for a column's values: none for whole numbers, else three
 * significant digits of the largest (at most 3 decimals), and more while an
 * end of the range would read as 0.
 */
export function decimalsFor(values: number[]): number {
  if (values.length === 0 || values.every((x) => Number.isInteger(x))) return 0;
  const largest = Math.max(...values.map(Math.abs));
  let dp = largest > 0 ? Math.min(3, Math.max(0, 2 - Math.floor(Math.log10(largest)))) : 0;
  const ends = [Math.min(...values), Math.max(...values)];
  while (dp < 4 && ends.some((x) => x !== 0 && Math.abs(x) < 0.5 * 10 ** -dp)) dp++;
  return dp;
}

/** A label's number: up to 4 significant digits, true minus, `+` when `signed`. */
export function short(x: number, signed = false): string {
  const t = String(Number(Math.abs(x).toPrecision(4)));
  if (x === 0) return "0";
  return x < 0 ? `\u2212${t}` : signed ? `+${t}` : t;
}

/** `x` to `dp` decimals, true minus, `+` when `signed` and above 0; never "−0". */
export function fixed(x: number, dp: number, signed = false): string {
  const t = Math.abs(x).toFixed(dp);
  if (Number(t) === 0) return t;
  return x < 0 ? `−${t}` : signed ? `+${t}` : t;
}

/** A column's range: "−120 → +20 mV", "0.006 → 0.989", or one value alone. */
export function span(values: number[], unit: string | null, signed: boolean): string {
  if (values.length === 0) return "—";
  const dp = decimalsFor(values);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const text =
    lo === hi ? fixed(lo, dp, signed) : `${fixed(lo, dp, signed)} → ${fixed(hi, dp, signed)}`;
  return unit === null ? text : `${text} ${unit}`;
}

/** Decimals `x` is written with, shortest round trip: 0 for 512, 3 for 0.512. */
function decimalsOf(x: number): number {
  const [mantissa, exponent] = Math.abs(x).toExponential().split("e");
  return Math.max(0, (mantissa.split(".")[1] ?? "").length - Number(exponent));
}

/**
 * Each sweep's x as a label, to two decimals, or to the precision of `data`,
 * the x the rows hold, where that's finer (#168): an interpolated −76.6667
 * between whole mV reads −76.67, a measured 0.512 ms reads 0.512. A finer
 * one is used where two would read the same. Beyond `toFixed`'s 100-decimal
 * limit, shortest round-trip labels keep even subnormal values distinct.
 */
export function sweepLabels(sweeps: number[], data: number[]): string[] {
  let dp = Math.max(2, ...data.map(decimalsOf));
  const distinct = new Set(sweeps).size;
  while (dp <= 100) {
    const labels = sweeps.map((x) => minus(String(Number(x.toFixed(dp)))));
    if (new Set(labels).size === distinct) return labels;
    dp++;
  }
  return sweeps.map((x) => minus(String(x)));
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "1 default", "2 defaults". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
