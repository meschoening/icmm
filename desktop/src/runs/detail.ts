/**
 * What Run detail says of a run (LaptopRunDetail, #232): its facts line, its
 * stages, the box under them (what's on the cluster now, why it waits, or why
 * it stopped), Resume's hint, Cancel's and Delete's confirms, its pace and ETA,
 * the grid of its topologies in the order they're sent, its progress chart,
 * the words of its ranked topologies and its spread plot. Runs' words (`words.ts`) say the
 * waits and the failures, so a run reads the same on both pages.
 */
import { whole } from "../configs/words";
import { inSentence, onPlatform } from "../setup/form";
import { memory, upTo } from "../setup/units";
import {
  aboutWords,
  durationWords,
  estimate,
  evaluationsPerStart,
  fromHost,
  fromRuns,
  paceWords,
  plural,
  sizeWords,
  startSeconds,
} from "../submit/estimate";
import { etaOf as forecastEta } from "../submit/forecast";
import { clock, weekdayDate } from "../ui/clock";
import type {
  FailedStarts,
  JobDefaults,
  Run,
  RunFailure,
  RunStop,
  RunSummary,
  RunTiming,
  SavedPlatform,
  RunStretches,
  TopologySummary,
} from "../wire/types.gen";
import { endOf, fittingSeconds } from "./fitting";
import { SPAN } from "./stretch";
import { barOf, counted, queueAheadOf, refusalOf, rmse, topologyName } from "./words";

type Platform = Pick<SavedPlatform, "type" | "name">;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export { fittingSeconds } from "./fitting";

/** A topology as the page writes it after the run's number: `T12.3`. */
export const topologyId = (t: { graph: number; open_state: number }) =>
  `T${t.graph}.${t.open_state}`;

/** A topology's key among a run's: its graph and open state. */
export const topologyKey = (t: { graph: number; open_state: number }) =>
  `${t.graph}.${t.open_state}`;

/** `This computer`, or the platform's name. */
export const platformName = (p: Platform) => (p.type === "local" ? "This computer" : p.name);

const at = (iso: string | null | undefined) => (iso == null ? NaN : Date.parse(iso));

/** The best of a run in the metric it ranks by: Val RMSE, or Train RMSE without validation points. */
export const bestValue = (r: Pick<Run, "best" | "validation">) =>
  r.best === null ? null : r.validation ? r.best.val_rmse : r.best.train_rmse;

// ── where a run is ────────────────────────────────────────────────────────────────────────────

/**
 * Where a run is, as Run detail shows it: waiting (queued or held), running,
 * canceling or resuming while its coordinator acts, or ended.
 */
export type Phase =
  "waiting" | "running" | "canceling" | "resuming" | "completed" | "failed" | "canceled";

export function phaseOf(r: Run): Phase {
  if (r.ended_at === null && r.canceling !== null) return "canceling";
  if (r.ended_at === null && r.resuming !== null) return "resuming";
  if (r.state === "queued" || r.state === "held") return "waiting";
  return r.state;
}

/** Whether the run has stopped, as its page counts it: ended, or resuming from an end. */
export const stopped = (phase: Phase) =>
  phase === "completed" || phase === "failed" || phase === "canceled" || phase === "resuming";

/** Its starts without a result, which a Resume fits. */
export const unfinishedOf = (r: Run) => Math.max(0, r.progress.starts - r.progress.starts_finished);

/**
 * Whether nothing of the run has fit yet: no start ended, and none has run,
 * though its first topologies may have gone out to wait at the scheduler
 * (#469 R06: a queued run isn't "1 fitting").
 */
function nothingYet(r: Run): boolean {
  const p = r.progress;
  return (
    p.starts_finished === 0 &&
    p.starts_failed === 0 &&
    p.topologies_complete === 0 &&
    p.topologies_failed === 0 &&
    (p.topologies_fitting === 0 || (r.first_running_at === null && p.starts_running === 0))
  );
}

// ── the engine ────────────────────────────────────────────────────────────────────────────────

/** The version of an engine from its bundle's key, `1.0.0-linux-x86_64-0123456789ab`. */
export function engineVersion(key: string | null): string | undefined {
  if (key === null) return undefined;
  return key.match(/^(.+?)-(?:linux|macos|windows)-/)?.[1];
}

/**
 * Resume's hint: which engine fits its unfinished starts. The run's own, or,
 * once that's gone (or below the Floor, ADR-0020), the one installed now.
 */
export function resumeHint(r: Run, platform: Platform, engineNow: string | null): string {
  const n = whole(unfinishedOf(r));
  const own = engineVersion(r.engine);
  if (!r.engine_installed) {
    const gone = own === undefined ? "Its engine" : `ICMM ${own}’s engine`;
    const now =
      engineNow === null
        ? "the engine installed now"
        : `ICMM ${engineNow}’s, the one installed now`;
    return `${gone} is no longer on ${platformName(platform)}, so Resume fits the ${n} unfinished starts with ${now}. They’ll agree with the rest in distribution, not to the last digit.`;
  }
  // The engine is named only when it changes (#324, SR17); a cancel's stopped starts begin again.
  const stopped = r.progress.starts_stopped;
  return stopped > 0
    ? `Resume fits the ${n} unfinished starts, the ${whole(stopped)} that ${stopped === 1 ? "was" : "were"} running again from the beginning.`
    : `Resume fits the ${n} unfinished starts.`;
}

// ── pace and ETA ──────────────────────────────────────────────────────────────────────────────

/** How far its topologies have got, as topologies: those ended, and the fitting ones' share. */
function progressed(r: Run): number {
  const p = r.progress;
  return p.topologies_complete + p.topologies_failed + barOf(p).fitting * p.topologies;
}

/**
 * The run's own pace, in seconds a topology, once one has ended: the time
 * it has spent fitting over how far it has got. `undefined` before.
 */
export function paceOf(r: Run, now: number): number | undefined {
  const p = r.progress;
  if (p.topologies_complete + p.topologies_failed === 0) return undefined;
  const fit = fittingSeconds(r, now);
  const done = progressed(r);
  if (fit === undefined || !(fit > 0) || !(done > 0)) return undefined;
  return fit / done;
}

/** An ETA, and whether it's Submit's estimate rather than the run's own pace. */
export interface Eta {
  at: number;
  estimate: boolean;
}

/** What a run's ETA comes from besides the run: the platform's finished starts and its settings now. */
export interface EtaAround {
  timings: RunTiming[];
  /** CPUs per start and the Running-starts cap; `undefined` before Platform settings are read. */
  cpus: number | undefined;
  cap: number | undefined;
  /** What each start takes beside its evaluations: `startOverheadS`, with the settings. */
  overheadS: number | undefined;
  /** When its numbers are from: now, or as of when the connection went (#326). */
  now: number;
  /**
   * This computer's time for an evaluation of the run, as its starts run here
   * (`time_evaluations`, #508): Submit's estimate where no finished start here
   * has timed its states and CPUs (#324).
   */
  host?: number;
}

/**
 * Submit's model of when a run's last start ends (#229): its starts left in
 * waves of `cap`, each as long as one of its starts at `cpus` CPUs, from the
 * platform's finished starts, or else this computer's timing (`host`, #324),
 * counting the time it has spent fitting (#507).
 * `undefined` for a run whose settings this ICMM can't read, or that neither
 * times.
 */
function submitEtaOf(r: Run, a: EtaAround): number | undefined {
  const t = submitTimingOf(r, a);
  if (t === undefined) return undefined;
  return forecastEta({ run: r, ...t, now: a.now, fittingS: fittingSeconds(r, a.now) });
}

/** Submit's time for one of the run's starts, from what `submitEtaOf` reads; `undefined` where it can't. */
function submitTimingOf(
  r: Run,
  a: EtaAround,
): { evaluations: number; perEvaluationS: number; overheadS: number; cap: number } | undefined {
  const search = r.settings?.search;
  const { cpus, cap, overheadS } = a;
  if (search === undefined || cpus === undefined || cap === undefined || overheadS === undefined)
    return undefined;
  const per =
    fromRuns(a.timings, r.num_states, cpus)?.seconds ??
    (a.host !== undefined ? fromHost(a.host).seconds : undefined);
  if (per === undefined || !(per > 0)) return undefined;
  const evaluations = evaluationsPerStart(search.evaluation_budget, search.population);
  if (evaluations <= 0) return undefined;
  return { evaluations, perEvaluationS: per, overheadS, cap };
}

/**
 * When a running run's first topology is due, before any has ended (#399,
 * HF05): Submit's model from its first start, the first topology's starts in
 * waves of `cap`, each as long as one start. `undefined` once a topology has
 * ended, past it, or where Submit's model can't time the run.
 */
export function firstDueOf(r: Run, a: EtaAround): number | undefined {
  const p = r.progress;
  if (phaseOf(r) !== "running" || p.topologies_complete + p.topologies_failed > 0) return undefined;
  const began = Date.parse(r.first_running_at ?? "");
  const t = submitTimingOf(r, a);
  if (t === undefined || Number.isNaN(began) || p.topologies <= 0) return undefined;
  const waves = Math.ceil(Math.ceil(p.starts / p.topologies) / Math.max(1, t.cap));
  const due = began + waves * startSeconds(t.evaluations, t.perEvaluationS, t.overheadS) * 1000;
  return due > a.now ? due : undefined;
}

/**
 * The one ETA of a running run, which Runs, Run detail and Submit's
 * forecast all show (#326): from its own pace over the time it spent
 * fitting once a topology has ended, else Submit's model. `undefined` for a
 * run that isn't running, or that neither can time.
 */
export function runEtaOf(r: Run, a: EtaAround): Eta | undefined {
  if (phaseOf(r) !== "running") return undefined;
  const pace = paceOf(r, a.now);
  if (pace !== undefined) {
    const left = Math.max(0, r.progress.topologies - progressed(r));
    return { at: a.now + left * pace * 1000, estimate: false };
  }
  const submit = submitEtaOf(r, a);
  return submit === undefined ? undefined : { at: submit, estimate: true };
}

