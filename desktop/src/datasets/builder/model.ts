/**
 * The Protocol builder's draft (#144; LaptopProtocolBuilder): its steps and
 * fields as typed, a template's preset (`templates.gen.ts`) or Blank to
 * start from, and the protocol they make for `validate_dataset`.
 *
 * Nothing here checks a value or names a template: the agent's
 * `validate_dataset` does both (ADR-0003). A value that isn't a number yet
 * stays as typed, and the protocol waits for it.
 */
import { TEMPLATES, type TemplateName, type TemplatePreset } from "../../wire/templates.gen";
import type { Issue, Measure, Point, Protocol, Source, Step, Template } from "../../wire/types.gen";
import type { FieldMark } from "../../setup/form";
import { NOT_A_WHOLE_NUMBER, parsed, PULSE_STEPS, shown, shownVoltage } from "../draft";
import { joinAnd } from "../format";
import type { SheetRead } from "../sheets";
import {
  formOfInterpolation,
  keyOf,
  madeOf,
  percentOf,
  readInterpolation,
  readShare,
  shownPoints,
  type InterpolationForm,
  type InterpolationRead,
  type Made,
  type ShareRead,
} from "../points";

export type MeasureKind = Measure["kind"];

export interface BuilderStep {
  /** As typed; kept while the voltage is swept, for when it's fixed again. */
  voltage: string;
  voltageSwept: boolean;
  duration: string;
  durationSwept: boolean;
  measure: MeasureKind | "none";
  /** A decay time's window: two fractions of the peak, in percent, as typed. */
  from: string;
  to: string;
}

/** Which sheet column plays x, y and SD (indices into the sheet's columns). */
export interface Mapping {
  x?: number;
  y?: number;
  sd?: number;
}

export interface BuilderDraft {
  name: string;
  holding: string;
  steps: BuilderStep[];
  normalized: boolean;
  weight: string;
  resolution: string;
  /** Interpolate as set: the preset starts it, and the row changes it. */
  interp: InterpolationForm;
  /** Its validation share in %, as typed (#166). */
  share: string;
  /**
   * The values a template's card filled and nobody has typed since (#164):
   * `holding`, and `v{j}` and `d{j}` for step j's voltage and duration.
   */
  defaults: string[];
  roles: Mapping;
  /**
   * Its points as this computer's engine made them, with their marks
   * (`points.ts`); current while their key is the draft's.
   */
  made?: Made;
}

/** A card under Start from: a template, or Blank, which no template is. */
export type PresetName = TemplateName | "blank";

/** Blank (LaptopProtocolBuilder): one fixed step at the holding potential, nothing measured. */
const BLANK: TemplatePreset = {
  holding_mV: -80,
  steps: [{ voltage_mV: -80, duration_ms: 100, measure: null }],
  normalized: false,
  weight: 1,
  time_resolution_ms: 0.1,
  interpolation: { enabled: false, points_per_gap: 1, log_x: false },
  validation_share: 0.2,
};

export const PRESETS: { name: PresetName; preset: TemplatePreset }[] = [
  ...(Object.keys(TEMPLATES) as TemplateName[]).map((name) => ({
    name,
    preset: TEMPLATES[name],
  })),
  { name: "blank", preset: BLANK },
];

/** What a swept quantity reads once it's made fixed, before anything is typed for it. */
const FIXED_VOLTAGE = "0";
const FIXED_DURATION = "100";

/** The decay window a decay time starts at: the Decay time template's, 100 → 37 %. */
const DECAY_WINDOW = (() => {
  const measure = TEMPLATES.decay_time.steps.find((s) => s.measure?.kind === "decay_time")!
    .measure as Extract<Measure, { kind: "decay_time" }>;
  return { from: percent(measure.from), to: percent(measure.to) };
})();

function percent(fraction: number): string {
  return shown(Number((fraction * 100).toPrecision(12)));
}

function stepOf(s: Step): BuilderStep {
  const window =
    s.measure?.kind === "decay_time"
      ? { from: percent(s.measure.from), to: percent(s.measure.to) }
      : DECAY_WINDOW;
  return {
    voltage: s.voltage_mV === "swept" ? FIXED_VOLTAGE : shownVoltage(s.voltage_mV),
    voltageSwept: s.voltage_mV === "swept",
    duration: s.duration_ms === "swept" ? FIXED_DURATION : shown(s.duration_ms),
    durationSwept: s.duration_ms === "swept",
    measure: s.measure?.kind ?? "none",
    ...window,
  };
}

