/**
 * What Topology says of a run's topology, `#214/T12.3` (LaptopTopology,
 * #233; built in #238): its stage, its status line and fact tiles, its
 * starts' squares and the list that counts them, how its finished starts
 * ended, and its Best starts and Failed rows. Run detail (#237) says a topology's stage
 * with `stageOf` and `stageLook` too, so it reads the same on both pages.
 */
import { whole } from "../../configs/words";
import { inSentence, onPlatform } from "../../setup/form";
import { aboutWords, durationWords, plural } from "../../submit/estimate";
import { clock } from "../../ui/clock";
import type {
  FailedStarts,
  RunSummary,
  SavedPlatform,
  StartCause,
  StartSummary,
  Topology,
  TopologyBest,
} from "../../wire/types.gen";
import { counted, rmse } from "../words";

type Platform = Pick<SavedPlatform, "type" | "name">;

/**
 * Where a topology stands, as its glyph and word say it: the wire's `state`,
 * with a fitting one whose starts all wait at the scheduler queued (held,
 * while its run is held on a policy or for space), one not sent yet `next`
 * only when it goes out after those out now, and, on a run that ended, the
 * one it was fitting unfinished and those it never sent not fitted.
 */
export type Stage =
  | "fitting"
  | "queued"
  | "held"
  | "next"
  | "waiting"
  | "complete"
  | "failed"
  | "unfinished"
  | "not fitted";

type Staged = Pick<
  Topology,
  "state" | "position" | "starts_running" | "starts_finished" | "starts_failed" | "starts_queued"
>;

export function stageOf(t: Staged, run: Pick<RunSummary, "ended_at" | "progress" | "held">): Stage {
  if (t.state === "complete" || t.state === "failed") return t.state;
  if (run.ended_at !== null) return t.state === "fitting" ? "unfinished" : "not fitted";
  if (t.state === "fitting") {
    const begun = t.starts_running + t.starts_finished + t.starts_failed > 0;
    if (begun || t.starts_queued === 0) return "fitting";
    return run.held !== null ? "held" : "queued";
  }
  return t.position === sentOf(run) ? "next" : "waiting";
}

/** How many of the run's topologies have gone out: they go out in order (old ADR-0030). */
function sentOf(run: Pick<RunSummary, "progress">): number {
  const p = run.progress;
  return p.topologies_complete + p.topologies_failed + p.topologies_fitting;
}

/** How many topologies go out before one not sent yet. */
export const aheadOf = (t: Pick<Topology, "position">, run: Pick<RunSummary, "progress">) =>
  Math.max(0, t.position - sentOf(run));

const LOOKS: Record<Stage, { word: string; glyph: string }> = {
  fitting: { word: "fitting", glyph: "g g-running live" },
  queued: { word: "queued", glyph: "g g-queued" },
  held: { word: "held", glyph: "g g-held" },
  next: { word: "next", glyph: "g g-next" },
  waiting: { word: "waiting", glyph: "g g-wait" },
  complete: { word: "complete", glyph: "g g-completed" },
  failed: { word: "failed", glyph: "g g-failed" },
  unfinished: { word: "unfinished", glyph: "g g-canceled" },
  "not fitted": { word: "not fitted", glyph: "g g-off" },
};

/** A stage's word and glyph, as its class names it. */
export const stageLook = (stage: Stage): { word: string; glyph: string } => LOOKS[stage];

// ── the status line ───────────────────────────────────────────────────────────────────────────

/** A piece of a line: its numbers set in mono (`n`), the scheduler's own word as it says it (`raw`). */
export interface Part {
  t: string;
  cls?: "n" | "raw" | "n vbest" | "tx";
  /** A number that can still change while the topology fits: underlined, with a hover (#373). */
  live?: true;
}

export interface StatusContext {
  run: Pick<
    RunSummary,
    "id" | "state" | "ended_at" | "queued" | "held" | "canceling" | "progress" | "first_running_at"
  >;
  platform: Platform;
  /** Whether the Active platform's scheduler is SLURM. */
  slurm: boolean;
  /** The partition its starts go to; `null` where there's none or it isn't known. */
  partition: string | null;
  /** The Running-starts cap: per run on SLURM, shared by all runs on This computer. */
  cap: number | undefined;
  now: number;
  /** When its last start ends, estimated; none while it can't be said. */
  eta?: number;
  /** For a topology next: the one ahead of it, and in how long its queue empties, in seconds. */
  ahead?: { name: string; inAbout?: number };
  /** For a failed topology: its failed starts by cause, most first. */
  causes?: FailedStarts[];
  /** While not connected: when the page was last read. */
  asOf?: number;
}

