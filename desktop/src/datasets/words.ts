/**
 * The Dataset wizard's words that more than one step or chart uses: its
 * steps, the status line's on Protocols, the template defaults in a
 * sentence, and the decay window's presets and sentence (#50).
 */
import type { TemplateName } from "../wire/templates.gen";
import type { Issue, Measure, Template } from "../wire/types.gen";
import type { BuilderStep } from "./builder/model";
import { defaultsOf, fieldAt, type Field, type ProtocolForm } from "./draft";
import { count, fixed, joinAnd } from "./format";
import { keepOneTrain, outOfRangeAt } from "./points";
import { TEMPLATE_LABELS } from "./sheets";

export type StepId = "source" | "sheets" | "protocols" | "review";

export const STEPS: { id: StepId; title: string; sub: string }[] = [
  { id: "source", title: "Source", sub: "Workbook and name" },
  { id: "sheets", title: "Sheets", sub: "Templates and names" },
  { id: "protocols", title: "Protocols", sub: "Voltages, timing, weights" },
  { id: "review", title: "Review", sub: "" },
];

const FIELD_WORDS: Record<string, string> = {
  holding: "hold",
  from: "decay window",
  to: "decay window",
  weight: "weight",
  resolution: "time resolution",
  normalized: "Normalize",
  name: "name",
  points: "points",
  interp: "Interpolate",
  perGap: "points per gap",
};

/** Where in a protocol a field is, as the status line names it. */
function where(key: string): string {
  const step = key.match(/^[vd](\d+)$/);
  if (step) return `step ${Number(step[1]) + 1}`;
  if (/^point\d+$/.test(key)) return "points";
  return FIELD_WORDS[key] ?? key;
}

/** Whether `issue` is about an interpolated point's value: one out of its measure's range. */
export function outOfRange(issue: Issue, forms: ProtocolForm[]): boolean {
  return outOfRangeAt(issue, (i) => forms[i]?.points) !== null;
}

/** The first protocol with interpolated points out of range: how many, its name and index, and its issues. */
function rangeOf(forms: ProtocolForm[], issues: Issue[]) {
  const out = issues.flatMap((i) => {
    const at = outOfRangeAt(i, (k) => forms[k]?.points);
    return at === null ? [] : [{ at, issue: i }];
  });
  if (out.length === 0) return null;
  const first = out[0].at.protocol;
  const mine = out.filter((o) => o.at.protocol === first);
  return {
    protocol: first,
    text: `${count(mine.length, "point")} out of range · ${forms[first]?.name ?? ""}`,
    issues: mine.map((o) => o.issue),
  };
}

/** The first protocol with interpolated points out of range: how many, and its name. */
export function rangeStatus(forms: ProtocolForm[], issues: Issue[]): string | null {
  return rangeOf(forms, issues)?.text ?? null;
}

/** What the Protocols step's status line says, and where what it names is. */
export interface ProtocolsStatus {
  blocked: boolean;
  text: string;
  /** The field the status names: its protocol's index and its key. */
  at?: { protocol: number; key: string };
  /** An issue it counts is the last answer's, while the next is on its way (#424 KF21). */
  checking?: boolean;
}

/**
 * The status line: what to fix first, then interpolated points out of
 * range, or how many values are template defaults. Keeping one train point is the
 * dataset's. `stale` are the issues of an answer the checks are asking
 * again for.
 */
export function protocolsStatus(
  forms: ProtocolForm[],
  issues: Issue[],
  stale: ReadonlySet<Issue> = new Set(),
): ProtocolsStatus {
  const mine = issues.filter((i) => fieldAt(i.path).protocol !== null && !outOfRange(i, forms));
  if (mine.length > 0) {
    const first = fieldAt(mine[0].path);
    const name = forms[first.protocol!]?.name ?? "";
    return {
      blocked: true,
      text: `${count(mine.length, "value")} to fix · ${name} ${where(first.key)}`,
      at: { protocol: first.protocol!, key: first.key },
      checking: mine.some((i) => stale.has(i)),
    };
  }
  const range = rangeOf(forms, issues);
  if (range !== null) {
    return {
      blocked: true,
      text: range.text,
      // Points per gap is what brings them back in range.
      at: { protocol: range.protocol, key: "perGap" },
      checking: range.issues.some((i) => stale.has(i)),
    };
  }
  const all = keepOneTrain(issues);
  if (all !== undefined) return { blocked: true, text: all.message, checking: stale.has(all) };
  const defaults = forms.reduce((n, f) => n + defaultsOf(f).length, 0);
  return {
    blocked: false,
    text:
      defaults > 0
        ? defaultsTally(defaults)
        : `${count(forms.length, "protocol")} ready`,
  };
}

