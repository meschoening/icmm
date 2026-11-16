/**
 * The Dataset wizard's draft: a choice for each sheet on the Sheets step,
 * then a form for each protocol on the Protocols step, started from its
 * template's preset (`templates.gen.ts`) and the voltages its sheet gives,
 * and the manifest content those make for `validate_dataset` and
 * `save_dataset` (ADR-0003).
 *
 * The form holds what the user typed, so a value that isn't a number yet
 * stays put; only the content parses it. Every other check is the agent's.
 * Each protocol's points are what this computer's engine made of its sheet's
 * (`points.ts`): interpolated as set, its split proposed (ADR-0011).
 */
import { TEMPLATES, type TemplateName, type TemplatePreset } from "../wire/templates.gen";
import type {
  DatasetContent,
  Issue,
  Measure,
  Point,
  Protocol,
  Step,
  Template,
} from "../wire/types.gen";
import type { BuilderDraft } from "./builder/model";
import {
  formOfInterpolation,
  keyOf,
  percentOf,
  pickedOf,
  readInterpolation,
  readShare,
  shownPoints,
  type InterpolationForm,
  type InterpolationRead,
  type Made,
  type ShareRead,
} from "./points";
import { pointsOf, protocolNames, type Role, type SheetRead } from "./sheets";

/** What the Sheets step chose for a sheet. */
export interface Choice {
  sheet: string;
  use: boolean;
  /** `none` until a template is picked; `custom` waits for its steps from the Protocol builder. */
  template: TemplateName | "none" | "custom";
  /** The protocol name, as typed. */
  name: string;
  roles: Partial<Record<Role, number>>;
  /** Recovery gaps in seconds rather than ms. */
  seconds: boolean;
  /** Its columns were mapped by name to the closest template, which the user took. */
  mapped?: boolean;
  /** Its sheet is named for a rise: as a decay time, its window starts at 10 → 90 % (#166). */
  rise?: boolean;
  /**
   * What the Protocol builder handed back for it, unsaved (#144), and the
   * template the engine found its steps to have; kept while another template
   * is chosen, for Custom again.
   */
  built?: Built;
}

export interface Built {
  draft: BuilderDraft;
  template: Template;
}

export function choicesOf(reads: SheetRead[]): Choice[] {
  const names = protocolNames(reads.map((r) => r.name));
  return reads.map((r, i) => ({
    sheet: r.name,
    use: !r.skipped,
    template: r.matched && r.template !== null ? r.template : "none",
    name: names[i],
    roles: r.roles,
    seconds: r.seconds,
    ...(r.rise ? { rise: true } : {}),
  }));
}

/** What a used sheet still needs before it can be a protocol. */
export interface Need {
  sheet: string;
  needs: "template" | "steps";
}

export interface SheetsStatus {
  matched: number;
  needs: Need[];
  leftOut: number;
}

export function sheetsStatus(reads: SheetRead[], choices: Choice[]): SheetsStatus {
  const status: SheetsStatus = { matched: 0, needs: [], leftOut: 0 };
  choices.forEach((c, i) => {
    if (!c.use || reads[i].skipped) status.leftOut++;
    else if (c.template === "none") status.needs.push({ sheet: c.sheet, needs: "template" });
    else if (c.template === "custom" && c.built === undefined) {
      status.needs.push({ sheet: c.sheet, needs: "steps" });
    } else status.matched++;
  });
  return status;
}

/**
 * The Protocols step's edits to one protocol, by field: text as typed, or a
 * switch. Interpolate's are `interp`, `perGap` and `logx`; the validation
 * share's, in %, is `share`.
 */
export type Edits = Record<string, string | boolean>;

/** A value on the Protocols step: what it reads, and whether its template gave it. */
export interface Field {
  key: string;
  value: string;
  /** From the template, not the workbook, and not edited. */
  default: boolean;
}

export interface StepForm {
  /** `null` where the step is swept. */
  voltage: Field | null;
  duration: Field | null;
  measure: Measure["kind"] | null;
}

