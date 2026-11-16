/**
 * The leaderboard's Export CSV… (#344, #339): every row the filters keep, not
 * only the pages shown, read a page of 100 at a time as the table reads them
 * (`list_leaderboard`, `after`), each with its Best start, in the table's
 * order. Each row's parameter count comes from its state graph, read 1,000 a
 * time (`read_state_graphs`), as the table's States · Params has it: empty
 * where that read fails, as the table shows "—".
 */
import { commands } from "../wire/api.gen";
import type { LeaderboardRow } from "../wire/types.gen";
import type { LeaderboardAsk } from "./queries";
import { graphKey } from "./queries";
import { parametersOf, topologyId } from "../runs/detail";

/** The most state graphs one read names (`MAX_STATE_GRAPHS`). */
const PER_READ = 1000;

export interface EveryRow {
  rows: LeaderboardRow[];
  validation: boolean;
  /** Each row's parameter count, by `graphKey`. */
  params: ReadonlyMap<string, number>;
}

/** Every row `ask` keeps, in its order; a row whose place moved between pages keeps its first. */
export async function readEveryRow(ask: LeaderboardAsk): Promise<EveryRow> {
  const rows: LeaderboardRow[] = [];
  const seen = new Set<string>();
  let page = await commands.list_leaderboard({ ...ask, after: null });
  for (;;) {
    for (const r of page.rows) {
      const key = `${r.run.id}/${r.graph}.${r.open_state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    if (page.next === null) break;
    page = await commands.list_leaderboard({ ...ask, after: page.next });
  }
  return { rows, validation: page.validation, params: await paramsOf(rows) };
}

async function paramsOf(rows: readonly LeaderboardRow[]): Promise<Map<string, number>> {
  const byStates = new Map<number, Set<number>>();
  for (const r of rows)
    byStates.set(r.num_states, (byStates.get(r.num_states) ?? new Set()).add(r.graph));
  const params = new Map<string, number>();
  for (const [numStates, graphs] of byStates) {
    const sorted = [...graphs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += PER_READ) {
      // A read that fails leaves its rows' counts empty, as the table shows "—" for them.
      const read = await commands
        .read_state_graphs({ num_states: numStates, graphs: sorted.slice(i, i + PER_READ) })
        .catch(() => ({ state_graphs: [] }));
      for (const g of read.state_graphs) {
        params.set(graphKey(numStates, g.graph), parametersOf(numStates, g.edges.length));
      }
    }
  }
  return params;
}

/** A cell as CSV writes it: quoted where it holds a comma, a quote or a line end. */
function cell(v: string | number | boolean | null): string {
  const t = v === null ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/**
 * The rows as CSV: the table's columns, in its order, each number to all its
 * digits, "—" an empty cell. Without validation points there's no Val column,
 * as the table has none. `fitting` marks a row in progress, whose numbers
 * change as its starts finish (#370).
 */
export function leaderboardCsv(every: EveryRow): string {
  const head = [
    "rank",
    "topology",
    "run",
    "config",
    "num_states",
    "parameters",
    "starts_finished",
    "starts",
    "near_best",
    "train_rmse",
    ...(every.validation ? ["val_rmse"] : []),
    "spread",
    "best_start",
    "fitting",
    "still_improving",
  ];
  const lines = [head.join(",")];
  for (const r of every.rows) {
    lines.push(
      [
        r.rank,
        `#${r.run.id}/${topologyId(r)}`,
        r.run.id,
        r.run.config.name,
        r.num_states,
        every.params.get(graphKey(r.num_states, r.graph)) ?? null,
        r.starts_finished,
        r.starts,
        r.near_best,
        r.best.train_rmse,
        ...(every.validation ? [r.best.val_rmse] : []),
        r.spread?.median ?? null,
        r.best.start,
        r.fitting,
        r.still_improving,
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