/** How many values are still a template's defaults (#501): "1 value is a template default". */
export function defaultsTally(n: number): string {
  return n === 1 ? "1 value is a template default" : `${n} values are template defaults`;
}

/** What a template's fixed step voltages are, by step, where they have a name. */
const VOLTAGE_WORDS: Partial<Record<Template, Record<number, string>>> = {
  steady_state_inactivation: { 1: "test pulse" },
  recovery: { 0: "conditioning pulse", 1: "recovery voltage", 2: "test pulse" },
};

/** The defaults in words: "every step's duration, recoveryE's recovery voltage and …". */
export function defaultsWords(forms: ProtocolForm[]): string {
  const durations = forms.flatMap((f) =>
    f.steps.flatMap((s, j) => (s.duration === null ? [] : [{ f, j, field: s.duration }])),
  );
  const allDurations = durations.length > 0 && durations.every((d) => d.field.default);
  const parts: string[] = allDurations ? ["every step’s duration"] : [];
  for (const f of forms) {
    const own = (field: Field | null): field is Field => field !== null && field.default;
    f.steps.forEach((s, j) => {
      if (own(s.voltage)) {
        parts.push(`${f.name}’s ${VOLTAGE_WORDS[f.template]?.[j] ?? `step ${j + 1} voltage`}`);
      }
      if (!allDurations && own(s.duration)) parts.push(`${f.name}’s step ${j + 1} duration`);
    });
    if (f.holding.default) parts.push(`${f.name}’s holding potential`);
  }
  return joinAnd(parts);
}

/** The decay window's presets, as the Window menu offers them (#50); a range never breaks (#560). */
export const WINDOWS = {
  tau: { label: "Time constant τ · 100\u00a0→\u00a037\u00a0%", from: "100", to: "37" },
  half: { label: "Half-decay · 100\u00a0→\u00a050\u00a0%", from: "100", to: "50" },
  rise: { label: "Rise · 10\u00a0→\u00a090\u00a0%", from: "10", to: "90" },
} as const;

/**
 * Which of a workbook's sheets a dataset takes, as Review says it: "its one
 * sheet.", "both of its sheets.", "all 5 of its sheets.", or "4 of its 6
 * sheets. README and Notes are left out.".
 */
export function sheetsUsedWords(used: number, sheets: number, leftOut: string[]): string {
  if (leftOut.length > 0) {
    return `${used} of its ${sheets} sheets. ${joinAnd(leftOut)} ${leftOut.length === 1 ? "is" : "are"} left out.`;
  }
  return sheets === 1
    ? "its one sheet."
    : sheets === 2
      ? "both of its sheets."
      : `all ${sheets} of its sheets.`;
}

/** The sentence a decay window that's refused reads: its rule, in % (#168). */
export const WINDOW_RULE =
  "Choose two different fractions of the peak, above 0 % and at most 100 %.";

/** Whether a window's two fractions, in %, are each above 0 and at most 100, and differ. */
export function windowValid(from: number, to: number): boolean {
  return from > 0 && to > 0 && from <= 100 && to <= 100 && from !== to;
}

/** What a decay window times, in words: the caption under its sketch (#50). */
export function windowWords(from: number, to: number): string {
  if (!windowValid(from, to)) return WINDOW_RULE;
  if (from < to) {
    return `Upward fractions time a rise before the peak: from ${from}\u00a0% of the peak to ${to}\u00a0%, each counted once the open probability stays above it.`;
  }
  const s =
    from === 100
      ? `From the peak until the open probability falls to ${to}\u00a0% of it and stays below.`
      : `From when the open probability falls to ${from}\u00a0% of its peak and stays below, until it does the same at ${to}\u00a0%.`;
  return from === 100 && to === 37 ? `${s} For one exponential, that’s its time constant τ.` : s;
}

/** Every saved point, and the interpolated and validation ones among them. */
export function pointCounts(forms: ProtocolForm[]) {
  const all = forms.flatMap((f) => f.points);
  return {
    points: all.length,
    interpolated: all.filter((p) => p.interpolated).length,
    validation: all.filter((p) => p.validation).length,
  };
}

/** A protocol's line in the list once it's interpolated: "12 interpolated · 1 per gap". */
export function interpolationLine(f: ProtocolForm): string | null {
  const added = f.points.filter((p) => p.interpolated).length;
  if (!f.read.made.enabled || added === 0) return null;
  return `${added} interpolated · ${f.read.made.points_per_gap} per gap`;
}

