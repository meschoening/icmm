/** How a topology's drawing is said: its caption, and the sentence a screen reader says (#212). */
import { idWords } from "../configs/words";
import { count } from "../datasets/format";
import type { SpecificId, StateGraph } from "../wire/types.gen";

type Drawn = Pick<StateGraph, "edges" | "open_states">;

/** "0", "0 and 2", "0, 1, 3 and 4". */
const listed = (xs: number[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** "T9: 5 states, 5 transitions, open states 0, 1, 3 and 4." */
export function drawingSentence(id: SpecificId, numStates: number, graph: Drawn): string {
  const opens = id.open_state === null ? graph.open_states : [id.open_state];
  const where = `${opens.length === 1 ? "open state" : "open states"} ${listed(opens)}`;
  return `${idWords(id)}: ${count(numStates, "state")}, ${count(graph.edges.length, "transition")}, ${where}.`;
}

/** What the caption says after the id: "open state 0", or "4 open states, ringed". */
export function drawingCaption(id: SpecificId, graph: Drawn): string {
  if (id.open_state !== null) return `open state ${id.open_state}`;
  return `${count(graph.open_states.length, "open state")}, ringed`;
}