/**
 * When a topology sent at `sent` (ms) began fitting, as its "took" counts it
 * (#507, F11): when it went out, or its run's first start running, if later,
 * so a topology sent while its run waited queued behind another run doesn't
 * count that wait.
 */
export function fitFrom(sent: number, run: Pick<RunSummary, "first_running_at">): number {
  const began = run.first_running_at === null ? NaN : Date.parse(run.first_running_at);
  return Number.isNaN(began) ? sent : Math.max(sent, began);
}

/** What follows the status word: " · SLURM array 4482163 · 16 running (run cap) · sent 9:04 AM · …". */
export function statusParts(stage: Stage, t: Topology, a: StatusContext): Part[] {
  const parts: Part[] = [];
  const say = (text: string, cls?: Part["cls"]) => parts.push(cls ? { t: text, cls } : { t: text });
  const at = (iso: string | null) => (iso === null ? undefined : Date.parse(iso));
  const when = (iso: string | null) => clock(Date.parse(iso!), a.now);
  const sent = at(t.first_sent_at);
  const ended = at(t.last_ended_at);
  const arrays = () => {
    const ids = t.arrays.flatMap((x) => (x.job_id === null ? [] : [x.job_id]));
    if (!a.slurm || ids.length === 0) return;
    say(ids.length === 1 ? " · SLURM array " : " · SLURM arrays ");
    ids.forEach((id, i) => {
      if (i > 0) say(", ");
      say(id, "n");
    });
  };
  const where = inSentence(a.platform);
  const sentAt = () => sent !== undefined && say(` · sent ${clock(sent, a.now)}`);
  const ending = () => {
    if (a.eta === undefined) return;
    const left = durationWords(Math.max(0, (a.eta - a.now) / 1000));
    say(` · ETA ${clock(a.eta, a.now)} · ${left} left`);
  };
  const runEnded = () => {
    const how = a.run.state === "failed" ? "failed" : "was canceled";
    return `run #${a.run.id} ${how} at ${when(a.run.ended_at)}`;
  };

  switch (stage) {
    case "fitting":
      if (a.slurm) {
        arrays();
        say(" · ");
        say(whole(t.starts_running), "n");
        say(a.cap !== undefined && t.starts_running >= a.cap ? " running (run cap)" : " running");
      } else {
        say(` · on ${where} · `);
        say(whole(t.starts_running), "n");
        say(` running, shared by all runs ${onPlatform(a.platform)}`);
      }
      sentAt();
      if (a.run.canceling !== null) say(" · canceling: its starts are stopping");
      else ending();
      break;
    case "held": {
      if (a.slurm) arrays();
      else say(` · on ${where}`);
      const hold = a.run.held;
      say(` · ${heldWords(hold)}`);
      sentAt();
      if (hold?.kind === "scheduler" && hold.reason !== null) {
        say(" · ");
        say(hold.reason, "raw");
      }
      break;
    }
    case "queued": {
      if (a.slurm) {
        arrays();
        const reason = a.run.queued?.reason ?? null;
        say(` · ${queuedWords(reason, a.partition)}`);
        sentAt();
        if (reason !== null) {
          say(" · ");
          say(reason, "raw");
        }
      } else {
        say(` · on ${where} · waiting for a slot`);
        sentAt();
      }
      break;
    }
    case "next":
      say(` · its ${plural(t.starts, "start", "starts")} go out `);
      if (a.ahead === undefined) say("next");
      else {
        say(`when ${a.ahead.name}’s queue empties`);
        if (a.ahead.inAbout !== undefined) say(`, in ${aboutWords(a.ahead.inAbout)}`);
      }
      break;
    case "waiting": {
      const before = aheadOf(t, a.run);
      say(" · not sent yet · ");
      say(whole(before), "n");
      say(before === 1 ? " topology goes out before it" : " topologies go out before it");
      break;
    }
    case "complete":
      if (a.slurm) arrays();
      else say(` · on ${where}`);
      sentAt();
      if (ended !== undefined) say(` · ended ${clock(ended, a.now)}`);
      if (sent !== undefined && ended !== undefined) {
        say(` · took ${durationWords(Math.max(0, ended - fitFrom(sent, a.run)) / 1000)}`);
      }
      break;
    case "failed":
      say(` · all ${plural(t.starts, "start", "starts")} failed`);
      if (a.causes !== undefined && a.causes.length > 0)
        say(`: ${a.causes.map(counted).join(", ")}`);
      if (a.slurm) arrays();
      else say(` · on ${where}`);
      sentAt();
      if (ended !== undefined) say(` · ended ${clock(ended, a.now)}`);
      break;
    case "unfinished":
      say(` · ${runEnded()}, with `);
      say(whole(t.starts_finished), "n");
      say(` of ${plural(t.starts, "start", "starts")} finished`);
      break;
    case "not fitted":
      say(` · ${runEnded()}, before this topology went out`);
      break;
  }
  if (a.asOf !== undefined) say(` · as of ${clock(a.asOf, a.now)}`);
  return parts;
}

