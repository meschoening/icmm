/**
 * Datasets' and Dataset detail's words (LaptopDatasets, LaptopDatasetDetail):
 * when a dataset was modified, a protocol's template as its row names it,
 * each protocol's facts and its charts' axes.
 */
import type { Point, Protocol, Step, Template } from "../../wire/types.gen";
import { clock } from "../../ui/clock";
import { count, fixed, minus, short, span } from "../format";
import { TEMPLATE_LABELS } from "../sheets";
import type { PointWords } from "../points";
import { WINDOWS } from "../words";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a revision was saved, as Datasets' Modified column says it: "today 10:20", "Aug 4". */
export function modifiedWords(at: string, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  // `clock` of a moment on its own day is its time alone.
  if (d.toDateString() === today.toDateString()) return `today ${clock(d.getTime(), now)}`;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === today.getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

/** A protocol's template as Datasets and Jump to name it: "G/V activation", "Custom · 3 steps". */
export function templateWords(template: Template, steps: number | null): string {
  if (template !== "custom") return TEMPLATE_LABELS[template];
  return steps === null ? "Custom" : `Custom · ${count(steps, "step")}`;
}

/** The step a protocol sweeps, and which quantity. */
function swept(p: Protocol): { index: number; quantity: "voltage" | "duration" } | null {
  for (const [index, s] of p.steps.entries()) {
    if (s.voltage_mV === "swept") return { index, quantity: "voltage" };
    if (s.duration_ms === "swept") return { index, quantity: "duration" };
  }
  return null;
}

/** The unit of a protocol's x: its swept voltage's or duration's. */
export function sweptUnit(p: Protocol): "mV" | "ms" {
  return swept(p)?.quantity === "duration" ? "ms" : "mV";
}

/** The measured points' x, the sweeps a protocol's voltage command draws, low to high. */
export function sweepsOf(p: Protocol): number[] {
  return p.points.filter((q) => !q.interpolated).map((q) => q.x);
}

const mV = (v: number) => `${short(v, v > 0)} mV`;
const ms = (t: number) => `${short(t)} ms`;

/** A fixed step: "−10 mV · 500 ms". */
function stepWords(s: Step): string {
  return `${typeof s.voltage_mV === "number" ? mV(s.voltage_mV) : "swept"} · ${typeof s.duration_ms === "number" ? ms(s.duration_ms) : "swept"}`;
}

/** The step between the sweeps' x: "10 mV", or "uneven". */
function increment(xs: number[], unit: string): string {
  if (xs.length < 2) return "—";
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  const first = gaps[0];
  return gaps.every((g) => Math.abs(g - first) <= 1e-9 * Math.max(1, Math.abs(first)))
    ? `${short(first)} ${unit}`
    : "uneven";
}

/** A decay window as the Window menu names it, or its fractions when it's Other. */
export function windowName(from: number, to: number): string {
  const f = Math.round(from * 1000) / 10;
  const t = Math.round(to * 1000) / 10;
  const preset = Object.values(WINDOWS).find((w) => Number(w.from) === f && Number(w.to) === t);
  return preset?.label ?? `${f} → ${t}\u00a0%`;
}

/** The fractions a decay time runs between, as an axis says them: "100 → 37 %". */
function windowSpan(from: number, to: number): string {
  return `${Math.round(from * 1000) / 10} → ${Math.round(to * 1000) / 10}\u00a0%`;
}

export interface Fact {
  k: string;
  v: string;
  /** Wraps, where the others keep to one line. */
  wraps?: boolean;
}

/** A sweep's range: "−80 → +40 mV", or "1 → 1000 ms (11)" for durations. */
function sweepSpan(xs: number[], quantity: "voltage" | "duration"): string {
  return quantity === "voltage" ? span(xs, "mV", true) : `${span(xs, "ms", false)} (${xs.length})`;
}

/**
 * A protocol's facts beside its charts: its steps as its template names
 * them, then Weight, Normalized, Interpolation and Validation, and Source.
 */
export function protocolFacts(p: Protocol, template: Template): Fact[] {
  const xs = sweepsOf(p);
  const sw = swept(p);
  const facts: Fact[] = [{ k: "Holding", v: mV(p.holding_mV) }];
  const [s0, s1, s2] = p.steps;
  switch (template) {
    case "gv_activation":
    case "decay_time":
    case "time_to_peak":
      facts.push(
        { k: "Test steps", v: sweepSpan(xs, "voltage") },
        { k: "Increment", v: increment(xs, "mV") },
        { k: "Step length", v: typeof s0.duration_ms === "number" ? ms(s0.duration_ms) : "swept" },
      );
      break;
    case "steady_state_inactivation":
      facts.push(
        { k: "Conditioning", v: sweepSpan(xs, "voltage") },
        { k: "Increment", v: increment(xs, "mV") },
        {
          k: "Cond. length",
          v: typeof s0.duration_ms === "number" ? ms(s0.duration_ms) : "swept",
        },
        { k: "Test pulse", v: stepWords(s1) },
      );
      break;
    case "recovery":
      facts.push(
        { k: "Pulse 1", v: stepWords(s0) },
        { k: "Gap", v: typeof s1.voltage_mV === "number" ? `at ${mV(s1.voltage_mV)}` : "swept" },
        { k: "Gap lengths", v: sweepSpan(xs, "duration") },
        { k: "Pulse 2", v: stepWords(s2) },
      );
      break;
    case "custom":
      p.steps.forEach((s, i) => {
        const v =
          sw?.index === i
            ? sw.quantity === "voltage"
              ? `${sweepSpan(xs, "voltage")} · ${typeof s.duration_ms === "number" ? ms(s.duration_ms) : ""}`
              : `${typeof s.voltage_mV === "number" ? mV(s.voltage_mV) : ""} · ${sweepSpan(xs, "duration")}`
            : stepWords(s);
        facts.push({
          k: `Step ${i + 1}`,
          v: s.measure === null ? v : `${v} · ${measuredWords(s.measure)}`,
        });
      });
      break;
  }
  const measure = p.steps.find((s) => s.measure !== null)?.measure;
  if (measure?.kind === "decay_time") {
    // Running upward, it's a rise (#164).
    const k = measure.from < measure.to ? "Rise window" : "Decay window";
    facts.push({ k, v: windowName(measure.from, measure.to) });
  }
  const validation = p.points.filter((q) => q.validation).length;
  facts.push(
    { k: "Weight", v: weightWords(p.weight) },
    { k: "Normalized", v: p.normalized ? "yes" : "no" },
    { k: "Interpolation", v: interpolationFact(p) },
    {
      k: "Validation",
      v: validation === 0 ? "none" : `${validation} of ${count(p.points.length, "point")}`,
    },
  );
  if (p.source !== null) {
    facts.push({ k: "Source", v: `${p.source.workbook} › ${p.source.sheet}`, wraps: true });
  }
  return facts;
}

const MEASURED = { peak: "peak", decay_time: "decay time", time_to_peak: "time to peak" } as const;

/** A measure in words: a decay time whose window runs upward is a rise time (#164). */
function measuredWords(measure: NonNullable<Step["measure"]>): string {
  return measure.kind === "decay_time" && measure.from < measure.to
    ? "rise time"
    : MEASURED[measure.kind];
}

/** A weight as it was typed, as the wizard and Review show it: "1", "1.5", "0.25". */
function weightWords(w: number): string {
  return minus(String(w));
}

/** "off", or "1 per gap · log x-axis". */
function interpolationFact(p: Protocol): string {
  const { enabled, points_per_gap, log_x } = p.interpolation;
  if (!enabled) return "off";
  return `${points_per_gap} per gap${log_x ? " · log x-axis" : ""}`;
}

/** Whether the data chart draws x on a log scale: the protocol's log x-axis, with every x above 0. */
export function logX(p: Protocol): boolean {
  return p.interpolation.log_x && p.points.every((q: Point) => q.x > 0);
}

/** The data chart's axes: what y measures (its caption) and what x sweeps (under it). */
export function axisTitles(p: Protocol, template: Template): { y: string; x: string } {
  const measure = p.steps.find((s) => s.measure !== null)?.measure;
  const sw = swept(p);
  const log = logX(p) ? ", log scale" : "";
  let y: string;
  if (measure?.kind === "decay_time") {
    const window = windowSpan(measure.from, measure.to);
    const name = measure.from < measure.to ? "Rise time" : "Decay time";
    y = p.normalized ? `${name}, ${window}, a fraction of the largest` : `${name}, ${window} (ms)`;
  } else if (measure?.kind === "time_to_peak") {
    y = "Time to peak (ms)";
  } else if (!p.normalized) {
    y = "Peak open probability";
  } else {
    y =
      template === "gv_activation"
        ? "Normalized conductance (G/Gmax)"
        : template === "steady_state_inactivation"
          ? "Normalized current (I/Imax)"
          : template === "recovery"
            ? "Fractional recovery (I₂/I₁)"
            : "Peak, as a fraction of the largest";
  }
  let x: string;
  switch (template) {
    case "gv_activation":
    case "decay_time":
      x = `Membrane voltage (mV${log})`;
      break;
    case "time_to_peak":
      x = `Test voltage (mV${log})`;
      break;
    case "steady_state_inactivation":
      x = `Conditioning voltage (mV${log})`;
      break;
    case "recovery":
      x = `Gap length (ms${log})`;
      break;
    case "custom":
      x =
        sw === null
          ? "Sweep"
          : `Step ${sw.index + 1} ${sw.quantity} (${sw.quantity === "voltage" ? "mV" : "ms"}${log})`;
      break;
  }
  return { y, x };
}

/** The sweep the voltage command draws dark, as its caption names it: "−20 mV", "32 ms gap". */
export function sweepWords(p: Protocol, template: Template, x: number): string {
  const sw = swept(p);
  if (sw?.quantity === "duration") return `${ms(x)}${template === "recovery" ? " gap" : ""}`;
  return mV(x);
}

/**
 * A point as its chart reads it out under the plot (DS06): its sweep and
 * values, "−20 mV · 0.418 ± 0.059", then what it is, " · validation" or
 * " · interpolated".
 */
export function readoutWords(
  p: Protocol,
  template: Template,
  point: Point,
  words: PointWords,
): { values: string; marks: string } {
  const sd = point.sd === null ? "" : ` ± ${fixed(point.sd, words.digits)}`;
  const unit = words.inMs ? "\u00a0ms" : "";
  const marks = [point.interpolated && "interpolated", point.validation && "validation"]
    .filter((m) => m !== false)
    .map((m) => ` · ${m}`)
    .join("");
  return {
    values: `${sweepWords(p, template, point.x)} · ${fixed(point.value, words.digits)}${sd}${unit}`,
    marks,
  };
}

/** The data chart's summary in words. */
export function pointsLabel(p: Protocol): string {
  const n = p.points.length;
  const added = p.points.filter((q) => q.interpolated).length;
  const held = p.points.filter((q) => q.validation).length;
  return [
    `${p.name}: ${n} ${n === 1 ? "point" : "points"}, mean and SD`,
    added > 0 ? `${added} of them interpolated, drawn as diamonds without SD` : null,
    held > 0 ? `${held} of them validation points, drawn hollow` : null,
  ]
    .filter((s) => s !== null)
    .join("; ");
}