/** Submit's estimate of a whole run, and what it's from: finished runs here, or this computer. */
export interface SubmitTotal {
  seconds: number;
  from: { kind: "runs"; runs: number } | { kind: "host" };
  cap: number;
}

/**
 * Submit's estimate of a whole run, before it starts: from the platform's
 * finished runs, or, before any has timed its states and CPUs, this
 * computer's timing of an evaluation (`host`, as its starts run here, #324,
 * #508); `undefined` where neither can.
 */
export function submitTotalOf(
  r: Run,
  a: {
    timings: RunTiming[] | undefined;
    job: JobDefaults | undefined;
    /** What each start takes beside its evaluations: `startOverheadS`. */
    overheadS: number;
    host?: number;
  },
): SubmitTotal | undefined {
  const search = r.settings?.search;
  if (search === undefined || a.timings === undefined || a.job === undefined) return undefined;
  const per =
    fromRuns(a.timings, r.num_states, a.job.cpus_per_start) ??
    (a.host !== undefined && a.host > 0 ? fromHost(a.host) : undefined);
  if (per === undefined || !(per.seconds > 0)) return undefined;
  const evaluations = evaluationsPerStart(search.evaluation_budget, search.population);
  if (evaluations <= 0) return undefined;
  const e = estimate({
    starts: r.progress.starts,
    topologies: r.progress.topologies,
    evaluations,
    perEvaluationS: per.seconds,
    overheadS: a.overheadS,
    cap: a.job.max_running_starts,
  });
  return { seconds: e.totalS, from: per.from, cap: a.job.max_running_starts };
}

/** The day of an ETA: its time within a day (with its day past midnight), else its day. */
function etaDay(eta: number, now: number): string {
  return eta - now < DAY ? clock(eta, now) : weekdayDate(eta, now);
}

/** An ETA as a stage says it: "ETA Fri, Aug 21, 6:40 AM", or "ETA about 11:48 PM, Submit's estimate". */
function etaWords(eta: Eta, now: number): string {
  return eta.estimate
    ? `ETA about ${etaDay(eta.at, now)}, Submit’s estimate`
    : `ETA ${clock(eta.at, now)}`;
}

// ── the facts line ────────────────────────────────────────────────────────────────────────────

/** A piece of the facts line: words, a number, or the best topology and its RMSE. */
export interface Part {
  t: string;
  kind?: "n" | "topology" | "best";
}

/**
 * The facts line under the heading: "37 / 120 topologies · 1 failed · 1
 * fitting · 3,864 / 12,000 finished · best so far #214/T12.3 at 0.0481 · ETA
 * Fri, Aug 21, 6:40 AM · 8 d 20 h left", and as of when, not connected.
 */
export function factsOf(
  r: Run,
  a: { eta: Eta | undefined; total: number | undefined; now: number; asOf: number | undefined },
): Part[] {
  const out: Part[] = [];
  const t = (s: string) => out.push({ t: s });
  const n = (x: number) => out.push({ t: whole(x), kind: "n" });
  const p = r.progress;
  const phase = phaseOf(r);
  const end = endOf(r);
  const endWord = (e: NonNullable<typeof end>) =>
    `${e.how === "canceled" ? "canceled" : "ended"} ${clock(e.at, a.now)}`;
  // How long it fit, not its wait to begin (#324, SR04).
  const fitWords = () => {
    if (end === undefined) return;
    const fit = fittingSeconds(r, a.now);
    t(fit === undefined ? ` · ${endWord(end)}` : ` · fit ${durationWords(fit)} · ${endWord(end)}`);
  };
  n(p.topologies_complete);
  t(" / ");
  n(p.topologies);
  t(" topologies");
  if (nothingYet(r)) {
    t(" · ");
    n(0);
    t(" / ");
    n(p.starts);
    t(` finished · submitted ${clock(at(r.submitted_at), a.now)}`);
    if (end !== undefined) t(` · ${endWord(end)}`);
    else if (a.total !== undefined) {
      t(` · ${aboutWords(a.total)} once it starts, Submit’s estimate`);
    }
  } else if (p.starts_finished === 0 && end !== undefined) {
    t(" · ");
    n(0);
    t(" / ");
    n(p.starts);
    t(" finished · ");
    n(p.starts_failed);
    t(" failed");
    fitWords();
  } else {
    if (p.topologies_failed > 0) {
      t(" · ");
      n(p.topologies_failed);
      t(" failed");
    }
    const going = phase === "running" || phase === "canceling" || phase === "waiting";
    if (going && p.topologies_fitting > 0) {
      t(" · ");
      n(p.topologies_fitting);
      t(" fitting");
    }
    t(" · ");
    n(p.starts_finished);
    t(" / ");
    n(p.starts);
    t(" finished");
    const value = bestValue(r);
    if (r.best !== null && value !== null) {
      t(going ? " · best so far " : " · best ");
      out.push({ t: topologyName(r.id, r.best), kind: "topology" });
      t(" at ");
      out.push({ t: rmse(value), kind: "best" });
    }
    if (phase === "running" && a.eta !== undefined) {
      if (a.eta.estimate) t(` · ${etaWords(a.eta, a.now)}`);
      else {
        const left = durationWords(Math.max(0, (a.eta.at - a.now) / 1000));
        t(` · ETA ${clock(a.eta.at, a.now)} · ${left} left`);
      }
    }
    fitWords();
  }
  if (a.asOf !== undefined) t(` · as of ${clock(a.asOf, a.now)}`);
  return out;
}

// ── facts ─────────────────────────────────────────────────────────────────────────────────────

/** "1 M" from a million up when it's whole in tenths of a million; else grouped by thousands. */
export function evaluationsWords(n: number): string {
  return n >= 1_000_000 && n % 100_000 === 0 ? `${n / 1_000_000} M` : whole(n);
}

/** A bound as the page writes it, with a true minus sign. */
const bound = (x: number) => String(x).replace("-", "−");

/** A piece of a line of facts: a number (`n`) or a symbol (`mono`) is in mono. */
export interface FactPart {
  t: string;
  cls?: "n" | "mono";
}

/**
 * Search's three lines: starts, population and budget; start points, seed
 * and logs; bounds. Its numbers are in mono, as the board draws them, and
 * so is `ln`, a symbol (#360, RF18).
 */
export function searchLines(r: Run): FactPart[][] {
  const n = (t: string): FactPart => ({ t, cls: "n" });
  const seed = [{ t: "seed " }, n(String(r.search_seed))];
  const c = r.settings;
  if (c === null) return [[...seed, { t: " · its settings were saved by a newer ICMM" }]];
  const s = c.search;
  const b = c.bounds;
  const [budget, unit] = evaluationsWords(s.evaluation_budget).split(" ");
  return [
    [
      n(whole(s.starts_per_topology)),
      { t: "\u00a0starts per topology ·\u00a0population " },
      n(whole(s.population)),
      { t: " ·\u00a0" },
      n(budget),
      { t: `${unit === undefined ? "" : `\u00a0${unit}`} evaluations each` },
    ],
    [
      { t: `${s.sobol_start_points ? "Sobol" : "random"} start points ·\u00a0` },
      ...seed,
      { t: " ·\u00a0log every " },
      n(whole(s.log_every_generations)),
      { t: `\u00a0${s.log_every_generations === 1 ? "generation" : "generations"}` },
    ],
    [
      { t: "parameters " },
      n(bound(b.rate_min)),
      { t: " to " },
      n(bound(b.rate_max)),
      { t: "\u00a0" },
      { t: "ln", cls: "mono" },
      { t: " units ·\u00a0voltage dependence " },
      n(bound(b.sigmoid_min_mV)),
      { t: " to " },
      n(bound(b.sigmoid_max_mV)),
      { t: "\u00a0mV" },
    ],
  ];
}

/** Platform's lines, as Platform settings are now: the platform, the cap, and each start. */
export function platformLines(
  platform: Platform,
  job: JobDefaults | undefined,
): { name: string; cap?: string; each?: string } {
  if (job === undefined) return { name: platformName(platform) };
  const cpus = plural(job.cpus_per_start, "CPU", "CPUs");
  const cap = `up to ${plural(job.max_running_starts, "start", "starts")} at once`;
  if (job.type !== "slurm") {
    return {
      name: platformName(platform),
      cap: `${cap}, shared by all runs ${onPlatform(platform)}`,
      each: `${cpus} each`,
    };
  }
  return {
    name: `${platformName(platform)} · SLURM`,
    cap,
    each: `${cpus} · ${memory(job.memory_per_start_mb)} memory · up to ${upTo(job.time_limit_per_start_min)} each`,
  };
}

// ── the stages ────────────────────────────────────────────────────────────────────────────────

export type StageNode =
  "done" | "live" | "busy" | "ring" | "held" | "todo" | "failed" | "canceled" | "completed";

export interface StageView {
  node: StageNode;
  /** The line to the next stage: drawn, dashed while fitting, faint ahead, none after the last. */
  line: "solid" | "dash" | "faint" | "none";
  time: string;
  name: string;
  detail: string;
  /** Dim for a stage still ahead, red for Failed. */
  tone?: "dim" | "red";
}

export interface StageAround {
  platform: Platform;
  slurm: boolean;
  partition: string | null;
  inFlight: RunSummary[];
  eta: Eta | undefined;
  total: number | undefined;
  now: number;
}