/** Why a held run's starts wait, in plain words: "held at your cluster job limit". */
export function heldWords(hold: RunSummary["held"]): string {
  if (hold === null) return "held";
  if (hold.kind === "space") return "held for space";
  const code = (hold.reason ?? "").split(",")[0].trim();
  if (code === "QOSMaxJobsPerUserLimit") return "held at your cluster job limit";
  if (code === "AssocMaxJobsLimit") return "held at your account’s job limit";
  return "held by the cluster";
}

/** Why a queued topology's starts wait, in plain words: "waiting for free nodes on general-cpu". */
export function queuedWords(reason: string | null, partition: string | null): string {
  const on = partition === null ? "" : ` on ${partition}`;
  switch (reason) {
    case "Resources":
      return `waiting for free nodes${on}`;
    case "Priority":
      return `waiting for its turn${on}`;
    case "JobArrayTaskLimit":
      return "waiting for room in its own array";
    default:
      return `queued${on}`;
  }
}

// ── the fact tiles ────────────────────────────────────────────────────────────────────────────

export interface Tile {
  label: string;
  /** Its lines, one `dd` each: the rank's two, every other tile's one. */
  lines: Part[][];
  /**
   * The one tile whose live number is a Tab stop naming the hover, while it fits: the RMSE
   * that ranks, as Val on Results (#370). Every live number opens it on hover (#373).
   */
  tab?: true;
}

/**
 * The header's tiles. With a Best start: its rank (by val RMSE, or train
 * without validation points) in its run and in its run's Ranking group, the
 * Best start, its RMSEs with the one that ranks in cobalt, how many finished
 * starts are near best, and the median spread. While it fits (`live`), every
 * number that can still change is underlined (#370, #373); the count of
 * finished starts near best stays plain. With none: why it doesn't rank, and
 * how many finished, and for a failed topology, its failures.
 */
export function tilesOf(
  t: Topology,
  a: {
    validation: boolean;
    run: Pick<RunSummary, "id" | "dataset">;
    causes?: FailedStarts[];
    live?: boolean;
  },
): Tile[] {
  const n = (x: string): Part => ({ t: x, cls: "n" });
  // A number that can still change while it fits.
  const lv = (x: string): Part => (a.live ? { t: x, cls: "n", live: true } : n(x));
  const best = t.best;
  if (best === null) {
    const tiles: Tile[] = [
      {
        label: "Rank",
        lines: [[{ t: t.state === "failed" ? "doesn’t rank" : "not ranked yet", cls: "tx" }]],
      },
      { label: "Finished", lines: [[n("0"), { t: ` of ${whole(t.starts)}` }]] },
    ];
    const causes = a.causes ?? [];
    if (t.state === "failed" && causes.length > 0) {
      const [first, ...rest] = causes.map(counted);
      const gap = first.indexOf(" ");
      const tail = [first.slice(gap), ...rest].join(", ");
      tiles.push({ label: "Failed", lines: [[n(first.slice(0, gap)), { t: tail }]] });
    }
    return tiles;
  }
  const value = (x: number | null) => (x === null ? "—" : rmse(x));
  const ranking = (x: number | null): Part => ({
    t: value(x),
    cls: "n vbest",
    ...(a.live ? { live: true as const } : {}),
  });
  const rank = (x: number | null) => lv(x === null ? "—" : whole(x));
  const tab = a.live === true ? ({ tab: true } as const) : {};
  const tiles: Tile[] = [
    {
      label: a.validation ? "Rank by val RMSE" : "Rank by train RMSE",
      lines: [
        [rank(t.rank), { t: ` of ${whole(t.ranked)} in #${a.run.id}` }],
        [rank(t.group_rank), { t: ` of ${whole(t.group_ranked)} on ${groupWords(a.run.dataset)}` }],
      ],
    },
    { label: "Best start", lines: [[lv(String(best.start))]] },
    a.validation
      ? { label: "Train RMSE", lines: [[lv(value(best.train_rmse))]] }
      : { label: "Train RMSE", lines: [[ranking(best.train_rmse)]], ...tab },
  ];
  if (a.validation) {
    tiles.push({ label: "Val RMSE", lines: [[ranking(best.val_rmse)]], ...tab });
  }
  tiles.push(
    {
      label: "Within 1 % of best",
      lines: [
        [
          n(t.near_best === null ? "—" : whole(t.near_best)),
          { t: ` of ${whole(t.starts_finished)}` },
        ],
      ],
    },
    {
      label: "Spread",
      lines: [[lv(t.spread === null ? "—" : t.spread.median.toFixed(2))]],
    },
  );
  return tiles;
}

