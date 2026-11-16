/**
 * What ⌘K finds (#408, #410; LaptopCommandPalette): the query as words or
 * a whole id, and the rows of each group it searches, from the reads the
 * desktop already has (`list_runs`, `runs_overview`, `list_datasets`,
 * `list_configs`). Pure: the palette reads, this matches and words.
 *
 * - Every word, ignoring case, must be part of a row's id or name: a run's
 *   `#214`, config name and dataset name, plus its state; a config's name and
 *   its dataset's; a dataset's name. Never the numbers at the right.
 * - `#214` is run 214 alone; `214` is run 214 or a name holding it, as Runs'
 *   filter has it (`run_store._filter`).
 * - A Results row is each matched dataset's best start on its current data,
 *   by Home's rule (`runs_overview`'s `best_val`, else `best_train`); a
 *   dataset matches when its name does, or any of its runs.
 * - Within a group: an exact id or a name typed whole first (a dataset's or
 *   config's name is the id the user types; a run goes by its config's, a
 *   result by its dataset's), then names starting with a word, then the
 *   group's page order.
 *
 * Recently opened (#411) words the pages last opened from the same reads, as
 * they are now: one deleted since drops out, and one not yet read shows by
 * the name it was opened under.
 */
import { plural } from "../../submit/estimate";
import type {
  ConfigSummary,
  DatasetBest,
  DatasetSummary,
  OpenedPage,
  RunsOverview,
  RunSummary,
  Start,
  Topology,
} from "../../wire/types.gen";

/** How many rows a group shows before its "N more" row. */
export const GROUP_ROWS = 4;

/** The run a page is about, from its path: `/runs/214/T12.3` is run 214's. */
export function pageRunOf(path: string): number | undefined {
  const m = path.match(/^\/runs\/([1-9]\d*)(?:\/|$)/);
  return m === null ? undefined : Number(m[1]);
}

/** What was typed: words, or a whole topology or start id. */
export type Query =
  | { kind: "words"; words: string[] }
  | { kind: "topology"; run: number; graph: number; openState: number }
  | { kind: "start"; run: number; graph: number; openState: number; start: number }
  /** `T12.3` with no run: the current run's on a run's page. */
  | { kind: "bare"; graph: number; openState: number; start?: number };

const NUM = "(0|[1-9]\\d*)";
/** `· start 37`, ` start 37`, ` 37` or `/37` after a topology. */
const START = `(?:\\s*·\\s*start\\s+|\\s+start\\s+|\\s+|/)${NUM}`;
const WHOLE = new RegExp(`^#?${NUM}/T?${NUM}\\.${NUM}(?:${START})?$`, "i");
const BARE = new RegExp(`^T${NUM}\\.${NUM}(?:${START})?$`, "i");

const safe = (...xs: number[]) => xs.every(Number.isSafeInteger);

/**
 * The query: `#214/T12.3`, `214/T12.3`, `#214/T12.3 37`, `#214/T12.3 · start 37`
 * and `214/12.3/37` are whole ids; `T12.3` is a bare one; the rest is words.
 */
export function parseQuery(text: string): Query {
  const q = text.trim().replace(/\s+/g, " ");
  const whole = q.match(WHOLE);
  if (whole !== null) {
    const [run, graph, openState] = [whole[1], whole[2], whole[3]].map(Number);
    const start = whole[4] === undefined ? undefined : Number(whole[4]);
    if (run > 0 && safe(run, graph, openState, start ?? 0)) {
      return start === undefined
        ? { kind: "topology", run, graph, openState }
        : { kind: "start", run, graph, openState, start };
    }
  }
  const bare = q.match(BARE);
  if (bare !== null) {
    const [graph, openState] = [bare[1], bare[2]].map(Number);
    const start = bare[3] === undefined ? undefined : Number(bare[3]);
    if (safe(graph, openState, start ?? 0)) return { kind: "bare", graph, openState, start };
  }
  return { kind: "words", words: q.toLowerCase().split(" ").filter(Boolean) };
}

/** Where a row opens. */
export type Target =
  | { to: "run"; run: number }
  | { to: "topology"; run: number; graph: number; openState: number }
  | { to: "start"; run: number; graph: number; openState: number; start: number }
  | { to: "dataset"; id: string }
  | { to: "config"; id: string };