/** A new protocol from Blank, under `name`. */
export function blankDraft(name: string, roles: Mapping = {}): BuilderDraft {
  return withPreset(
    {
      name,
      holding: "",
      steps: [],
      normalized: false,
      weight: shown(BLANK.weight),
      resolution: "",
      interp: formOfInterpolation(BLANK.interpolation),
      share: percentOf(BLANK.validation_share),
      defaults: [],
      roles,
    },
    "blank",
  );
}

/**
 * A saved protocol as a draft (Edit protocol…), its data mapped by `roles`:
 * its points as saved, with their marks, until its data or interpolation
 * changes.
 */
export function draftOf(protocol: Protocol, roles: Mapping): BuilderDraft {
  return {
    name: protocol.name,
    holding: shownVoltage(protocol.holding_mV),
    steps: protocol.steps.map(stepOf),
    normalized: protocol.normalized,
    weight: shown(protocol.weight),
    resolution: shown(protocol.time_resolution_ms),
    interp: formOfInterpolation(protocol.interpolation),
    share: percentOf(protocol.validation_share),
    defaults: [],
    roles,
    made: madeOf(protocol),
  };
}

/** The fields a change counts by, each compared as its value, so "1.0" is no change from "1". */
const TEXT_FIELDS = ["name", "holding", "weight", "resolution", "share"] as const;
const STEP_FIELDS = ["voltage", "duration", "from", "to"] as const;

function sameText(a: string, b: string): boolean {
  const x = parsed(a);
  const y = parsed(b);
  return x !== null && y !== null ? x === y : a.trim() === b.trim();
}

function sameStep(a: BuilderStep, b: BuilderStep): boolean {
  return (
    a.voltageSwept === b.voltageSwept &&
    a.durationSwept === b.durationSwept &&
    a.measure === b.measure &&
    STEP_FIELDS.every((k) => sameText(a[k], b[k]))
  );
}

function sameInterp(a: InterpolationForm, b: InterpolationForm): boolean {
  return (
    a.enabled === b.enabled && a.logX === b.logX && (!a.enabled || sameText(a.perGap, b.perGap))
  );
}

/** Whether `draft` switched a point that `from` had made the same way. */
function marksChanged(from: BuilderDraft, draft: BuilderDraft): boolean {
  if (from.made === undefined || draft.made === undefined) return false;
  if (from.made.key !== draft.made.key) return false;
  const was = new Map(from.made.points.map((p) => [p.x, p.validation]));
  return draft.made.points.some((p) => was.get(p.x) !== p.validation);
}

/** Whether two mappings put the same columns in each role. */
export function sameRoles(a: Mapping, b: Mapping): boolean {
  return a.x === b.x && a.y === b.y && a.sd === b.sd;
}

/**
 * How many changes `draft` makes to `from`: each field whose value differs,
 * each step that differs or was added or removed, its data, mapped
 * otherwise or read from another sheet (`dataChanged`), its interpolation,
 * and its validation points.
 */
export function changesOf(from: BuilderDraft, draft: BuilderDraft, dataChanged: boolean): number {
  let n = TEXT_FIELDS.filter((k) => !sameText(from[k], draft[k])).length;
  if (from.normalized !== draft.normalized) n++;
  if (!sameInterp(from.interp, draft.interp)) n++;
  if (marksChanged(from, draft)) n++;
  const common = Math.min(from.steps.length, draft.steps.length);
  for (let j = 0; j < common; j++) if (!sameStep(from.steps[j], draft.steps[j])) n++;
  n += Math.abs(from.steps.length - draft.steps.length);
  if (dataChanged || !sameRoles(from.roles, draft.roles)) n++;
  return n;
}

/**
 * Reload after another computer's save (section 1's note): `theirs`, with
 * each field you changed since `from` kept as you have it. Each step's
 * values are fields of their own while no step was added or removed on
 * either side (#164); then the steps are one field, as the data mapping is.
 */