/**
 * The run's Ranking group, as a Best start's page names it: "herg-wt", its
 * "’s earlier data", or ", deleted"; a dataset this platform never had, by its id.
 */
function groupWords(d: RunSummary["dataset"]): string {
  const which = d.deleted ? ", deleted" : d.earlier ? "’s earlier data" : "";
  return `${d.name ?? d.id}${which}`;
}

// ── the starts grid ───────────────────────────────────────────────────────────────────────────

/** How a start's square looks: finished near or further from best, then its state. */
export type Kind = "near" | "far" | "running" | "queued" | "failed" | "canceled" | "unsent";

export interface Square {
  start: number;
  kind: Kind;
  /** The Best start, outlined. */
  best: boolean;
  /** Its tooltip and its name for a screen reader. */
  title: string;
  /** A sent start opens its page, a finished one's its Result (#346); one never sent, nothing. */
  to: "start" | null;
  /** A finished start still improving at its end, marked while Mark still-improving starts is on. */
  improving: boolean;
}

/** A start is near best within 1 % of the Best start's Train RMSE (ADR-0021). */
export function isNear(train: number | null, best: Pick<TopologyBest, "train_rmse"> | null) {
  return train !== null && best?.train_rmse != null && train <= best.train_rmse * 1.01 + 1e-12;
}

/** "1st", "2nd", "3rd", "4th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** A failed start's cause, as its row and square say it. */
export const CAUSE: Record<StartCause, string> = {
  out_of_memory: "out of memory",
  time_limit: "time limit",
  lost: "node failure",
  error: "error",
};

const unfitted = (stage: Stage) => stage === "unfinished" || stage === "not fitted";

/** How a still-improving start's mark reads, on its square and in Best starts (#234). */
export const STILL_IMPROVING = "still improving at its end";

/** Whether `s` is marked: finished still improving, while Mark still-improving starts is on. */
const marked = (s: StartSummary, mark = false) =>
  mark && s.state === "finished" && s.still_improving === true;

export function squaresOf(
  starts: StartSummary[],
  a: {
    best: TopologyBest | null;
    stage: Stage;
    /** Without SLURM, the platform whose slots its queued starts wait for: This computer, or an SSH host. */
    local?: Platform;
    /** For a queued or held topology on SLURM: what its starts wait for, in plain words. */
    waiting?: string;
    /** Mark still-improving starts (#234). */
    mark?: boolean;
  },
): Square[] {
  const queued = a.local
    ? `queued on ${inSentence(a.local)}, waiting for a slot`
    : (a.stage === "queued" || a.stage === "held") && a.waiting !== undefined
      ? `queued · ${a.waiting}`
      : "queued on the cluster";
  return starts.map((s) => {
    const name = `Start ${s.start}`;
    const square = (
      kind: Kind,
      words: string,
      to: Square["to"],
      best = false,
      improving = false,
    ): Square => ({
      start: s.start,
      kind,
      best,
      title: `${name} · ${words}`,
      to,
      improving,
    });
    switch (s.state) {
      case "finished": {
        const near = isNear(s.train_rmse, a.best);
        const best = a.best?.start === s.start;
        const train = `train ${s.train_rmse === null ? "—" : rmse(s.train_rmse)}`;
        const improving = marked(s, a.mark);
        const words = [
          train,
          near ? "within 1 % of best" : "",
          best ? "best" : "",
          improving ? STILL_IMPROVING : "",
        ].filter(Boolean);
        return square(near ? "near" : "far", words.join(" · "), "start", best, improving);
      }
      case "running":
        return square(
          "running",
          s.try_number > 1 ? `running · ${ordinal(s.try_number)} try` : "running",
          "start",
        );
      case "queued":
        return square("queued", queued, "start");
      case "failed":
        return square("failed", `failed · ${s.cause === null ? "error" : CAUSE[s.cause]}`, "start");
      case "canceled":
        return square("canceled", "canceled · not counted", "start");
      case "waiting":
        return s.try_number > 0
          ? square("unsent", "waiting to go out again", "start")
          : square("unsent", unfitted(a.stage) ? "not fitted" : "not sent yet", null);
    }
  });
}

