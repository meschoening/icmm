/**
 * The Config builder's fields as typed (LaptopConfigBuilder), and what they
 * make: the config `validate_config` checks and a save keeps, how many
 * changes they make to the config as saved, and, after another computer's
 * save, what Reload keeps and what each changed field says (section 1's
 * note and marks, #164).
 *
 * The engine is the only checker (#178): a field that isn't a number is sent
 * as a value outside every range, so the engine's sentence for its range is
 * what shows under it. The builder says only what the wire can't carry: an
 * entry of Specific IDs that isn't an id, a sigmoid bound that isn't a
 * number, and a whole number past what the wire counts.
 */
import { minus } from "../../datasets/format";
import type { FieldMark } from "../../setup/form";
import type { Config, Issue, SpecificId } from "../../wire/types.gen";
import { exampleIdsWords, idWords, whole } from "../words";

export type Which = "sample" | "ids" | "all";

export interface ConfigDraft {
  name: string;
  /** The dataset chosen, by id; `""` while none is. */
  dataset: string;
  states: string;
  which: Which;
  sample: string;
  ids: string;
  starts: string;
  population: string;
  evaluations: string;
  /** Blank draws one at submit. */
  seed: string;
  log: string;
  sobol: boolean;
  rateMin: string;
  rateMax: string;
  sigmoidMin: string;
  sigmoidMax: string;
}

/** Each field, in the page's order. */
export type Field = keyof ConfigDraft;
export const FIELDS: Field[] = [
  "name",
  "dataset",
  "states",
  "which",
  "sample",
  "ids",
  "starts",
  "population",
  "evaluations",
  "seed",
  "log",
  "sobol",
  "rateMin",
  "rateMax",
  "sigmoidMin",
  "sigmoidMax",
];

/** The fields Advanced holds, which open it by themselves with a check or a note. */
export const IN_ADVANCED: Field[] = [
  "seed",
  "log",
  "sobol",
  "rateMin",
  "rateMax",
  "sigmoidMin",
  "sigmoidMax",
];

/** A new config's fields (#178, #45): no name or number of states yet, and a Random sample of 5. */
export function newDraft(dataset: string): ConfigDraft {
  return {
    name: "",
    dataset,
    states: "",
    which: "sample",
    sample: "5",
    ids: "",
    starts: "100",
    population: "50",
    evaluations: whole(1_000_000),
    seed: "",
    log: "200",
    sobol: false,
    rateMin: minus("-10"),
    rateMax: "10",
    sigmoidMin: minus("-80"),
    sigmoidMax: "60",
  };
}

/** The fields that hold a number. */
export type Numeric = Exclude<Field, "name" | "dataset" | "which" | "ids" | "sobol">;

const BOUNDS_FIELDS: Numeric[] = ["rateMin", "rateMax", "sigmoidMin", "sigmoidMax"];

/**
 * A number as a saved config's field shows it, with a true minus: grouped,
 * but for the number of states, the bounds, and the seed, which reads as a
 * run's page writes it so it types back (#45).
 */
function shown(field: Numeric, n: number): string {
  const plain = field === "states" || field === "seed" || BOUNDS_FIELDS.includes(field);
  return minus(plain ? String(n) : whole(n));
}

/** A saved config's fields, as the builder shows them. */
export function draftOf(config: Config): ConfigDraft {
  const { topology, search, bounds } = config;
  const which = topology.which;
  return {
    name: config.name,
    dataset: config.dataset_id,
    states: topology.num_states === null ? "" : shown("states", topology.num_states),
    which: which.kind,
    sample: which.kind === "sample" ? shown("sample", which.count) : "5",
    ids: which.kind === "ids" ? idsText(which.ids) : "",
    starts: shown("starts", search.starts_per_topology),
    population: shown("population", search.population),
    evaluations: shown("evaluations", search.evaluation_budget),
    seed: search.search_seed === null ? "" : shown("seed", search.search_seed),
    log: shown("log", search.log_every_generations),
    sobol: search.sobol_start_points,
    rateMin: shown("rateMin", bounds.rate_min),
    rateMax: shown("rateMax", bounds.rate_max),
    sigmoidMin: shown("sigmoidMin", bounds.sigmoid_min_mV),
    sigmoidMax: shown("sigmoidMax", bounds.sigmoid_max_mV),
  };
}

/** Specific IDs as the field writes them: "T1991, T1408.0". */
export const idsText = (ids: SpecificId[]) => ids.map(idWords).join(", ");

/** The largest whole number the wire carries (2⁵³ − 1). */
export const MAX_WIRE_INT = Number.MAX_SAFE_INTEGER;