/** What a run waits on, where the box says it in full: "waiting for general-cpu". */
function waitsOn(r: Run, a: StageAround): string {
  if (r.state === "held") {
    if (r.held?.kind === "space") return "held for space";
    const code = (r.held?.reason ?? "").split(",")[0].trim();
    return code === "QOSMaxJobsPerUserLimit" || code === "AssocMaxJobsLimit"
      ? "at your cluster job limit"
      : "held by the cluster";
  }
  if (!a.slurm) {
    const ahead = queueAheadOf(r, a.inFlight);
    return ahead === undefined
      ? `waiting for a free slot ${onPlatform(a.platform)}`
      : `waiting for #${ahead.id}’s starts to end`;
  }
  return `waiting for ${a.partition ?? "the cluster"}`;
}

/** Why a stop, or a failed run's last stage, says it failed. */
function failedWords(failure: RunFailure | null, finished: number | null): string {
  const failed = failure?.failed_starts.reduce((n, f) => n + f.starts, 0) ?? 0;
  if (finished === 0 && failed > 0) return "every start that ran failed";
  switch (failure?.cause) {
    case "starts_failed":
      return `${plural(failed, "start", "starts")} failed`;
    case "stopped_early":
      return "20 starts in a row failed";
    case "refused":
      return "a job was refused";
    case "coordinator":
      return "its coordinating job kept failing";
    default:
      return "it stopped";
  }
}

/**
 * A stage's facts as the page sets them (#322): they break only after a dot,
 * so "4 d 4 h", "3,864 / 12,000 finished" and general-cpu stay whole.
 */
export function unbroken(s: string): string {
  return s
    .replace(/ · /g, " · ")
    .replace(/(\d) \/ (\d)/g, "$1 / $2")
    .replace(/(\d) (d|h|m|s|finished|failed)\b/g, "$1 $2")
    .replace(/\b(d|h) (\d)/g, "$1 $2")
    .replace(/ so far/g, " so far")
    .replace(/(\w)-(\w)/g, "$1‑$2");
}

/** A date as a line sets it: it breaks after its weekday's comma, never inside "Nov 12" or "3:10 PM". */
export function wholeDate(s: string): string {
  return s.replace(/\b([A-Z][a-z]{2}) (\d)/g, "$1\u00a0$2").replace(/ (?=[AP]M\b)/g, "\u00a0");
}

/** Past this many stops, the earlier ones fold into Fitting, so the line keeps to seven stages. */
const STOPS_SHOWN = 2;

/** A stretch of fitting: from a start running (NaN when none ran) to its stop, its end or now. */
interface Leg {
  began: number;
  until: number;
  /** Its finished starts at its end; `null` for a stop recorded before ICMM kept them. */
  finished: number | null;
}

/**
 * The run's stages (#322, stage line B): Submitted, then Fitting from the
 * first start that ran, opening with the wait for it ("after waiting 7 m for
 * general-cpu", "began at once"); each stop (Canceled or Failed) and its
 * Resume stay as stages after it, each stretch counting its own fitting
 * time; then Ended with the ETA while it runs, or how it ended. Canceling and
 * Resuming take the last place while the coordinator acts. Before a start
 * runs, Queued (or Held) is the wait; a run that never ran a start reads
 * Submitted · Queued · Failed. Past two stops, the earlier ones fold into
 * Fitting. Each time leaves out the date it shares with the stage before.
 */
export function stagesOf(r: Run, a: StageAround): StageView[] {
  const p = r.progress;
  const phase = phaseOf(r);
  const S: StageView[] = [];
  let prev = a.now;
  const when = (t: number) => {
    if (Number.isNaN(t)) return "";
    const s = clock(t, prev);
    prev = t;
    return s;
  };
  S.push({
    node: "done",
    line: "solid",
    time: when(at(r.submitted_at)),
    name: "Submitted",
    detail: `its config as saved, on ${r.dataset.name ?? "its dataset"}’s revision ${r.dataset.revision}`,
  });
  const end = endOf(r);
  const live = phase === "running" || phase === "waiting" || phase === "canceling";
  const finishedOf = (n: number | null) =>
    n === null ? "" : `${whole(n)} / ${whole(p.starts)} finished`;
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const ahead: StageView = {
    node: "todo",
    line: "none",
    time: "",
    name: "Ended",
    detail: a.eta === undefined ? "" : etaWords(a.eta, a.now),
    tone: "dim",
  };
  const canceling = (): StageView => ({
    node: "busy",
    line: "none",
    time: when(at(r.canceling)),
    name: "Canceling",
    detail:
      p.starts_running > 0
        ? `stopping its ${plural(p.starts_running, "running start", "running starts")}`
        : "taking its starts off the queue",
  });
  const liveNode = (): StageNode =>
    phase === "canceling"
      ? "busy"
      : phase === "running"
        ? "live"
        : r.state === "held"
          ? "held"
          : "ring";
  const endDetail = (how: "completed" | "failed" | "canceled") =>
    how === "completed"
      ? "every start finished"
      : how === "failed"
        ? failedWords(r.failure, p.starts_finished)
        : `after ${whole(p.topologies_complete)} of ${plural(p.topologies, "topology", "topologies")}`;

  // Its stops, and a Resume accepted before ICMM kept them as one.
  const stops: RunStop[] =
    phase === "resuming" && r.stops.length === 0 && r.resuming !== null
      ? [
          {
            ended: r.resuming.ended,
            ended_at: r.resuming.ended_at,
            starts_finished: null,
            topologies_complete: null,
            starts_stopped: null,
            failure: null,
            resumed_at: r.resuming.since,
            running_at: null,
          },
        ]
      : r.stops;
  const first = at(r.first_running_at);
  const legs: Leg[] = [];
  for (let i = 0; i <= stops.length; i++) {
    const stop = stops[i] as RunStop | undefined;
    const began =
      i === 0
        ? stop === undefined || first <= at(stop.ended_at)
          ? first
          : NaN
        : at(stops[i - 1].running_at);
    legs.push({
      began,
      until: stop !== undefined ? at(stop.ended_at) : (end?.at ?? a.now),
      finished: stop !== undefined ? stop.starts_finished : p.starts_finished,
    });
  }
  const fit = (l: Leg) => (Number.isNaN(l.began) ? 0 : Math.max(0, (l.until - l.began) / 1000));

  // Past two stops, the stretches before the first shown fold into Fitting.
  const folded = Math.max(0, stops.length - STOPS_SHOWN);
  const merged = legs.slice(0, folded + 1);
  const ran = merged.find((l) => !Number.isNaN(l.began));
  const firstLeg: Leg = {
    began: ran?.began ?? NaN,
    until: merged[merged.length - 1].until,
    finished: merged[merged.length - 1].finished,
  };
  const firstFit = merged.reduce((n, l) => n + fit(l), 0);
  const shown = stops.slice(folded);
  const latest = shown.length === 0;
  const resumedTimes =
    folded === 0
      ? ""
      : `resumed ${folded === 1 ? "once" : folded === 2 ? "twice" : `${whole(folded)} times`}`;

  if (Number.isNaN(firstLeg.began)) {
    // No start ran before its first stop, or yet.
    if (latest && end === undefined) {
      const held = r.state === "held";
      S.push({
        node: phase === "canceling" ? "ring" : held ? "held" : "ring",
        line: "faint",
        time: "",
        name: held ? "Held" : "Queued",
        detail: waitsOn(r, a),
      });
      if (phase === "canceling") {
        S.push(canceling());
        return S;
      }
      S.push({
        node: "todo",
        line: "faint",
        time: "",
        name: "Fitting",
        detail: `${plural(p.topologies, "topology", "topologies")}, ${a.slurm ? "sent" : "started"} one at a time`,
        tone: "dim",
      });
      S.push({
        node: "todo",
        line: "none",
        time: "",
        name: "Ended",
        detail: a.total === undefined ? "" : `ETA ${aboutWords(a.total)} after it starts`,
        tone: "dim",
      });
      return S;
    }
    const failure = latest ? r.failure : shown[0].failure;
    S.push({
      node: "done",
      line: "solid",
      time: "",
      name: "Queued",
      detail:
        failure?.cause === "refused"
          ? "its first array was refused"
          : r.first_array_at === null
            ? "nothing went out"
            : "none of its starts ran",
    });
  } else {
    const so = latest && live;
    const failedOut = latest && end !== undefined && p.starts_finished === 0 && p.starts_failed > 0;
    S.push({
      node: so ? liveNode() : "done",
      line: so ? "dash" : "solid",
      time: when(firstLeg.began),
      name: "Fitting",
      detail: join(
        waitedFor(r, a, firstLeg.began),
        `${durationWords(firstFit)}${so ? " so far" : ""}`,
        failedOut
          ? `${whole(p.starts_failed)} failed, none finished`
          : finishedOf(firstLeg.finished),
        resumedTimes,
      ),
    });
  }

  // Each stop shown, and the stretch after its Resume.
  shown.forEach((stop, j) => {
    const failed = stop.ended === "failed";
    S.push({
      node: failed ? "failed" : "canceled",
      line: "faint",
      time: when(at(stop.ended_at)),
      name: failed ? "Failed" : "Canceled",
      detail: failed
        ? Number.isNaN(firstLeg.began) && j === 0
          ? "nothing fit"
          : failedWords(stop.failure, stop.starts_finished)
        : stop.topologies_complete === null
          ? ""
          : `after ${whole(stop.topologies_complete)} of ${plural(p.topologies, "topology", "topologies")}`,
      tone: failed ? "red" : undefined,
    });
    const leg = legs[folded + j + 1];
    const last = j === shown.length - 1;
    if (last && phase === "resuming") {
      S.push({
        node: "busy",
        line: "none",
        time: when(at(r.resuming?.since ?? stop.resumed_at)),
        name: "Resuming",
        detail: `${plural(unfinishedOf(r), "start", "starts")} to fit`,
      });
      return;
    }
    const time = when(at(stop.resumed_at));
    if (Number.isNaN(leg.began)) {
      const waiting = last && live;
      S.push({
        node: waiting ? (r.state === "held" ? "held" : "ring") : "done",
        line: waiting ? "faint" : "solid",
        time,
        name: "Resumed",
        detail: waiting ? waitsOn(r, a) : "none of its starts ran",
      });
      return;
    }
    const so = last && live;
    S.push({
      node: so ? liveNode() : "done",
      line: so ? "dash" : "solid",
      time,
      name: "Resumed",
      detail: join(
        "fitting again",
        `${durationWords(fit(leg))}${so ? " so far" : ""}`,
        finishedOf(leg.finished),
      ),
    });
  });
  if (phase === "resuming") return S;
  if (phase === "canceling") S.push(canceling());
  else if (live) S.push(ahead);
  else if (end !== undefined) {
    S.push({
      node: end.how,
      line: "none",
      time: when(end.at),
      name: end.how === "completed" ? "Completed" : end.how === "failed" ? "Failed" : "Canceled",
      detail:
        end.how === "failed" && Number.isNaN(first) && shown.length === 0
          ? "nothing fit"
          : endDetail(end.how),
      tone: end.how === "failed" ? "red" : undefined,
    });
  }
  return S;
}

