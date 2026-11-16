/**
 * A workbook's sheets as the Dataset wizard reads them (old ADR-0006): the
 * desktop reads the cells (`read_workbook`), and this works out which rows
 * and columns hold numbers, the template a sheet's name and columns suggest,
 * which column plays each of its roles, and the names to propose.
 *
 * Nothing here checks a value: the agent's `validate_dataset` does (ADR-0003).
 */
import type { TemplateName } from "../wire/templates.gen";
import type { Point, Protocol, Template, WorkbookSheet } from "../wire/types.gen";

/** What a column is to a template: its swept x, its values, their SD, and the voltages. */
export type Role = "x" | "y" | "sd" | "holding" | "pulse";

/** A role's column as the Sheets step shows it: its words, its token and its unit. */
export interface RoleSpec {
  role: Role;
  label: string;
  token: string;
  /** The unit its values are in; recovery's gap is in s or ms, which the user picks. */
  unit: "mV" | "ms" | "s|ms" | null;
}

const SD: RoleSpec = { role: "sd", label: "Std. deviation", token: "SD", unit: null };
const HOLDING: RoleSpec = { role: "holding", label: "Holding", token: "V0", unit: "mV" };

/** Each template's columns, in the order the old app's workbooks lay them out. */
export const ROLES: Record<TemplateName, RoleSpec[]> = {
  gv_activation: [
    { role: "x", label: "Voltage", token: "V", unit: "mV" },
    { role: "y", label: "Conductance", token: "G", unit: null },
    SD,
    HOLDING,
  ],
  steady_state_inactivation: [
    { role: "x", label: "Conditioning", token: "V", unit: "mV" },
    { role: "y", label: "Current", token: "G", unit: null },
    SD,
    HOLDING,
    { role: "pulse", label: "Test pulse", token: "V1", unit: "mV" },
  ],
  recovery: [
    { role: "x", label: "Gap length", token: "T", unit: "s|ms" },
    { role: "y", label: "Recovery", token: "G", unit: null },
    SD,
    HOLDING,
    { role: "pulse", label: "Pulses", token: "V1", unit: "mV" },
  ],
  decay_time: [
    { role: "x", label: "Voltage", token: "V", unit: "mV" },
    { role: "y", label: "Decay time", token: "T", unit: "ms" },
    { ...SD, unit: "ms" },
    HOLDING,
  ],
  time_to_peak: [
    { role: "x", label: "Voltage", token: "V", unit: "mV" },
    { role: "y", label: "Time to peak", token: "T", unit: "ms" },
    { ...SD, unit: "ms" },
    HOLDING,
  ],
};

/** The words for a template, as the Sheets step's menu has them. */
export const TEMPLATE_LABELS: Record<TemplateName, string> = {
  gv_activation: "G/V activation",
  steady_state_inactivation: "Steady-state inactivation",
  recovery: "Recovery from inactivation",
  decay_time: "Decay time",
  time_to_peak: "Time to peak",
};

/** A column with a number in it: its header, and its number in each data row. */
export interface Column {
  /** Its header's text, or its letter without one. */
  name: string;
  numbers: (number | null)[];
}

export interface SheetRead {
  name: string;
  /** Its columns with a number in them, left to right. */
  columns: Column[];
  /** How many rows hold numbers. */
  rows: number;
  /** It has no number to read, so it can't be used. */
  skipped: boolean;
  /** The template its name or columns suggest; `null` when they don't say which. */
  template: TemplateName | null;
  /**
   * Its columns are the template's, by their tokens. A name for an
   * activation τ is never matched: Decay or rise time is only its closest (#166).
   */
  matched: boolean;
  /** Its name is a rise time's ("rise", "trise", "10-90"): its window starts at 10 → 90 %. */
  rise: boolean;
  /** Each role's column (an index into `columns`), by name. */
  roles: Partial<Record<Role, number>>;
  /** The voltages its holding and test pulse columns give. */
  values: { holding?: number; pulse?: number };
  /** The x column's largest value. */
  largestX: number | null;
  /** Recovery gaps read as seconds, since none is above 10. */
  seconds: boolean;
}

/** The largest recovery gap that suggests seconds: 10 s, where 10 ms is too short to recover. */
const SECONDS_UP_TO = 10;