/** Review's Interpolation column: "1 per gap · log x", or a dash. */
export function interpolationWords(f: ProtocolForm): string {
  const { enabled, points_per_gap, log_x } = f.read.made;
  if (!enabled) return "—";
  return `${points_per_gap} per gap${log_x ? " · log x" : ""}`;
}

/** Review's validation points: the protocols holding out as many, grouped in their order. */
export function validationGroups(forms: ProtocolForm[]): { count: number; names: string[] }[] {
  const groups: { count: number; names: string[] }[] = [];
  for (const f of forms) {
    const count = f.points.filter((p) => p.validation).length;
    if (count === 0) continue;
    const group = groups.find((g) => g.count === count);
    if (group) group.names.push(f.name);
    else groups.push({ count, names: [f.name] });
  }
  return groups;
}

/**
 * Which way a decay time's window runs (ADR-0010): upward fractions time a
 * rise. `null` where no window is known yet.
 */
export type Direction = "decay" | "rise" | null;

export function directionOf(from: number, to: number): Exclude<Direction, null> {
  return from < to ? "rise" : "decay";
}

/** The shared type's name where no window is known yet (#164). */
export const DECAY_OR_RISE = "Decay or rise time";

/**
 * A template's name: the Decay time template reads Decay time or Rise time
 * by its window, and Decay or rise time where none is known (#164).
 */
export function templateName(template: TemplateName, direction: Direction): string {
  if (template !== "decay_time") return TEMPLATE_LABELS[template];
  return direction === "rise" ? "Rise time" : direction === "decay" ? "Decay time" : DECAY_OR_RISE;
}

/** A protocol's template in words: its name, its window known, or "Custom · 3 steps". */
export function templateLabel(
  template: Template,
  steps: number,
  direction: Exclude<Direction, null> = "decay",
): string {
  return template === "custom"
    ? `Custom · ${count(steps, "step")}`
    : templateName(template, direction);
}

/** What each template measures, in a line (#164), under its match and in the closest-template box. */
const TEMPLATE_LINES: Record<Exclude<TemplateName, "decay_time">, string> = {
  gv_activation: "The peak during each swept step.",
  steady_state_inactivation: "The peak in a test pulse after each swept conditioning step.",
  recovery: "The peak in a second pulse after each swept gap.",
  time_to_peak: "From the start of each swept step to its peak.",
};

const DECAY_LINES: Record<"decay" | "rise" | "either", string> = {
  decay: "From the peak until the current falls to 37\u00a0% of it.",
  rise: "From 10\u00a0% to 90\u00a0% of the peak, as the current rises.",
  either:
    "Between two fractions of the peak: as the current falls after it (100 → 37\u00a0%), or rises before it (10 → 90\u00a0%).",
};

/**
 * What a template measures, in a line. A decay time with its window known
 * (the Protocols step's, or the one guessed from the sheet's name) says that
 * window's fractions, so a half-decay sheet falls to 50 %, not 37 %.
 */
export function templateLine(
  template: Template,
  direction: Direction,
  window?: { from: number; to: number },
): string {
  if (template === "custom") return "Steps you set yourself, in the protocol builder.";
  if (template !== "decay_time") return TEMPLATE_LINES[template];
  if (window === undefined || !windowValid(window.from, window.to)) {
    return DECAY_LINES[direction ?? "either"];
  }
  const { from, to } = window;
  if (from < to) return `From ${from}\u00a0% to ${to}\u00a0% of the peak, as the current rises.`;
  return from === 100
    ? `From the peak until the current falls to ${to}\u00a0% of it.`
    : `From when the current falls to ${from}\u00a0% of the peak until it falls to ${to}\u00a0%.`;
}

/** A measure in words, as facts and checks name it; a decay time running upward is a rise. */
export function measureWords(measure: Measure): string {
  if (measure.kind === "peak") return "peak";
  if (measure.kind === "time_to_peak") return "time to peak";
  return measure.from < measure.to ? "rise time" : "decay time";
}

/** Normalized peaks by template: what the values are fractions of. */
export const NORMALIZED_Y: Partial<Record<Template, string>> = {
  gv_activation: "G/Gmax",
  steady_state_inactivation: "I/Imax",
  recovery: "I₂/I₁",
};