/** The wait before its first start ran: "after waiting 7 m for general-cpu", or "began at once". */
function waitedFor(r: Run, a: StageAround, began: number): string {
  const waited = (began - at(r.submitted_at)) / 1000;
  if (!(waited >= 60)) return "began at once";
  const place = a.slurm ? (a.partition ?? "the cluster") : `a free slot ${onPlatform(a.platform)}`;
  return `after waiting ${durationWords(waited)} for ${place}`;
}

// ── still improving ───────────────────────────────────────────────────────────────────────────

/** A piece of the still-improving note: words, a number, the share, or the config's name. */
export interface NotePart {
  t: string;
  kind?: "n" | "share" | "config";
}

/**
 * The note under the stages while Mark still-improving starts is on (#234):
 * the share of the finished starts whose Train RMSE was still falling when
 * their evaluations ran out. While the run fits it's "So far"; once it has
 * ended, it names the config to raise Evaluations per start in, unless that
 * config is deleted. None still improving is one line, `some` false. Before
 * a start has finished there's none.
 */
export function improvingNote(
  r: Run,
  phase: Phase,
): { some: boolean; parts: NotePart[] } | undefined {
  const finished = r.progress.starts_finished;
  const still = r.progress.starts_still_improving;
  if (finished === 0) return undefined;
  const parts: NotePart[] = [];
  const t = (x: string) => parts.push({ t: x });
  if (still === 0) {
    if (finished === 1) t("The ");
    else t("None of the ");
    parts.push({ t: whole(finished), kind: "n" });
    t(
      finished === 1
        ? " finished start wasn’t still improving at its end."
        : " finished starts was still improving at its end.",
    );
    return { some: false, parts };
  }
  // Never rounded to none, or to all while some weren't.
  const pct = (100 * still) / finished;
  const share =
    pct < 1 ? "under 1 %" : `${still < finished ? Math.min(99, Math.round(pct)) : 100} %`;
  const ended = phase === "completed" || phase === "failed" || phase === "canceled";
  if (ended) parts.push({ t: share[0].toUpperCase() + share.slice(1), kind: "share" });
  else {
    t("So far, ");
    parts.push({ t: share, kind: "share" });
  }
  const search = r.settings?.search;
  const evaluations =
    search === undefined ? 0 : evaluationsPerStart(search.evaluation_budget, search.population);
  if (evaluations > 0) {
    t(" of finished starts were still improving when they reached ");
    parts.push({ t: whole(evaluations), kind: "n" });
    t(" evaluations.");
  } else t(" of finished starts were still improving when their evaluations ran out.");
  if (!ended || r.config.deleted) {
    t(" More evaluations per start may fit better.");
  } else {
    t(" More evaluations per start may fit better: raise it in ");
    parts.push({ t: r.config.name, kind: "config" });
    t(", then Submit again…");
  }
  return { some: true, parts };
}

// ── the box under the stages ──────────────────────────────────────────────────────────────────

/** The cap line under the box's number: words, the Platform settings link, words. */
export interface CapLine {
  before: string;
  link: boolean;
  after: string;
}

export interface StateBox {
  label: string;
  big: string;
  bigOf: string;
  cap: CapLine | undefined;
  /** What's on the cluster now: the fitting topology's card and those after it. */
  live: boolean;
  glyph?: string;
  what?: string;
  next?: string;
  raw?: string;
  since?: string;
  hint?: string;
  /** Its coordinating job log says why it stopped: Open its log opens it (#289). */
  log?: boolean;
  /** The last line of its left column while the run goes on: it needs no ICMM (#324, SR02). */
  keep?: string;
}

/** That a run in flight goes on without the app, under the box's number (#322). */
const KEEPS_GOING = "Keeps going if you close ICMM.";

/** A topology named `#214/T12.3`, with a count of its starts. */
export interface Named {
  name: string;
  starts: number;
}

export interface BoxAround {
  platform: Platform;
  slurm: boolean;
  job: JobDefaults | undefined;
  partition: string | null;
  /** The user's running SLURM jobs, each array task counted; `undefined` unread. */
  jobs: number | undefined;
  /** The QOS limit on them; `null` where none applies, `undefined` unread. */
  limit: number | null | undefined;
  /** Every run in flight on the platform, to say whose jobs or slots are in use. */
  inFlight: RunSummary[];
  /** The fitting topology's queued starts, to say what a cancel takes off the cluster. */
  queued: Named | undefined;
  /** Its first unfinished topology, which a Resume sends first. */
  firstUnfinished: Named | undefined;
  /** Why it waits, as Runs says it (`waitingOf`). */
  waiting: { say: string; raw: string | undefined; since: string } | undefined;
  /** The topology whose starts failed, when only one has any. */
  failedIn: string | undefined;
  /**
   * What this page's Resume answered about the engine: the one it replaced,
   * `null` for none, `undefined` when it isn't known (resumed elsewhere).
   */
  replacedEngine?: string | null;
  engineNow: string | null;
  now: number;
  asOf: number | undefined;
}

/** Run numbers as a phrase: "#213's", "#213's and #212's". */
function whose(ids: number[]): string {
  const named = ids.map((id) => `#${id}’s`);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
}

/** Starts still running in the topologies sent before the card's (#500), and in how many. */
export interface Earlier {
  running: number;
  topologies: number;
}

/**
 * What the topologies sent before `card`, the newest fitting, still run, so
 * the card and its "+ 3 running in 2 earlier arrays" add up to the box (#500).
 * `undefined` when none still has a start running.
 */
export function earlierOf(sent: TopologySummary[], card: TopologySummary): Earlier | undefined {
  const before = sent
    .slice(0, Math.max(0, sent.indexOf(card)))
    .filter((t) => t.state === "fitting" && t.starts_running > 0);
  if (before.length === 0) return undefined;
  return { running: before.reduce((n, t) => n + t.starts_running, 0), topologies: before.length };
}

/** The card's words after that count: "running in 2 earlier arrays" ("topologies" without SLURM). */
export function earlierWords(e: Earlier, slurm: boolean): string {
  const k = e.topologies;
  const what = slurm
    ? plural(k, "earlier array", "earlier arrays")
    : plural(k, "earlier topology", "earlier topologies");
  return `running in ${what}`;
}

/** Facts set as one line (#500): each keeps its words together, so it breaks only after a dot. */
export function factLine(...facts: string[]): string {
  return facts.map((f) => f.replace(/ /g, "\u00a0")).join("\u00a0· ");
}

/** The slots in use on a platform without SLURM: this run's, and the other runs' holding some. */
function slotsOf(r: Run, a: BoxAround): { used: number; mine: number; others: RunSummary[] } {
  const others = a.inFlight.filter((o) => o.id !== r.id && o.progress.starts_running > 0);
  const mine = r.ended_at === null ? r.progress.starts_running : 0;
  return { used: mine + others.reduce((n, o) => n + o.progress.starts_running, 0), mine, others };
}

/**
 * The box's number on a platform without SLURM (#500): the slots in use of
 * the cap all its runs share, and how many are this run's ("of 5 in use ·
 * 3 #214's"). On the cluster the cap is each run's own, so it counts the run's.
 */
function slotsInUse(r: Run, a: BoxAround): { big: string; bigOf: string } {
  const { used, mine } = slotsOf(r, a);
  const cap = a.job?.max_running_starts;
  const own = mine === 0 ? "none" : mine === used ? "all" : whole(mine);
  return {
    big: whole(used),
    bigOf: factLine(
      cap === undefined ? "in use" : `of ${whole(cap)} in use`,
      ...(used === 0 ? [] : [`${own} #${r.id}’s`]),
    ),
  };
}

/** The cap line of the box: the cap and CPUs from Platform settings, then whose jobs or slots. */
function capLineOf(r: Run, a: BoxAround, holders: boolean): CapLine | undefined {
  const job = a.job;
  if (job === undefined) return undefined;
  const cpus = plural(job.cpus_per_start, "CPU", "CPUs");
  const { mine, others } = slotsOf(r, a);
  const theirs = others.reduce((n, o) => n + o.progress.starts_running, 0);
  // The time doesn't break from its AM or PM where the line wraps.
  const asOf =
    a.asOf === undefined ? "" : ` · as of ${clock(a.asOf, a.now).replace(/ (?=[AP]M$)/, "\u00a0")}`;
  if (!a.slurm) {
    // The box's number says how many slots are this run's; this line names the others' (#500).
    const holding = whose(others.map((o) => o.id));
    const fact =
      mine === 0 && theirs === job.max_running_starts
        ? `all ${whole(theirs)} are ${holding}`
        : `${whole(theirs)} ${theirs === 1 ? "is" : "are"} ${holding}`;
    // It breaks after the dot, never inside "2 are #41's".
    const who = theirs === 0 ? "" : `\u00a0· ${factLine(fact)}`;
    return {
      before: `Up to ${whole(job.max_running_starts)} at once, shared by all runs ${onPlatform(a.platform)}, ${cpus} each, from `,
      link: true,
      after: `${who}${asOf}`,
    };
  }
  let jobs = "";
  if (a.jobs !== undefined) {
    jobs =
      a.limit == null
        ? `${whole(a.jobs)} of your cluster jobs running`
        : `${whole(a.jobs)} of your ${whole(a.limit)} cluster jobs in use`;
    if (holders && theirs > 0 && a.jobs > 0) {
      const ids = whose(others.map((o) => o.id));
      jobs += theirs >= a.jobs ? `, all ${ids}` : `, ${whole(theirs)} of them ${ids}`;
    }
  }
  return {
    before: `Up to ${whole(job.max_running_starts)} at once, ${cpus} each, from `,
    link: true,
    after: `${jobs === "" ? "" : ` · ${jobs}`}${asOf}`,
  };
}