export interface ProtocolForm {
  sheet: string;
  name: string;
  /** Its template, or `custom` for steps the Protocol builder made that match none. */
  template: Template;
  /** The steps and settings it started from, to draw with while a field isn't a number. */
  base: TemplatePreset;
  holding: Field;
  steps: StepForm[];
  /** A decay time's window, in percent of the peak. */
  window: { from: Field; to: Field } | null;
  normalized: boolean;
  weight: Field;
  resolution: Field;
  /** Interpolate as set: a template starts it off, and a Recovery template on a log x-axis. */
  interp: InterpolationForm;
  /** What Interpolate's settings make, over its measured points. */
  read: InterpolationRead;
  /** Its validation share in %, as typed (#166). */
  share: string;
  /** What that share proposes at, and saves. */
  shareRead: ShareRead;
  /** Its validation points picked by hand: a redraw asks first (#166). */
  picked: number;
  /** Its sheet's points, as read. */
  measured: Point[];
  /** What its points are made from (`keyOf`): its made points are current while this is theirs. */
  key: string;
  /** Its points as made, with their marks; its measured points until they are. */
  points: Point[];
}

/** A number as the wizard shows it: shortest round trip, true minus. */
export function shown(x: number): string {
  return x < 0 ? `−${String(-x)}` : String(x);
}

/** A voltage as the wizard and the builder show it: signed, "+40", as the facts say it (#168). */
export function shownVoltage(v: number): string {
  return v > 0 ? `+${shown(v)}` : shown(v);
}

