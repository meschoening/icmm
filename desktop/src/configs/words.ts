/**
 * How Configs writes a config (LaptopConfigs): its row's facts, its
 * topologies, its settings, why Submit run can't use it, and why it can't
 * be read.
 */
import { count, minus } from "../datasets/format";
import { newerWords } from "../newer";
import type { ConfigDataset, ConfigSummary, SpecificId, UnreadableError } from "../wire/types.gen";
// The engine's examples, which `tests/test_config_checks.py` checks against the lists.
import examples from "./idExamples.json";

/** A whole number as the boards write it: "1,000,000". */
export const whole = (n: number) => n.toLocaleString("en-US");

/** A bound as the boards write it: "−10", "9.5". */
export const bound = (x: number) => minus(String(x));

/** "5 random topologies", "all 411 topologies", "10 specific topologies". */
export function topologiesWords(which: ConfigSummary["which"], topologies: number): string {
  const noun = topologies === 1 ? "topology" : "topologies";
  switch (which) {
    case "all":
      return `all ${whole(topologies)} ${noun}`;
    case "sample":
      return `${whole(topologies)} random ${noun}`;
    case "ids":
      return `${whole(topologies)} specific ${noun}`;
    default:
      return `${whole(topologies)} ${noun}`;
  }
}

/**
 * A row's facts after its dataset's name, as one line under the name at the
 * list's 340 px (#180): "11 states · 5 random topologies · 100 starts", the
 * starts each topology gets, as the detail's "5 random topologies × 100 =
 * 500 starts" has them. A count its save couldn't make is left out.
 */
export function rowFacts(c: Pick<ConfigSummary, "num_states" | "which" | "topologies" | "starts">) {
  const facts: string[] = [];
  if (c.num_states !== null) facts.push(count(c.num_states, "state"));
  if (c.topologies !== null) facts.push(topologiesWords(c.which, c.topologies));
  if (c.topologies !== null && c.topologies > 0 && c.starts !== null) {
    const each = c.starts / c.topologies;
    facts.push(`${whole(each)} ${each === 1 ? "start" : "starts"}`);
  }
  return facts;
}

/** A Specific ID as it's written: `T1991` for every topology of its state graph, `T1991.6` for one. */
export const idWords = (id: SpecificId) =>
  id.open_state === null ? `T${id.graph}` : `T${id.graph}.${id.open_state}`;

/** A number of states' Specific IDs example: a state graph and one of its open states. */
export interface IdExample {
  graph: number;
  open_state: number;
}

const ID_EXAMPLES: Record<string, IdExample> = examples;

/**
 * The Specific IDs example for a number of states (CF10), the engine's
 * `ID_EXAMPLES`: a state graph with more than one open state, and one of them
 * other than 0. Without a number of states, #180's 11-state T1991.6.
 */
export const idExample = (numStates: number | null): IdExample =>
  ID_EXAMPLES[String(numStates)] ?? ID_EXAMPLES["11"];

/** The example written each way an id can be: "6", "T6" (every open state) and "T6.3" (one). */
export function exampleIds(numStates: number | null) {
  const { graph, open_state } = idExample(numStates);
  return {
    graph: String(graph),
    bare: idWords({ graph, open_state: null }),
    one: idWords({ graph, open_state }),
    open: open_state,
  };
}

/** "6, T6 or T6.3", as the sentences that say how to write an id give it. */
export function exampleIdsWords(numStates: number | null): string {
  const { graph, bare, one } = exampleIds(numStates);
  return `${graph}, ${bare} or ${one}`;
}

/**
 * How many generations a start runs: its whole budget, its last generation
 * whole (ADR-0008), as the engine counts it; `null` without a population of
 * at least 2 or a budget of at least 1.
 */
export function generationsOf(budget: number, population: number): number | null {
  if (population < 2 || budget < 1) return null;
  return Math.ceil(budget / population);
}

export const generationWords = (n: number) => (n === 1 ? "generation" : "generations");

/** A voltage with its sign, as the boards write a midpoint: "+80", "−60", "0". */
const signed = (mV: number) => (mV > 0 ? `+${mV}` : mV < 0 ? minus(String(mV)) : "0");

/**
 * What Voltage dependence bounds lo … hi make (CF01): they bound a and b of
 * tanh((V + a)/b), so midpoints (−a) run from −hi to −lo, and widths (|b|,
 * shown with b > 0, ADR-0007) up to the larger of |lo| and |hi|. `null` for
 * a pair that isn't a range.
 */
export function voltageWords(
  lo: number | null,
  hi: number | null,
): { from: string; to: string; width: string } | null {
  if (lo === null || hi === null || !(lo < hi)) return null;
  return {
    from: signed(-hi),
    to: signed(-lo),
    width: String(Math.max(Math.abs(lo), Math.abs(hi))),
  };
}

/**
 * A free name for a config saved again as a new one (CF04): `name`, or
 * `-2`, `-3`… when another config has it, ignoring case, within 64.
 */
export function againName(name: string, names: string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = name.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** What a number of states that isn't one says, as the engine does. */
export const STATES_WORDS = "Choose a number of states from 3 to 16.";

/** What an empty Specific IDs says, as the engine does: "Write at least one id: 6, T6 or T6.3." */
export const emptyIdsWords = (numStates: number | null) =>
  `Write at least one id: ${exampleIdsWords(numStates)}.`;

/**
 * Why Submit run can't use a config's dataset now, under the buttons
 * (#180): deleted, or a current revision ICMM can't read. `undefined` when it
 * can. `edit` is what the page calls the way into the config's builder:
 * "Edit" on Configs, "Edit config" on Submit run.
 */
export function submitBlocker(d: ConfigDataset, edit = "Edit"): string | undefined {
  if (d.deleted) return `Choose another dataset in ${edit} to submit`;
  if (d.unreadable !== null) return unreadableWords(d.name ?? "Its dataset", d.unreadable);
  return undefined;
}

function unreadableWords(name: string, e: UnreadableError): string {
  return e.data.problem === "newer"
    ? `${name} was saved by a newer ICMM. Update ICMM on this computer to submit.`
    : `ICMM can’t read ${name}’s current revision. Its page on Datasets says why.`;
}

/**
 * What the three-line box says of a config this ICMM can't read: a newer
 * ICMM's names this ICMM's version and says what to do, as Import does of a
 * newer file (#168); any other says the agent's sentence, and a damaged one
 * what to do (#452). Never "put it back": a config lives in the runs
 * database, and its file there is never read back (ADR-0016).
 */
export function unreadableConfigWords(
  name: string,
  e: UnreadableError,
): { what: string; next: string | undefined } {
  switch (e.data.problem) {
    case "newer":
      return { what: newerWords(name), next: "Update ICMM on this computer to use it." };
    case "damaged":
      return { what: e.message, next: DAMAGED_CONFIG_NEXT };
    default:
      return { what: e.message, next: undefined };
  }
}

/** What to do about a damaged config, where it can be deleted. */
export const DAMAGED_CONFIG_NEXT =
  "Delete it, then make it again. Its runs keep the settings they were submitted with.";
