/**
 * What the Start page says of a start, `#214/T12.3 · start 71` (LaptopStart,
 * #196; built in #239): where it stands, its status line, its tiles, why it
 * ended, where it runs, and the tail of its Start log. Each reads the start as
 * `read_start` has it and its Start log as far as it's been read.
 */
import { whole } from "../../configs/words";
import { inSentence } from "../../setup/form";
import { durationWords, evaluationsPerStart, plural } from "../../submit/estimate";
import { clock } from "../../ui/clock";
import type {
  GroupRank,
  Run,
  SavedPlatform,
  Start,
  StartLogPoint,
  StartSummary,
} from "../../wire/types.gen";
import { TOP_TEN } from "./charts";
import { evaluationsWords, memoryWords, ordinal, queuedWords, type Part } from "../topology/words";
import { exitCode, rmse } from "../words";

export type { Part };

type Platform = Pick<SavedPlatform, "type" | "name">;

/**
 * Where a start stands, as its page draws it: not sent yet, waiting at the
 * scheduler, running before its first log point and after, finished (its
 * page its Result, #346), or ended short for its cause.
 */
export type Phase =
  | "waiting"
  | "queued"
  | "starting"
  | "running"
  | "finished"
  | "canceled"
  | "time_limit"
  | "out_of_memory"
  | "lost"
  | "error";

export function phaseOf(s: Pick<Start, "state" | "cause">, logged: boolean): Phase {
  switch (s.state) {
    case "waiting":
    case "queued":
    case "finished":
    case "canceled":
      return s.state;
    case "running":
      return logged ? "running" : "starting";
    case "failed":
      return s.cause ?? "error";
  }
}

/** Whether the start has stopped short: it shows its best so far, which never counts. */
export const endedShort = (p: Phase) =>
  p === "canceled" || p === "time_limit" || p === "out_of_memory" || p === "lost" || p === "error";

const LOOKS: Record<Phase, { word: string; glyph: string; red?: boolean }> = {
  waiting: { word: "waiting", glyph: "g g-wait" },
  queued: { word: "queued", glyph: "g g-queued" },
  starting: { word: "running", glyph: "g g-running" },
  running: { word: "running", glyph: "g g-running" },
  finished: { word: "finished", glyph: "g g-completed" },
  canceled: { word: "canceled", glyph: "g g-canceled" },
  time_limit: { word: "failed · time limit", glyph: "g g-failed", red: true },
  out_of_memory: { word: "failed · out of memory", glyph: "g g-failed", red: true },
  lost: { word: "failed · node failure", glyph: "g g-failed", red: true },
  error: { word: "failed · error", glyph: "g g-failed", red: true },
};

/** A phase's word and glyph, and whether it's said in red. */
export const lookOf = (p: Phase) => LOOKS[p];

/** What the page reads a start by. */
export interface StartContext {
  run: Pick<
    Run,
    | "id"
    | "state"
    | "ended_at"
    | "queued"
    | "validation"
    | "settings"
    | "dataset"
    | "num_states"
    | "protocols"
  >;
  start: Start;
  /** Its latest try's Start log as read so far, oldest first. */
  points: StartLogPoint[];
  platform: Platform;
  /** Whether SLURM runs its starts; else they're processes on the platform, which has no jobs. */
  slurm: boolean;
  now: number;
  /** While not connected: when the page was last read. */
  asOf?: number;
}