/**
 * A fact at a row's right: words; an RMSE (`val 0.0393`), dotted while it's live; or words that
 * give way to `short` where they'd cut the row's name (KF11).
 */
export type Fact =
  | string
  | { metric: "val" | "train"; value: number; live: boolean }
  | { full: string; short: string };

/** "best on herg-wt", which gives way to "best" (KF11). */
const bestOn = (dataset: string): Fact => ({ full: `best on ${dataset}`, short: "best" });

export type RowIcon = "run" | "result" | "topology" | "dataset" | "config";

/** A row as the palette draws it, on one line. */
export interface Row {
  key: string;
  icon: RowIcon;
  /**
   * What leads the name: a run's `#214`, gray; or a result's `#211/T12.3`
   * and its start, or a topology's `#214/T12.3`, then " in ".
   */
  lead?: { id: string; start?: number };
  /** The name the query's words are marked in, in mono. */
  name: string;
  /** A run whose config was deleted. */
  gone?: boolean;
  /** A run matched through its dataset's name: that name, said after its own (KF10). */
  via?: string;
  facts: Fact[];
  to: Target;
  /** A recently opened row's page, under its name now, which opening it records again. */
  page?: OpenedPage;
}

/** A group's kind, in the order the palette shows them. */
export type GroupKind = "runs" | "results" | "datasets" | "configs";

export const GROUP_KINDS: GroupKind[] = ["runs", "results", "datasets", "configs"];

export const GROUP_LABEL: Record<GroupKind, string> = {
  runs: "Runs",
  results: "Results",
  datasets: "Datasets",
  configs: "Configs",
};

/** What "N more" counts: "2 more runs". */
export const GROUP_NOUN: Record<GroupKind, [string, string]> = {
  runs: ["run", "runs"],
  results: ["result", "results"],
  datasets: ["dataset", "datasets"],
  configs: ["config", "configs"],
};

/** The reads the palette searches; each `undefined` until read. */
export interface Index {
  runs?: RunSummary[];
  /** `runs` is only part of them (Runs' and Home's first pages), so nothing counts by them. */
  runsPartial?: boolean;
  overview?: RunsOverview;
  datasets?: DatasetSummary[];
  configs?: ConfigSummary[];
}

/** A run's state as its row says it: Runs' word, or "canceling" while its cancel stops it. */
export const stateWord = (r: Pick<RunSummary, "state" | "canceling" | "ended_at">) =>
  r.canceling !== null && r.ended_at === null ? "canceling" : r.state;

const has = (text: string | null | undefined, w: string) =>
  text != null && text.toLowerCase().includes(w);

function runHolds(r: RunSummary, w: string): boolean {
  if (w.startsWith("#")) return w === `#${r.id}`;
  if (w === String(r.id)) return true;
  return has(r.config.name, w) || has(r.dataset.name, w) || stateWord(r).includes(w);
}

const runMatches = (r: RunSummary, words: string[]) => words.every((w) => runHolds(r, w));

/** Whether names hold every word between them; `#` words name runs alone. */
const namesHold = (names: (string | null)[], words: string[]) =>
  words.every((w) => !w.startsWith("#") && names.some((n) => has(n, w)));

/**
 * Its place in its group: an exact id or the name typed whole (the query, or one of its words),
 * then a name starting with a word, then the rest.
 */
export function rank(name: string, words: string[], exact = false): number {
  const lower = name.toLowerCase();
  if (exact || lower === words.join(" ") || words.includes(lower)) return 0;
  return words.some((w) => lower.startsWith(w)) ? 1 : 2;
}