/** What the builder says of a whole number past what the wire carries. */
export const PAST_WIRE = `ICMM counts up to ${whole(MAX_WIRE_INT)}.`;

/** A whole number as typed, its thousands commas allowed: the number, or why it isn't one. */
export function wholeOf(text: string): number | "not" | "past" {
  const t = text.trim().replace(/[,\s]/g, "").replace(/^[−-]/, "-");
  if (!/^-?\d+$/.test(t)) return "not";
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : "past";
}

/** A number as typed, true minus or hyphen: the number, or `null` while it isn't one. */
export function numberOf(text: string): number | null {
  const t = text.trim().replace(/^[−-]/, "-");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

/**
 * A number field's text once it's left (CF18): as a saved config's shows,
 * when it's a number; as typed when it isn't, so its check is about what
 * was typed.
 */
export function tidied(field: Numeric, text: string): string {
  const read = (t: string) => (BOUNDS_FIELDS.includes(field) ? numberOf(t) : wholeOf(t));
  const n = read(text);
  if (typeof n !== "number") return text;
  // Never into a form the field doesn't read, such as 1e-7.
  const saved = shown(field, n);
  return read(saved) === n ? saved : text;
}

/** The number of states as Specific IDs are kept by: 011 is 11's. */
export function statesKey(text: string): string {
  const n = wholeOf(text);
  return typeof n === "number" ? String(n) : text.trim();
}

/** An entry of Specific IDs: `1991`, `T1991`, `1991.6` or `T1991.6`. */
const ID = /^[Tt]?(\d+)(?:\.(\d+))?$/;

/** Each entry of Specific IDs as written, separated by commas or spaces, and the id it names. */
export function idEntries(text: string): { written: string; id: SpecificId | null }[] {
  return text
    .split(/[\s,]+/)
    .filter((t) => t !== "")
    .map((written) => {
      const m = written.match(ID);
      const graph = m === null ? NaN : Number(m[1]);
      const open = m?.[2] === undefined ? null : Number(m[2]);
      const ok = Number.isSafeInteger(graph) && (open === null || Number.isSafeInteger(open));
      return { written, id: ok ? { graph, open_state: open } : null };
    });
}

/** What the builder says itself, under a field: what the wire can't carry. */
interface Said {
  field: Field;
  message: string;
  /** For Specific IDs, the entry it's about, by where it was written. */
  at?: number;
}

/** The fields as the config the engine checks, and what the builder says about them itself. */
export interface Wire {
  config: Config;
  said: Said[];
  /** The engine's paths whose issues the builder's own sentences replace. */
  replaced: string[][];
  /** For each id sent, the entry it came from, by where it was written. */
  entries: number[];
  /** How many entries Specific IDs has, ids or not. */
  written: number;
}

/**
 * The config the fields make. A whole-number field that isn't one is sent
 * as a value outside its range (0, or −1 where 0 is in it), so the engine
 * checks it and says its range; one past what the wire carries is the
 * builder's to say. Blank fields a new config starts without are sent as
 * their absence: no number of states, no search seed.
 */
export function wireOf(d: ConfigDraft): Wire {
  const said: Said[] = [];
  const replaced: string[][] = [];
  const int = (field: Field, path: string[], text: string, outside: number) => {
    const n = wholeOf(text);
    if (n === "past") {
      said.push({ field, message: PAST_WIRE });
      replaced.push(path);
      return outside;
    }
    return n === "not" ? outside : n;
  };
  const states =
    d.states.trim() === "" ? null : int("states", ["topology", "num_states"], d.states, 0);
  const entries = idEntries(d.ids);
  const ids: SpecificId[] = [];
  const from: number[] = [];
  // Its examples are the number of states' own (CF10).
  const write = `Write ${exampleIdsWords(states)}.`;
  entries.forEach((e, at) => {
    if (e.id === null) {
      said.push({ field: "ids", message: `${e.written} isn’t an id. ${write}`, at });
    } else {
      ids.push(e.id);
      from.push(at);
    }
  });
  // Entries none of which is an id are said as such, not as an empty list.
  if (entries.length > 0 && ids.length === 0) replaced.push(["topology", "which", "ids"]);
  const which: Config["topology"]["which"] =
    d.which === "all"
      ? { kind: "all" }
      : d.which === "sample"
        ? { kind: "sample", count: int("sample", ["topology", "which", "count"], d.sample, 0) }
        : { kind: "ids", ids };
  const seedText = d.seed.trim();
  const seed = seedText === "" ? null : int("seed", ["search", "search_seed"], seedText, -1);
  // A rate bound that isn't a number is sent past the engine's rail, which says it.
  const rate = (text: string) => numberOf(text) ?? Number.MAX_VALUE;
  const sigmoid = (field: "sigmoidMin" | "sigmoidMax", text: string, fallback: number) => {
    const x = numberOf(text);
    if (x !== null) return x;
    said.push({ field, message: `Write a number of mV, such as ${minus(String(fallback))}.` });
    // Compared with a bound that isn't one, the order means nothing.
    replaced.push(["bounds", "sigmoid_min_mV"]);
    return fallback;
  };
  return {
    config: {
      format: 1,
      name: d.name,
      dataset_id: d.dataset,
      topology: { num_states: states, which },
      search: {
        starts_per_topology: int("starts", ["search", "starts_per_topology"], d.starts, 0),
        population: int("population", ["search", "population"], d.population, 0),
        evaluation_budget: int("evaluations", ["search", "evaluation_budget"], d.evaluations, 0),
        log_every_generations: int("log", ["search", "log_every_generations"], d.log, 0),
        search_seed: seed,
        sobol_start_points: d.sobol,
      },
      bounds: {
        rate_min: rate(d.rateMin),
        rate_max: rate(d.rateMax),
        sigmoid_min_mV: sigmoid("sigmoidMin", d.sigmoidMin, -80),
        sigmoid_max_mV: sigmoid("sigmoidMax", d.sigmoidMax, 60),
      },
    },
    said,
    replaced,
    entries: from,
    written: entries.length,
  };
}

const SEARCH: Record<string, Field> = {
  starts_per_topology: "starts",
  population: "population",
  evaluation_budget: "evaluations",
  log_every_generations: "log",
  search_seed: "seed",
  sobol_start_points: "sobol",
};

const BOUNDS: Record<string, Field> = {
  rate_min: "rateMin",
  rate_max: "rateMax",
  sigmoid_min_mV: "sigmoidMin",
  sigmoid_max_mV: "sigmoidMax",
};

/** The field an issue's path names; the run cap with All is said under Which topologies. */
export function fieldOf(path: string[]): Field {
  const [a, b, c] = path;
  if (a === "name") return "name";
  if (a === "dataset_id") return "dataset";
  if (a === "topology") {
    if (b === "num_states") return "states";
    if (c === "count") return "sample";
    if (c === "ids") return "ids";
    return "which";
  }
  if (a === "search") return SEARCH[b] ?? "starts";
  return BOUNDS[b] ?? "rateMin";
}

/** One issue under its field: the engine's or the builder's own. */
export interface FieldIssue {
  field: Field;
  message: string;
  severity: Issue["severity"];
  /** For Specific IDs, the entry it's about, by where it was written. */
  at?: number;
}

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Every issue under its field, in the page's order: the builder's own and
 * the engine's, Specific IDs' in the order their entries were written. The
 * engine's for a path the builder says itself are left out.
 */
export function issuesOf(wire: Wire, engine: Issue[]): FieldIssue[] {
  const own: FieldIssue[] = wire.said.map((s) => ({ ...s, severity: "error" }));
  const theirs: FieldIssue[] = engine
    .filter((i) => !wire.replaced.some((p) => samePath(p, i.path)))
    .map((i) => {
      const index = i.path[0] === "topology" && i.path[2] === "ids" ? i.path[3] : undefined;
      const at = index === undefined ? undefined : wire.entries[Number(index)];
      return {
        field: fieldOf(i.path),
        message: i.message,
        severity: i.severity,
        ...(at !== undefined ? { at } : {}),
      };
    });
  const order = (i: FieldIssue) => FIELDS.indexOf(i.field) * 1e6 + (i.at ?? -1);
  return [...own, ...theirs]
    .map((issue, n) => ({ issue, n }))
    .sort((a, b) => order(a.issue) - order(b.issue) || a.n - b.n)
    .map((x) => x.issue);
}

/** A field's value as it compares: numbers as numbers, ids as their written form. */
function canonical(d: ConfigDraft, field: Field): string {
  const v = d[field];
  if (typeof v === "boolean") return String(v);
  switch (field) {
    case "name":
    case "dataset":
    case "which":
      return v;
    case "ids": {
      const entries = idEntries(v);
      return entries.every((e) => e.id !== null)
        ? entries.map((e) => idWords(e.id!)).join(",")
        : v.trim();
    }
    case "rateMin":
    case "rateMax":
    case "sigmoidMin":
    case "sigmoidMax":
      return String(numberOf(v) ?? v.trim());
    default: {
      const n = wholeOf(v);
      return typeof n === "number" ? String(n) : v.trim();
    }
  }
}

/** Whether a field shows: a sample's size only with Random sample, Specific IDs only with them. */
const shows = (d: ConfigDraft, field: Field) =>
  field === "sample" ? d.which === "sample" : field === "ids" ? d.which === "ids" : true;

/** The fields `now` changes from `from`, in the page's order; one that doesn't show isn't a change. */
export function changedFields(from: ConfigDraft, now: ConfigDraft): Field[] {
  return FIELDS.filter((f) => shows(now, f) && canonical(from, f) !== canonical(now, f));
}

/**
 * Reload after another computer's save (section 1's note): theirs, with
 * each field you changed since `from` kept as you have it.
 */
export function reloadDraft(from: ConfigDraft, mine: ConfigDraft, theirs: ConfigDraft) {
  const next: Record<Field, unknown> = { ...theirs };
  for (const f of FIELDS) if (canonical(from, f) !== canonical(mine, f)) next[f] = mine[f];
  return next as unknown as ConfigDraft;
}

const WHICH_WORDS: Record<Which, string> = {
  sample: "Random sample",
  ids: "Specific IDs",
  all: "All",
};

/** A field's value as "was …" says it. */
function wasWords(d: ConfigDraft, field: Field, datasetName: (id: string) => string): string {
  if (field === "dataset") return datasetName(d.dataset);
  if (field === "which") return WHICH_WORDS[d.which];
  if (field === "sobol") return d.sobol ? "on" : "off";
  const v = d[field] as string;
  return v.trim() !== "" ? v : field === "seed" ? "drawn at submit" : "blank";
}

/**
 * Under each field you or another computer changed (Settings' marks, #164):
 * yours since `base`, as "Changed · was …"; theirs, from `opened` to `base`
 * after Reload, as "From another computer · was …"; and one you both
 * changed keeps yours and says what they saved.
 */
export function fieldMarks(
  opened: ConfigDraft,
  base: ConfigDraft,
  now: ConfigDraft,
  datasetName: (id: string) => string,
): Partial<Record<Field, FieldMark>> {
  const mine = changedFields(base, now);
  const theirs = changedFields(opened, base).filter((f) => shows(now, f));
  const marks: Partial<Record<Field, FieldMark>> = {};
  for (const f of FIELDS) {
    const m = mine.includes(f);
    const t = theirs.includes(f);
    const at = (d: ConfigDraft) => wasWords(d, f, datasetName);
    if (m && t) marks[f] = { kind: "both", was: at(opened), saved: at(base) };
    else if (m) marks[f] = { kind: "mine", was: at(base) };
    else if (t) marks[f] = { kind: "theirs", was: at(opened) };
  }
  return marks;
}

/** How the note names each field. */
const FIELD_WORDS: Record<Field, string> = {
  name: "name",
  dataset: "dataset",
  states: "number of states",
  which: "which topologies",
  sample: "sample",
  ids: "IDs",
  starts: "starts per topology",
  population: "population size",
  evaluations: "evaluations per start",
  seed: "search seed",
  log: "log interval",
  sobol: "Sobol start points",
  rateMin: "parameter bounds",
  rateMax: "parameter bounds",
  sigmoidMin: "voltage dependence bounds",
  sigmoidMax: "voltage dependence bounds",
};

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const wordsOf = (fields: Field[]) => [...new Set(fields.map((f) => FIELD_WORDS[f]))];

/**
 * What the note says once another computer saved `theirs` over `base`, the
 * builder holding `now`: the fields it changed, and what Reload keeps,
 * naming any field you both changed, as Settings' note does (#118's U15).
 */
export function elsewhereNotice(
  base: ConfigDraft,
  theirs: ConfigDraft,
  now: ConfigDraft,
): { fields: string | undefined; reload: string } {
  const changed = FIELDS.filter((f) => canonical(base, f) !== canonical(theirs, f));
  const mine = changedFields(base, now);
  const both = mine.filter(
    (f) => changed.includes(f) && canonical(theirs, f) !== canonical(now, f),
  );
  let reload = "Reload shows theirs.";
  if (both.length > 0) {
    reload = `Reload shows theirs. You both changed ${listed(wordsOf(both))}, so it keeps yours.`;
  } else if (mine.length > 0) {
    const n = wordsOf(mine).length;
    reload = `Reload shows theirs and keeps ${n === 1 ? "the field" : `the ${n} fields`} you changed.`;
  }
  return { fields: changed.length === 0 ? undefined : listed(wordsOf(changed)), reload };
}
