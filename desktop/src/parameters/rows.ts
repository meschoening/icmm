/**
 * The Parameters rows (#41, built in #287): the open state's row, a row per
 * other state, a row per edge, then the Voltage dependence curve's a and b,
 * each with its two parts. Topology, Start and Result show a topology's
 * parameters in them, each with its own strips.
 *
 * Each part names its place in the vector the core reads (ADR-0007): a pair
 * per state (sᵢ, sᵢᵛ), a pair per edge in the topology's edge order (eᵢ,ⱼ,
 * eᵢ,ⱼᵛ), then a and b.
 */

/** One parameter: where it sits in the vector, and its name in a sentence. */
export interface PartRef {
  index: number;
  /** "Favorability of state 1", "Speed of edge 0–8", "a". */
  name: string;
  /** a and b are in mV; the rest in ln units. */
  mV: boolean;
}

export interface StateRow {
  state: number;
  constant: PartRef;
  voltage: PartRef;
}

export interface EdgeRow {
  /** The lower state. */
  i: number;
  j: number;
  constant: PartRef;
  voltage: PartRef;
}

export interface ParameterRows {
  open: number;
  /** Every state but the open one, by number. */
  states: StateRow[];
  /** In the topology's edge order: the order of its edge parameters. */
  edges: EdgeRow[];
  a: PartRef;
  b: PartRef;
  /** 2N + 2E + 2. */
  count: number;
}

/** A topology's rows, its edges as `read_state_graphs` gives them, each lower state first. */
export function parameterRows(
  numStates: number,
  openState: number,
  edges: readonly (readonly number[])[],
): ParameterRows {
  const part = (index: number, name: string): PartRef => ({ index, name, mV: false });
  const states = Array.from({ length: numStates }, (_, s) => s)
    .filter((s) => s !== openState)
    .map((state) => ({
      state,
      constant: part(2 * state, `Favorability of state ${state}`),
      voltage: part(2 * state + 1, `Voltage sensitivity of state ${state}`),
    }));
  const base = 2 * numStates;
  const rows = edges.map(([i, j], k) => ({
    i,
    j,
    constant: part(base + 2 * k, `Speed of edge ${i}–${j}`),
    voltage: part(base + 2 * k + 1, `Voltage sensitivity of edge ${i}–${j}`),
  }));
  const count = base + 2 * edges.length + 2;
  return {
    open: openState,
    states,
    edges: rows,
    a: { index: count - 2, name: "a", mV: true },
    b: { index: count - 1, name: "b", mV: true },
    count,
  };
}