export function ranked<T>(items: T[], rankOf: (t: T) => number): T[] {
  return items
    .map((t, i) => ({ t, i, r: rankOf(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}

/** A run's state, then its best: Val RMSE, or Train without validation points; live while in flight. */
function runFacts(r: RunSummary): Fact[] {
  const facts: Fact[] = [stateWord(r)];
  const b = r.best;
  const value = b === null ? null : (b.val_rmse ?? b.train_rmse);
  if (b !== null && value !== null) {
    facts.push({ metric: b.val_rmse !== null ? "val" : "train", value, live: r.ended_at === null });
  }
  return facts;
}

/** A run's row; `words` it matched by, if one is held by its dataset's name alone, name it. */
export function runRow(r: RunSummary, words: string[] = []): Row {
  const throughDataset = words.some(
    (w) =>
      !w.startsWith("#") &&
      w !== String(r.id) &&
      !has(r.config.name, w) &&
      !stateWord(r).includes(w) &&
      has(r.dataset.name, w),
  );
  return {
    key: `run ${r.id}`,
    icon: "run",
    lead: { id: `#${r.id}` },
    name: r.config.name,
    gone: r.config.deleted || undefined,
    via: throughDataset ? (r.dataset.name ?? undefined) : undefined,
    facts: runFacts(r),
    to: { to: "run", run: r.id },
  };
}

const topologyName = (run: number, graph: number, openState: number) =>
  `#${run}/T${graph}.${openState}`;

/** A dataset's best on its current data, by Home's rule: Val RMSE, else Train. */
function bestOf(
  overview: RunsOverview,
  id: string,
): { best: DatasetBest; byTrain: boolean } | undefined {
  const o = overview.datasets.find((d) => d.id === id);
  if (o === undefined || o.deleted) return undefined;
  if (o.best_val !== null) return { best: o.best_val, byTrain: false };
  if (o.best_train !== null) return { best: o.best_train, byTrain: true };
  return undefined;
}

function resultRow(
  d: DatasetSummary,
  { best, byTrain }: { best: DatasetBest; byTrain: boolean },
  runs: RunSummary[] | undefined,
): Row {
  const run = runs?.find((r) => r.id === best.run);
  return {
    key: `result ${d.id}`,
    icon: "result",
    lead: { id: topologyName(best.run, best.graph, best.open_state), start: best.start },
    // Its run's config, once the runs are read.
    name: run?.config.name ?? "",
    facts: [{ metric: byTrain ? "train" : "val", value: best.rmse, live: false }, bestOn(d.name)],
    to: {
      to: "start",
      run: best.run,
      graph: best.graph,
      openState: best.open_state,
      start: best.start,
    },
  };
}

function datasetRow(d: DatasetSummary, overview: RunsOverview | undefined): Row {
  const facts: Fact[] = [plural(d.protocols.length, "protocol", "protocols")];
  if (overview !== undefined) {
    facts.push(plural(overview.datasets.find((o) => o.id === d.id)?.runs ?? 0, "run", "runs"));
  }
  return {
    key: `dataset ${d.id}`,
    icon: "dataset",
    name: d.name,
    facts,
    to: { to: "dataset", id: d.id },
  };
}

function configRow(c: ConfigSummary, runs: RunSummary[] | undefined): Row {
  const facts: Fact[] = [];
  if (c.dataset.name !== null) facts.push(`on ${c.dataset.name}`);
  if (runs !== undefined) {
    facts.push(plural(runs.filter((r) => r.config.id === c.id).length, "run", "runs"));
  }
  return {
    key: `config ${c.id}`,
    icon: "config",
    name: c.name,
    facts,
    to: { to: "config", id: c.id },
  };
}

/** Each group's matches, all of them, in order; `undefined` for a group whose reads aren't in. */
export type Found = Record<GroupKind, Row[] | undefined>;

/** What `words` find in `index`. */
export function search(index: Index, words: string[]): Found {
  const { runs, overview, datasets, configs } = index;
  const exactRun = (r: RunSummary) => words.some((w) => w === `#${r.id}` || w === String(r.id));

  let results: Row[] | undefined;
  if (overview !== undefined && datasets !== undefined) {
    // Home's order: the dataset whose latest run is newest first.
    const latest = new Map(overview.datasets.map((o) => [o.id, o.latest_run]));
    const order = [...datasets].sort((a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0));
    const rows: { row: Row; name: string }[] = [];
    for (const d of order) {
      const best = bestOf(overview, d.id);
      const hit =
        best !== undefined &&
        (namesHold([d.name], words) ||
          (runs ?? []).some((r) => r.dataset.id === d.id && runMatches(r, words)));
      if (hit) rows.push({ row: resultRow(d, best, runs), name: d.name });
    }
    results = ranked(rows, (x) => rank(x.name, words, false)).map((x) => x.row);
  }

  return {
    runs:
      runs === undefined
        ? undefined
        : ranked(
            runs.filter((r) => runMatches(r, words)),
            (r) => rank(r.config.name, words, exactRun(r)),
          ).map((r) => runRow(r, words)),
    results,
    datasets:
      datasets === undefined
        ? undefined
        : ranked(
            datasets.filter((d) => namesHold([d.name], words)),
            (d) => rank(d.name, words, false),
          ).map((d) => datasetRow(d, overview)),
    configs:
      configs === undefined
        ? undefined
        : ranked(
            configs.filter((c) => namesHold([c.name, c.dataset.name], words)),
            (c) => rank(c.name, words, false),
          ).map((c) => configRow(c, index.runsPartial ? undefined : runs)),
  };
}

/** A topology typed whole, as its row says it once read: "in progress · val 0.0481" while it fits. */
export function topologyRow(
  ref: { run: number; graph: number; openState: number },
  run: RunSummary | undefined,
  t: Topology | undefined,
): Row {
  const facts: Fact[] = [];
  if (t !== undefined) {
    if (t.provisional) facts.push("in progress");
    else if (t.state === "failed") facts.push("failed");
    const value = t.best === null ? null : (t.best.val_rmse ?? t.best.train_rmse);
    if (t.best !== null && value !== null) {
      facts.push({
        metric: t.best.val_rmse !== null ? "val" : "train",
        value,
        live: t.provisional,
      });
    }
  }
  return {
    key: "typed topology",
    icon: "topology",
    lead: { id: topologyName(ref.run, ref.graph, ref.openState) },
    name: run?.config.name ?? "",
    facts,
    to: { to: "topology", ...ref },
  };
}

/**
 * A start typed whole: its RMSE once it finished, else its state; and "best on herg-wt" while
 * it's its dataset's best on current data, as Results' rows say.
 */
export function startRow(
  ref: { run: number; graph: number; openState: number; start: number },
  run: RunSummary | undefined,
  s: Start | undefined,
  overview?: RunsOverview,
): Row {
  const facts: Fact[] = [];
  if (s !== undefined) {
    const value = s.val_rmse ?? s.train_rmse;
    if (s.state !== "finished") facts.push(s.state);
    else if (value !== null) {
      facts.push({ metric: s.val_rmse !== null ? "val" : "train", value, live: false });
    }
  }
  const best =
    run === undefined || overview === undefined ? undefined : bestOf(overview, run.dataset.id);
  if (
    best !== undefined &&
    best.best.run === ref.run &&
    best.best.graph === ref.graph &&
    best.best.open_state === ref.openState &&
    best.best.start === ref.start
  ) {
    facts.push(bestOn(run!.dataset.name ?? ""));
  }
  return {
    key: "typed start",
    icon: "result",
    lead: { id: topologyName(ref.run, ref.graph, ref.openState), start: ref.start },
    name: run?.config.name ?? "",
    facts,
    to: { to: "start", ...ref },
  };
}

/** A recently opened page's key: which page it is, whatever its name. */
export function pageKey(p: OpenedPage): string {
  switch (p.kind) {
    case "run":
      return `run ${p.run}`;
    case "topology":
      return `topology ${topologyName(p.run, p.graph, p.open_state)}`;
    case "start":
      return `start ${topologyName(p.run, p.graph, p.open_state)}/${p.start}`;
    case "dataset":
    case "config":
      return `${p.kind} ${p.id}`;
  }
}

/** A recent topology's or start's own read: its answer once in, or that it's gone. */
export interface RecentRead {
  data: Topology | Start | undefined;
  /** Its read answered `not_found`. */
  gone: boolean;
}

/**
 * Recently opened's rows, newest first: each page with its facts as they are now, from the
 * index and its own read. A page deleted since drops out; one whose reads aren't in shows by
 * the name it was opened under. Datasets and configs lead their facts with their kind
 * ("dataset · 2 protocols · 0 runs", "config on herg-wt · 2 runs"), since their names look
 * alike; runs, topologies and starts read as the search's rows do.
 */
export function recentRows(
  pages: OpenedPage[],
  index: Index,
  reads: Map<string, RecentRead>,
): Row[] {
  const { runs, overview, datasets, configs } = index;
  const rows: Row[] = [];
  for (const p of pages) {
    const key = `recent ${pageKey(p)}`;
    if (p.kind === "dataset" || p.kind === "config") {
      if (deleted(p, index, reads)) continue;
      if (p.kind === "dataset") {
        const d = datasets?.find((x) => x.id === p.id);
        const row: Row =
          d === undefined
            ? { key, icon: "dataset", name: p.name, facts: [], to: { to: "dataset", id: p.id } }
            : datasetRow(d, overview);
        rows.push({
          ...row,
          key,
          page: { ...p, name: row.name },
          facts: ["dataset", ...row.facts],
        });
      } else {
        const c = configs?.find((x) => x.id === p.id);
        const row: Row =
          c === undefined
            ? { key, icon: "config", name: p.name, facts: [], to: { to: "config", id: p.id } }
            : configRow(c, index.runsPartial ? undefined : runs);
        const [first, ...rest] = row.facts;
        const facts: Fact[] =
          typeof first === "string" && first.startsWith("on ")
            ? [`config ${first}`, ...rest]
            : ["config", ...row.facts];
        rows.push({ ...row, key, page: { ...p, name: row.name }, facts });
      }
      continue;
    }
    if (deleted(p, index, reads)) continue;
    const run = runs?.find((r) => r.id === p.run);
    const read = reads.get(pageKey(p));
    let row: Row;
    if (p.kind === "run") {
      row =
        run === undefined
          ? {
              key,
              icon: "run",
              lead: { id: `#${p.run}` },
              name: p.name,
              facts: [],
              to: { to: "run", run: p.run },
            }
          : runRow(run);
    } else {
      const ref = { run: p.run, graph: p.graph, openState: p.open_state };
      row =
        p.kind === "topology"
          ? topologyRow(ref, run, read?.data as Topology | undefined)
          : startRow({ ...ref, start: p.start }, run, read?.data as Start | undefined, overview);
      if (run === undefined) row = { ...row, name: p.name };
    }
    rows.push({ ...row, key, page: { ...p, name: row.name } });
  }
  return rows;
}

/** Whether a recent page was deleted since: its reads are in, and it isn't among them. */
function deleted(p: OpenedPage, index: Index, reads: Map<string, RecentRead>): boolean {
  const { runs, datasets, configs } = index;
  if (p.kind === "dataset") return datasets !== undefined && !datasets.some((d) => d.id === p.id);
  if (p.kind === "config") return configs !== undefined && !configs.some((c) => c.id === p.id);
  const runGone = runs !== undefined && !index.runsPartial && !runs.some((r) => r.id === p.run);
  return runGone || reads.get(pageKey(p))?.gone === true;
}

/**
 * The newest recent page dropped as deleted whose name or id holds every word, as it was opened
 * (KF05): a dataset's or config's name, a run's `#213 herg-wt-10state`, a topology's or start's
 * id.
 */
export function deletedRecent(
  pages: OpenedPage[],
  index: Index,
  reads: Map<string, RecentRead>,
  words: string[],
): string | undefined {
  if (words.length === 0) return undefined;
  for (const p of pages) {
    if (!deleted(p, index, reads)) continue;
    if (p.kind === "dataset" || p.kind === "config") {
      if (namesHold([p.name], words)) return p.name;
      continue;
    }
    const id =
      p.kind === "run"
        ? `#${p.run}`
        : `${topologyName(p.run, p.graph, p.open_state)}${p.kind === "start" ? ` · start ${p.start}` : ""}`;
    const holds = words.every((w) =>
      w.startsWith("#") ? p.kind === "run" && w === id : w === String(p.run) || has(p.name, w),
    );
    if (holds) return p.kind === "run" ? `${id} ${p.name}` : id;
  }
  return undefined;
}

/** The words a fact reads as, in full: "val 0.0393", "best on herg-wt". */
export const factWords = (f: Fact) =>
  typeof f === "string" ? f : "full" in f ? f.full : `${f.metric} ${f.value.toFixed(4)}`;