/** Normalize's hint: what your values are, by measure (#50). */
export function normalizeHint(
  measure: Measure["kind"],
  normalized: boolean,
  template: Template,
  rise = false,
): string {
  if (measure === "time_to_peak") return "Not offered for time to peak, which is compared in ms.";
  if (measure === "decay_time") {
    const what = rise ? "rise" : "decay";
    return normalized
      ? `Your values are fractions of the largest ${what} time. The model’s are divided by its largest train sweep to match.`
      : `Your values are ${what} times in ms, compared as they are.`;
  }
  if (!normalized) return "Your values are open probability, 0 to 1, compared as they are.";
  // Recovery's values are I₂/I₁ per sweep, not fractions of the largest (#539 U6).
  if (template === "recovery")
    return "Your values are I₂/I₁, each sweep’s second peak over its first. The model’s second peaks are divided by their largest: the same once recovery is complete at the longest gap.";
  const unit = NORMALIZED_Y[template];
  return `Your values are fractions of the largest${unit ? ` (${unit})` : ""}. The model’s peaks are divided by its largest train sweep to match.`;
}

/** The one-line hint under Peak and Time to peak (#50). */
export const MEASURE_HINTS: Partial<Record<Measure["kind"], string>> = {
  peak: "The highest open probability on this step, including the step’s first reading.",
  time_to_peak: "The time from this step’s start to its peak, in ms.",
};

/** What a built protocol measures: "measures decay time, 100 → 37 %, on step 2". */
export function measureFact(steps: BuilderStep[]): string {
  const measured = steps.flatMap((s, j) => (s.measure === "none" ? [] : [j]));
  if (measured.length === 0) return "no measured step";
  if (measured.length > 1) return `${measured.length} measured steps`;
  const s = steps[measured[0]];
  const from = Number(s.from.replace("−", "-"));
  const to = Number(s.to.replace("−", "-"));
  const measure: Measure =
    s.measure === "decay_time" ? { kind: "decay_time", from, to } : { kind: s.measure as "peak" };
  const window = s.measure === "decay_time" ? `, ${s.from} → ${s.to} %,` : "";
  return `measures ${measureWords(measure)}${window} on step ${measured[0] + 1}`;
}

/**
 * What the Interpolate row says under it (#52): what it does while off, what
 * it adds and costs while on, and that it redraws the validation points (#166).
 */
export function tradeOffWords(
  on: { added: number; measured: number; perGap: number } | null,
): string {
  if (on === null) {
    return "Adds points between yours, read off a cubic spline through all of them. Turning it on, or changing points per gap, redraws the validation points.";
  }
  const more = on.perGap > 1 ? `, more at ${on.perGap}` : "";
  return `Adds ${on.added} points on a cubic spline through your ${on.measured}. The spline passes through validation points too, so they shape what’s added, and fits take longer: about 1.5×\u00a0at 1\u00a0per gap${more}. Changing points per gap redraws the validation points.`;
}

/** A fix for interpolated points out of range that works: fewer per gap, the log x-axis, or neither. */
export interface RangeFix {
  fewer?: number;
  log?: boolean;
}

/**
 * Interpolated points out of their measure's range (#52): the first one's
 * value and x, the rule they break (`validate_dataset`'s sentence), then the
 * one fix that works.
 */
export function outOfRangeWords(
  points: { x: number; value: number; unit: "mV" | "ms" }[],
  rule: string,
  fix: RangeFix,
  name: string,
): string {
  const [first] = points;
  const n = points.length;
  const said = rule.charAt(0).toLowerCase() + rule.slice(1).replace(/\.$/, "");
  const then =
    fix.fewer !== undefined
      ? `Choose ${fix.fewer}\u00a0per gap, where every point is in range, or turn interpolation off.`
      : fix.log
        ? "Try the log x-axis, or turn interpolation off."
        : `Turn interpolation off for ${name}.`;
  return `${n === 1 ? "1 interpolated point is" : `${n} interpolated points are`} out of range: the spline gives ${fixed(first.value, 3)} at ${fixed(first.x, 1)}\u00a0${first.unit}, and ${said}. ${then}`;
}

/** What the Validation row says under it (#53, #166), by how many points the protocol holds out. */
export function validationHint(p: { name: string; points: number; held: number }): string {
  if (p.points < 3 && p.held === 0) {
    return "Too few points to propose any: the proposal needs 3. Click a point to hold it out anyway.";
  }
  if (p.held > 0) {
    return "Hollow points are validation points: fits leave them out, and Val RMSE scores how well a fit predicts them. Click a point on the chart to switch it.";
  }
  return `${p.name} has no validation points, so it counts only toward Train RMSE.`;
}
