/**
 * Compare's sentences and tables (LaptopCompare, #54; built in #342): up to
 * three starts, A, B and C, from the session's selection, each with what its
 * run, start, topology and data say. Starts rank only among starts on the
 * same data (ADR-0006): the same dataset's same Ranking group. Nothing here
 * reads; `queries.ts` gathers each `Candidate`.
 */
import { engineVersion } from "../runs/detail";
import { rmse } from "../runs/words";
import type { Bounds, Drift, Point, SpreadSummary, StartState } from "../wire/types.gen";

/** The data a candidate was fit to: its dataset's Ranking group. */
export interface CandidateData {
  dataset: string;
  name: string;
  digest: string;
  /** Whether it's the dataset's current data. */
  current: boolean;
  /** When earlier data was current: "Jul 20 – Aug 4". */
  range: string | undefined;
  /** How many validation points it has; `undefined` where its revision can't be read. */
  validation: number | undefined;
}

/** One protocol of a candidate's data, with its fit and its scores. */
export interface CandidateProtocol {
  name: string;
  /** "G/V activation". */
  label: string;
  logx: boolean;
  points: readonly Point[];
  /** Its model at each point's x, once this computer's engine has drawn it. */
  model: readonly { x: number; value: number | null }[] | undefined;
  /** Its model along its points' x, as its line is drawn (#367); with `model`. */
  line: readonly { x: number; value: number | null }[] | undefined;
  /** Its RMSEs as the run stored them; `null` for a failed sweep, or no points. */
  val: number | null;
  train: number | null;
}

export interface Candidate {
  run: number;
  graph: number;
  openState: number;
  start: number;
  runName: string;
  numStates: number;
  edges: number | undefined;
  population: number | undefined;
  /** Each start's evaluations. */
  budget: number | undefined;
  data: CandidateData;
  state: StartState;
  val: number | null;
  train: number | null;
  stillImproving: boolean | null;
  change: number | null;
  /** Where it ranks in its topology by Train RMSE among the finished starts. */
  place: { best: boolean; rank: number | undefined; of: number };
  topology: {
    fitting: boolean;
    starts: number;
    finished: number;
    nearBest: number | null;
    spread: SpreadSummary | null;
    /** From its first array to its last start's end, or now while it fits. */
    wallS: number | null;
    /** Its Top 10's raw best vectors, the lowest Train RMSE first (ADR-0021). */
    top10: readonly (readonly number[])[];
    /** Each parameter's spread over its Top 10, in layout order; `null` with fewer than 2. */
    spreads: readonly (number | null)[] | null;
  };
  /** Its raw best vector (ADR-0007), `null` before its first generation is logged. */
  best: readonly number[] | null;
  /** Its run's parameter box; `undefined` where a newer ICMM submitted it. */
  bounds: Bounds | undefined;
  /** Its dataset revision's number. */
  revision: number;
  /**
   * Its data's protocols, in its revision's order. Where its revision can't be read, those its run
   * recorded, with their stored scores and no points; `undefined` where it stored none.
   */
  protocols: CandidateProtocol[] | undefined;
  unreadable: "missing" | "damaged" | "newer" | undefined;
  drift: Drift | null;
  /** Its fit can be drawn, and this computer's engine hasn't drawn it yet. */
  drawing: boolean;
}

export const LETTERS = ["A", "B", "C"] as const;

/** Each candidate's line: its stroke and dash, as LaptopCompare draws them. */
export const SLOTS = [
  { stroke: "var(--cobalt)", dash: "" },
  { stroke: "var(--cobalt-2)", dash: "6 3" },
  { stroke: "var(--cobalt-2)", dash: "1.5 2.5" },
] as const;

const n = (x: number) => x.toLocaleString("en-US");