/** A typed number, with either minus sign; `null` if it isn't one. */
export function parsed(text: string): number | null {
  const t = text.trim().replace(/^−/, "-");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

/** A rise time's window, as a sheet named for a rise starts it (#166): 10 → 90 % of the peak. */
const RISE_WINDOW: Measure = { kind: "decay_time", from: 0.1, to: 0.9 };

/** The voltage a sheet's test pulse column gives each fixed step, by template. */
export const PULSE_STEPS: Partial<Record<TemplateName, number[]>> = {
  steady_state_inactivation: [1],
  recovery: [0, 2],
};

/** Every used sheet with a template, in sheet order, keyed by sheet name in `edits`. */
export function formsOf(
  reads: SheetRead[],
  choices: Choice[],
  edits: Record<string, Edits>,
  made: Record<string, Made> = {},
): ProtocolForm[] {
  return choices.flatMap((c, i) =>
    usable(reads[i], c) ? [formOf(reads[i], c, edits[c.sheet] ?? {}, made[c.sheet])] : [],
  );
}

/** The edits a change to Interpolate's settings makes. */
export function interpEdits(change: Partial<InterpolationForm>): Edits {
  const edits: Edits = {};
  if (change.enabled !== undefined) edits.interp = change.enabled;
  if (change.perGap !== undefined) edits.perGap = change.perGap;
  if (change.logX !== undefined) edits.logx = change.logX;
  return edits;
}

/** Interpolate's settings: the edits over where its template or the builder started them. */
function interpOf(start: InterpolationForm, edits: Edits): InterpolationForm {
  const { interp, perGap, logx } = edits;
  return {
    enabled: typeof interp === "boolean" ? interp : start.enabled,
    perGap: typeof perGap === "string" ? perGap : start.perGap,
    logX: typeof logx === "boolean" ? logx : start.logX,
  };
}

/** A form's points: its sheet's, made as Interpolate and its validation share set them. */
function pointsPart(
  measured: Point[],
  interp: InterpolationForm,
  share: string,
  start: number,
  made: Made | undefined,
) {
  const read = readInterpolation(interp, measured, made);
  const shareRead = readShare(share, made, start);
  const key = keyOf(measured, read.made, shareRead.made);
  const points = shownPoints(measured, made);
  const picked = made?.key === key ? pickedOf(made, points) : 0;
  return { interp, read, share, shareRead, measured, key, points, picked };
}

/** The share as typed, else where its template or the builder started it. */
function shareOf(start: number, edits: Edits): string {
  return typeof edits.share === "string" ? edits.share : percentOf(start);
}

function usable(read: SheetRead, c: Choice): boolean {
  if (!c.use || read.skipped || c.template === "none") return false;
  return c.template !== "custom" || c.built !== undefined;
}

export function formOf(read: SheetRead, choice: Choice, edits: Edits, made?: Made): ProtocolForm {
  if (choice.template === "custom") return builtFormOf(read, choice, choice.built!, edits, made);
  const template = choice.template as TemplateName;
  const preset = TEMPLATES[template];
  const field = (key: string, from: number, fromSheet: boolean, show = shown): Field => {
    const typed = edits[key];
    return typeof typed === "string"
      ? { key, value: typed, default: false }
      : { key, value: show(from), default: !fromSheet };
  };
  const pulse = read.values.pulse;
  const pulseSteps = PULSE_STEPS[template] ?? [];
  const steps = preset.steps.map((s, j): StepForm => {
    const fromPulse = pulse !== undefined && pulseSteps.includes(j);
    return {
      voltage:
        s.voltage_mV === "swept"
          ? null
          : field(`v${j}`, fromPulse ? pulse : s.voltage_mV, fromPulse, shownVoltage),
      duration: s.duration_ms === "swept" ? null : field(`d${j}`, s.duration_ms, false),
      measure: s.measure?.kind ?? null,
    };
  });
  const measured =
    choice.rise && template === "decay_time"
      ? RISE_WINDOW
      : preset.steps.find((s) => s.measure !== null)?.measure;
  const percent = (key: string, fraction: number): Field => {
    const typed = edits[key];
    return typeof typed === "string"
      ? { key, value: typed, default: false }
      : { key, value: shown(Number((fraction * 100).toPrecision(12))), default: false };
  };
  const holding = read.values.holding;
  const normalized = edits.normalized;
  return {
    sheet: choice.sheet,
    name: choice.name,
    template,
    base: preset,
    holding: field("holding", holding ?? preset.holding_mV, holding !== undefined, shownVoltage),
    steps,
    window:
      measured?.kind === "decay_time"
        ? { from: percent("from", measured.from), to: percent("to", measured.to) }
        : null,
    normalized: typeof normalized === "boolean" ? normalized : preset.normalized,
    weight: field("weight", preset.weight, true),
    resolution: field("resolution", preset.time_resolution_ms, true),
    ...pointsPart(
      pointsOf(read, choice.roles, choice.seconds),
      interpOf(formOfInterpolation(preset.interpolation), edits),
      shareOf(preset.validation_share, edits),
      preset.validation_share,
      made,
    ),
  };
}

/**
 * A protocol the Protocol builder made: its values are the user's, but for
 * those a template's card filled and nobody has typed since (#164).
 */
function builtFormOf(
  read: SheetRead,
  choice: Choice,
  built: Built,
  edits: Edits,
  made: Made | undefined,
): ProtocolForm {
  const d = built.draft;
  const field = (key: string, text: string): Field => {
    const typed = edits[key];
    return typeof typed === "string"
      ? { key, value: typed, default: false }
      : { key, value: text, default: d.defaults.includes(key) };
  };
  const decay = d.steps.find((s) => s.measure === "decay_time");
  const normalized = edits.normalized;
  const number = (text: string) => parsed(text) ?? 0;
  const base: TemplatePreset = {
    holding_mV: number(d.holding),
    steps: d.steps.map((s) => ({
      voltage_mV: s.voltageSwept ? "swept" : number(s.voltage),
      duration_ms: s.durationSwept ? "swept" : number(s.duration),
      measure:
        s.measure === "none"
          ? null
          : s.measure === "decay_time"
            ? { kind: "decay_time", from: number(s.from) / 100, to: number(s.to) / 100 }
            : { kind: s.measure },
    })),
    normalized: d.normalized,
    weight: number(d.weight),
    time_resolution_ms: number(d.resolution),
    interpolation: { enabled: false, points_per_gap: 1, log_x: false },
    validation_share: (parsed(d.share) ?? 20) / 100,
  };
  return {
    sheet: choice.sheet,
    name: choice.name,
    template: built.template,
    base,
    holding: field("holding", d.holding),
    steps: d.steps.map((s, j) => ({
      voltage: s.voltageSwept ? null : field(`v${j}`, s.voltage),
      duration: s.durationSwept ? null : field(`d${j}`, s.duration),
      measure: s.measure === "none" ? null : s.measure,
    })),
    window: decay ? { from: field("from", decay.from), to: field("to", decay.to) } : null,
    normalized: typeof normalized === "boolean" ? normalized : d.normalized,
    weight: field("weight", d.weight),
    resolution: field("resolution", d.resolution),
    ...pointsPart(
      pointsOf(read, d.roles, choice.seconds && d.steps.some((s) => s.durationSwept)),
      interpOf(d.interp, edits),
      typeof edits.share === "string" ? edits.share : d.share,
      d.made?.share ?? base.validation_share,
      made,
    ),
  };
}

/** Which way a form's decay time runs, by its window as typed: a rise runs upward (#164). */
export function formDirection(f: Pick<ProtocolForm, "window">): "decay" | "rise" {
  const from = f.window === null ? null : parsed(f.window.from.value);
  const to = f.window === null ? null : parsed(f.window.to.value);
  return from !== null && to !== null && from < to ? "rise" : "decay";
}

/** The values in a form its template gave, in the order the form shows them. */
export function defaultsOf(form: ProtocolForm): Field[] {
  const fields = [form.holding, ...form.steps.flatMap((s) => [s.voltage, s.duration])];
  return fields.filter((f): f is Field => f !== null && f.default);
}

const NOT_A_NUMBER = "Enter a number.";
export const NOT_A_WHOLE_NUMBER = "Enter a whole number.";

/**
 * The manifest content the forms make, or `null` with an issue at each value
 * that isn't a number yet; paths as the agent writes them.
 */
export function contentOf(
  name: string,
  workbook: string,
  forms: ProtocolForm[],
): { content: DatasetContent | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const protocols = forms.map((f, i): Protocol => {
    const at = (...rest: string[]) => ["protocols", String(i), ...rest];
    const num = (field: Field, path: string[]): number => {
      const x = parsed(field.value);
      if (x === null) issues.push({ path, message: NOT_A_NUMBER, severity: "error" });
      return x ?? 0;
    };
    const holding_mV = num(f.holding, at("holding_mV"));
    const steps = f.steps.map((s, j): Step => {
      const step = (...rest: string[]) => at("steps", String(j), ...rest);
      const voltage_mV = s.voltage === null ? "swept" : num(s.voltage, step("voltage_mV"));
      const duration_ms = s.duration === null ? "swept" : num(s.duration, step("duration_ms"));
      let measure: Measure | null = null;
      if (s.measure === "decay_time" && f.window !== null) {
        const from = num(f.window.from, step("measure", "from")) / 100;
        const to = num(f.window.to, step("measure", "to")) / 100;
        measure = { kind: "decay_time", from, to };
      } else if (s.measure !== null) {
        measure = { kind: s.measure } as Measure;
      }
      return { voltage_mV, duration_ms, measure };
    });
    if (f.read.saved === null) {
      issues.push({
        path: at("interpolation", "points_per_gap"),
        message: NOT_A_WHOLE_NUMBER,
        severity: "error",
      });
    }
    if (f.shareRead.saved === null) {
      issues.push({ path: at("validation_share"), message: NOT_A_WHOLE_NUMBER, severity: "error" });
    }
    return {
      name: f.name,
      source: { workbook, sheet: f.sheet },
      holding_mV,
      steps,
      normalized: f.normalized,
      weight: num(f.weight, at("weight")),
      time_resolution_ms: num(f.resolution, at("time_resolution_ms")),
      interpolation: f.read.saved ?? f.read.made,
      validation_share: f.shareRead.saved ?? f.shareRead.made,
      points: f.points,
    };
  });
  return { content: issues.length > 0 ? null : { name, protocols }, issues };
}

/** The field an issue's path names: a protocol's (by index) and its key, or the dataset's. */
export function fieldAt(path: string[]): { protocol: number | null; key: string } {
  if (path[0] !== "protocols" || path.length < 3) return { protocol: null, key: path[0] ?? "" };
  const protocol = Number(path[1]);
  const [key, j, sub, last] = path.slice(2);
  if (key === "holding_mV") return { protocol, key: "holding" };
  if (key === "time_resolution_ms") return { protocol, key: "resolution" };
  if (key === "validation_share") return { protocol, key: "share" };
  if (key === "interpolation")
    return { protocol, key: j === "points_per_gap" ? "perGap" : "interp" };
  if (key === "points" && sub === "value") return { protocol, key: `point${j}` };
  if (key === "steps" && j !== undefined) {
    if (sub === "voltage_mV") return { protocol, key: `v${j}` };
    if (sub === "duration_ms") return { protocol, key: `d${j}` };
    if (sub === "measure" && (last === "from" || last === "to")) return { protocol, key: last };
  }
  return { protocol, key };
}