export interface Count {
  n: string;
  word: string;
}

/** How many starts stand each way, for the grid's sentence: finished always while it fits, then those present. */
export function countsOf(starts: StartSummary[], stage: Stage): Count[] {
  const of = (state: StartSummary["state"]) => starts.filter((s) => s.state === state).length;
  const counts: Count[] = [];
  const nF = of("finished");
  if (nF > 0 || stage === "fitting" || stage === "complete" || stage === "unfinished") {
    counts.push({ n: whole(nF), word: "finished" });
  }
  const shown: [StartSummary["state"], string][] = [
    ["running", "running"],
    ["queued", "queued"],
    ["failed", "failed"],
    ["canceled", "canceled"],
    ["waiting", unfitted(stage) ? "not fitted" : "not sent yet"],
  ];
  for (const [state, word] of shown) {
    if (of(state) > 0) counts.push({ n: whole(of(state)), word });
  }
  return counts;
}

/** A row of the Starts list: its kind's swatch, its count and its words. */
export interface Listed {
  kind: Kind | "improving";
  n: string;
  word: string;
  /** After its words, quieter: "1 on its 2nd try", "not counted". */
  sub?: string;
  /** Failed, its count in red. */
  red?: true;
}

/**
 * The Starts list beside the grid, its counts and its legend in one (#359):
 * the kinds present, finished both near and further from best, then how many
 * are marked still improving at the end (#234), and the rest.
 */
export function listOf(
  starts: StartSummary[],
  stage: Stage,
  a: {
    best: Pick<TopologyBest, "train_rmse"> | null;
    /** Without SLURM, the platform whose slots its queued starts wait for. */
    local?: Platform;
    /** Mark still-improving starts (#234). */
    mark?: boolean;
  },
): Listed[] {
  const of = (state: StartSummary["state"]) => starts.filter((s) => s.state === state);
  const rows: Listed[] = [];
  const row = (kind: Listed["kind"], n: number, word: string, more: Partial<Listed> = {}) =>
    n > 0 && rows.push({ kind, n: whole(n), word, ...more });
  const finished = of("finished");
  if (finished.length > 0) {
    const near = finished.filter((s) => isNear(s.train_rmse, a.best)).length;
    rows.push(
      { kind: "near", n: whole(near), word: "finished within 1 % of best" },
      { kind: "far", n: whole(finished.length - near), word: "finished, further from best" },
    );
  }
  row("improving", starts.filter((s) => marked(s, a.mark)).length, "still improving at the end");
  const running = of("running");
  const later = running.filter((s) => s.try_number > 1);
  const tries = new Set(later.map((s) => s.try_number));
  const sub =
    later.length === 0
      ? undefined
      : tries.size > 1
        ? `${whole(later.length)} on a later try`
        : `${whole(later.length)} on ${later.length === 1 ? "its" : "their"} ${ordinal(later[0].try_number)} try`;
  row("running", running.length, "running", sub === undefined ? {} : { sub });
  row(
    "queued",
    of("queued").length,
    a.local ? `queued on ${inSentence(a.local)}` : "queued on the cluster",
  );
  row("failed", of("failed").length, "failed", { sub: "not counted", red: true });
  row("canceled", of("canceled").length, "canceled", { sub: "not counted" });
  row("unsent", of("waiting").length, unfitted(stage) ? "not fitted" : "not sent yet");
  return rows;
}