/** "a, b and c". */
export function and(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** `#214/T12.3`. */
export const topologyName = (c: Pick<Candidate, "run" | "graph" | "openState">) =>
  `#${c.run}/T${c.graph}.${c.openState}`;

/** `#214/T12.3 · start 23`. */
export const candidateName = (c: Candidate) => `${topologyName(c)} · start ${c.start}`;

const dataKey = (d: CandidateData) => `${d.dataset}/${d.digest}`;

/**
 * The one topology two or more candidates share (#361): the same states, line index and open
 * state, so their parameters line up. `oneRun` when one run fit them all, so they share its
 * Top 10; its name is then the run's (`#214/T12.3`), else the topology's alone (`T9.3`).
 */
export function sharedTopology(
  candidates: readonly Candidate[],
): { name: string; oneRun: boolean } | undefined {
  const [first] = candidates;
  if (candidates.length < 2) return undefined;
  const same = candidates.every(
    (c) =>
      c.numStates === first.numStates && c.graph === first.graph && c.openState === first.openState,
  );
  if (!same) return undefined;
  const oneRun = candidates.every((c) => c.run === first.run);
  return { name: oneRun ? topologyName(first) : `T${first.graph}.${first.openState}`, oneRun };
}

const ranksByVal = (d: CandidateData) => d.validation !== 0;

// ── the data ──────────────────────────────────────────────────────────────────────────────────

export interface DataGroup {
  key: string;
  data: CandidateData;
  /** Which candidates are on it, by index and letter. */
  members: number[];
  letters: string[];
  /** On a chip: "herg-wt", or "herg-wt · Jul 20 – Aug 4". */
  label: string;
  /** In a row or a column head: "herg-wt", or its earlier data's "Jul 20 – Aug 4". */
  short: string;
  /** On Points from: "herg-wt", or "herg-wt, Jul 20 – Aug 4". */
  seg: string;
}

/** The candidates' data, in the order each first appears. */
export function dataOf(candidates: readonly Candidate[]): DataGroup[] {
  const groups: DataGroup[] = [];
  candidates.forEach((c, i) => {
    const key = dataKey(c.data);
    let g = groups.find((x) => x.key === key);
    if (g === undefined) {
      const d = c.data;
      g = {
        key,
        data: d,
        members: [],
        letters: [],
        label: d.current ? d.name : `${d.name} · ${d.range}`,
        short: d.name,
        seg: d.current ? d.name : `${d.name}, ${d.range}`,
      };
      groups.push(g);
    }
    g.members.push(i);
    g.letters.push(LETTERS[i]);
  });
  for (const g of groups) {
    if (g.data.current) continue;
    // Its range alone is enough beside another of its dataset's data.
    const kin = groups.some((x) => x !== g && x.data.dataset === g.data.dataset);
    g.short = kin ? g.data.range! : g.label;
  }
  return groups;
}

/** Whether the candidates' data differ, so each RMSE names its data. */
export const spans = (candidates: readonly Candidate[]) => dataOf(candidates).length > 1;

// ── the heading's facts ───────────────────────────────────────────────────────────────────────

const counted = ["none", "one", "two", "three"];

/**
 * "3 starts on herg-wt · 1 of their topologies still fitting", "3 starts on
 * herg-wt and herg-wt-interp", "3 starts on herg-wt, one on its earlier
 * data", "2 starts of #214/T12.3 on herg-wt · their topology still fitting".
 */
export function factsOf(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) return "Nothing in the selection yet";
  const groups = dataOf(candidates);
  const count = candidates.length;
  const starts = `${n(count)} start${count === 1 ? "" : "s"}`;
  const topologies = [...new Set(candidates.map(topologyName))];
  const shared = sharedTopology(candidates);
  const datasets = [...new Set(groups.map((g) => g.data.name))];
  let on = `on ${and(datasets)}`;
  if (datasets.length === 1 && groups.length > 1) {
    const earlier = candidates.filter((c) => !c.data.current).length;
    on += `, ${counted[earlier] ?? n(earlier)} on its earlier data`;
  } else if (groups.length === 1 && !groups[0].data.current) {
    on = `on ${datasets[0]}’s earlier data`;
  }
  const head = shared === undefined ? `${starts} ${on}` : `${starts} of ${shared.name} ${on}`;
  const fitting = new Set(candidates.filter((c) => c.topology.fitting).map(topologyName)).size;
  const still =
    fitting === 0
      ? undefined
      : topologies.length === 1
        ? count === 1
          ? "its topology still fitting"
          : "their topology still fitting"
        : `${n(fitting)} of their topologies still fitting`;
  const noVal = groups.every((g) => g.data.validation === 0)
    ? `no validation points, so Train RMSE compares ${count === 1 ? "it" : "them"}`
    : undefined;
  return [head, noVal, still].filter((x) => x !== undefined).join(" · ");
}