/** Each start's evaluations, from its run's settings; `undefined` from a newer ICMM's. */
export function budgetOf(run: Pick<Run, "settings">): number | undefined {
  const search = run.settings?.search;
  if (search === undefined) return undefined;
  return evaluationsPerStart(search.evaluation_budget, search.population);
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const at = (iso: string | null | undefined) => (iso == null ? undefined : Date.parse(iso));

/**
 * When a running start ends, from its pace so far: its latest point's
 * evaluations a second since its first, and what of its budget is left.
 * `undefined` before two log points, or without when it started.
 */
export function etaOf(c: StartContext): number | undefined {
  const first = c.points[0];
  const latest = last(c.points);
  const budget = budgetOf(c.run);
  const started = at(c.start.ran_with?.started_at);
  if (first === undefined || latest === undefined || budget === undefined || started === undefined)
    return undefined;
  const seconds = latest.elapsed_s - first.elapsed_s;
  const done = latest.evaluations - first.evaluations;
  if (!(seconds > 0) || !(done > 0)) return undefined;
  const left = Math.max(0, budget - latest.evaluations) / (done / seconds);
  return started + (latest.elapsed_s + left) * 1000;
}

/** How far it got: "870k of 1 M evaluations", "before its first generation". */
function reached(c: StartContext): string {
  const latest = last(c.points);
  const budget = budgetOf(c.run);
  const evaluations = latest?.evaluations ?? c.start.evaluations;
  if (evaluations === null || evaluations === undefined || evaluations === 0)
    return "before its first generation";
  const of = budget === undefined ? "" : ` of ${evaluationsWords(budget)}`;
  return `at ${evaluationsWords(evaluations)}${of} evaluations`;
}

/** Why a start whose end reason is `overflow` ended early, yet finished (#468, #478). */
export const OVERFLOWED = "CMA-ES’s step size overflowed";

/** Whether it has a best to show, which never counts once it stopped short. */
const hasBest = (c: StartContext) => c.start.best !== null || c.points.length > 0;

/** "2nd try, after node c07 failed NODE_FAIL": a later try, and how the one before it ended. */
function tryParts(start: Start): Part[] {
  if (start.try_number < 2) return [];
  const parts: Part[] = [{ t: ` · ${ordinal(start.try_number)} try` }];
  const b = start.before;
  if (b === null) return parts;
  const on = b.node === null ? "" : ` on ${b.node}`;
  switch (b.cause) {
    case "lost":
      parts.push({
        t: b.node === null ? ", after the cluster lost it" : `, after node ${b.node} failed`,
      });
      if (b.scheduler_state !== null) parts.push({ t: " " }, { t: b.scheduler_state, cls: "raw" });
      break;
    case "time_limit":
      parts.push({ t: `, after its time limit${on}` });
      break;
    case "out_of_memory":
      parts.push({ t: `, after it ran out of memory${on}` });
      break;
    case "error":
      parts.push({ t: `, after an error${on}` });
      break;
    case null:
      break;
  }
  return parts;
}

/** Why a queued start waits, in plain words; the scheduler gives its reason for its run's starts. */
function waitingWords(reason: string | null): string {
  if (reason === null) return "waiting for SLURM to start it";
  return reason === "Resources" ? "waiting for nodes to free up" : queuedWords(reason, null);
}

/** "SLURM job 4482163_71 on c07", or "on this computer", "on Lab workstation". */
function whereParts(c: StartContext): Part[] {
  const r = c.start.ran_with;
  if (!c.slurm || r?.job_id == null) return [{ t: ` · on ${inSentence(c.platform)}` }];
  const parts: Part[] = [{ t: " · SLURM job " }, { t: r.job_id, cls: "n" }];
  if (r.node !== null) parts.push({ t: " on " }, { t: r.node, cls: "n" });
  return parts;
}

/**
 * What follows the status word: " · SLURM job 4482163_71 on c07 · started
 * 10:31 AM · ETA …". A finished start says when it ended and how long it
 * took, and `bestOf` names the topology it's the Best start of: "#214/T12.3".
 */
export function statusParts(phase: Phase, c: StartContext, bestOf?: string): Part[] {
  const parts: Part[] = [];
  const say = (t: string, cls?: Part["cls"]) => parts.push(cls ? { t, cls } : { t });
  const r = c.start.ran_with;
  const started = at(r?.started_at);
  const ended = at(r?.ended_at);
  const notCounted = () => hasBest(c) && say(" · not counted");
  if (c.asOf !== undefined) say(` · as of ${clock(c.asOf, c.now)}`);
  switch (phase) {
    case "waiting":
      say(" · not sent yet: it goes out as a slot frees up");
      break;
    case "queued": {
      if (!c.slurm) {
        say(` · on ${inSentence(c.platform)} · waiting for a slot`);
        break;
      }
      if (r?.job_id != null) {
        say(" · SLURM job ");
        say(r.job_id, "n");
      }
      const reason = c.run.queued?.reason ?? null;
      say(` · ${waitingWords(reason)}`);
      if (reason !== null) {
        say(" · ");
        say(reason, "raw");
      }
      break;
    }
    case "starting":
    case "running":
    case "finished": {
      if (phase === "finished" && bestOf !== undefined) say(` · best start of ${bestOf}`);
      if (phase === "finished" && c.start.end_reason === "overflow")
        say(` · ended ${reached(c)}: ${OVERFLOWED}`);
      parts.push(...tryParts(c.start), ...whereParts(c));
      if (started !== undefined) say(` · started ${clock(started, c.now)}`);
      if (phase === "finished" && ended !== undefined) {
        say(` · ended ${clock(ended, c.now)}`);
        const took =
          tookSeconds(c) ?? (started === undefined ? undefined : (ended - started) / 1000);
        if (took !== undefined) {
          say(" · took ");
          parts.push(...wallParts(took));
        }
      }
      if (phase === "starting") say(" · starting up");
      if (phase === "running") {
        const eta = etaOf(c);
        if (eta !== undefined) {
          const left = durationWords(Math.max(0, (eta - c.now) / 1000));
          say(` · ETA ${clock(eta, c.now)} · ${left} left`);
        }
      }
      break;
    }
    case "canceled": {
      notCounted();
      const when = at(c.run.ended_at) ?? ended;
      say(" · the run was canceled");
      if (when !== undefined) say(` at ${clock(when, c.now)}`);
      const how = reached(c);
      say(how.startsWith("at ") ? `, after ${how.slice(3)}` : `, ${how}`);
      break;
    }
    case "time_limit": {
      notCounted();
      const limit = r?.time_limit_min == null ? "" : ` ${durationWords(r.time_limit_min * 60)}`;
      say(` · hit its${limit} limit`);
      if (r?.node != null) {
        say(" on ");
        say(r.node, "n");
      }
      say(` ${reached(c)}`);
      break;
    }
    case "out_of_memory": {
      notCounted();
      const memory = r?.memory_mb == null ? "" : ` ${memoryWords(r.memory_mb)}`;
      say(` · used all${memory} of its memory`);
      if (r?.node != null) {
        say(" on ");
        say(r.node, "n");
      }
      say(` ${reached(c)}`);
      break;
    }
    case "lost":
      say(` · lost by the cluster on ${plural(c.start.try_number, "try", "tries")}`);
      if (r?.node != null) {
        say(", the last on ");
        say(r.node, "n");
      }
      if (r?.scheduler_state != null) {
        say(" ");
        say(r.scheduler_state, "raw");
      }
      break;
    case "error": {
      notCounted();
      say(r?.exit_code == null ? " · stopped with an error" : ` · exit code ${exitCode(r.exit_code)}`);
      say(` ${reached(c)}`);
      parts.push(...whereParts(c));
      if (ended !== undefined) say(` · ended ${clock(ended, c.now)}`);
      break;
    }
  }
  return parts;
}

// ── the tiles ─────────────────────────────────────────────────────────────────────────────────

export interface Tile {
  label: string;
  parts: Part[];
  /** Evaluations' bar: how much of the budget is done, and how it's drawn. */
  bar?: { done: number; look: "live" | "ended" | "red" | "still" };
}

/** A share as the tiles say it: "+0.9 %", "−2.1 %"; one that rounds to none, "0.0 %", unsigned. */
export function signedPercent(x: number): string {
  const p = Math.abs(x * 100).toFixed(1);
  if (Number(p) === 0) return `${p} %`;
  return `${x < 0 ? "−" : "+"}${p} %`;
}

/**
 * The budget's last tenth (#360, RF19): the window a finished start's
 * still-improving mark weighs (`start.py`'s, from generation 9/10 of its
 * budget), so a finished start's is its stored `still_improving_change`.
 * Another's covers its latest tenth of the budget, from the last log point at
 * or before a tenth back, and names the span it covers where that's over half
 * again a tenth ("Last 10k of 20k", logged every 10k); before it has run a
 * tenth, it's "not yet". So does
 * one whose step size overflowed: its stored change is null, as it ended
 * before the budget's last tenth (#478).
 */
function lastTenth(phase: Phase, c: StartContext): Tile {
  const budget = budgetOf(c.run);
  const dash: Part[] = [{ t: "—", cls: "n" }];
  if (budget === undefined) return { label: "Last tenth", parts: dash };
  const span = budget / 10;
  const label = `Last tenth · ${evaluationsWords(span)} of ${evaluationsWords(budget)}`;
  const change = (x: number): Part[] => [
    { t: signedPercent(x), cls: "n" },
    { t: " train RMSE", cls: "tx" },
  ];
  if (phase === "finished" && c.start.end_reason !== "overflow") {
    const stored = c.start.still_improving_change;
    return { label, parts: stored === null ? dash : change(stored) };
  }
  const latest = last(c.points);
  if (latest === undefined) return { label, parts: dash };
  if (latest.evaluations < span) {
    return {
      label,
      parts: [
        { t: "not yet", cls: "tx" },
        { t: ` · from ${evaluationsWords(span)}`, cls: "tx" },
      ],
    };
  }
  const from = c.points.filter((p) => p.evaluations <= latest.evaluations - span).pop();
  const start = from ?? c.points[0];
  // Logged so sparsely that its points span more than half again a tenth, the label names what
  // they cover (F16); a log point's usual overshoot of a tenth keeps "Last tenth".
  const covered = latest.evaluations - start.evaluations;
  const named =
    covered <= span * 1.5
      ? label
      : `Last ${evaluationsWords(covered)} of ${evaluationsWords(budget)}`;
  if (start === latest || start.train_rmse === null || latest.train_rmse === null)
    return { label: named, parts: dash };
  if (!(start.train_rmse > 0)) return { label: named, parts: dash };
  return { label: named, parts: change(latest.train_rmse / start.train_rmse - 1) };
}

/**
 * Where a finished start stands: the Best start by its topology's rank in
 * its Ranking group (`read_group_rank`, once read), another by its place
 * among its topology's finished starts by Train RMSE.
 */
export type Standing =
  | {
      best: true;
      rank: Pick<GroupRank, "rank" | "ranked" | "current"> | undefined;
      /** Its run's dataset, "herg-wt", and whether it's been deleted since. */
      dataset: { name: string; deleted: boolean };
    }
  | { best: false; place: { n: number; of: number } | undefined };

/**
 * The topology's finished starts by Train RMSE, the lowest first: "—", a
 * failed sweep's, after every number, and ties by index.
 */
export function byTrain(starts: readonly StartSummary[]): StartSummary[] {
  return starts
    .filter((s) => s.state === "finished")
    .sort(
      (a, b) =>
        (a.train_rmse ?? Infinity) - (b.train_rmse ?? Infinity) ||
        (a.train_rmse === null ? 1 : 0) - (b.train_rmse === null ? 1 : 0) ||
        a.start - b.start,
    );
}

/** A finished start's place among its topology's finished starts by Train RMSE, and the next one's. */
export function placeOf(
  starts: readonly StartSummary[] | undefined,
  start: number,
): { n: number; of: number; next: number | undefined } | undefined {
  if (starts === undefined) return undefined;
  const ranked = byTrain(starts);
  const i = ranked.findIndex((s) => s.start === start);
  return i < 0 ? undefined : { n: i + 1, of: ranked.length, next: ranked[i + 1]?.start };
}

/**
 * The way one place down by Train RMSE (#360, RF17): "Next worse: start 31 ·
 * 39th by Train", or on the Best start, "Next best: start 5 · 2nd by Train";
 * none from the last place. `title` names the topology, "#214/T12.3".
 */
export function nextDown(
  place: { n: number; next: number | undefined } | undefined,
  best: boolean,
  title: string,
): { label: string; aria: string } | undefined {
  if (place?.next === undefined) return undefined;
  const word = best ? "Next best" : "Next worse";
  const at = ordinal(place.n + 1);
  return {
    label: `${word}: start ${place.next} · ${at} by Train`,
    aria: `${word} in ${title}: start ${place.next}, ${at} by Train RMSE`,
  };
}

/**
 * The Best start's rank: "3", then " of 187 on herg-wt"; on earlier data
 * "’s earlier data", a deleted dataset's ", deleted", and ", by Train RMSE"
 * without validation points, which rank by it. "—" until it's read.
 */
function rankParts(s: Extract<Standing, { best: true }>, validation: boolean): Part[] {
  const r = s.rank;
  if (r === undefined || r.rank === null) return [{ t: "—", cls: "n" }];
  const which = s.dataset.deleted ? ", deleted" : r.current ? "" : "’s earlier data";
  const by = validation ? "" : ", by Train RMSE";
  return [
    { t: whole(r.rank), cls: "n" },
    { t: ` of ${whole(r.ranked)} on ${s.dataset.name}${which}${by}`, cls: "tx" },
  ];
}

/**
 * The tiles under the heading: its Train RMSE so far against the best
 * finished start's, its Val RMSE, where it would rank among the finished
 * starts by Train RMSE, its evaluations, and its change over the budget's
 * last tenth. `finished` are the topology's finished starts' Train RMSEs;
 * `segment` names the topology, "T12.3". A finished start's say where it
 * stands (`standing`) instead of where it would rank.
 */
export function tilesOf(
  phase: Phase,
  c: StartContext,
  finished: number[],
  segment: string,
  standing?: Standing,
): Tile[] {
  const latest = last(c.points);
  const short = endedShort(phase);
  const dim = (t: string): Part => ({ t, cls: "tx" });
  const tiles: Tile[] = [];
  if (phase === "finished") {
    tiles.push(...finishedTiles(c, finished, segment, standing));
  } else {
    tiles.push(...soFarTiles(phase, c, finished, segment));
  }
  const budget = budgetOf(c.run);
  const evaluations =
    latest?.evaluations ?? (short || phase === "finished" ? c.start.evaluations : null) ?? 0;
  const of = budget === undefined ? "" : ` of ${evaluationsWords(budget)}`;
  tiles.push({
    label: "Evaluations",
    parts: [{ t: evaluations === 0 ? "0" : evaluationsWords(evaluations), cls: "n" }, dim(of)],
    bar:
      budget === undefined
        ? undefined
        : {
            done: Math.min(1, evaluations / budget),
            look:
              phase === "time_limit"
                ? "red"
                : short || phase === "finished"
                  ? "ended"
                  : phase === "running" && c.asOf === undefined
                    ? "live"
                    : "still",
          },
  });
  tiles.push(lastTenth(phase, c));
  return tiles;
}

/**
 * A finished start's Train and Val RMSE, a failed sweep's "—", and where it
 * stands. The Best start's Val is cobalt, or its Train without validation
 * points; another's Train says how far it is from the best.
 */
function finishedTiles(
  c: StartContext,
  finished: number[],
  segment: string,
  standing: Standing | undefined,
): Tile[] {
  const dim = (t: string): Part => ({ t, cls: "tx" });
  const failed: Part[] = [{ t: "—", cls: "n" }, dim(" · a sweep failed")];
  const best = standing?.best === true;
  const validation = c.run.validation;
  const { train_rmse: train, val_rmse: val } = c.start;
  const top = finished.length > 0 ? Math.min(...finished) : undefined;
  const vs =
    !best && train !== null && top !== undefined && top > 0
      ? [dim(` ${signedPercent(train / top - 1)} vs best`)]
      : [];
  const tiles: Tile[] = [
    {
      label: "Train RMSE",
      parts:
        train === null
          ? failed
          : [{ t: rmse(train), cls: best && !validation ? "n vbest" : "n" }, ...vs],
    },
  ];
  if (validation) {
    tiles.push({
      label: "Val RMSE",
      parts: val === null ? failed : [{ t: rmse(val), cls: best ? "n vbest" : "n" }],
    });
  }
  if (standing?.best === true) {
    tiles.push({ label: "Rank", parts: rankParts(standing, validation) });
  } else {
    const place = standing?.place;
    tiles.push({
      label: `Rank in ${segment}`,
      parts:
        place === undefined
          ? [{ t: "—", cls: "n" }]
          : [{ t: whole(place.n), cls: "n" }, dim(` of ${whole(place.of)} by Train RMSE`)],
    });
  }
  return tiles;
}

/** A start that hasn't finished: its RMSEs so far or at its end, and where it would rank. */
function soFarTiles(phase: Phase, c: StartContext, finished: number[], segment: string): Tile[] {
  const latest = last(c.points);
  const short = endedShort(phase);
  const so = short ? " at its end" : " so far";
  const dim = (t: string): Part => ({ t, cls: "tx" });
  const dash: Part = { t: "—", cls: "n" };
  const tiles: Tile[] = [];
  const train = latest?.train_rmse ?? (short ? c.start.train_rmse : null) ?? null;
  const val = latest?.val_rmse ?? (short ? c.start.val_rmse : null) ?? null;
  const shown = latest !== undefined || (short && c.start.best !== null);
  const best = finished.length > 0 ? Math.min(...finished) : undefined;
  if (!shown) {
    tiles.push({ label: `Train RMSE${short ? "" : " so far"}`, parts: [dash] });
    if (c.run.validation) tiles.push({ label: `Val RMSE${short ? "" : " so far"}`, parts: [dash] });
  } else {
    const vs =
      train !== null && best !== undefined && best > 0
        ? [dim(` ${signedPercent(train / best - 1)} vs best`)]
        : [];
    tiles.push({
      label: `Train RMSE${so}`,
      parts: [
        { t: train === null ? "—" : rmse(train), cls: c.run.validation ? "n" : "n vbest" },
        ...vs,
      ],
    });
    if (c.run.validation) {
      tiles.push({
        label: `Val RMSE${so}`,
        parts: [{ t: val === null ? "—" : rmse(val), cls: "n vbest" }],
      });
    }
  }
  if (short) tiles.push({ label: "Would rank", parts: [dim("doesn’t rank")] });
  else if (phase !== "running" || train === null)
    tiles.push({ label: "Would rank", parts: [dim("not yet")] });
  else if (finished.length === 0)
    tiles.push({ label: "Would rank", parts: [dim(`no start in ${segment} has finished`)] });
  else {
    const rank = finished.filter((x) => x < train).length + 1;
    tiles.push({
      label: "Would rank",
      parts: [
        { t: whole(rank), cls: "n" },
        dim(` of ${whole(finished.length + 1)} in ${segment}, if it ended now`),
      ],
    });
  }
  return tiles;
}

// ── why it ended ──────────────────────────────────────────────────────────────────────────────

export interface Why {
  label: string;
  /** How far it got: "870k", and "of 1 M evaluations". */
  big: string;
  bigOf: string;
  cap: string;
  glyph: string;
  what: string;
  next: string;
  hint: string;
  /** An error, ICMM's own problem: Report a problem… sits beside Open job log (#126). */
  report?: true;
}

/**
 * The box for a start that stopped short: why, what to do, and how far it
 * got. `exception` names an error's kind, from its traceback: "RuntimeError".
 */
export function whyOf(
  phase: Phase,
  c: StartContext,
  segment: string,
  exception?: string,
): Why | undefined {
  if (!endedShort(phase)) return undefined;
  const r = c.start.ran_with;
  const latest = last(c.points);
  const budget = budgetOf(c.run);
  const evaluations = latest?.evaluations ?? c.start.evaluations ?? 0;
  const run = `#${c.run.id}`;
  const once = c.run.ended_at === null ? " once it has ended" : "";
  const on = r?.node == null ? "" : ` on ${r.node}`;
  const counted = hasBest(c) ? " · not counted" : "";
  const base = {
    big: evaluations === 0 ? "0" : evaluationsWords(evaluations),
    bigOf: budget === undefined ? "evaluations" : `of ${evaluationsWords(budget)} evaluations`,
    cap: hasBest(c)
      ? `Its best so far shows here, but never counts toward ${run}/${segment}.`
      : "It stopped before its first generation, so there’s nothing to show.",
    glyph: "g g-failed",
  };
  switch (phase) {
    case "time_limit": {
      const limit = r?.time_limit_min == null ? "" : ` ${durationWords(r.time_limit_min * 60)}`;
      return {
        ...base,
        label: "Why it ended",
        what: `Hit its${limit} time limit${on}${counted}`,
        next: `Raise Time limit per start in Platform settings, then Resume ${run}${once}.`,
        hint: "Resume fits it again from its seed, from its first generation.",
      };
    }
    case "canceled": {
      const when = at(c.run.ended_at) ?? at(r?.ended_at);
      return {
        ...base,
        glyph: "g g-canceled",
        label: "Why it ended",
        what: `The run was canceled${when === undefined ? "" : ` at ${clock(when, c.now)}`}${counted}`,
        next: `Resume ${run} to fit it again${once}.`,
        hint: "Resume fits it again from its seed, with the run’s other unfinished starts.",
      };
    }
    case "out_of_memory": {
      const memory = r?.memory_mb == null ? "" : ` ${memoryWords(r.memory_mb)}`;
      return {
        ...base,
        label: "Why it failed",
        what: `Used all${memory} of its memory${on}${counted}`,
        next: `Raise Memory per start in Platform settings, then Resume ${run}${once}.`,
        hint: "Resume fits it again from its seed, from its first generation.",
      };
    }
    case "lost":
      return {
        ...base,
        label: "Why it failed",
        what: `The cluster lost it on ${plural(c.start.try_number, "try", "tries")}${r?.node == null ? "" : `, the last${on}`}`,
        next: `Resume ${run} to fit it again${once}.`,
        hint: "A lost start is the cluster’s, not ICMM’s or your settings’: Resume fits it again from its seed.",
      };
    default:
      return {
        ...base,
        label: "Why it failed",
        what: `Error${r?.exit_code == null ? "" : ` · exit code ${exitCode(r.exit_code)}`}${exception === undefined ? "" : ` · ${exception}`}${on}${counted}`,
        next: "An error is a problem in ICMM, not in your settings. Report it, and its job log goes with the report.",
        report: true,
        hint: `Resume fits it again from its seed${once}; the same error may come back.`,
      };
  }
}

/**
 * Why a start's fit can't be drawn, where it would be: its run's revision
 * can't be read here (#346). A newer ICMM's revision is `NewerRevision`'s.
 */
export function fitUnreadableWords(
  dataset: string,
  revision: number,
  problem: "missing" | "damaged",
  start: number,
): string {
  const which = `${dataset}’s revision ${revision}`;
  const so = `so start ${start}’s fit can’t be drawn here.`;
  switch (problem) {
    case "missing":
      return `${which} isn’t in the Data folder any more, ${so}`;
    case "damaged":
      return `${which} is damaged, ${so}`;
  }
}

/** The kind of error a traceback's last line names: "RuntimeError" from "RuntimeError: …". */
export function exceptionOf(lines: { t: string; err: boolean }[]): string | undefined {
  const last = lines.find((l) => l.err)?.t;
  const kind = last?.match(/^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit))\b/)?.[1];
  return kind;
}