export function reloadDraft(from: BuilderDraft, mine: BuilderDraft, theirs: BuilderDraft) {
  const keep = <K extends keyof BuilderDraft>(k: K, same: boolean) => (same ? theirs[k] : mine[k]);
  const n = from.steps.length;
  const steps =
    mine.steps.length === n && theirs.steps.length === n
      ? theirs.steps.map((t, j): BuilderStep => {
          const [f, m] = [from.steps[j], mine.steps[j]];
          const pick = <K extends keyof BuilderStep>(k: K, same: boolean) => (same ? t[k] : m[k]);
          return {
            voltage: pick("voltage", sameText(f.voltage, m.voltage)),
            voltageSwept: pick("voltageSwept", f.voltageSwept === m.voltageSwept),
            duration: pick("duration", sameText(f.duration, m.duration)),
            durationSwept: pick("durationSwept", f.durationSwept === m.durationSwept),
            measure: pick("measure", f.measure === m.measure),
            from: pick("from", sameText(f.from, m.from)),
            to: pick("to", sameText(f.to, m.to)),
          };
        })
      : keep(
          "steps",
          from.steps.length === mine.steps.length &&
            from.steps.every((s, j) => sameStep(s, mine.steps[j])),
        );
  return {
    ...theirs,
    name: keep("name", sameText(from.name, mine.name)),
    holding: keep("holding", sameText(from.holding, mine.holding)),
    weight: keep("weight", sameText(from.weight, mine.weight)),
    resolution: keep("resolution", sameText(from.resolution, mine.resolution)),
    share: keep("share", sameText(from.share, mine.share)),
    normalized: keep("normalized", from.normalized === mine.normalized),
    steps,
    defaults: mine.defaults,
    roles: keep("roles", sameRoles(from.roles, mine.roles)),
    interp: keep("interp", sameInterp(from.interp, mine.interp)),
    // Points you switched, or made otherwise, stay; the builder makes them again if their data moved.
    made: keep("made", !marksChanged(from, mine) && sameInterp(from.interp, mine.interp)),
  } satisfies BuilderDraft;
}

/** Each field a mark can sit under, by key, as it reads: what "was …" says. */
function marked(d: BuilderDraft, steps: boolean): Map<string, string> {
  const fields = new Map<string, string>([
    ["name", d.name],
    ["holding", d.holding],
    ["weight", d.weight],
    ["resolution", d.resolution],
    ["share", d.share],
  ]);
  if (steps) {
    d.steps.forEach((s, j) => {
      fields.set(`v${j}`, s.voltageSwept ? "swept" : s.voltage);
      fields.set(`d${j}`, s.durationSwept ? "swept" : s.duration);
    });
  }
  return fields;
}

/** The keys of the fields that differ from `a` to `b`; a step's only while both have as many. */
function changedKeys(a: BuilderDraft, b: BuilderDraft): string[] {
  const steps = a.steps.length === b.steps.length;
  const [x, y] = [marked(a, steps), marked(b, steps)];
  return [...x.keys()].filter((k) => !sameText(x.get(k)!, y.get(k)!));
}

/**
 * Under each field you or another computer changed (Settings' marks, #164):
 * yours since `base`, the revision it shows, as "Changed · was …"; theirs,
 * from `opened` to `base` after Reload, as "From another computer · was …";
 * and one you both changed keeps yours and says what they saved.
 */
export function fieldMarks(
  opened: BuilderDraft,
  base: BuilderDraft,
  now: BuilderDraft,
): Record<string, FieldMark> {
  const mine = changedKeys(base, now);
  const theirs = changedKeys(opened, base);
  const at = (d: BuilderDraft, k: string) => marked(d, true).get(k) ?? "";
  const marks: Record<string, FieldMark> = {};
  for (const k of new Set([...mine, ...theirs])) {
    if (mine.includes(k) && theirs.includes(k)) {
      marks[k] = { kind: "both", was: at(opened, k), saved: at(base, k) };
    } else if (mine.includes(k)) marks[k] = { kind: "mine", was: at(base, k) };
    else marks[k] = { kind: "theirs", was: at(opened, k) };
  }
  return marks;
}

const FIELD_WORDS: Record<string, string> = {
  name: "name",
  holding: "holding potential",
  weight: "weight",
  resolution: "time resolution",
  share: "validation share",
};