/** The hint beside Starts, and the grid's sentence for a screen reader. */
export function gridWords(counts: Count[], starts: number): { hint: string; aria: string } {
  const sent = counts.some(
    (c) => c.word !== "not sent yet" && c.word !== "not fitted" && c.n !== "0",
  );
  const listed = counts.map((c) => `${c.n} ${c.word}`).join(", ");
  return {
    hint: sent ? "select one to open it" : "none has gone out yet",
    aria: `${plural(starts, "start", "starts")}: ${listed}.${sent ? " Each sent start opens its page." : ""}`,
  };
}

// ── how the finished starts ended, and Best starts ────────────────────────────────────────────

/** The finished starts with a Train RMSE, lowest first: a failed sweep's "—" ranks after every number. */
function byTrain(starts: StartSummary[]): StartSummary[] {
  const done = starts.filter((s) => s.state === "finished");
  return done.sort(
    (x, y) => (x.train_rmse ?? Infinity) - (y.train_rmse ?? Infinity) || x.start - y.start,
  );
}

/** Under the dot chart: how many finished starts ended within 1, 10 and 50 % of the best, further, and the median's. */
export function endedOf(
  starts: StartSummary[],
  best: Pick<TopologyBest, "train_rmse">,
): { of: number; c1: number; c10: number; c50: number; far: number; median: string } {
  const trains = byTrain(starts).flatMap((s) => (s.train_rmse === null ? [] : [s.train_rmse]));
  const b = best.train_rmse ?? trains[0] ?? 0;
  const within = (f: number) => trains.filter((x) => x <= b * f + 1e-12).length;
  const c50 = within(1.5);
  return {
    of: trains.length,
    c1: within(1.01),
    c10: within(1.1),
    c50,
    far: trains.length - c50,
    median: trains.length === 0 ? "—" : rmse(trains[Math.floor((trains.length - 1) / 2)]),
  };
}

export interface BestRow {
  rank: number;
  start: number;
  train: string;
  val: string;
  /** Its Train RMSE over the best's: "+0.05 %"; "—" for the best and a failed sweep. */
  delta: string;
  wall: Part[];
  /** The Best start, in cobalt. */
  best: boolean;
  /** Still improving at its end, marked before Train while Mark still-improving starts is on. */
  improving: boolean;
}

/** A wall time: "21 m 57 s", or "1 h 23 m" from an hour, its numbers in mono. */
function wallParts(seconds: number | null): Part[] {
  if (seconds === null) return [{ t: "—" }];
  const s = Math.round(seconds);
  const n = (x: number): Part => ({ t: String(x), cls: "n" });
  if (s < 3600) return [n(Math.floor(s / 60)), { t: " m " }, n(s % 60), { t: " s" }];
  return [n(Math.floor(s / 3600)), { t: " h " }, n(Math.floor((s % 3600) / 60)), { t: " m" }];
}

/**
 * Best starts' rows: the finished starts by Train RMSE, each against the
 * topology's Best start's, which `read_topology` names; a start that finished
 * since it was read can rank above it for a moment.
 */
export function bestRowsOf(
  starts: StartSummary[],
  best: Pick<TopologyBest, "start" | "train_rmse"> | null,
  mark = false,
): BestRow[] {
  const top = best?.train_rmse ?? null;
  return byTrain(starts).map((s, i) => {
    const isBest = s.start === best?.start;
    const pct =
      top === null || top === 0 || s.train_rmse === null ? null : (s.train_rmse / top - 1) * 100;
    const size = pct === null ? 0 : Math.abs(pct);
    const shown = size.toFixed(size < 0.1 ? 2 : size < 10 ? 1 : 0);
    // A share that rounds to none has no sign: "0.00 %", never "−0.00 %".
    const sign = pct === null || Number(shown) === 0 ? "" : pct < 0 ? "−" : "+";
    const delta = isBest || pct === null ? "—" : `${sign}${shown} %`;
    return {
      rank: i + 1,
      start: s.start,
      train: s.train_rmse === null ? "—" : rmse(s.train_rmse),
      val: s.val_rmse === null ? "—" : rmse(s.val_rmse),
      delta,
      wall: wallParts(s.elapsed_s),
      best: isBest,
      improving: marked(s, mark),
    };
  });
}

/** The tracks Best starts and Failed share, in px: Rank, Start and Train. */
export interface Tracks {
  rank: number;
  start: number;
  train: number;
}

/** How wide `chars` characters of IBM Plex Mono are at `px`: every glyph is 0.6 em. */
const mono = (chars: number, px: number) => (chars * px * 6) / 10;