// ── the note when the data differ ─────────────────────────────────────────────────────────────

const TAIL =
  "Each RMSE is scored on its own data, so the lowest is marked only among starts on the same data.";

/** Under the fit's heading when the candidates' data differ: what differs, and why it matters. */
export function caveatOf(
  candidates: readonly Candidate[],
): { lead: string; rest: string } | undefined {
  const groups = dataOf(candidates);
  if (groups.length < 2) return undefined;
  const datasets = new Set(groups.map((g) => g.data.dataset));
  if (datasets.size === groups.length) {
    const counts = groups.map(
      (g) =>
        `${g.data.name} ${g.data.validation === undefined ? "?" : g.data.validation === 0 ? "none" : n(g.data.validation)}`,
    );
    return { lead: "Validated on different points:", rest: `${counts.join(", ")}. ${TAIL}` };
  }
  // Earlier data first, each ranking on its own; then current data.
  const ordered = [
    ...groups.filter((g) => !g.data.current),
    ...groups.filter((g) => g.data.current),
  ];
  let named: string | undefined;
  const clauses = ordered.map((g) => {
    const who = and(g.letters);
    const d = g.data;
    const its = named === d.dataset ? "its" : `${d.name}’s`;
    named = d.dataset;
    if (!d.current) {
      const one = g.letters.length === 1;
      return `${who} to ${its} data from ${d.range}, which ${one ? "ranks" : "rank"} on ${one ? "its" : "their"} own`;
    }
    const kin = groups.some((x) => x !== g && x.data.dataset === d.dataset);
    return kin ? `${who} to ${its} current data` : `${who} to ${d.name}`;
  });
  return { lead: "Fit to different data:", rest: `${clauses.join("; ")}. ${TAIL}` };
}

// ── the lowest ────────────────────────────────────────────────────────────────────────────────

/**
 * Which of `values`, one per candidate, is marked the lowest: among the
 * candidates on the same data, never across. On one data, the lowest of any
 * that have one; across data, only where two or more on the same data do.
 */
export function lowestOf(
  candidates: readonly Candidate[],
  values: readonly (number | null | undefined)[],
): boolean[] {
  const marked = candidates.map(() => false);
  if (candidates.length < 2) return marked;
  const groups = dataOf(candidates);
  const span = groups.length > 1;
  for (const g of groups) {
    const scored = g.members.filter((i) => values[i] != null);
    if (scored.length < (span ? 2 : 1)) continue;
    const low = Math.min(...scored.map((i) => values[i]!));
    for (const i of scored) if (values[i] === low) marked[i] = true;
  }
  return marked;
}

// ── each protocol's fit ───────────────────────────────────────────────────────────────────────

export interface ProtocolRow {
  letter: string;
  /** Its data, when the candidates' data differ; or why it has no fit here. */
  note: string;
  /** "0.0043", "—" for a failed sweep, or empty where it has no such protocol. */
  value: string;
  /**
   * Which RMSE its value is, when the candidates rank by different metrics: its data's, so a
   * candidate reads the same word on every chart. `undefined` without a value, or on one metric.
   */
  metric: "val" | "train" | undefined;
  lowest: boolean;
}

export interface ShownProtocol {
  name: string;
  label: string;
  logx: boolean;
  /** The points the chart draws: those of Points from's data, or the first that has it. */
  points: readonly Point[];
  /** Under its name, when Points from's data lack it: "Not in herg-wt-37c: herg-wt’s points". */
  from: string | undefined;
  /** What its chart's prose says the fits are over: "the data", or "herg-wt’s points, as herg-wt-37c lacks it". */
  over: string;
  /** Each candidate's line, in order: `undefined` where it has none to draw. */
  lines: (
    | {
        model: readonly { x: number; value: number | null }[];
        line: readonly { x: number; value: number | null }[];
        data: readonly Point[];
      }
    | undefined
  )[];
  /**
   * Which RMSE the rows read, when it's one: Val, or Train where no candidate's data has
   * validation points. `undefined` when they rank by different metrics, and each row says its own.
   */
  metric: "Val" | "Train" | undefined;
  rows: ProtocolRow[];
}