export function readSheet(sheet: WorkbookSheet): SheetRead {
  const width = Math.max(0, ...sheet.numbers.map((r) => r.length));
  const cellNumber = (r: number, c: number): number | null =>
    sheet.numbers[r]?.[c] ?? textNumber(sheet.texts[r]?.[c] ?? null);
  const rowHasNumber = (r: number) =>
    Array.from({ length: width }, (_, c) => cellNumber(r, c)).some((x) => x !== null);
  const first = sheet.numbers.findIndex((_, r) => rowHasNumber(r));
  if (first < 0) return skipped(sheet.name);

  // The header is the row just above the first number, when it has words.
  const above = first > 0 ? (sheet.texts[first - 1] ?? []) : [];
  const header = above.some((t) => t !== null && t.trim() !== "") ? above : [];
  const dataRows = sheet.numbers.map((_, r) => r).filter((r) => r >= first && rowHasNumber(r));
  const columns: Column[] = [];
  for (let c = 0; c < width; c++) {
    const numbers = dataRows.map((r) => cellNumber(r, c));
    if (numbers.every((x) => x === null)) continue;
    columns.push({ name: header[c]?.trim() || letter(c), numbers });
  }

  const tokens = columns.map((c) => c.name.toLowerCase());
  const has = (...t: string[]) => t.every((x) => tokens.includes(x.toLowerCase()));
  const named = byName(sheet.name);
  const template = named.template ?? byColumns(has);
  const matched =
    template !== null &&
    !named.activationTau &&
    ROLES[template].filter((s) => s.role === "x" || s.role === "y").every((s) => has(s.token));
  const roles = template === null ? {} : rolesByName(template, columns);
  const first_ = (role: Role) => {
    const at = roles[role];
    return at === undefined
      ? undefined
      : (columns[at].numbers.find((x) => x !== null) ?? undefined);
  };
  const values: SheetRead["values"] = {};
  const holding = first_("holding");
  const pulse = first_("pulse");
  if (holding !== undefined) values.holding = holding;
  if (pulse !== undefined) values.pulse = pulse;
  const xs = roles.x === undefined ? [] : columns[roles.x].numbers.filter((x) => x !== null);
  const largestX = xs.length === 0 ? null : Math.max(...xs);
  return {
    name: sheet.name,
    columns,
    rows: dataRows.length,
    skipped: false,
    template,
    matched,
    rise: named.rise,
    roles,
    values,
    largestX,
    seconds: template === "recovery" && largestX !== null && largestX <= SECONDS_UP_TO,
  };
}

function skipped(name: string): SheetRead {
  return {
    name,
    columns: [],
    rows: 0,
    skipped: true,
    template: null,
    matched: false,
    rise: false,
    roles: {},
    values: {},
    largestX: null,
    seconds: false,
  };
}