/** Everything that differs from `a` to `b`, in words, in the page's order. */
function changedWords(a: BuilderDraft, b: BuilderDraft): string[] {
  const words: string[] = [];
  for (const k of ["name", "holding"])
    if (!sameText(a[k as "name"], b[k as "name"])) words.push(FIELD_WORDS[k]);
  if (a.steps.length !== b.steps.length) words.push("steps");
  else {
    a.steps.forEach((s, j) => {
      const t = b.steps[j];
      const step = `step ${j + 1}`;
      if (s.voltageSwept !== t.voltageSwept || (!s.voltageSwept && !sameText(s.voltage, t.voltage)))
        words.push(`${step} voltage`);
      if (
        s.durationSwept !== t.durationSwept ||
        (!s.durationSwept && !sameText(s.duration, t.duration))
      )
        words.push(`${step} duration`);
      if (s.measure !== t.measure) words.push(`${step} measure`);
      else if (s.measure === "decay_time" && !(sameText(s.from, t.from) && sameText(s.to, t.to)))
        words.push(`${step} window`);
    });
  }
  if (a.normalized !== b.normalized) words.push("Normalize");
  for (const k of ["weight", "resolution", "share"]) {
    if (!sameText(a[k as "weight"], b[k as "weight"])) words.push(FIELD_WORDS[k]);
  }
  if (!sameInterp(a.interp, b.interp)) words.push("interpolation");
  if (!sameRoles(a.roles, b.roles)) words.push("data");
  if (marksChanged(a, b)) words.push("validation points");
  return words;
}

/**
 * What the note says once another computer saved `theirs` over `base`, the
 * draft holding `now`: the fields it changed, and what Reload keeps,
 * naming any field you both changed, as Settings' note does (#118's U15).
 */
export function elsewhereNotice(
  base: BuilderDraft,
  theirs: BuilderDraft,
  now: BuilderDraft,
): { fields: string | undefined; reload: string } {
  const changed = changedWords(base, theirs);
  const mine = changedWords(base, now);
  const both = mine.filter((w) => changed.includes(w) && changedWords(theirs, now).includes(w));
  let reload = "Reload shows theirs.";
  if (both.length > 0) {
    reload = `Reload shows theirs. You both changed ${joinAnd(both)}, so it keeps yours.`;
  } else if (mine.length > 0) {
    reload = `Reload shows theirs and keeps ${mine.length === 1 ? "the field" : `the ${mine.length} fields`} you changed.`;
  }
  return { fields: changed.length === 0 ? undefined : joinAnd(changed), reload };
}

/** The values a template's card filled that are still as it filled them, in the page's order. */
export function defaultsOf(draft: BuilderDraft): string[] {
  const keys = [
    "holding",
    ...draft.steps.flatMap((s, j) => [
      ...(s.voltageSwept ? [] : [`v${j}`]),
      ...(s.durationSwept ? [] : [`d${j}`]),
    ]),
  ];
  return keys.filter((k) => draft.defaults.includes(k));
}

/** The draft with fields typed: each one typed is no longer a default. */
export function typed(draft: BuilderDraft, change: Partial<BuilderDraft>): BuilderDraft {
  const next = { ...draft, ...change };
  return "holding" in change
    ? { ...next, defaults: draft.defaults.filter((k) => k !== "holding") }
    : next;
}

/** Step `j` with values typed: a voltage or duration typed is no longer a default. */
export function typedStep(
  draft: BuilderDraft,
  j: number,
  change: Partial<BuilderStep>,
): BuilderDraft {
  const cleared = [
    ...("voltage" in change ? [`v${j}`] : []),
    ...("duration" in change ? [`d${j}`] : []),
  ];
  return {
    ...draft,
    steps: draft.steps.map((s, i) => (i === j ? { ...s, ...change } : s)),
    defaults: draft.defaults.filter((k) => !cleared.includes(k)),
  };
}

/** Defaults' keys with their steps renumbered: `to(j)` is step j's new place, `null` if it's gone. */
function renumbered(defaults: string[], to: (j: number) => number | null): string[] {
  return defaults.flatMap((k) => {
    const m = k.match(/^([vd])(\d+)$/);
    if (m === null) return [k];
    const j = to(Number(m[2]));
    return j === null ? [] : [`${m[1]}${j}`];
  });
}

