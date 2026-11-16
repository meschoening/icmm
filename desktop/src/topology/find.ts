/**
 * Find custom topology (#222): what's typed as transitions between states
 * numbered however the user likes, the words for it and for each check
 * `match_topology` answers, and what Add does with the id it finds. Nothing
 * here names a kind of state: ICMM knows only which state is open.
 */
import { idEntries } from "../configs/builder/draft";
import { idWords } from "../configs/words";
import { count } from "../datasets/format";
import type { FoundTopology, SpecificId, TopologyIssue } from "../wire/types.gen";

/** What's typed, as ICMM reads it. */
export interface Typed {
  /** Each transition once, as its two numbers in the order typed; a repeat is ignored. */
  transitions: [number, number][];
  /** What isn't two whole numbers joined by a dash, as typed. */
  bad: string[];
  /** Every state's number, lowest first. */
  states: number[];
}

/**
 * A transition: two whole numbers joined by a dash, a hyphen, “↔” or “⇌”, or
 * the em dash, minus sign, “⇄” and typeset hyphens a paper's text pastes as.
 */
const TRANSITION = /^(\d+)\s*[–\-↔⇌—−⇄‐‑‒]\s*(\d+)$/;

/** The transitions typed, separated by commas (or lines). */
export function parseTransitions(text: string): Typed {
  const transitions: [number, number][] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  const states = new Set<number>();
  for (const item of text.split(/[,\n]/)) {
    const written = item.trim();
    if (written === "") continue;
    const m = written.match(TRANSITION);
    const [a, b] = m === null ? [NaN, NaN] : [Number(m[1]), Number(m[2])];
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      bad.push(written);
      continue;
    }
    const pair = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    transitions.push([a, b]);
    states.add(a).add(b);
  }
  return { transitions, bad, states: [...states].sort((x, y) => x - y) };
}

/** "5 states, 4 transitions." */
export const readBack = (t: Typed) =>
  `${count(t.states.length, "state")}, ${count(t.transitions.length, "transition")}.`;

/** "1", "1 and 2", "1, 2, 3 and 7". */
function listed(xs: readonly (number | string)[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "State 2" or "States 1 and 2". */
const statesWords = (xs: readonly number[]) =>
  `${xs.length === 1 ? "State" : "States"} ${listed(xs)}`;

/** “2–” isn’t two state numbers joined by a dash. */
export function badWords(bad: readonly string[]): string {
  const quoted = listed(bad.map((b) => `“${b}”`));
  return `${quoted} ${bad.length === 1 ? "isn’t" : "aren’t"} two state numbers joined by a dash.`;
}

const LOOP_RULE =
  "ICMM’s topologies loop through at most 4: two loops that share a transition make a longer one.";
const NEIGHBORS_RULE = "A state in ICMM’s topologies has at most 4.";
const ONE_PIECE = "A topology is one connected piece.";
const TWO_STATES = "A transition joins two different states.";

/** Each typed state's neighbors, setting aside a state joined to itself. */
function neighborCounts(t: Typed): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [a, b] of t.transitions) {
    if (a === b) continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return counts;
}

/** What a check says: the rule `issue` breaks, and the typed numbers that break it. */
export function checkWords(issue: TopologyIssue, t: Typed): string {
  const { states } = issue;
  switch (issue.rule) {
    case "loop":
      return issue.loop !== null
        ? `States ${listed(issue.loop)} make a loop through ${issue.loop.length} states. ${LOOP_RULE}`
        : `States ${listed(states)} make loops through more than 4 states. ${LOOP_RULE}`;
    case "neighbors": {
      const counts = neighborCounts(t);
      const each = states.map((s) => counts.get(s) ?? 0);
      if (states.length === 1)
        return `State ${states[0]} has ${each[0]} neighbors. ${NEIGHBORS_RULE}`;
      const how = each.every((c) => c === each[0])
        ? `each have ${each[0]} neighbors`
        : `have ${listed(each)} neighbors`;
      return `States ${listed(states)} ${how}. ${NEIGHBORS_RULE}`;
    }
    case "connected":
      return `${statesWords(states)} ${states.length === 1 ? "isn’t" : "aren’t"} joined to the rest. ${ONE_PIECE}`;
    case "num_states":
      return "ICMM’s topologies have 3 to 16 states.";
    case "self_transition":
      return states.length === 1
        ? `State ${states[0]} is joined to itself. ${TWO_STATES}`
        : `States ${listed(states)} are joined to themselves. ${TWO_STATES}`;
    case "repeated_transition":
      return `${statesWords(states)} are joined more than once.`;
    case "open_state":
      return `Open state ${listed(states)} isn’t one of the states typed.`;
  }
}

/** What Add does with a found topology, given the config's number of states and ids as typed. */
export interface AddPlan {
  label: string;
  /** What it changes besides the ids, said under the drawings. */
  note: string | null;
  /** The ids after it; absent when it can't add. */
  ids?: string;
  /** The number of states after it, when it changes. */
  states?: string;
  /** Why Add is gray. */
  blocked?: string;
}

const idOf = (found: FoundTopology) =>
  idWords({ graph: found.graph, open_state: found.open_state });

/**
 * `fitted` is what the builder's check says the ids fit, as a save keeps them:
 * an id its symmetry renames, such as `T8.1` for `T8.0`, is there by that name.
 */
export function addPlan(
  found: FoundTopology,
  statesText: string,
  idsText: string,
  fitted: readonly SpecificId[] = [],
): AddPlan {
  const id = idOf(found);
  const n = found.num_states;
  const entries = idEntries(idsText);
  const typed = /^\s*\d+\s*$/.test(statesText) ? Number(statesText) : null;
  if (typed === n) {
    const ids = [...entries.flatMap((e) => (e.id === null ? [] : [e.id])), ...fitted];
    const same = ids.filter((i) => i.graph === found.graph);
    if (same.some((i) => i.open_state === found.open_state)) {
      return { label: `Add ${id}`, note: null, blocked: `${id} is already in the ids.` };
    }
    const bare = same.find((i) => i.open_state === null);
    if (bare !== undefined) {
      return { label: `Add ${id}`, note: null, blocked: `${idWords(bare)} already fits ${id}.` };
    }
    const kept = idsText.trim().replace(/,\s*$/, "");
    return { label: `Add ${id}`, note: null, ids: kept === "" ? id : `${kept}, ${id}` };
  }
  const sets = `adding ${id} sets Number of states to ${n}`;
  if (entries.length === 0) {
    return { label: `Add ${id}`, note: `It has ${n} states: ${sets}.`, ids: id, states: String(n) };
  }
  const removed = listed(entries.map((e) => e.written));
  const note =
    typed === null
      ? `It has ${n} states: ${sets} and removes ${removed}.`
      : `The config has ${typed} states. Adding ${id} sets it to ${n} and removes ${removed}, which have ${typed} states.`;
  return { label: `Replace the ids with ${id}`, note, ids: id, states: String(n) };
}