/**
 * Each protocol any candidate's data has, lined up by name in the order they
 * first appear; `pointsFrom` is the index of the data group whose points the
 * charts draw. A candidate's row reads its ranking RMSE as its run stored it:
 * Val, or Train for data without validation points.
 */
export function protocolsOf(candidates: readonly Candidate[], pointsFrom: number): ShownProtocol[] {
  const groups = dataOf(candidates);
  const span = groups.length > 1;
  const shown = groups[Math.min(pointsFrom, groups.length - 1)];
  const names: string[] = [];
  for (const c of candidates) {
    for (const p of c.protocols ?? []) if (!names.includes(p.name)) names.push(p.name);
  }
  const byVal = groups.map((g) => ranksByVal(g.data));
  const mixed = byVal.includes(true) && byVal.includes(false);
  return names.map((name) => {
    const own = candidates.map((c) => c.protocols?.find((p) => p.name === name));
    // An unreadable candidate's protocol has its scores but no points, so its chart draws the
    // first readable one's.
    const read = own.map((p, i) => (candidates[i].unreadable === undefined ? p : undefined));
    const readAt = read.findIndex((p) => p !== undefined);
    const at = readAt >= 0 ? readAt : own.findIndex((p) => p !== undefined);
    const first = own[at]!;
    const mine = shown?.members.map((i) => read[i]).find((p) => p !== undefined);
    const from = mine ?? first;
    const drawn = groups.find((g) => g.members.includes(at))!;
    // Points from's data lack it, so its chart draws the first data that has it: none, where
    // only an unreadable revision has it.
    const other = mine === undefined && shown !== undefined && readAt >= 0;
    const values = candidates.map((c, i) =>
      own[i] === undefined ? undefined : ranksByVal(c.data) ? own[i]!.val : own[i]!.train,
    );
    const lowest = lowestOf(candidates, values);
    return {
      name,
      label: first.label,
      logx: first.logx,
      points: from.points,
      from: other ? `Not in ${shown.label}: ${drawn.label}’s points` : undefined,
      over: other ? `${drawn.label}’s points, as ${shown.label} lacks it` : "the data",
      lines: candidates.map((c, i) => {
        const p = own[i];
        return p?.model === undefined || p.line === undefined || c.unreadable !== undefined
          ? undefined
          : { model: p.model, line: p.line, data: p.points };
      }),
      metric: mixed ? undefined : byVal.includes(true) ? "Val" : "Train",
      rows: candidates.map((c, i) => {
        const group = groups.find((g) => g.members.includes(i))!;
        const v = values[i];
        return {
          letter: LETTERS[i],
          note:
            c.protocols === undefined
              ? "not drawn"
              : own[i] === undefined
                ? `not in ${c.data.name}`
                : span
                  ? group.short
                  : "",
          value: own[i] === undefined ? "" : v === null || v === undefined ? "—" : rmse(v),
          metric: !mixed || own[i] === undefined ? undefined : ranksByVal(c.data) ? "val" : "train",
          lowest: lowest[i],
        };
      }),
    };
  });
}

/** Under the fit: what its rows read, and the mark. */
export function fitFoot(candidates: readonly Candidate[]): { says: string; low: string } {
  const groups = dataOf(candidates);
  const without = [...new Set(groups.filter((g) => !ranksByVal(g.data)).map((g) => g.data.name))];
  const has = (k: number) => (k === 1 ? "has" : "have");
  const says =
    without.length === 0
      ? "Val RMSE per protocol."
      : without.length === groups.length
        ? `Train RMSE per protocol: ${and(without)} ${has(without.length)} no validation points.`
        : `Val RMSE per protocol; Train RMSE for ${and(without)}, which ${has(without.length)} no validation points.`;
  return {
    says,
    low:
      groups.length > 1
        ? "marks the lowest among starts on the same data."
        : "marks the lowest for each protocol.",
  };
}

// ── Metrics ───────────────────────────────────────────────────────────────────────────────────

export interface MetricCell {
  text: string;
  mono: boolean;
  lowest: boolean;
  /** A number that can still change, its topology still fitting: underlined, with a hover (#373). */
  live: boolean;
  /** Still improving's mark. */
  improving: boolean;
  /** Run's cell links to its run. */
  run?: number;
  title?: string;
}