/** The draft started over from a card: its hold, steps, Normalize and Time resolution. */
export function withPreset(draft: BuilderDraft, name: PresetName): BuilderDraft {
  const preset = PRESETS.find((p) => p.name === name)!.preset;
  const steps = preset.steps.map(stepOf);
  return {
    ...draft,
    holding: shownVoltage(preset.holding_mV),
    steps,
    normalized: preset.normalized,
    resolution: shown(preset.time_resolution_ms),
    interp: formOfInterpolation(preset.interpolation),
    // A template's values are its defaults to check (#164); Blank isn't a template.
    defaults:
      name === "blank"
        ? []
        : [
            "holding",
            ...steps.flatMap((s, j) => [
              ...(s.voltageSwept ? [] : [`v${j}`]),
              ...(s.durationSwept ? [] : [`d${j}`]),
            ]),
          ],
  };
}

/**
 * The draft with a sheet's V0 and V1 (#168), as the wizard reads them: its
 * holding potential at V0, and the fixed steps its template's test pulse
 * takes (`PULSE_STEPS`) at V1. A value the sheet doesn't give stays.
 */
export function withVoltages(
  draft: BuilderDraft,
  read: SheetRead,
  template: Template | undefined,
): BuilderDraft {
  const { holding, pulse } = read.values;
  const pulses =
    template === undefined || template === "custom" ? [] : (PULSE_STEPS[template] ?? []);
  const set = draft.steps.flatMap((s, j) =>
    pulse !== undefined && pulses.includes(j) && !s.voltageSwept ? [j] : [],
  );
  // What the sheet gives isn't a template default.
  const cleared = [...(holding === undefined ? [] : ["holding"]), ...set.map((j) => `v${j}`)];
  return {
    ...draft,
    holding: holding === undefined ? draft.holding : shownVoltage(holding),
    steps: draft.steps.map((s, j) =>
      set.includes(j) ? { ...s, voltage: shownVoltage(pulse!) } : s,
    ),
    defaults: draft.defaults.filter((k) => !cleared.includes(k)),
  };
}

/** A measure's Normalize and Time resolution, as the template measuring it has them. */
export function measureDefaults(kind: MeasureKind): {
  normalized: boolean;
  time_resolution_ms: number;
} {
  const template = (Object.keys(TEMPLATES) as TemplateName[]).find((t) =>
    TEMPLATES[t].steps.some((s) => s.measure?.kind === kind),
  )!;
  const { normalized, time_resolution_ms } = TEMPLATES[template];
  return { normalized, time_resolution_ms };
}

/** Step `j` measures `kind`: Normalize and Time resolution go to that measure's defaults. */
export function setMeasure(
  draft: BuilderDraft,
  j: number,
  kind: MeasureKind | "none",
): BuilderDraft {
  const steps = draft.steps.map((s, i) => (i === j ? { ...s, measure: kind } : s));
  if (kind === "none") return { ...draft, steps, normalized: false };
  const defaults = measureDefaults(kind);
  return {
    ...draft,
    steps,
    normalized: defaults.normalized,
    resolution: shown(defaults.time_resolution_ms),
  };
}

/** A step after the last, at the holding potential for 100 ms. */
export function addStep(draft: BuilderDraft): BuilderDraft {
  const holding = parsed(draft.holding);
  const step: BuilderStep = {
    ...stepOf({ voltage_mV: holding ?? BLANK.holding_mV, duration_ms: 100, measure: null }),
  };
  return { ...draft, steps: [...draft.steps, step] };
}

/** Step `j` swapped with the one `by` (±1) from it. */
export function moveStep(draft: BuilderDraft, j: number, by: 1 | -1): BuilderDraft {
  const k = j + by;
  if (k < 0 || k >= draft.steps.length) return draft;
  const steps = [...draft.steps];
  [steps[j], steps[k]] = [steps[k], steps[j]];
  const defaults = renumbered(draft.defaults, (i) => (i === j ? k : i === k ? j : i));
  return { ...draft, steps, defaults };
}

export function removeStep(draft: BuilderDraft, j: number): BuilderDraft {
  if (draft.steps.length <= 1) return draft;
  const defaults = renumbered(draft.defaults, (i) => (i === j ? null : i > j ? i - 1 : i));
  return { ...draft, steps: draft.steps.filter((_, i) => i !== j), defaults };
}

const NOT_A_NUMBER = "Enter a number.";