/**
 * The box under the stages: what's on the cluster now while it runs, why it
 * waits, what a cancel or resume is doing, or why it stopped; nothing once
 * it completed.
 */
export function boxOf(r: Run, a: BoxAround): StateBox | undefined {
  const p = r.progress;
  const phase = phaseOf(r);
  const local = !a.slurm;
  const label = local ? `On ${inSentence(a.platform)} now` : "On the cluster now";
  const cap = a.job?.max_running_starts;
  const of = cap === undefined ? "starts running" : `of ${plural(cap, "start", "starts")} running`;
  const number = local ? slotsInUse(r, a) : { big: whole(p.starts_running), bigOf: of };
  if (phase === "running") {
    return {
      label,
      ...number,
      cap: capLineOf(r, a, true),
      live: true,
      keep: KEEPS_GOING,
    };
  }
  if (phase === "waiting") {
    const w = a.waiting;
    return {
      label,
      ...number,
      // A run held at the job limit names whose jobs in its own line; the rest say it here.
      cap: capLineOf(r, a, !(r.state === "held" && r.held?.kind !== "space")),
      live: false,
      glyph: r.state === "held" ? "g g-held" : "g g-queued",
      what: w?.say,
      raw: w?.raw,
      since: w?.raw === undefined ? undefined : w.since,
      keep: KEEPS_GOING,
    };
  }
  const since = (iso: string | null | undefined) => {
    const t = at(iso);
    return Number.isNaN(t) ? "" : `since ${clock(t, a.now)}`;
  };
  if (phase === "canceling") {
    const what = cancelingWhat(r, a);
    return {
      label: "Canceling",
      big: whole(p.starts_running),
      bigOf: p.starts_running === 1 ? "start stopping" : "starts stopping",
      cap: { before: since(r.canceling), link: false, after: "" },
      live: false,
      glyph: "g g-busy",
      what,
      next:
        p.starts_running > 0
          ? `The ${plural(p.starts_finished, "finished start is", "finished starts are")} kept, and Resume fits the ${p.starts_running === 1 ? "1 stopped one" : `${whole(p.starts_running)} stopped ones`} again from the beginning.`
          : `The ${plural(p.starts_finished, "finished start is", "finished starts are")} kept, and Resume can fit the rest later.`,
    };
  }
  if (phase === "resuming") {
    const first =
      a.firstUnfinished === undefined
        ? ""
        : ` ${a.firstUnfinished.name}’s ${plural(a.firstUnfinished.starts, "unfinished start goes", "unfinished starts go")} out first.`;
    const begins = local
      ? "It starts as soon as a start’s slot is free."
      : `Its coordinating job is starting on ${a.partition ?? "the cluster"}.`;
    // The starts its cancel stopped begin again; the engine is named only when it changed (#324).
    const stopped = r.stops.at(-1)?.starts_stopped ?? 0;
    const again =
      stopped > 0
        ? `The ${stopped === 1 ? "1 start" : `${whole(stopped)} starts`} the cancel stopped ${stopped === 1 ? "is" : "are"} fit again from the beginning.`
        : undefined;
    const own = engineVersion(r.engine);
    const engine = own === undefined ? "the engine installed now" : `ICMM ${own}’s engine`;
    const replaced = a.replacedEngine == null ? undefined : engineVersion(a.replacedEngine);
    const changed =
      a.replacedEngine == null
        ? undefined
        : `With ${engine}, the one installed now: ${replaced === undefined ? "the rest’s" : `ICMM ${replaced}’s`} is no longer on ${platformName(a.platform)}.`;
    const hint = [again, changed].filter(Boolean).join(" ");
    return {
      label: "Resuming",
      big: whole(unfinishedOf(r)),
      bigOf: unfinishedOf(r) === 1 ? "start to fit" : "starts to fit",
      cap: { before: since(r.resuming?.since), link: false, after: "" },
      live: false,
      glyph: "g g-busy",
      what: `${begins}${first}`,
      ...(hint === "" ? {} : { hint }),
      keep: KEEPS_GOING,
    };
  }
  if (phase === "completed") return undefined;
  const stop = stopOf(r, a);
  return {
    label: phase === "failed" ? "Why it stopped" : "Canceled",
    big: whole(unfinishedOf(r)),
    bigOf: `of ${plural(p.starts, "start", "starts")} unfinished`,
    cap: undefined,
    live: false,
    glyph: phase === "failed" ? "g g-failed" : "g g-canceled",
    what: stop.what,
    next: stop.next,
    raw: stop.raw,
    since: stop.since,
    hint: resumeHint(r, a.platform, a.engineNow),
    ...(stop.log ? { log: true } : {}),
  };
}

/**
 * What a cancel is doing, as Run detail's box and Runs' row say it (#324,
 * SR03): "Stopping its 16 running starts and taking #214/T12.3's 20 queued
 * starts off the cluster."
 */
export function cancelingWhat(
  r: Pick<RunSummary, "progress">,
  a: { platform: Platform; slurm: boolean; queued: Named | undefined },
): string {
  const p = r.progress;
  const local = !a.slurm;
  const where = local ? inSentence(a.platform) : "the cluster";
  const stop =
    p.starts_running > 0
      ? `Stopping its ${plural(p.starts_running, "running start", "running starts")}`
      : "";
  const queued = local ? ["waiting start", "waiting starts"] : ["queued start", "queued starts"];
  const off =
    a.queued !== undefined && a.queued.starts > 0
      ? `taking ${a.queued.name}’s ${plural(a.queued.starts, queued[0], queued[1])} off ${where}`
      : "";
  return stop && off
    ? `${stop} and ${off}.`
    : stop
      ? `${stop}.`
      : off
        ? `${off[0].toUpperCase()}${off.slice(1)}.`
        : `Taking its starts off ${where}.`;
}

/**
 * The fitting topology's starts not yet out of a cancel's way, `#214/T12.3`'s
 * 20 queued: those not finished, failed or running. `undefined` without one.
 */
export function queuedOf(run: number, fitting: TopologySummary | undefined): Named | undefined {
  if (fitting === undefined) return undefined;
  const rest =
    fitting.starts - fitting.starts_finished - fitting.starts_failed - fitting.starts_running;
  return { name: topologyName(run, fitting), starts: Math.max(0, rest) };
}

/** Where a run's failed starts say what happened, when no one change answers them. */
const ON_TOPOLOGY = "Each failed start’s cause and log are on its topology’s page.";

/** What to change for a cause of failed starts, where Platform settings has the answer. */
const CHANGES: Partial<Record<FailedStarts["cause"], string>> = {
  out_of_memory: "Raise Memory per start in Platform settings, then Resume.",
  time_limit: "Raise Time limit per start in Platform settings, then Resume.",
};

function causeChange(cause: FailedStarts["cause"] | undefined): string | undefined {
  return cause === undefined ? undefined : CHANGES[cause];
}

/** A cause of failed starts, uncounted, as "20 starts in a row failed: out of memory" names it. */
const UNCOUNTED: Record<FailedStarts["cause"], string> = {
  out_of_memory: "out of memory",
  error: "errors",
  time_limit: "over the time limit",
  lost: "lost by the cluster",
};

/**
 * Why a run stopped, in the box (#232): the reason, what to change, and the
 * scheduler's own words where there are some; a canceled run says when and
 * how far it got.
 */
export function stopOf(
  r: Pick<Run, "state" | "progress" | "failure" | "ended_at">,
  a: Pick<BoxAround, "platform" | "job" | "partition" | "failedIn" | "now">,
): { what: string; next?: string; raw?: string; since?: string; log?: boolean } {
  const p = r.progress;
  if (r.state === "canceled") {
    const ended = at(r.ended_at);
    const when = Number.isNaN(ended) ? "" : ` ${clock(ended, a.now)}`;
    return {
      what: `Canceled${when}, after ${whole(p.topologies_complete)} of ${plural(p.topologies, "topology", "topologies")}`,
    };
  }
  const f = r.failure;
  if (f === null) return { what: "It stopped." };
  const failed = f.failed_starts.reduce((n, s) => n + s.starts, 0);
  const causes = f.failed_starts.map(counted).join(", ");
  const notFitted = Math.max(0, p.starts - p.starts_finished - failed);
  const notFittedWords = notFitted > 0 ? ` · ${whole(notFitted)} not fitted` : "";
  // One cause behind every failed start: what to change for it, where there's one (#326).
  const only = f.failed_starts.length === 1 ? causeChange(f.failed_starts[0].cause) : undefined;
  if (p.starts_finished === 0 && failed > 0 && f.cause !== "refused" && f.cause !== "coordinator") {
    return {
      what: `All ${plural(failed, "start", "starts")} failed${causes ? `: ${causes}` : ""}${notFittedWords}`,
      next:
        only ??
        (a.failedIn === undefined ? ON_TOPOLOGY : `Each start’s error is on ${a.failedIn}’s page.`),
    };
  }
  switch (f.cause) {
    case "starts_failed":
      return {
        what: `${whole(failed)} of ${plural(p.starts, "start", "starts")} failed${causes ? `: ${causes}` : ""}`,
        next: only ?? ON_TOPOLOGY,
      };
    case "stopped_early": {
      const why = f.failed_starts
        .slice(0, 2)
        .map((s) => UNCOUNTED[s.cause])
        .join(" and ");
      return {
        what: `20 starts in a row failed${why ? `: ${why}` : ""}${notFittedWords}`,
        next: causeChange(f.failed_starts[0]?.cause) ?? ON_TOPOLOGY,
      };
    }
    case "refused": {
      const account = a.job?.type === "slurm" ? a.job.account : null;
      const said = refusalOf(f, { platform: a.platform, account, partition: a.partition });
      const ended = at(r.ended_at);
      return {
        what: said.what,
        next: `${said.change[0].toUpperCase()}${said.change.slice(1)}.`,
        raw: said.code ?? f.detail ?? undefined,
        since: Number.isNaN(ended) ? undefined : `refused ${clock(ended, a.now)}`,
      };
    }
    case "coordinator":
      return {
        what: "Its coordinating job kept failing",
        next: "Three in a row ended without sending or collecting a start. The last one’s log says why.",
        log: true,
      };
  }
}

