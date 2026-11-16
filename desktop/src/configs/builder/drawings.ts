/**
 * Specific IDs' drawings (#212): each id the read-back fits, as a save keeps
 * it, with its state graph. An id its checks refuse is only in its check.
 */
import { useState } from "react";
import type { Spot } from "../../topology/layout";
import { useStateGraphs } from "../../topology/queries";
import { useLayouts } from "../../topology/useLayouts";
import type { ConfigCheck, SpecificId, StateGraph } from "../../wire/types.gen";
import { idWords } from "../words";

export interface IdDrawing {
  id: SpecificId;
  graph: StateGraph;
  /** Where each of its states sits. */
  spots: Spot[];
}

export interface IdDrawings {
  numStates: number;
  drawings: IdDrawing[];
}

/**
 * Past this many ids, none is drawn: a list that long is pasted, not checked
 * against a paper by eye, and drawing it would take minutes.
 */
export const MOST_DRAWN = 100;

/**
 * The ids a check keeps, as a save will keep them, but each one past its list
 * or its states, which only its check names; `null` when it keeps no Specific
 * IDs or can't count them.
 */
export function drawnIds(check: ConfigCheck): SpecificId[] | null {
  const { num_states, which } = check.config.topology;
  if (which.kind !== "ids" || num_states === null || check.counts === null) return null;
  const { state_graphs } = check.counts;
  const ids = which.ids.filter(
    ({ graph, open_state }) =>
      graph >= 0 &&
      graph < state_graphs &&
      (open_state === null || (open_state >= 0 && open_state < num_states)),
  );
  return ids;
}

/**
 * `ids`' drawings once each one's state graph is read and laid out. The last
 * ones stay meanwhile, so they don't blink out as an id is added.
 */
export function useIdDrawings(numStates: number | null, ids: SpecificId[] | null) {
  const graphs = numStates === null || ids === null ? [] : [...new Set(ids.map((id) => id.graph))];
  const read = useStateGraphs(numStates ?? 0, graphs);
  const found = read === undefined ? [] : graphs.flatMap((g) => read.get(g) ?? []);
  const laid = useLayouts(found.map((g) => ({ numStates: numStates ?? 0, edges: g.edges })));
  const [shown, setShown] = useState<{ key: string; drawn: IdDrawings } | null>(null);
  if (numStates === null || ids === null || ids.length === 0) return null;
  const available = found.map((graph) => graph.graph).join(",");
  const key = `${numStates}:${ids.map(idWords).join(" ")}:${available}`;
  if (read !== undefined && laid !== undefined && shown?.key !== key) {
    const drawings = ids.flatMap((id) => {
      const i = found.findIndex((g) => g.graph === id.graph);
      return i < 0 ? [] : [{ id, graph: found[i], spots: laid[i] }];
    });
    setShown({ key, drawn: { numStates, drawings } });
  }
  return shown?.drawn ?? null;
}