export interface MetricRow {
  label: string;
  /** For the row's own look: the run's is two lines. */
  kind?: "run";
  cells: MetricCell[];
}

const cell = (text: string, o: Partial<MetricCell> = {}): MetricCell => ({
  text,
  mono: true,
  lowest: false,
  live: false,
  improving: false,
  ...o,
});

/** "−1.8 %": a change, its sign kept, to a tenth of a percent. */
function percent(x: number): string {
  const p = Math.round(x * 1000) / 10;
  return `${p < 0 ? "−" : p > 0 ? "+" : ""}${Math.abs(p).toFixed(1)} %`;
}

/** "48 m", "1 h 06 m", "2 h 38 m"; past a day, "2 d 4 h". */
export function topologyWall(seconds: number): string {
  if (!(seconds >= 60)) return "under a minute";
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 24) {
    const hours = Math.round(minutes / 60);
    return `${Math.floor(hours / 24)} d` + (hours % 24 ? ` ${hours % 24} h` : "");
  }
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} m`;
}

/**
 * "Best start", "2 of 64 by Train RMSE", "… so far" while its topology fits (#373), or the state
 * of a start that hasn't finished.
 */
function placeWords(c: Candidate): string {
  if (c.state !== "finished") return c.state;
  const so = c.topology.fitting ? " so far" : "";
  if (c.place.best) return `Best start${so}`;
  return c.place.rank === undefined
    ? "—"
    : `${n(c.place.rank)} of ${n(c.place.of)} by Train RMSE${so}`;
}

/**
 * Metrics, a column per candidate. Val RMSE (where any data has validation
 * points), Train RMSE, Validation points (where the data differ), Still
 * improving (while Settings marks it), then each start's place and its run's
 * and topology's numbers. While its topology fits, its place says "so far"
 * and its wall time is live; its counts of finished starts stay plain (#373).
 */
export function metricsOf(
  candidates: readonly Candidate[],
  o: { marking: boolean; now: number },
): MetricRow[] {
  const groups = dataOf(candidates);
  const span = groups.length > 1;
  const anyVal = groups.some((g) => ranksByVal(g.data));
  const byVal = candidates.map((c) => ranksByVal(c.data));
  const valLow = lowestOf(
    candidates,
    candidates.map((c, i) => (byVal[i] ? c.val : undefined)),
  );
  const trainLow = lowestOf(
    candidates,
    candidates.map((c, i) => (byVal[i] ? undefined : c.train)),
  );
  const rows: MetricRow[] = [];
  if (anyVal) {
    rows.push({
      label: "Val RMSE",
      cells: candidates.map((c, i) =>
        !byVal[i]
          ? cell("—", { title: `${c.data.name} has no validation points` })
          : c.val === null
            ? cell("—", { title: "A validation sweep failed" })
            : cell(rmse(c.val), { lowest: valLow[i] }),
      ),
    });
  }
  rows.push({
    label: "Train RMSE",
    cells: candidates.map((c, i) =>
      c.train === null ? cell("—") : cell(rmse(c.train), { lowest: trainLow[i] }),
    ),
  });
  if (span) {
    rows.push({
      label: "Validation points",
      cells: candidates.map((c) =>
        cell(c.data.validation === undefined ? "—" : n(c.data.validation)),
      ),
    });
  }
  if (o.marking) {
    rows.push({
      label: "Still improving",
      cells: candidates.map((c) => {
        if (c.stillImproving === null) return cell("—");
        const by = c.change === null ? "" : ` · ${percent(c.change)}`;
        return c.stillImproving ? cell(`yes${by}`, { improving: true }) : cell(`no${by}`);
      }),
    });
  }
  rows.push({
    label: "In its topology",
    cells: candidates.map((c) => cell(placeWords(c), { mono: false })),
  });
  rows.push({
    label: "Run",
    kind: "run",
    cells: candidates.map((c) => cell(c.runName, { run: c.run, title: `#${c.run} ${c.runName}` })),
  });
  rows.push({
    label: "States · Params",
    cells: candidates.map((c) =>
      cell(`${c.numStates} · ${c.edges === undefined ? "—" : 2 * c.numStates + 2 * c.edges + 2}`),
    ),
  });
  rows.push({
    label: "CMA-ES population",
    cells: candidates.map((c) => cell(c.population === undefined ? "—" : n(c.population))),
  });
  rows.push({
    label: "Starts finished",
    cells: candidates.map((c) => cell(`${n(c.topology.finished)} / ${n(c.topology.starts)}`)),
  });
  rows.push({
    label: "Near best · within 1 %",
    cells: candidates.map((c) =>
      cell(
        c.topology.nearBest === null
          ? "—"
          : `${n(c.topology.nearBest)} / ${n(c.topology.finished)}`,
      ),
    ),
  });
  rows.push({
    label: "Topology wall time",
    cells: candidates.map((c) =>
      cell(c.topology.wallS === null ? "—" : topologyWall(c.topology.wallS), {
        live: c.topology.fitting,
      }),
    ),
  });
  return rows;
}