/**
 * The next step Home's ended card says under a failed run's reason (#398,
 * HF01, HF02): Run detail's, where it's one change in Platform settings or
 * the coordinating job's log, which the card then offers; none otherwise.
 */
export function cardNextOf(
  r: Pick<Run, "state" | "progress" | "failure" | "ended_at">,
  a: Pick<BoxAround, "platform" | "job" | "partition" | "failedIn" | "now">,
): { next: string; log: boolean } | undefined {
  if (r.state !== "failed") return undefined;
  const stop = stopOf(r, a);
  if (stop.next === undefined) return undefined;
  if (stop.log === true) return { next: stop.next, log: true };
  return Object.values(CHANGES).includes(stop.next) ? { next: stop.next, log: false } : undefined;
}

// ── the confirms ──────────────────────────────────────────────────────────────────────────────

/** A list as a sentence: "a", "a and b", "a, b and c". */
function listed(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");
}

/** Cancel run…'s confirm: what stops, what isn't fit, and that the finished starts are kept. */
export function cancelWords(r: Run, a: { slurm: boolean; queued: Named | undefined }): string {
  const p = r.progress;
  if (nothingYet(r) && p.starts_running === 0) {
    return "Nothing has started yet. It leaves the queue, and Resume can send it again later.";
  }
  const notSent = Math.max(
    0,
    p.topologies - p.topologies_complete - p.topologies_failed - p.topologies_fitting,
  );
  const unfit: string[] = [];
  if (a.queued !== undefined && a.queued.starts > 0) {
    const [one, many] = a.slurm
      ? ["queued start", "queued starts"]
      : ["waiting start", "waiting starts"];
    unfit.push(`${a.queued.name}’s ${plural(a.queued.starts, one, many)}`);
  }
  if (notSent > 0) {
    unfit.push(
      `the ${plural(notSent, "topology", "topologies")} ${a.slurm ? "not sent yet" : "not started yet"}`,
    );
  }
  const kept = `The ${plural(p.starts_finished, "finished start is", "finished starts are")} kept`;
  if (p.starts_running > 0) {
    // Its running starts begin again on a Resume, with what wasn't fit yet (#324, SR17).
    const one = p.starts_running === 1;
    const stops = `Its ${plural(p.starts_running, "running start stops", "running starts stop")}, and Resume fits ${one ? "it" : "them"} again from the beginning`;
    return `${stops}${unfit.length === 0 ? "" : `, with ${listed(unfit)}`}. ${kept}.`;
  }
  const single = unfit.length === 1 && (notSent === 1 || a.queued?.starts === 1);
  const notFit = unfit.length === 0 ? "" : `${listed(unfit)} ${single ? "isn’t" : "aren’t"} fit`;
  const later = `${kept}, and Resume can fit the rest later.`;
  return notFit ? `${notFit[0].toUpperCase()}${notFit.slice(1)}. ${later}` : later;
}

/**
 * Delete run…'s confirm, before the folder's path: with what the folder holds, as its
 * coordinator counted it (`folder_bytes`), once it has.
 */
export function deleteWords(platform: Platform, folderBytes: number | null): string {
  const size = folderBytes === null ? "" : `, ${sizeWords(folderBytes)}`;
  return `Its rankings, results and logs go from ${platformName(platform)}, and so does its folder${size}. Results and Home stop counting it. This can’t be undone.`;
}

// ── the grid of topologies ────────────────────────────────────────────────────────────────────

/** What a topology's square shows. */
export type CellKind =
  "complete" | "failed" | "fitting" | "unfinished" | "next" | "waiting" | "not-fitted";

export interface Cell {
  key: string;
  /** Its topology's id, `T12.3`: its page is `/runs/214/T12.3`. */
  id: string;
  kind: CellKind;
  title: string;
  /** A complete square's share of cobalt, 65–100 %: stronger for a lower RMSE. */
  shade?: number;
  /** A fitting or unfinished square's fill: its finished starts' share. */
  fill?: number;
  best: boolean;
}

export interface Grid {
  cells: Cell[];
  legend: { kind: CellKind | "best"; t: string }[];
  /** The shade's ends, lowest first, for a run with complete topologies. */
  shade: { metric: string; lo: string; hi: string } | undefined;
}

/**
 * The run's topologies as squares, in the order they're sent (#232): complete
 * ones shaded by their Best start's RMSE, failed, fitting with its finished
 * starts as a fill (unfinished, once the run has stopped), the next to go
 * out, and those waiting (not fitted, once it has stopped). The best is ringed.
 */
export function gridOf(r: Run, sent: TopologySummary[], rankOf: Map<string, number>): Grid {
  const phase = phaseOf(r);
  const ended = stopped(phase);
  const byVal = r.validation;
  const metric = (t: TopologySummary) => (byVal ? t.best?.val_rmse : t.best?.train_rmse) ?? null;
  const values = sent
    .filter((t) => t.state === "complete")
    .map(metric)
    .filter((v): v is number => v !== null);
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 0;
  // Before any start has run, those sent wait like the rest, as a queued run draws them (#507).
  const fits = (t: TopologySummary) => t.state === "fitting" && (ended || !nothingYet(r));
  // The latest sent of those fitting is the one whose queue the next waits on.
  const fitting = sent.filter(fits).at(-1);
  const next = ended || fitting === undefined ? undefined : sent.find((t) => t.state === "next");
  const bestKey = r.best === null ? undefined : topologyKey(r.best);
  const counts = new Map<CellKind, number>();
  const cells = sent.map((t): Cell => {
    const key = topologyKey(t);
    const name = topologyName(r.id, t);
    let kind: CellKind;
    if (t.state === "complete") kind = "complete";
    else if (t.state === "failed") kind = "failed";
    else if (fits(t)) kind = ended ? "unfinished" : "fitting";
    else if (t === next) kind = "next";
    else kind = ended ? "not-fitted" : "waiting";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const finished = `${whole(t.starts_finished)} of ${plural(t.starts, "start", "starts")} finished`;
    const v = metric(t);
    const rank = rankOf.get(key);
    const title: Record<CellKind, string> = {
      complete: `${name} · complete${rank === undefined ? "" : ` · rank ${whole(rank)}`}${v === null ? "" : ` · ${byVal ? "val" : "train"} ${rmse(v)}`}`,
      failed: `${name} · failed · all ${plural(t.starts, "start", "starts")} failed`,
      fitting: `${name} · fitting · ${finished}`,
      unfinished: `${name} · unfinished · ${finished}`,
      next: `${name} · next · sent when ${fitting === undefined ? "the one fitting" : topologyName(r.id, fitting)}’s queue empties`,
      waiting: `${name} · waiting · not sent yet`,
      "not-fitted": `${name} · not fitted`,
    };
    return {
      key,
      id: topologyId(t),
      kind,
      title: title[kind],
      shade:
        kind !== "complete"
          ? undefined
          : v === null
            ? 65
            : Math.round(100 - ((v - lo) / (hi - lo || 1)) * 35),
      fill:
        kind === "fitting" || kind === "unfinished"
          ? t.starts_finished / Math.max(1, t.starts)
          : undefined,
      best: key === bestKey && (kind === "complete" || kind === "fitting" || kind === "unfinished"),
    };
  });
  const legend: Grid["legend"] = [];
  const n = (k: CellKind) => counts.get(k) ?? 0;
  if (n("complete")) legend.push({ kind: "complete", t: `${whole(n("complete"))} complete` });
  if (n("failed")) legend.push({ kind: "failed", t: `${whole(n("failed"))} failed` });
  if (n("fitting")) {
    legend.push({ kind: "fitting", t: `${whole(n("fitting"))} fitting · fill = starts finished` });
  }
  if (n("unfinished")) {
    const u = sent.filter((t) => t.state === "fitting");
    const failed = u.reduce((s, t) => s + t.starts_failed, 0);
    legend.push({
      kind: "unfinished",
      t:
        u.every((t) => t.starts_finished === 0) && failed > 0
          ? `${whole(n("unfinished"))} unfinished · ${u.length === 1 ? "its" : "their"} ${plural(failed, "start", "starts")} failed`
          : `${whole(n("unfinished"))} unfinished · fill = starts finished`,
    });
  }
  if (next !== undefined) legend.push({ kind: "next", t: `next (${topologyId(next)})` });
  if (n("waiting")) {
    legend.push({ kind: "waiting", t: `${whole(n("waiting"))} waiting · not sent yet` });
  }
  if (n("not-fitted")) {
    legend.push({ kind: "not-fitted", t: `${whole(n("not-fitted"))} not fitted` });
  }
  if (cells.some((c) => c.best)) {
    legend.push({
      kind: "best",
      t: phase === "running" || phase === "canceling" ? "best so far" : "best",
    });
  }
  return {
    cells,
    legend,
    shade:
      values.length > 0
        ? { metric: byVal ? "Val RMSE" : "Train RMSE", lo: rmse(lo), hi: rmse(hi) }
        : undefined,
  };
}