/**
 * The protocol the draft makes, its points made from `measured`, its
 * sheet's, or `null` with an issue at each value that isn't a number yet;
 * paths under `at`, as the agent writes them for the protocol at that place
 * in the dataset. With them, what Interpolate makes of its settings, the key
 * its points are made from, and the points it shows.
 */
export function protocolOf(
  draft: BuilderDraft,
  measured: Point[],
  source: Source | null,
  at: string[] = ["protocols", "0"],
): {
  protocol: Protocol | null;
  issues: Issue[];
  read: InterpolationRead;
  shareRead: ShareRead;
  key: string;
  points: Point[];
} {
  const issues: Issue[] = [];
  const num = (text: string, ...path: string[]): number => {
    const x = parsed(text);
    if (x === null)
      issues.push({ path: [...at, ...path], message: NOT_A_NUMBER, severity: "error" });
    return x ?? 0;
  };
  const holding_mV = num(draft.holding, "holding_mV");
  const steps = draft.steps.map((s, j): Step => {
    const step = String(j);
    const voltage_mV = s.voltageSwept ? "swept" : num(s.voltage, "steps", step, "voltage_mV");
    const duration_ms = s.durationSwept ? "swept" : num(s.duration, "steps", step, "duration_ms");
    let measure: Measure | null = null;
    if (s.measure === "decay_time") {
      const from = num(s.from, "steps", step, "measure", "from") / 100;
      const to = num(s.to, "steps", step, "measure", "to") / 100;
      measure = { kind: "decay_time", from, to };
    } else if (s.measure !== "none") {
      measure = { kind: s.measure };
    }
    return { voltage_mV, duration_ms, measure };
  });
  const weight = num(draft.weight, "weight");
  const time_resolution_ms = num(draft.resolution, "time_resolution_ms");
  const read = readInterpolation(draft.interp, measured, draft.made);
  if (read.saved === null) {
    issues.push({
      path: [...at, "interpolation", "points_per_gap"],
      message: NOT_A_WHOLE_NUMBER,
      severity: "error",
    });
  }
  const shareRead = readShare(draft.share, draft.made, BLANK.validation_share);
  if (shareRead.saved === null) {
    issues.push({
      path: [...at, "validation_share"],
      message: NOT_A_WHOLE_NUMBER,
      severity: "error",
    });
  }
  const points = shownPoints(measured, draft.made);
  const protocol: Protocol = {
    name: draft.name,
    source,
    holding_mV,
    steps,
    normalized: draft.normalized,
    weight,
    time_resolution_ms,
    interpolation: read.saved ?? read.made,
    validation_share: shareRead.saved ?? shareRead.made,
    points,
  };
  return {
    protocol: issues.length > 0 ? null : protocol,
    issues,
    read,
    shareRead,
    key: keyOf(measured, read.made, shareRead.made),
    points,
  };
}

/**
 * The draft with the wizard's Protocols step edits over it (`Edits`, keyed
 * as `formOf` keys them), for the builder opened again on that protocol.
 */
export function withEdits(
  draft: BuilderDraft,
  edits: Record<string, string | boolean>,
): BuilderDraft {
  const text = (key: string, was: string) => {
    const typed = edits[key];
    return typeof typed === "string" ? typed : was;
  };
  const decay = draft.steps.findIndex((s) => s.measure === "decay_time");
  return {
    ...draft,
    // A value typed on the Protocols step is no longer a default.
    defaults: draft.defaults.filter((k) => typeof edits[k] !== "string"),
    holding: text("holding", draft.holding),
    steps: draft.steps.map((s, j) => ({
      ...s,
      voltage: text(`v${j}`, s.voltage),
      duration: text(`d${j}`, s.duration),
      from: j === decay ? text("from", s.from) : s.from,
      to: j === decay ? text("to", s.to) : s.to,
    })),
    normalized: typeof edits.normalized === "boolean" ? edits.normalized : draft.normalized,
    weight: text("weight", draft.weight),
    resolution: text("resolution", draft.resolution),
    share: text("share", draft.share),
    interp: {
      enabled: typeof edits.interp === "boolean" ? edits.interp : draft.interp.enabled,
      perGap: text("perGap", draft.interp.perGap),
      logX: typeof edits.logx === "boolean" ? edits.logx : draft.interp.logX,
    },
  };
}