/**
 * Best starts' first three tracks, which Failed shares so its Start and Train
 * sit under Best starts' (#359): each its widest entry, head or cell, plus
 * 8 px, as Results' leaderboard sizes its columns (#358). Train widens by the
 * still-improving ↓ and its gap where a row is `marked`. The rest of each
 * table's tracks the browser sizes to their content.
 */
export function tracksOf(best: BestRow[], failed: FailedRow[], marked: boolean): Tracks {
  const widest = (head: string, cells: string[], px: number, extra = 0) =>
    Math.ceil(Math.max(mono(head.length, 13), ...cells.map((c) => mono(c.length, px) + extra))) + 8;
  const starts = [...best, ...failed].map((r) => String(r.start));
  return {
    rank: widest(
      "Rank",
      best.map((r) => String(r.rank)),
      13,
    ),
    start: widest("Start", starts, 14),
    train: widest(
      "Train",
      [...best.map((r) => r.train), ...failed.map(() => "—")],
      14,
      marked ? 16 : 0,
    ),
  };
}

/** Beside Best starts: "64 finished, by train RMSE · 16 still running · 2 canceled". */
export function bestSub(starts: StartSummary[], stage: Stage): string {
  const count = (state: StartSummary["state"]) => starts.filter((s) => s.state === state).length;
  const nF = count("finished");
  if (nF === 0) return stage === "failed" ? "none finished" : "none finished yet";
  const nR = count("running");
  const nC = count("canceled");
  return [
    `${whole(nF)} finished, by train RMSE`,
    nR > 0 ? `${whole(nR)} still running` : "",
    nC > 0 ? `${whole(nC)} canceled` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── the Failed group ──────────────────────────────────────────────────────────────────────────

export interface FailedRow {
  start: number;
  /** Its latest try: "1st", "3rd". */
  tryWord: string;
  cause: string;
  /** What happened, from what the scheduler kept of its latest try. */
  why: string;
}

/** Memory as Platform settings asks for it, in GB of 1024 MB: "4 GB". */
export function memoryWords(mb: number): string {
  if (mb < 1024) return `${whole(mb)} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** Evaluations, short: "870k", "1.2 M". */
export function evaluationsWords(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))} M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return whole(n);
}

function whyOf(s: StartSummary): string {
  const r = s.ran_with;
  const on = r?.node ? ` on ${r.node}` : "";
  switch (s.cause) {
    case "out_of_memory": {
      const memory = r?.memory_mb == null ? "" : ` ${memoryWords(r.memory_mb)}`;
      const ran =
        r?.started_at && r.ended_at
          ? ` after ${durationWords((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)}`
          : "";
      return `used all${memory} of its memory${on}${ran}`;
    }
    case "time_limit": {
      const limit = r?.time_limit_min == null ? "" : ` ${durationWords(r.time_limit_min * 60)}`;
      const at = s.evaluations === null ? "" : ` at ${evaluationsWords(s.evaluations)} evaluations`;
      const so = s.train_rmse === null ? "" : ` · best so far ${rmse(s.train_rmse)}`;
      return `hit its${limit} limit${on}${at}${so}`;
    }
    case "lost": {
      const state = r?.scheduler_state ? ` (${r.scheduler_state})` : "";
      const last = r?.node ? ` · the last on ${r.node}${state}` : state;
      return `lost ${plural(s.try_number, "time", "times")}${last}`;
    }
    case "error":
    case null:
      return r?.exit_code == null ? "stopped with an error" : `exit code ${r.exit_code}`;
  }
}

/** The Failed group's rows, by start. */
export function failedRowsOf(starts: StartSummary[]): FailedRow[] {
  return starts
    .filter((s) => s.state === "failed")
    .map((s) => ({
      start: s.start,
      tryWord: ordinal(Math.max(1, s.try_number)),
      cause: s.cause === null ? "error" : CAUSE[s.cause],
      why: whyOf(s),
    }));
}

const ALL: Record<StartCause, string> = {
  error: "all with the same error",
  out_of_memory: "all out of memory",
  time_limit: "all at the time limit",
  lost: "all lost by the cluster",
};

/** Beside Failed: they don't count, and Resume fits them again; a failed topology's one cause. */
export function failedSub(stage: Stage, causes: FailedStarts[], runEnded: boolean): string {
  if (stage === "failed") {
    const opens = "each opens its start, with its log";
    return causes.length === 1 ? `${ALL[causes[0].cause]} · ${opens}` : opens;
  }
  return runEnded
    ? "not counted · Resume fits them again"
    : "not counted · Resume fits them again once the run has ended";
}

/** A topology's failed starts counted by cause, most first. */
export function causesOf(starts: StartSummary[]): FailedStarts[] {
  const by = new Map<StartCause, number>();
  for (const s of starts) {
    if (s.state === "failed") by.set(s.cause ?? "error", (by.get(s.cause ?? "error") ?? 0) + 1);
  }
  return [...by].map(([cause, n]) => ({ cause, starts: n })).sort((x, y) => y.starts - x.starts);
}

// ── before a start has finished ───────────────────────────────────────────────────────────────

/** What the dot chart and Best starts say with no start finished; `table` is none for a failed topology. */
export function emptyWords(
  stage: Stage,
  starts: number,
  causes: FailedStarts[],
): { dist: string; distMeta: string; table: string | undefined } {
  if (stage === "failed") {
    const errors = causes.length === 1 && causes[0].cause === "error";
    return {
      dist: "No start finished, so there’s nothing to show here.",
      distMeta: errors
        ? `All ${whole(starts)} stopped with an error. Each one’s error and log are below.`
        : `All ${whole(starts)} failed. Each one’s cause and log are below.`,
      table: undefined,
    };
  }
  return {
    dist: "No start has finished yet.",
    distMeta: "Each finished start’s final train RMSE shows here as a dot.",
    table: "None has finished yet. Finished starts list here, lowest train RMSE first.",
  };
}

// ── when it ends ──────────────────────────────────────────────────────────────────────────────

/**
 * When the topology's last start ends: each start takes the median time of its
 * finished starts with what a start takes beside its evaluations (`overheadS`,
 * #508), or `perStartS`, the platform's, before one has finished; the running
 * ones counted from when they began, the rest taking the slots as they free;
 * as many slots as run now, or `slots` while none does. `undefined` with
 * nothing left to run, or no time per start to go by.
 */
export function etaOf(
  starts: StartSummary[],
  a: { now: number; slots: number; overheadS: number; perStartS?: number },
): number | undefined {
  const times = starts
    .flatMap((s) => (s.state === "finished" && s.elapsed_s !== null ? [s.elapsed_s] : []))
    .sort((x, y) => x - y);
  const per =
    times.length > 0 ? times[Math.floor((times.length - 1) / 2)] + a.overheadS : a.perStartS;
  const running = starts.filter((s) => s.state === "running");
  const left = starts.filter((s) => s.state === "queued" || s.state === "waiting").length;
  if (per === undefined || running.length + left === 0) return undefined;
  const ms = per * 1000;
  const free = running.map((s) => {
    const began = s.ran_with?.started_at ? Date.parse(s.ran_with.started_at) : a.now;
    return Math.max(a.now, began + ms);
  });
  while (free.length < (running.length > 0 ? running.length : Math.max(1, a.slots)))
    free.push(a.now);
  let last = Math.max(...free);
  for (let i = 0; i < left; i++) {
    free.sort((x, y) => x - y);
    free[0] += ms;
    last = Math.max(last, free[0]);
  }
  return last;
}

/**
 * In how long, in seconds, the topology ahead has sent its last start: its
 * `waiting` take `slots` at a time, the first a half start in. `undefined`
 * with none waiting, or no time per start to go by.
 */
export function queueEmptiesIn(
  waiting: number,
  slots: number,
  perStartS: number | undefined,
): number | undefined {
  if (waiting <= 0 || perStartS === undefined) return undefined;
  return (Math.ceil(waiting / Math.max(1, slots)) - 0.5) * perStartS;
}

// ── a revision that can't be read ─────────────────────────────────────────────────────────────

/**
 * Under the heading: why this run's starts don't draw their fits (nothing on
 * Topology simulates). A newer ICMM's revision is `NewerRevision`'s.
 */
export function unreadableWords(
  dataset: string | null,
  revision: number,
  problem: "missing" | "damaged",
): string {
  const which = `${dataset ?? "Its dataset"}’s revision ${revision}`;
  const so = "so this run’s starts don’t draw their fits.";
  switch (problem) {
    case "missing":
      return `${which} isn’t in the Data folder any more, ${so}`;
    case "damaged":
      return `${which} is damaged, ${so}`;
  }
}