/** Under Metrics: the mark, Still improving's rule while it's on, and what "—" means. */
export function metricsFoot(
  candidates: readonly Candidate[],
  marking: boolean,
): { low: string; improving: string | undefined; dash: string | undefined } {
  const span = dataOf(candidates).length > 1;
  const budgets = [...new Set(candidates.map((c) => c.budget))];
  const tenth =
    budgets.length === 1 && budgets[0] !== undefined
      ? `its last ${n(Math.round(budgets[0] / 10))} evaluations`
      : "the last 10 % of its evaluations";
  return {
    low: span ? "marks the lowest among starts on the same data." : "marks the lowest.",
    improving: marking
      ? `Still improving: its Train RMSE fell more than 1 % over ${tenth}.`
      : undefined,
    dash: candidates.some((c) => ranksByVal(c.data) && c.val === null)
      ? "“—”: a validation sweep failed, so it has no Val RMSE."
      : undefined,
  };
}

// ── Drift and revisions that can't be read ────────────────────────────────────────────────────

const engineWords = (key: string | null) => {
  const v = engineVersion(key);
  return v === undefined ? undefined : `ICMM ${v}`;
};

/**
 * A candidate's warning: its sentence, by its letter. A revision a newer ICMM saved has two
 * links after `text` (#360, #361), "Get the newest ICMM to draw it, or see herg-wt’s
 * revisions.", the second to `newer`'s dataset; then `tail`. Drift names its protocols in
 * `names`, between `text` and `tail`, each in mono as the Start page's Drift box has them (#453).
 */
export interface Warning {
  letter: string;
  text: string;
  names?: readonly string[];
  newer?: { dataset: string; name: string };
  tail?: string;
}

const STORED = "Its scores below are the ones its run stored.";

/** A sentence for each candidate whose curves differ from its scores, or can't be drawn. */
export function warningsOf(candidates: readonly Candidate[]): Warning[] {
  return candidates.flatMap((c, i): Warning[] => {
    const letter = LETTERS[i];
    if (c.unreadable !== undefined) {
      const which = `${c.data.name}’s revision ${c.revision}`;
      const why =
        c.unreadable === "newer"
          ? "was saved by a newer ICMM"
          : c.unreadable === "missing"
            ? "isn’t in the Data folder any more"
            : "is damaged";
      const text = `${which} ${why}, so start ${c.start}’s fit can’t be drawn here.`;
      return c.unreadable === "newer"
        ? [{ letter, text, newer: { dataset: c.data.dataset, name: c.data.name }, tail: STORED }]
        : [{ letter, text: `${text} ${STORED}` }];
    }
    if (c.drift === null) return [];
    const drawn = engineWords(c.drift.drawn_engine);
    const fit = engineWords(c.drift.fit_engine);
    return [
      {
        letter,
        text: `Drawn by this computer’s engine${drawn === undefined ? "" : ` (${drawn})`}, start ${c.start}’s errors for`,
        names: c.drift.protocols,
        tail: `differ from the stored ones${fit === undefined ? "" : `, scored by ${fit}`}.`,
      },
    ];
  });
}

// ── Export figures… ───────────────────────────────────────────────────────────────────────────

/** "herg-wt-compare": the folder the save dialog proposes. */
export const exportFolderName = (candidates: readonly Candidate[]) =>
  `${candidates[0]?.data.name ?? "icmm"}-compare`;
