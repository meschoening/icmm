/** Round axes for the dataset charts: the wizard's and Dataset detail's. */

/** Up to `n` round ticks across lo…hi, as a person would label an axis. */
export function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    out.push(Number(t.toPrecision(12)));
  }
  return out;
}

/** Powers of 10 across lo…hi, for a log axis. */
export function decades(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(lo)); 10 ** k <= hi * (1 + 1e-9); k++) {
    if (10 ** k >= lo * (1 - 1e-9)) out.push(Number((10 ** k).toPrecision(12)));
  }
  return out;
}

/** A value axis's ends: from 0 (or below, for data well below it) to a round top. */
export function valueRange(values: number[]): [number, number] {
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  if (hi <= 1.1 && lo >= -0.1) return [lo < -0.02 ? -0.1 : 0, 1];
  const t = ticks(Math.min(0, lo), hi, 3);
  const step = t.length > 1 ? t[1] - t[0] : 1;
  const top = t[t.length - 1] < hi ? t[t.length - 1] + step : t[t.length - 1];
  return [lo < 0 ? -step * Math.ceil(-lo / step) : 0, top];
}

/**
 * At most `max` round ticks across lo…hi for a wide chart: the smallest
 * step of 1, 2, 2.5, 3, 4 or 5 (times a power of 10) that keeps to `max`,
 * one landing on `lo` first ("−80, −40, 0, 40" over −80…40).
 */
export function wideTicks(lo: number, hi: number, max = 5): number[] {
  if (!(hi > lo)) return [lo];
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / max));
  const steps = [1, 2, 2.5, 3, 4, 5, 10, 20].map((m) => m * mag);
  const across = (step: number) => {
    const out: number[] = [];
    for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + step * 1e-9; t += step) {
      out.push(Number(t.toPrecision(12)));
    }
    return out;
  };
  const fits = steps.filter((s) => across(s).length <= max);
  const onLo = fits.find((s) => Math.abs(lo / s - Math.round(lo / s)) < 1e-9);
  return across(onLo ?? fits[0] ?? steps[steps.length - 1]);
}