/** A text cell that is a plain number, as Excel keeps one typed with a leading apostrophe. */
function textNumber(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim().replace(/^−/, "-");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

function letter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * The template a sheet's name suggests, as the old app guessed it, and a few
 * words more. A name for a rise is a decay time's whose fractions run up; one
 * for an activation τ ("tau" and an "act" that isn't "inact" or "deact") only
 * suggests it, since a τ fitted to a rising current isn't a decay time (#166).
 */
function byName(name: string): {
  template: TemplateName | null;
  rise: boolean;
  activationTau: boolean;
} {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const as = (template: TemplateName | null) => ({ template, rise: false, activationTau: false });
  const activation = /act/.test(n.replace(/inact|deact/g, ""));
  if (/tau/.test(n) && activation) return { ...as("decay_time"), activationTau: true };
  if (/rise|1090/.test(n)) return { ...as("decay_time"), rise: true };
  if (/tau|decay/.test(n)) return as("decay_time");
  if (/ttp|timetopeak|^peak/.test(n)) return as("time_to_peak");
  if (/^rec|recovery/.test(n)) return as("recovery");
  if (/^ssi|inact/.test(n)) return as("steady_state_inactivation");
  if (/^gv|activ/.test(n)) return as("gv_activation");
  return as(null);
}

/** The template a sheet's tokens say, where only one has them. */
function byColumns(has: (...t: string[]) => boolean): TemplateName | null {
  if (has("T", "G")) return "recovery";
  if (has("V", "G", "V1")) return "steady_state_inactivation";
  if (has("V", "G")) return "gv_activation";
  return null;
}

/** Words each role's column goes by, beyond its token; a whole word scores above a prefix. */
const SYNONYMS: Record<string, string[]> = {
  V: ["vm", "voltage", "vtest", "vcond", "vstep", "potential", "mv"],
  T: [
    "time",
    "gap",
    "interval",
    "delay",
    "dt",
    "tau",
    "decay",
    "rise",
    "trise",
    "risetime",
    "ttp",
    "tpeak",
    "timetopeak",
  ],
  G: ["conductance", "gnorm", "current", "i", "inorm", "fraction", "frac", "recovery", "ratio"],
  SD: ["std", "stdev", "stddev", "err", "error", "sem", "se"],
  V0: ["vhold", "vh", "hold", "holding"],
  V1: ["vpulse", "pulse", "pulses", "vtest", "test"],
};

/** How well a column's header suits a role's token: 0 not at all, up to 3 for the token itself. */
function score(header: string, token: string): number {
  const h = header
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (h === token.toLowerCase()) return 3;
  const words = SYNONYMS[token] ?? [];
  if (words.includes(h)) return 2;
  if (words.some((w) => w.length > 1 && h.startsWith(w))) return 1;
  return 0;
}

/** Each of a template's roles, the column whose name suits it best, no column twice. */
export function rolesByName(
  template: TemplateName,
  columns: Column[],
): Partial<Record<Role, number>> {
  const roles: Partial<Record<Role, number>> = {};
  const used = new Set<number>();
  for (const spec of ROLES[template]) {
    let best = -1;
    let bestScore = 0;
    columns.forEach((c, i) => {
      const s = used.has(i) ? 0 : score(c.name, spec.token);
      if (s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best >= 0) {
      roles[spec.role] = best;
      used.add(best);
    }
  }
  return roles;
}

/** `x` s in ms, by moving the decimal point, so 0.007 s is 7 ms exactly. */
function msOf(x: number): number {
  const [mantissa, exponent] = x.toExponential().split("e");
  return Number(`${mantissa}e${Number(exponent) + 3}`);
}

/** A sheet's points by its roles' columns: each row with an x and a value, as its cells hold them. */
export function pointsOf(
  read: SheetRead,
  roles: Partial<Record<Role, number>>,
  seconds: boolean,
): Point[] {
  const { x, y, sd } = roles;
  if (x === undefined || y === undefined) return [];
  const column = (i: number | undefined) => (i === undefined ? [] : read.columns[i].numbers);
  const xs = column(x);
  const ys = column(y);
  const sds = column(sd);
  const points: Point[] = [];
  xs.forEach((at, r) => {
    const value = ys[r];
    if (at === null || value === null) return;
    points.push({
      x: seconds ? msOf(at) : at,
      value,
      sd: sds[r] ?? null,
      validation: false,
      interpolated: false,
    });
  });
  return points;
}

/**
 * A saved protocol's measured points as a sheet the Protocol builder maps
 * (Edit protocol…): named for its Source, its columns x, y and SD, as the
 * builder names a protocol it made (#144). Its workbook isn't kept, so this
 * is all there is to map until Change… reads another.
 */
export function savedSheet(protocol: Pick<Protocol, "name" | "source" | "points">): SheetRead {
  const measured = protocol.points.filter((p) => !p.interpolated);
  const columns: Column[] = [
    { name: "x", numbers: measured.map((p) => p.x) },
    { name: "y", numbers: measured.map((p) => p.value) },
  ];
  if (measured.some((p) => p.sd !== null)) {
    columns.push({ name: "SD", numbers: measured.map((p) => p.sd) });
  }
  return {
    name: protocol.source?.sheet ?? protocol.name,
    columns,
    rows: measured.length,
    skipped: false,
    template: null,
    matched: false,
    rise: false,
    roles: { x: 0, y: 1, ...(columns.length > 2 ? { sd: 2 } : {}) },
    values: {},
    largestX: measured.length === 0 ? null : Math.max(...measured.map((p) => p.x)),
    seconds: false,
  };
}

/**
 * The sheet the Protocol builder's Choose… and Change… open on (#168): the
 * one named in the protocol's Source, else the first the wizard matches to
 * its template, else the workbook's first.
 */
export function openingSheet(
  sheets: SheetRead[],
  source: string | undefined,
  template: Template | undefined,
): SheetRead {
  return (
    sheets.find((s) => s.name === source) ??
    sheets.find((s) => template !== undefined && s.template === template) ??
    sheets[0]
  );
}

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A protocol name for each sheet: its name within the rules, unique ignoring case (ADR-0003). */
export function protocolNames(sheets: string[]): string[] {
  const taken = new Set<string>();
  return sheets.map((sheet) => {
    let base = sheet
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    if (base === "") base = "protocol";
    if (DEVICE.test(base)) base = `${base}_`;
    const name = unique(base, 32, taken);
    taken.add(name.toLowerCase());
    return name;
  });
}

/** `base`, or with `-2`, `-3`… when another has it ignoring case, within `max` characters. */
export function unique(base: string, max: number, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = base.slice(0, max - suffix.length) + suffix;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A dataset name from the workbook's file name: `herg_wt_2026.xlsx` is `herg-wt-2026`. */
export function datasetName(file: string): string {
  const name = file
    .replace(/\.xlsx$/i, "")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return name === "" ? "dataset" : name;
}
