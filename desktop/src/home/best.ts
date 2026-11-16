/**
 * Home's Best per dataset (#391, LaptopMain): each dataset that isn't
 * deleted, by Datasets' Best val's rule (its ended runs on its current data,
 * by Val RMSE, else by Train RMSE), named by its top topology's Best start.
 * Its latest run first, those with no runs last.
 */
import type { DatasetSummary, RunsDataset, RunState, RunSummary } from "../wire/types.gen";

/** How many datasets Home lists before "N more in Datasets". */
export const BEST_SHOWN = 6;

/** Where a row opens. */
export type BestTo =
  | { kind: "start"; run: number; graph: number; openState: number; start: number }
  | { kind: "run"; run: number }
  | { kind: "dataset"; id: string };

export interface BestRow {
  id: string;
  name: string;
  /** Its best run's RMSE; `undefined` before it has one. */
  rmse?: number;
  /** Ranked by Train RMSE: its best run has no validation points. */
  byTrain: boolean;
  /** "#211/T12.3 · start 37 · 8 states", or why it has no best yet. */
  sub: string;
  /** Its best's topology and start, written apart so they read as numbers. */
  named?: { topology: string; start: number; states: number };
  /**
   * The run fitting on its current data with the lowest live best, which isn't
   * this row's best until it ends: "#213 is fitting · 0.0450 so far" (#399, HF07).
   */
  fitting?: { run: number; rmse: number };
  to: BestTo;
}

/** What a row reads of a run in flight. */
export type InFlight = Pick<RunSummary, "id" | "state" | "canceling" | "dataset" | "best">;

/** A run in flight's word after "is": "#1 is fitting". */
const WORD: Partial<Record<RunState, string>> = {
  running: "fitting",
  queued: "queued",
  held: "held",
};

const protocols = (n: number) => `${n} ${n === 1 ? "protocol" : "protocols"}`;

/**
 * Each dataset's row, latest run first, then those with no runs as the
 * Datasets list orders them. `inFlight` are the runs in flight, which name
 * what a dataset's latest run is doing.
 */
export function bestRows(
  datasets: readonly DatasetSummary[],
  overview: readonly RunsDataset[],
  inFlight: readonly InFlight[],
): BestRow[] {
  const runs = new Map(overview.map((o) => [o.id, o]));
  const rows = datasets.map((d) => ({ d, o: runs.get(d.id) }));
  const latest = (o: RunsDataset | undefined) =>
    o === undefined || o.runs === 0 ? 0 : o.latest_run;
  // Stable: those with no runs keep the list's order.
  rows.sort((a, b) => latest(b.o) - latest(a.o));
  return rows.map(({ d, o }) => rowOf(d, o, inFlight));
}

function rowOf(
  d: DatasetSummary,
  o: RunsDataset | undefined,
  inFlight: readonly InFlight[],
): BestRow {
  const fitting = fittingOf(d.id, inFlight);
  const best = o?.best_val ?? o?.best_train ?? null;
  if (o !== undefined && best !== null) {
    const topology = `#${best.run}/T${best.graph}.${best.open_state}`;
    return {
      id: d.id,
      name: d.name,
      rmse: best.rmse,
      byTrain: o.best_val === null,
      sub: `${topology} · start ${best.start} · ${best.num_states} states`,
      named: { topology, start: best.start, states: best.num_states },
      fitting,
      to: {
        kind: "start",
        run: best.run,
        graph: best.graph,
        openState: best.open_state,
        start: best.start,
      },
    };
  }
  if (o === undefined || o.runs === 0) {
    return {
      id: d.id,
      name: d.name,
      byTrain: false,
      sub: `No runs yet · ${protocols(d.protocols.length)}`,
      to: { kind: "dataset", id: d.id },
    };
  }
  const flying = inFlight.find((r) => r.id === o.latest_run);
  const word =
    flying === undefined
      ? "fitting"
      : flying.canceling !== null
        ? "canceling"
        : (WORD[flying.state] ?? "fitting");
  // A run fitting with a best says so on its own line, with that best.
  const doing =
    (flying === undefined && o.runs_in_flight !== o.runs) ||
    (word === "fitting" && fitting !== undefined)
      ? undefined
      : `#${o.latest_run} is ${word}`;
  const lead =
    o.runs_in_flight === o.runs
      ? "No run has ended yet"
      : o.runs_earlier === o.runs
        ? `${o.runs_earlier.toLocaleString("en-US")} on earlier data`
        : "No run has ranked yet";
  const sub = doing === undefined || o.runs_earlier === o.runs ? lead : `${lead} · ${doing}`;
  return {
    id: d.id,
    name: d.name,
    byTrain: false,
    sub,
    fitting,
    to: { kind: "run", run: o.latest_run },
  };
}

/** The run fitting on dataset `id`'s current data with the lowest live best, by Val RMSE, else Train. */
function fittingOf(id: string, inFlight: readonly InFlight[]): BestRow["fitting"] {
  let low: BestRow["fitting"];
  for (const r of inFlight) {
    if (r.dataset.id !== id || r.dataset.earlier || r.state !== "running" || r.canceling !== null) {
      continue;
    }
    const v = r.best === null ? null : (r.best.val_rmse ?? r.best.train_rmse);
    if (v !== null && (low === undefined || v < low.rmse)) low = { run: r.id, rmse: v };
  }
  return low;
}