/** The end of a job log: from its last traceback, or its last `max` lines; each line with whether it's the error's. */
export function tracebackOf(text: string, max = 12): { t: string; err: boolean }[] {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const from = lines
    .map((l) => l.startsWith("Traceback (most recent call last):"))
    .lastIndexOf(true);
  const tail = from >= 0 ? lines.slice(from) : lines;
  const shown = tail.length > max ? [tail[0], "  …", ...tail.slice(tail.length - max + 2)] : tail;
  const errAt = from >= 0 ? shown.length - 1 : -1;
  return shown
    .filter((t, i) => t !== "" || i < shown.length - 1)
    .map((t, i) => ({ t, err: i === errAt }));
}

// ── where it runs ─────────────────────────────────────────────────────────────────────────────

export interface ClusterRow {
  k: string;
  parts: Part[];
  /** Memory's bar: the share of its limit it used at most. */
  bar?: number;
}

/** A wall time as the box says it: "52 s", "13 m 10 s", "4 h", "2 h 05 m". */
export function wallWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h} h` : m === 60 ? `${h + 1} h` : `${h} h ${String(m).padStart(2, "0")} m`;
}

/**
 * How long a finished start's search took, by the clock the topology page's
 * Best starts and its start log read (its result's `elapsed_s`), not from
 * when the coordinator first saw it running to when it collected it (F13).
 */
function tookSeconds(c: StartContext): number | undefined {
  return c.start.state === "finished" && c.start.elapsed_s !== null ? c.start.elapsed_s : undefined;
}

/** "13 m 10 s" in its parts: each number in mono, each unit after it. */
function wallParts(seconds: number): Part[] {
  const words = wallWords(seconds).split(" ");
  return words.map((w, i): Part =>
    i % 2 === 0 ? { t: w, cls: "n" } : { t: ` ${w}${i < words.length - 1 ? " " : ""}` },
  );
}

/**
 * The aside's box: on the cluster or on this computer, as of `readAt` (when
 * it was last read), or as it ended; its job, node, CPUs, memory and wall
 * time, as far as each is known.
 */
export function clusterOf(
  phase: Phase,
  c: StartContext,
  readAt: number,
): { title: string; asOf: string; rows: ClusterRow[] } {
  const r = c.start.ran_with;
  const local = !c.slurm;
  const ended = endedShort(phase) || phase === "finished";
  const title = local ? `On ${inSentence(c.platform)}` : "On the cluster";
  const asOf = ended ? "when it ended" : `as of ${clockSeconds(c.asOf ?? readAt, c.now)}`;
  const rows: ClusterRow[] = [];
  const n = (t: string): Part => ({ t, cls: "n" });
  const dim = (t: string): Part => ({ t, cls: "tx" });
  const population = c.run.settings?.search.population;
  if (!local) {
    if (r?.job_id == null)
      rows.push({ k: "Job", parts: [dim(r === null ? "not sent yet" : "not taken yet")] });
    else {
      const task = r.array_task === null ? "" : ` · array task ${r.array_task}`;
      const again = c.start.try_number > 1 ? ` · ${ordinal(c.start.try_number)} try` : "";
      rows.push({ k: "Job", parts: [n(r.job_id), dim(`${task}${again}`)] });
    }
    rows.push({ k: "Node", parts: r?.node == null ? [dim("not placed yet")] : [n(r.node)] });
  }
  if (phase === "waiting" || phase === "queued") {
    if (!local && phase === "queued") {
      const reason = c.run.queued?.reason ?? null;
      if (reason !== null) {
        rows.push({
          k: "Waiting",
          parts: [
            {
              t: `${waitingWords(reason).replace(/^waiting /, "")} · `,
            },
            { t: reason, cls: "raw" },
          ],
        });
      }
    }
    if (r !== null) {
      const limits: Part[] = [];
      if (r.time_limit_min !== null) limits.push(...hourParts(r.time_limit_min), { t: " · " });
      limits.push(n(String(r.cpus)), { t: r.cpus === 1 ? " CPU" : " CPUs" });
      if (r.memory_mb !== null) limits.push({ t: " · " }, ...memoryParts(r.memory_mb));
      rows.push({ k: "Limit", parts: limits });
    }
    return { title, asOf, rows };
  }
  if (phase === "error" && r?.exit_code != null)
    rows.push({ k: "Exit code", parts: [n(exitCode(r.exit_code))] });
  else if (r !== null) {
    const rounds =
      population === undefined
        ? []
        : [dim(` · ${whole(Math.ceil(population / r.cpus))} rounds per generation`)];
    rows.push({ k: "CPUs", parts: [n(String(r.cpus)), ...rounds] });
  }
  if (r?.peak_memory_mb != null) {
    // "3.0 of 4 GB at most": the peak to a decimal in its limit's unit; under 1 GB, its own
    // unit, "35 MB of 4 GB", where it read "0.0" (F13).
    const used =
      r.memory_mb === null
        ? memoryParts(r.peak_memory_mb)
        : r.memory_mb < 1024
          ? [n(whole(r.peak_memory_mb)), { t: " of " }, ...memoryParts(r.memory_mb)]
          : r.peak_memory_mb >= 1024
            ? [n((r.peak_memory_mb / 1024).toFixed(1)), { t: " of " }, ...memoryParts(r.memory_mb)]
            : [...memoryParts(r.peak_memory_mb), { t: " of " }, ...memoryParts(r.memory_mb)];
    rows.push({
      k: "Memory",
      parts: [...used, { t: " at most" }],
      bar: r.memory_mb === null ? undefined : Math.min(1, r.peak_memory_mb / r.memory_mb),
    });
  } else if (r?.memory_mb != null && !ended) {
    rows.push({ k: "Memory", parts: [{ t: "up to " }, ...memoryParts(r.memory_mb)] });
  }
  const started = at(r?.started_at);
  const stopped = ended ? at(r?.ended_at) : (c.asOf ?? readAt);
  const limit = r?.time_limit_min ?? null;
  const took = tookSeconds(c);
  if (phase === "time_limit" && limit !== null) {
    rows.push({ k: "Wall time", parts: [...hourParts(limit), dim(" · its limit")] });
  } else if (ended && took !== undefined) {
    const parts = wallParts(took);
    if (limit !== null) parts.push(dim(` · limit ${durationWords(limit * 60)}`));
    rows.push({ k: "Wall time", parts });
  } else if (started !== undefined && stopped !== undefined) {
    const parts = wallParts((stopped - started) / 1000);
    if (limit !== null) parts.push(dim(` · limit ${durationWords(limit * 60)}`));
    rows.push({ k: "Wall time", parts });
  }
  return { title, asOf, rows };
}

/** "4 h" from minutes, its number in mono. */
function hourParts(minutes: number): Part[] {
  // A duration's spaces are no-break ones (#449): its number, then the rest, held together.
  const [num, ...unit] = durationWords(minutes * 60).split(/\s/);
  return [{ t: num, cls: "n" }, { t: `\u00a0${unit.join("\u00a0")}` }];
}

/** "4 GB", its number in mono. */
function memoryParts(mb: number): Part[] {
  const [num, unit] = memoryWords(mb).split(" ");
  return [{ t: num, cls: "n" }, { t: ` ${unit}` }];
}

/** "10:44:10 AM": a time to the second, as the box's as-of says it. */
export function clockSeconds(at: number, now: number): string {
  const minute = clock(at, now);
  const seconds = String(new Date(at).getSeconds()).padStart(2, "0");
  return minute.replace(/(\d{1,2}:\d{2})(?!.*\d{1,2}:\d{2})/, `$1:${seconds}`);
}

// ── the log ───────────────────────────────────────────────────────────────────────────────────

/** "0:13:10": a log point's time since its worker began. */
function elapsedWords(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return `${Math.floor(t / 3600)}:${mm}:${ss}`;
}

/** The gap between the Start log's columns. */
const GAP = 2;

/** A Start log point's cells, under `time · gen · evals · best · val · σ`, val only with validation. */
function logCells(p: StartLogPoint, validation: boolean): string[] {
  const value = (x: number | null) => (x === null ? "—" : x.toFixed(4));
  return [
    elapsedWords(p.elapsed_s),
    String(p.generation),
    String(p.evaluations),
    value(p.train_rmse),
    ...(validation ? [value(p.val_rmse)] : []),
    // "4.4e5", not "4.4e+5": a σ grown huge keeps the Log box's columns in its width.
    p.sigma.toPrecision(2).replace("e+", "e"),
  ];
}

/**
 * The Start log as a table (#469 R07): its head and a line a point, each column as wide as its
 * widest value or head and two spaces apart, so no two values ever run together; σ, last, isn't
 * padded.
 */
export function logTable(
  points: StartLogPoint[],
  validation: boolean,
): { head: string; lines: string[] } {
  const heads = ["time", "gen", "evals", "best", ...(validation ? ["val"] : []), "σ"];
  const rows = points.map((p) => logCells(p, validation));
  const widths = heads.map(
    (h, i) => rows.reduce((w, r) => Math.max(w, r[i].length), h.length) + GAP,
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("");
  return { head: line(heads), lines: rows.map(line) };
}

/** The Start log as Copy copies it: `logTable`'s head and lines, a line each. */
export function logText(points: StartLogPoint[], validation: boolean): string {
  const { head, lines } = logTable(points, validation);
  return [head, ...lines].join("\n") + "\n";
}

/** The log's head and its last `n` lines, `time · gen · evals · best · val · σ`, newest last. */
export function logTail(
  points: StartLogPoint[],
  validation: boolean,
  n = 8,
): { head: string; lines: string[] } {
  return logTable(points.slice(-n), validation);
}

// ── around it ─────────────────────────────────────────────────────────────────────────────────

/** The next running start after `start` in its topology, by index, coming round; none alone. */
export function nextRunning(starts: StartSummary[] | undefined, start: number): number | undefined {
  const running = (starts ?? []).filter((s) => s.state === "running" && s.start !== start);
  return (running.find((s) => s.start > start) ?? running[0])?.start;
}

const SUPER: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

/**
 * A rate as the Rates box says it, to 3 significant figures: "0.00644",
 * "145", "3,894", and past those, "1.99 × 10⁴" or "4.54 × 10⁻⁴"; "—" for
 * one past what a number holds.
 */
export function rateWords(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp >= 4 || exp < -3) {
    const [m, e] = x.toExponential(2).split("e");
    const power = String(Number(e)).replace(/./g, (ch) => SUPER[ch] ?? ch);
    return `${m} × 10${power}`;
  }
  return exp >= 3 ? whole(Math.round(x)) : x.toPrecision(3);
}

/** A protocol's RMSE from its raw SSE over its points; `null` with a failed point or none. */
export const protocolRmse = (
  sse: number | undefined,
  points: number,
  failed: number | undefined,
) =>
  sse === undefined || failed === undefined || failed > 0 || points === 0
    ? null
    : Math.sqrt(sse / points);

/** A start's stored RMSE of protocol `i`, train or val, as its run scored it. */
export const storedRmse = (
  s: Pick<
    Start,
    "train_sse" | "train_points" | "train_failed" | "val_sse" | "val_points" | "val_failed"
  >,
  i: number,
  val: boolean,
) =>
  val
    ? protocolRmse(s.val_sse?.[i], s.val_points?.[i] ?? 0, s.val_failed?.[i])
    : protocolRmse(s.train_sse?.[i], s.train_points?.[i] ?? 0, s.train_failed?.[i]);

/** What a start's parameters are read against, in Parameters' head and its table's name. */
export interface Against {
  head: string;
  label: string;
  /** Under 10 finished starts, why no range shows: Parameters' hint, for a start not the best (#557). */
  few?: string;
}

/**
 * What start `n`'s parameters are read against in `title`: its topology's
 * Top 10 (`top`, the best start's first), or under 10 finished starts, which
 * the Top 10 holds every one of, those starts themselves (#557).
 */
export function againstOf(top: readonly { start: number }[], title: string, n: number): Against {
  if (top.length === 0 || top.length >= TOP_TEN) {
    return { head: `${title}’s top 10 by Train RMSE`, label: `${title}’s top 10` };
  }
  if (top.length === 1) {
    const only = `start ${top[0].start}, ${title}’s only finished start`;
    return {
      head: only,
      label: only,
      few: `Only start ${top[0].start} has finished, so start ${n} is read against it alone: under 10 finished starts there’s no top 10 to draw a range from.`,
    };
  }
  const these = `${title}’s ${top.length} finished starts`;
  return {
    head: these,
    label: these,
    few: "Under 10 finished starts there’s no top 10 to draw a range from, so each finished start shows on its own, and none is marked outside.",
  };
}