/**
 * The grid's columns: 20 for the canvas's 120 topologies, and more as they
 * grow, so the field stays about as tall as six rows of twenty.
 */
export function gridColumns(count: number): number {
  return Math.max(20, Math.ceil(Math.sqrt((count * 20) / 6)));
}

// ── past 2,000 topologies ─────────────────────────────────────────────────────────────────────

/** Up to this many topologies, Run detail reads every one and draws a square each (#291). */
export const SQUARES_MOST = 2_000;

/** Whether Run detail draws the run as a bar and reads its stretches: past 2,000 topologies. */
export const pastSquares = (r: Run) => r.progress.topologies > SQUARES_MOST;

export type BarKind = "complete" | "failed" | "fitting" | "unfinished" | "waiting" | "not-fitted";

export interface StateBar {
  /** Each state the run has topologies in, with how many. */
  segments: { kind: BarKind; n: number }[];
  legend: { kind: BarKind; t: string }[];
  aria: string;
}

/**
 * Past 2,000 topologies, the run's topologies by state as one bar (#291),
 * from its counts: complete, failed, fitting (unfinished once it has
 * stopped), and waiting, the next one among them (not fitted once it has
 * stopped).
 */
export function topologyBarOf(r: Run): StateBar {
  const p = r.progress;
  const ended = stopped(phaseOf(r));
  const waiting = Math.max(
    0,
    p.topologies - p.topologies_complete - p.topologies_failed - p.topologies_fitting,
  );
  const parts: [BarKind, number, string][] = [
    ["complete", p.topologies_complete, "complete"],
    ["failed", p.topologies_failed, "failed"],
    ended
      ? ["unfinished", p.topologies_fitting, "unfinished"]
      : ["fitting", p.topologies_fitting, "fitting"],
    ended ? ["not-fitted", waiting, "not fitted"] : ["waiting", waiting, "waiting · not sent yet"],
  ];
  const held = parts.filter(([, n]) => n > 0);
  const legend = held.map(([kind, n, words]) => ({ kind, t: `${whole(n)} ${words}` }));
  return {
    segments: held.map(([kind, n]) => ({ kind, n })),
    legend,
    aria: `${plural(p.topologies, "topology", "topologies")}: ${legend.map((l) => l.t).join(", ")}.`,
  };
}

// ── ranked topologies ─────────────────────────────────────────────────────────────────────────

/** A topology's parameters (ADR-0007): 2 per state, 2 per edge, and the sigmoid's a and b. */
export const parametersOf = (numStates: number, edges: number) => 2 * numStates + 2 * edges + 2;

/** A failed topology's reason: "All 100 starts failed: 100 errors". */
export function failedTopologyWords(
  t: TopologySummary,
  causes: FailedStarts[] | undefined,
): string {
  const head = `All ${plural(t.starts_failed || t.starts, "start", "starts")} failed`;
  const said = causes?.map(counted).join(", ");
  return said ? `${head}: ${said}` : head;
}

/** The table’s line beside its heading: "38 ranked (1 in progress) · top 8 by Val RMSE" (#370). */
export function rankedSub(r: Run, ranked: number, provisional: number, shown: number): string {
  if (ranked === 0) return "";
  const by = r.validation ? "Val RMSE" : "Train RMSE";
  const going = !stopped(phaseOf(r));
  const paren =
    provisional > 0 ? ` (${whole(provisional)} ${going ? "in progress" : "unfinished"})` : "";
  return `${whole(ranked)} ranked${paren} · ${ranked > shown ? `top ${whole(shown)} by ${by}` : `by ${by}`}`;
}

// ── the spread plot ───────────────────────────────────────────────────────────────────────────

/** A dot of the spread plot: `x` from 0 to 1 across the RMSE axis, and its median spread. */
export interface SpreadDot {
  x: number;
  median: number;
}

export interface Spread {
  title: string;
  sub: string;
  aria: string;
  /** The RMSE axis' five ticks: their words, and where each sits, 0 to 1 across. */
  ticks: { at: number; words: string }[];
  word: string;
  /** The best ranked topology, named; missing while it has no median. */
  best: (SpreadDot & { name: string }) | undefined;
  rest: SpreadDot[];
  /** Past 200 dots, they shrink and fade. */
  dense: boolean;
}

/**
 * The spread plot (#291): each ranked topology's median spread against the
 * RMSE it ranks by, one dot each, from the ranked topologies read (at most
 * 2,000). The RMSE axis rounds out to 0.005. A topology whose Top 10 holds
 * one start has no median, so no dot. Missing with fewer than 2 ranked.
 */
export function spreadOf(
  r: Run,
  ranked: TopologySummary[],
  rankedCount: number,
): Spread | undefined {
  const read = ranked.filter((t) => t.best !== null);
  if (read.length < 2) return undefined;
  const metric = (t: TopologySummary) =>
    (r.validation ? t.best?.val_rmse : t.best?.train_rmse) ?? null;
  const drawn = read.flatMap((t) => {
    const v = metric(t);
    return v === null || t.spread === null ? [] : [{ t, v, median: t.spread.median }];
  });
  if (drawn.length === 0) return undefined;
  const values = drawn.map((d) => d.v);
  // In 200ths, so the ticks' words come from whole numbers.
  const lo = Math.floor(Math.min(...values) * 200 + 1e-9);
  const hi = Math.max(lo + 1, Math.ceil(Math.max(...values) * 200 - 1e-9));
  const x = (v: number) => (v * 200 - lo) / (hi - lo);
  const word = r.validation ? "Val RMSE" : "Train RMSE";
  const n = whole(read.length);
  const which =
    rankedCount > read.length
      ? `the top ${n} of ${whole(rankedCount)} ranked topologies`
      : `all ${n} ranked topologies`;
  const first = drawn[0].t === read[0] ? drawn[0] : undefined;
  const name = topologyName(r.id, read[0]);
  return {
    title: `Param spread against ${word}`,
    sub: `${which}, one dot each: its median`,
    aria: `Median param spread against ${word} for ${which}${first === undefined ? "" : `; the best, ${name}, at ${first.median.toFixed(2)}`}.`,
    // A tick is a whole number of 800ths: 12.5 ten-thousandths each, rounded half up.
    ticks: [0, 1, 2, 3, 4].map((k) => ({
      at: k / 4,
      words: rmse(Math.round((4 * lo + k * (hi - lo)) * 12.5) / 10_000),
    })),
    word,
    best: first === undefined ? undefined : { x: x(first.v), median: first.median, name },
    rest: drawn.filter((d) => d !== first).map((d) => ({ x: x(d.v), median: d.median })),
    dense: drawn.length > 200,
  };
}

// ── the progress chart ────────────────────────────────────────────────────────────────────────

const X0 = 48;
const X1 = 452;

export interface ChartDrawn {
  /**
   * Drawn at the page's width (#291), past 2,000 topologies: its x in the
   * plot's own units, 0 to `SPAN` (`stretch.ts`); else 456 px wide, its x in px.
   */
  wide: boolean;
  topologies: { line: string; lastX: number; lastY: number; done: number; total: number };
  /** The RMSE axis' three ticks, lowest first. */
  ticks: [number, number, number];
  /** Each complete topology's best; none at the page's width. */
  dots: { x: number; y: number }[];
  step: string;
  best: { x: number; y: number; value: string };
  now: { x: number; text: string };
  projection: { line: string; etaX: number; eta: string; word: string } | undefined;
  days: { x: number; label: string }[];
  title: string;
  aria: string;
}

export interface Chart {
  caption: string;
  /** Drawn once a start has finished; else the empty frame's words. */
  drawn: ChartDrawn | undefined;
  empty: { what: string; estimate: string } | undefined;
}

/**
 * Topologies complete's middle gridline: the whole number of topologies
 * nearest half the total, at its own height, where the line at half an odd
 * total was labeled a number it isn't; none under 2, where it would sit on
 * 0 or the total. Its y is the gridline's, on the half pixel as theirs.
 */
export function topologiesMiddle(total: number): { n: number; y: number } | undefined {
  if (total < 2) return undefined;
  const n = Math.round(total / 2);
  return { n, y: Math.round(116 - (n / total) * 84) + 0.5 };
}

/** Three round ticks spanning `lo` to `hi`: the smallest round step whose three ticks cover both. */
export function ticksOf(lo: number, hi: number): [number, number, number] {
  const span = Math.max(hi - lo, Math.abs(hi) * 0.1, 1e-6);
  const mag = 10 ** Math.floor(Math.log10(span / 2));
  const round = (x: number) => Number(x.toPrecision(12));
  for (const m of [1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
    const step = m * mag;
    const start = Math.floor(lo / step + 1e-9) * step;
    if (start + 2 * step >= hi - 1e-12) {
      return [round(start), round(start + step), round(start + 2 * step)];
    }
  }
  return [round(lo), round((lo + hi) / 2), round(hi)];
}

/** Ticks under the chart: a day each, "Sun 9", at most about seven; hours under two days. */
function daysOf(from: number, to: number, x: (ms: number) => number): ChartDrawn["days"] {
  const out: ChartDrawn["days"] = [];
  const span = to - from;
  if (!(span > 0)) return out;
  const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (span >= 2 * DAY) {
    const step = Math.max(1, Math.ceil(span / DAY / 7));
    const d = new Date(from);
    d.setHours(24, 0, 0, 0);
    while (d.getTime() <= to) {
      out.push({ x: x(d.getTime()), label: `${WEEK[d.getDay()]} ${d.getDate()}` });
      d.setDate(d.getDate() + step);
    }
    return out;
  }
  const hours = span / (60 * MINUTE);
  const step = [1, 2, 3, 4, 6, 12].find((h) => hours / h <= 7) ?? 12;
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  while (d.getTime() < from || d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
  for (; d.getTime() <= to; d.setHours(d.getHours() + step)) {
    out.push({ x: x(d.getTime()), label: clock(d.getTime(), d.getTime()) });
  }
  return out;
}

interface ChartAround {
  eta: Eta | undefined;
  pace: number | undefined;
  total: SubmitTotal | undefined;
  slurm: boolean;
  now: number;
}

/** What the chart draws, whichever its source: when topologies completed, and the best line. */
interface Course {
  /** When topologies completed, earliest first: how many at each time. */
  done: { t: number; n: number }[];
  /** The best line: each value from the time it holds, earliest first. */
  best: { t: number; v: number }[];
  /** Each complete topology's best, for its dot. */
  dots: { t: number; v: number }[];
  /** What the RMSE axis spans. */
  values: number[];
}

/**
 * The progress chart (#232): topologies complete over time, and the best
 * RMSE of all finished starts, with each complete topology's best as a dot;
 * while it runs, a projection to the ETA. A topology's best counts from when
 * one of its starts last ended (`last_ended_at`).
 */
export function chartOf(r: Run, sent: TopologySummary[], a: ChartAround): Chart {
  const metric = (t: TopologySummary) =>
    (r.validation ? t.best?.val_rmse : t.best?.train_rmse) ?? null;
  const points = sent
    .map((t) => ({ t: at(t.last_ended_at), v: metric(t), complete: t.state === "complete" }))
    .filter(
      (q): q is { t: number; v: number; complete: boolean } => !Number.isNaN(q.t) && q.v !== null,
    )
    .sort((m, n) => m.t - n.t);
  const best: Course["best"] = [];
  for (const q of points) if (best.length === 0 || q.v < best[best.length - 1].v) best.push(q);
  const done = sent
    .filter((t) => t.state === "complete")
    .map((t) => at(t.last_ended_at))
    .filter((t) => !Number.isNaN(t))
    .sort((m, n) => m - n)
    .map((t) => ({ t, n: 1 }));
  return drawnOf(
    r,
    { done, best, dots: points.filter((q) => q.complete), values: points.map((q) => q.v) },
    a,
    [X0, X1],
  );
}

/**
 * The progress chart past 2,000 topologies (#291), at the page's width: from
 * the run's **Stretches**, each counted at its end (or now, for the one under
 * way), the best line as the run's best at each, and no dots. A run submitted
 * before ICMM kept them has nothing to draw, and says so.
 */
export function wideChartOf(r: Run, stretches: RunStretches, a: ChartAround): Chart {
  const began = at(r.first_array_at);
  const length = stretches.stretch_s;
  if (length === null) {
    const nothing = drawnOf(r, { done: [], best: [], dots: [], values: [] }, a, [0, SPAN]);
    if (Number.isNaN(began) || r.progress.starts_finished === 0) return nothing;
    return {
      caption: captionOf(r, a),
      drawn: undefined,
      empty: {
        what: "It was submitted before ICMM kept a run’s progress over time, so there’s nothing to draw.",
        estimate: "",
      },
    };
  }
  const endAt = (n: number) => Math.min(began + (n + 1) * length * 1000, chartStop(r, a.now));
  const done = stretches.stretches
    .filter((s) => s.topologies_complete > 0)
    .map((s) => ({ t: endAt(s.stretch), n: s.topologies_complete }));
  const best: Course["best"] = [];
  for (const s of stretches.stretches) {
    const v = r.validation ? s.best_val_rmse : s.best_train_rmse;
    if (v !== null && (best.length === 0 || best[best.length - 1].v !== v)) {
      best.push({ t: endAt(s.stretch), v });
    }
  }
  return drawnOf(r, { done, best, dots: [], values: best.map((q) => q.v) }, a, [0, SPAN]);
}

/**
 * The chart's line beside its heading, once it draws: how long it fit (so far,
 * after a Resume), or since when it fits, and its pace (#324, SR04).
 */
function captionOf(r: Run, a: ChartAround): string {
  const end = endOf(r);
  const pace = a.pace === undefined ? "" : ` · ≈ ${paceWords(a.pace)} per topology`;
  const fit = fittingSeconds(r, a.now);
  if (end !== undefined) return `fit ${durationWords(fit ?? 0)}${pace}`;
  if (r.stops.length > 0 && fit !== undefined) return `fit ${durationWords(fit)} so far${pace}`;
  const since = clock(at(r.first_running_at ?? r.first_array_at), a.now);
  return `fitting since ${since}${a.pace === undefined ? " · its own pace once a topology finishes" : pace}`;
}

/** Where the chart stops: the run's end, or now. */
const chartStop = (r: Run, now: number) => endOf(r)?.at ?? now;

/** The chart from `course`, across `x0` to `x1`: px for the narrow chart, the plot's units for the wide. */
function drawnOf(r: Run, course: Course, a: ChartAround, [x0, x1]: [number, number]): Chart {
  const p = r.progress;
  const phase = phaseOf(r);
  const end = endOf(r);
  const began = at(r.first_array_at);
  if (Number.isNaN(began) || course.best.length === 0) {
    const from =
      a.total?.from.kind === "runs"
        ? `from ${plural(a.total.from.runs, "finished run", "finished runs")} here`
        : "timed on this computer";
    const est =
      end !== undefined || a.total === undefined
        ? ""
        : `Submit’s estimate: ${aboutWords(a.total.seconds)} at ${plural(a.total.cap, "running start", "running starts")}, ${from}. ${a.slurm ? "Not counting any wait for the cluster." : "Not counting the wait for runs ahead of it."}`;
    const failedOut = end !== undefined && p.starts_failed > 0 && r.first_array_at !== null;
    const fit = fittingSeconds(r, a.now);
    return {
      caption: failedOut
        ? `fit ${durationWords(fit ?? 0)}`
        : end === undefined && r.first_running_at !== null
          ? `fitting since ${clock(at(r.first_running_at), a.now)}`
          : "nothing fit yet",
      drawn: undefined,
      empty: {
        what:
          end === undefined
            ? "Draws once its first topology finishes."
            : failedOut
              ? "No topology finished before it stopped."
              : "Nothing fit before it stopped.",
        estimate: est,
      },
    };
  }
  const going = phase === "running" || phase === "canceling" || phase === "waiting";
  const projecting = phase === "running" && a.eta !== undefined && a.eta.at > a.now;
  const stop = end?.at ?? a.now;
  const last = projecting && a.eta !== undefined ? a.eta.at : stop;
  const span = Math.max(last - began, MINUTE);
  const x = (ms: number) => x0 + ((Math.min(Math.max(ms, began), last) - began) / span) * (x1 - x0);
  const total = Math.max(1, p.topologies);
  const yN = (n: number) => 116 - (n / total) * 84;

  // Topologies complete, a step up at each one's end.
  let line = `M${x(began).toFixed(1)} ${yN(0).toFixed(1)}`;
  let done = 0;
  for (const q of course.done) {
    done += q.n;
    line += ` H${x(q.t).toFixed(1)} V${yN(done).toFixed(1)}`;
  }
  line += ` H${x(stop).toFixed(1)}`;

  // The best line, and each complete topology's best.
  const ticks = ticksOf(Math.min(...course.values), Math.max(...course.values));
  const yV = (v: number) => 256 - ((v - ticks[0]) / (ticks[2] - ticks[0])) * 84;
  const dots = course.dots.map((q) => ({ x: x(q.t), y: yV(q.v) }));
  let step = "";
  for (const q of course.best) {
    step +=
      step === ""
        ? `M${x(q.t).toFixed(1)} ${yV(q.v).toFixed(1)}`
        : ` H${x(q.t).toFixed(1)} V${yV(q.v).toFixed(1)}`;
  }
  step += ` H${x(stop).toFixed(1)}`;
  const min = course.best[course.best.length - 1].v;

  // Times on the chart always carry their day: the axis spans days.
  const dated = (t: number) => clock(t, t - 2 * DAY);
  const nowWord = going ? `now ${dated(a.now)}` : `${end?.how ?? "ended"} ${dated(stop)}`;
  const etaWord =
    a.eta === undefined
      ? ""
      : a.eta.estimate
        ? `ETA about ${etaDay(a.eta.at, a.now)} · Submit’s estimate`
        : `ETA ${dated(a.eta.at)}`;
  const title = r.validation ? "Best val RMSE" : "Best train RMSE";
  return {
    caption: captionOf(r, a),
    drawn: {
      wide: x0 === 0,
      topologies: {
        line,
        lastX: x(stop),
        lastY: yN(done),
        done,
        total: p.topologies,
      },
      ticks,
      dots,
      step,
      best: { x: x(stop), y: yV(min), value: rmse(min) },
      now: { x: x(stop), text: nowWord },
      projection:
        projecting && a.eta !== undefined
          ? {
              line: `M${x(stop).toFixed(1)} ${yN(done).toFixed(1)} L${x(last).toFixed(1)} ${yN(total).toFixed(1)}`,
              etaX: x(last),
              eta: etaWord,
              word: a.eta.estimate
                ? "Submit’s estimate, until a topology finishes"
                : "projection at its own pace",
            }
          : undefined,
      days: daysOf(began, last, x),
      title,
      aria: `Topologies complete and ${title} since ${clock(began, a.now)}. ${whole(done)} of ${whole(p.topologies)} complete; ${nowWord}${projecting ? `; ${etaWord}` : ""}. ${title} ${rmse(min)}.`,
    },
    empty: undefined,
  };
}
