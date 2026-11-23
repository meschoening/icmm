/**
 * What Runs says of a run (LaptopRuns, #231), and what its run-ended
 * notifications say (LaptopRunNotifications): why a run in flight waits, how
 * far it has got, why one ended short, how its best compares with its
 * dataset's, and the page's facts line. The notifications use the rows'
 * words, so a run reads the same in both.
 */
import { whole } from "../configs/words";
import { inSentence, onPlatform } from "../setup/form";
import { durationWords, elapsedWords, plural, sizeWords } from "../submit/estimate";
import { clock, clockInSentence, longDay, weekdayDate } from "../ui/clock";
import { fittingSeconds, type Times } from "./fitting";
import type {
  FailedStarts,
  RunCounts,
  RunFailure,
  RunsDataset,
  RunSummary,
  SavedPlatform,
  StartCause,
} from "../wire/types.gen";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** A run as it's named everywhere: `#214 herg-wt-11state`. */
export const runName = (r: Pick<RunSummary, "id" | "config">) => `#${r.id} ${r.config.name}`;

/** A run's number from a path, `214`; `undefined` when it isn't one. */
export function runNumberOf(param: string): number | undefined {
  const id = /^[1-9]\d*$/.test(param) ? Number(param) : undefined;
  return id !== undefined && Number.isSafeInteger(id) ? id : undefined;
}

/** An RMSE as the rows write it: four decimals. */
export const rmse = (x: number) => x.toFixed(4);

/**
 * A process's exit code as its platform writes it (#556, G5): Windows keeps
 * one as an unsigned 32-bit number, so −1 is 4294967295 and a crash
 * 3221225477; from 2³¹ it reads in hex, as Windows tools write it,
 * "0xFFFFFFFF", "0xC0000005". Every other code reads as a number.
 */
export function exitCode(code: number): string {
  return code >= 2 ** 31 && code < 2 ** 32
    ? `0x${code.toString(16).toUpperCase().padStart(8, "0")}`
    : String(code);
}

/** A run in flight's best in a runs table, on hover (#373): its number is live. */
export const RUNNING_TIP = "Still running: this changes as its topologies finish.";

/** A topology of a run, written `#214/T12.3`. */
export const topologyName = (run: number, best: { graph: number; open_state: number }) =>
  `#${run}/T${best.graph}.${best.open_state}`;

// ── the facts line ────────────────────────────────────────────────────────────────────────────

/**
 * Runs' facts line, in its parts: "2 running · 1 canceling · 1 queued · 1 held", then
 * how many ended and since when, then the failed and canceled among them,
 * only those that aren't 0 ("5 failed · 1 canceled").
 */
export function factsOf(
  c: RunCounts,
  now: number,
): { live: string; ended: number; since: string | undefined; paren: string } {
  const live = [`${whole(c.running)} running`];
  if (c.canceling > 0) live.push(`${whole(c.canceling)} canceling`);
  if (c.queued > 0) live.push(`${whole(c.queued)} queued`);
  if (c.held > 0) live.push(`${whole(c.held)} held`);
  const paren = [
    c.failed > 0 ? `${whole(c.failed)} failed` : "",
    c.canceled > 0 ? `${whole(c.canceled)} canceled` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const first = c.first_ended_at === null ? NaN : Date.parse(c.first_ended_at);
  return {
    live: live.join(" · "),
    ended: c.ended,
    since: Number.isNaN(first) ? undefined : weekdayDate(first, now),
    paren,
  };
}

// ── runs in flight ─────────────────────────────────────────────────────────────────────────────

/** What a run in flight's progress bar is cut into, as fractions of its topologies. */
export interface Bar {
  done: number;
  failed: number;
  /** How far its fitting topologies have got, as topologies. */
  fitting: number;
}

/**
 * The bar of a running run: its complete topologies, its failed ones, and
 * how far its fitting ones have got, from the starts that ended outside the
 * topologies already counted. Nothing past the whole.
 */
export function barOf(p: RunSummary["progress"]): Bar {
  const total = Math.max(1, p.topologies);
  const ended = p.topologies_complete + p.topologies_failed;
  const perTopology = p.starts / total;
  const startsEnded = p.starts_finished + p.starts_failed;
  const partial =
    perTopology > 0
      ? Math.max(0, Math.min(p.topologies - ended, startsEnded / perTopology - ended))
      : 0;
  return {
    done: p.topologies_complete / total,
    failed: p.topologies_failed / total,
    fitting: partial / total,
  };
}

/** "37 / 120 topologies · 1 failed · 1 fitting": only a count that isn't 0 is named past the first. */
export function topologiesLine(p: RunSummary["progress"]): string {
  const parts = [`${whole(p.topologies_complete)} / ${whole(p.topologies)} topologies`];
  if (p.topologies_failed > 0) parts.push(`${whole(p.topologies_failed)} failed`);
  parts.push(`${whole(p.topologies_fitting)} fitting`);
  return parts.join(" · ");
}

/** "16 of 16 starts running · 3,864 / 12,000 finished"; without the cap, "16 starts running · …". */
export function startsLine(p: RunSummary["progress"], cap: number | undefined): string {
  const running =
    cap === undefined
      ? `${plural(p.starts_running, "start", "starts")} running`
      : `${whole(p.starts_running)} of ${whole(cap)} starts running`;
  return `${running} · ${whole(p.starts_finished)} / ${whole(p.starts)} finished`;
}

/**
 * "Running again since 8:02 AM, after this computer restarted", for a run
 * relaunched where its starts run as processes: This computer, or an SSH
 * host without SLURM, "after Lab workstation restarted".
 */
export function againLine(r: RunSummary, platform: Platform, now: number): string | undefined {
  if (r.state !== "running" || r.relaunched_at === null) return undefined;
  const at = Date.parse(r.relaunched_at);
  if (Number.isNaN(at)) return undefined;
  return `Running again since ${clock(at, now)}, after ${inSentence(platform)} restarted`;
}

/** What a waiting run's row says: the plain sentence, then the scheduler's own reason and since when. */
export interface Waiting {
  say: string;
  raw: string | undefined;
  since: string;
}

/** What Runs knows of the platform beside the runs, to word a wait. */
export interface Around {
  platform: Platform;
  /** Whether SLURM schedules its starts; else they take slots, as on This computer. */
  slurm: boolean;
  /** The Job defaults' partition; `null` for SLURM's default, `undefined` unread. */
  partition?: string | null;
  /** This computer's Running-starts cap. */
  cap?: number;
  /** The user's running SLURM jobs, each array task counted; `undefined` unread. */
  jobs?: number;
  /** Every run in flight, newest first, to say whose jobs or slots it waits behind. */
  inFlight: RunSummary[];
  /** `inFlight`, where it holds all of them, as read: unfiltered (#538). */
  allInFlight?: RunSummary[];
  /** How the platform's paths are shown (`useShownPath`, #326); as they're written by default. */
  shownPath?: (path: string) => string;
  /** The running runs' ETAs, by run, for when a queued run on This computer starts (#399, HF10). */
  etas?: ReadonlyMap<number, number | undefined>;
}

/** Run numbers, newest first, as a phrase: "#214's", "#214's and #213's", "#214's, #213's and #210's". */
function whose(ids: number[]): string {
  const named = ids.map((id) => `#${id}’s`);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
}

/** Held reasons in words, by the scheduler's code; a code not here gets the general sentence. */
const HELD: Record<string, (where: string) => string> = {
  QOSMaxJobsPerUserLimit: () =>
    "You’re at your cluster job limit, so it waits. It starts on its own when one of your jobs finishes.",
  AssocMaxJobsLimit: () =>
    "You’re at your account’s job limit, so it waits. It starts on its own when one of your jobs finishes.",
  AssocGrpCpuLimit: () =>
    "Your group is using all the CPUs its account allows, so it waits. It starts on its own as your group’s jobs finish.",
  QOSGrpCpuLimit: () =>
    "Your group is using all the CPUs its QOS allows, so it waits. It starts on its own as your group’s jobs finish.",
  AssocGrpMemLimit: () =>
    "Your group is using all the memory its account allows, so it waits. It starts on its own as your group’s jobs finish.",
  QOSGrpMemLimit: () =>
    "Your group is using all the memory its QOS allows, so it waits. It starts on its own as your group’s jobs finish.",
  ReqNodeNotAvail: (where) =>
    `The nodes it needs on ${where} are down or reserved, as for maintenance. It starts on its own once they’re back.`,
  PartitionDown: (where) => `${where} isn’t taking jobs now. It starts on its own once it is.`,
  PartitionInactive: (where) => `${where} isn’t taking jobs now. It starts on its own once it is.`,
  JobHeldUser: () =>
    "Its jobs are held on the cluster, with scontrol hold. It starts once they’re released.",
  JobHeldAdmin: () =>
    "An administrator is holding its jobs on the cluster. It starts once they release them.",
};

/**
 * The run a queued run on This computer waits on: the newest run in flight
 * before it, running or queued, since its slots go to waiting starts earlier
 * run first, and a run queued before it goes first (ADR-0019; #507, F11). A
 * run held for space sends nothing, so it holds no slot.
 */
export function queueAheadOf<R extends Pick<RunSummary, "id" | "state">>(
  r: Pick<RunSummary, "id">,
  inFlight: R[],
): R | undefined {
  return inFlight
    .filter((o) => o.id < r.id && (o.state === "running" || o.state === "queued"))
    .sort((x, y) => y.id - x.id)[0];
}

/**
 * Whether a queued run on This computer is only starting: no run is ahead of
 * it and a slot is free, so it waits on nothing but its own start, a few
 * seconds (#538). It needs every run in flight on the platform, as read: a
 * filtered or unread list (`undefined`) can't say a slot is free. Before the
 * cap is read, a slot is free while none is in use.
 */
export function startingHere(
  r: Pick<RunSummary, "id" | "state" | "canceling">,
  inFlight: Pick<RunSummary, "id" | "state" | "progress">[] | undefined,
  cap: number | undefined,
): boolean {
  if (inFlight === undefined || r.state !== "queued" || r.canceling !== null) return false;
  if (queueAheadOf(r, inFlight) !== undefined) return false;
  const used = inFlight
    .filter((o) => o.id !== r.id)
    .reduce((n, o) => n + o.progress.starts_running, 0);
  return cap === undefined ? used === 0 : used < cap;
}

/** Why a run in flight that isn't running waits, as its row says it. */
export function waitingOf(r: RunSummary, a: Around, now: number): Waiting {
  const local = !a.slurm;
  const where = a.partition ? a.partition : inSentence(a.platform);
  if (r.state === "held" && r.held !== null) {
    const since = `held since ${clock(Date.parse(r.held.since), now)}`;
    if (r.held.kind === "space") {
      const s = r.held.space;
      return {
        say:
          s === null
            ? "Held for space: its folders are short of room for its next starts. It carries on by itself once there’s room."
            : `Held for space: only ${sizeWords(s.free_bytes)} is free in ${a.shownPath?.(s.folder) ?? s.folder}, less than its next starts write. It carries on by itself once about ${sizeWords(s.carries_on_bytes)} is free.`,
        raw: undefined,
        since,
      };
    }
    const reason = r.held.reason ?? "";
    const code = reason.split(",")[0].trim();
    const say =
      HELD[code]?.(where) ??
      "The cluster is holding it for now, for the reason beside. It starts on its own once that clears.";
    const holding = a.inFlight.filter((o) => o.id !== r.id && o.progress.starts_running > 0);
    const jobsLine =
      code === "QOSMaxJobsPerUserLimit" && a.jobs !== undefined && holding.length > 0
        ? `your ${whole(a.jobs)} jobs are ${whose(holding.map((o) => o.id))} starts · `
        : "";
    return { say, raw: reason || undefined, since: `${jobsLine}${since}` };
  }
  const queuedSince = r.queued === null ? r.submitted_at : r.queued.since;
  const since = `queued since ${clock(Date.parse(queuedSince), now)}`;
  if (local) {
    const ahead = queueAheadOf(r, a.inFlight);
    const cap =
      a.cap === undefined
        ? ""
        : ` ${a.platform.type === "local" ? "This computer" : a.platform.name} runs up to ${plural(a.cap, "start", "starts")} at once, shared by all its runs.`;
    // Where that run alone holds the slots, its ETA is when they free up (#399, HF10).
    const holding = a.inFlight.filter((o) => o.id !== r.id && o.progress.starts_running > 0);
    const eta =
      ahead !== undefined && holding.length === 1 && holding[0].id === ahead.id
        ? a.etas?.get(ahead.id)
        : undefined;
    const around = eta === undefined ? "" : `, around ${clockInSentence(eta, now)}`;
    return {
      say: startingHere(r, a.allInFlight, a.cap)
        ? `Starting now: a slot is free.${cap}`
        : ahead === undefined
          ? `Starts as soon as a start’s slot is free.${cap}`
          : `Starts as #${ahead.id}’s starts end${around}.${cap}`,
      raw: undefined,
      since,
    };
  }
  const reason = r.queued?.reason ?? null;
  const on = a.partition ? ` on ${a.partition}` : "";
  const say =
    reason === "Resources"
      ? `Waiting for free nodes${on}. It starts on its own as they free up.`
      : reason === "Priority"
        ? `Waiting for its turn${on}: other jobs are ahead of it. It starts on its own.`
        : reason === "JobArrayTaskLimit"
          ? "Waiting for room in its own array. It starts on its own as its running starts end."
          : `Waiting to begin${on}. It starts on its own.`;
  return { say, raw: reason ?? undefined, since };
}

/** "up to 16 running starts per run · 32 of your 32 cluster jobs in use", above the runs in flight. */
export function capLine(a: {
  platform: Platform;
  slurm: boolean;
  cap: number | undefined;
  jobs: number | undefined;
  limit: number | null | undefined;
  inFlight: RunSummary[];
}): string | undefined {
  if (a.cap === undefined) return undefined;
  if (!a.slurm) {
    const used = a.inFlight.reduce((n, r) => n + r.progress.starts_running, 0);
    return `up to ${plural(a.cap, "start", "starts")} at once, shared by all runs ${onPlatform(a.platform)} · ${whole(used)} of ${whole(a.cap)} in use`;
  }
  const per = `up to ${plural(a.cap, "running start", "running starts")} per run`;
  if (a.jobs === undefined) return per;
  return a.limit == null
    ? `${per} · ${whole(a.jobs)} of your cluster jobs running`
    : `${per} · ${whole(a.jobs)} of your ${whole(a.limit)} cluster jobs in use`;
}

/** "Fri, Aug 21" and "6:40 AM" for an ETA another day; "Today" and the time for one today. */
export function etaParts(eta: number, now: number): { day: string; time: string; left: string } {
  const sameDay = new Date(eta).toDateString() === new Date(now).toDateString();
  return {
    day: sameDay ? "Today" : weekdayDate(eta, now),
    time: clock(eta, eta),
    left: `${durationWords(Math.max(0, (eta - now) / 1000))} left`,
  };
}

// ── runs that ended ────────────────────────────────────────────────────────────────────────────

/** A cause of failed starts, counted: "25 out of memory", "5 errors", "1 lost by the cluster". */
export function counted(f: FailedStarts): string {
  const n = whole(f.starts);
  switch (f.cause) {
    case "out_of_memory":
      return `${n} out of memory`;
    case "error":
      return `${n} ${f.starts === 1 ? "error" : "errors"}`;
    case "time_limit":
      return `${n} over the time limit`;
    case "lost":
      return `${n} lost by the cluster`;
  }
}

/** Why starts failed, uncounted: "out of memory", "errors". */
export const CAUSE: Record<StartCause, string> = {
  out_of_memory: "out of memory",
  error: "errors",
  time_limit: "over the time limit",
  lost: "lost by the cluster",
};

/** What to change in Platform settings for a refusal, by SLURM's code. */
const REFUSED: Record<string, (p: string, account: string, partition: string) => string> = {
  InvalidAccount: (p, account) =>
    `${p} won’t run jobs on account ${account} · change Account in Platform settings, then Resume`,
  InvalidQOS: (p, account, partition) =>
    `${p} won’t run account ${account}’s jobs on ${partition} · change Account or Partition in Platform settings, then Resume`,
  AccountNotAllowed: (p, account, partition) =>
    `${p} won’t run account ${account}’s jobs on ${partition} · change Account or Partition in Platform settings, then Resume`,
  PartitionTimeLimit: (p, _, partition) =>
    `${p} won’t run starts this long on ${partition} · lower Time limit per start in Platform settings, then Resume`,
  QOSMaxWallDurationPerJobLimit: (p, _, partition) =>
    `${p} won’t run starts this long on ${partition} · lower Time limit per start in Platform settings, then Resume`,
  PartitionConfig: (p, _, partition) =>
    `${p} has no room on ${partition} for the CPUs or memory a start asks for · lower them in Platform settings, then Resume`,
  BadConstraints: (p) =>
    `No node on ${p} has the CPUs or memory a start asks for · lower them in Platform settings, then Resume`,
};

/**
 * A refused run's refusal: what the cluster won't do, "McKelvey HPC won't
 * run jobs on account lab-account", what to change ("change Account
 * in Platform settings, then Resume"), and SLURM's code, `InvalidAccount`,
 * read from its words. `account` and `partition` are the Job defaults now.
 */
export function refusalOf(
  f: Pick<RunFailure, "detail">,
  a: { platform: Platform; account?: string | null; partition?: string | null },
): { what: string; change: string; code: string | undefined } {
  const name = a.platform.type === "local" ? "This computer" : a.platform.name;
  const code = /\(([A-Za-z]+)\)/.exec(f.detail ?? "")?.[1];
  const words = REFUSED[code ?? ""];
  const said =
    words?.(name, a.account ?? "this account", a.partition ?? "its partition") ??
    `${name} won’t take its jobs as asked · check Platform settings, then Resume`;
  const [what, change] = said.split(" · ");
  return { what, change, code };
}

/**
 * Why a run that ended short ended, under its dataset line: its failed starts
 * by cause, 20 in a row, a refusal in what to change, or its coordinating
 * job; a canceled run says how far it got. `undefined` for a run that
 * completed. `account` and `partition` are the Job defaults now, which the
 * refusal says to change.
 */
export function endedWhy(
  r: RunSummary,
  a: {
    platform: Platform;
    account?: string | null;
    partition?: string | null;
    /** Its coordinating job's log is offered beside it (Home's card, #398). */
    logHere?: boolean;
  },
): string | undefined {
  const p = r.progress;
  if (r.state === "canceled") {
    return `Canceled after ${whole(p.topologies_complete)} of ${plural(p.topologies, "topology", "topologies")}`;
  }
  if (r.state !== "failed" || r.failure === null) return undefined;
  const f = r.failure;
  const failed = f.failed_starts.reduce((n, s) => n + s.starts, 0);
  const unfitted = Math.max(0, p.starts - p.starts_finished - failed);
  switch (f.cause) {
    case "starts_failed": {
      const causes = f.failed_starts.map(counted).join(", ");
      const all = failed >= p.starts;
      const head = all
        ? `All ${plural(p.starts, "start", "starts")} failed`
        : `${whole(failed)} of ${plural(p.starts, "start", "starts")} failed`;
      return causes ? `${head}: ${causes}` : head;
    }
    case "stopped_early": {
      const why = f.failed_starts
        .slice(0, 2)
        .map((s) => CAUSE[s.cause])
        .join(" and ");
      const head = why ? `20 starts in a row failed: ${why}` : "20 starts in a row failed";
      return `${head} ·\u00a0${whole(unfitted)}\u00a0not fitted`;
    }
    case "refused": {
      const r = refusalOf(f, a);
      return `${r.what} ·\u00a0${r.change}`;
    }
    case "coordinator":
      return a.logHere === true
        ? `Its coordinating job kept failing ·\u00a0${whole(unfitted)}\u00a0not fitted`
        : "Its coordinating job kept failing ·\u00a0its log is on the run page";
  }
}

/** How a run's best compares with its dataset's best run, in Vs dataset best. */
export interface Compared {
  /** "best", "4.6 % higher", or "—". */
  word: string;
  /** Compared by Train RMSE: its dataset has no validation points. */
  byTrain: boolean;
  best: boolean;
  title: string;
}

/**
 * A run's best against the best run on its dataset's current data: "best"
 * when it's that run, else how much higher, to one decimal under 10 % and
 * whole from there. A dataset without validation points compares by Train
 * RMSE. A run fit to earlier data, on a deleted dataset, or with no best
 * isn't compared.
 */
export function comparedOf(r: RunSummary, dataset: RunsDataset | undefined): Compared {
  const name = r.dataset.name ?? "its dataset";
  const none = (title: string): Compared => ({
    word: "—",
    byTrain: false,
    best: false,
    title,
  });
  if (r.dataset.deleted) return none("Its dataset was deleted");
  if (r.dataset.earlier) {
    return none(`Fit to earlier data of ${name}, so not compared with runs on its current data`);
  }
  const byTrain = !r.validation;
  const mine = byTrain ? r.best?.train_rmse : r.best?.val_rmse;
  const best = byTrain ? dataset?.best_train : dataset?.best_val;
  if (mine == null || best == null) return { ...none(""), byTrain };
  const which = byTrain ? "Train RMSE" : "Val RMSE";
  if (best.run === r.id) {
    return {
      word: "best",
      byTrain,
      best: true,
      title: byTrain
        ? `Lowest Train RMSE of any run on ${name}, which has no validation points`
        : `Lowest Val RMSE of any run on ${name}`,
    };
  }
  return {
    word: `${percentHigher(mine, best.rmse)} % higher`,
    byTrain,
    best: false,
    title: `than ${rmse(best.rmse)}, the best ${which} on ${name}, of #${best.run}`,
  };
}

/** How much higher `x` is than `best`, as a percentage: one decimal under 10, whole from there. */
function percentHigher(x: number, best: number): string {
  const p = (x / best - 1) * 100;
  return p < 10 ? (Math.round(p * 10) / 10).toFixed(1) : String(Math.round(p));
}

/**
 * How long a run fit, its wait to begin and any time stopped left out (#324,
 * SR04): "5 d 5 h", "4 m 35 s" (#538), "under a minute"; `undefined` for one that never
 * ran a start.
 */
export function fitFor(r: Times, now: number): string | undefined {
  const s = fittingSeconds(r, now);
  return s === undefined ? undefined : elapsedWords(s);
}

/** How long a run waited before its first start ran, in seconds; `undefined` before one did. */
function waitOf(r: Times): number | undefined {
  const s = (Date.parse(r.first_running_at ?? "") - Date.parse(r.submitted_at)) / 1000;
  return Number.isNaN(s) ? undefined : Math.max(0, s);
}

/** Ended runs grouped by the day they ended, each day headed "Tuesday, August 11", latest first. */
export function byDay<T extends Pick<RunSummary, "ended_at">>(
  runs: T[],
  now: number,
): { day: string; runs: T[] }[] {
  const days: { key: string; day: string; runs: T[] }[] = [];
  for (const r of runs) {
    if (r.ended_at === null) continue;
    const at = Date.parse(r.ended_at);
    const key = new Date(at).toDateString();
    const last = days.at(-1);
    if (last?.key === key) last.runs.push(r);
    else days.push({ key, day: longDay(at, now), runs: [r] });
  }
  return days.map(({ day, runs }) => ({ day, runs }));
}

// ── the run-ended notifications ────────────────────────────────────────────────────────────────

/** What a notification says: its title and the line under it. */
export interface Notice {
  title: string;
  body: string;
}

/** "Val RMSE 0.0393, the best on herg-wt", or how it compares: a completed run's result. */
function resultLine(r: RunSummary, dataset: RunsDataset | undefined): string | undefined {
  const name = r.dataset.name ?? "its dataset";
  const byTrain = !r.validation;
  const mine = byTrain ? r.best?.train_rmse : r.best?.val_rmse;
  if (mine == null) return undefined;
  const label = `${byTrain ? "Train" : "Val"} RMSE ${rmse(mine)}`;
  const c = comparedOf(r, dataset);
  if (c.word === "—") return label;
  const tail = byTrain ? `, which has no validation points` : "";
  if (c.best) return `${label}, the best on ${name}${tail}`;
  return `${label}, ${c.word} than ${name}’s best${tail}`;
}

/**
 * A run that ended, as its notification says it: completed with its result
 * and how long it fit, or failed with the reason its row gives. `away` leads
 * with when it ended, for a run that ended while ICMM was away. `named`
 * ends the title with its platform, "on McKelvey HPC", kept whole: once a
 * platform besides This computer is saved (#323).
 */
export function endedNotice(
  r: RunSummary,
  a: {
    platform: Platform;
    named?: boolean;
    dataset: RunsDataset | undefined;
    account?: string | null;
    partition?: string | null;
    away?: number;
    now: number;
  },
): Notice {
  const on = a.named ? ` ${`on ${inSentence(a.platform)}`.replaceAll(" ", "\u00a0")}` : "";
  const title = `${runName(r)} ${r.state}${on}`;
  const lead =
    a.away === undefined || r.ended_at === null
      ? []
      : [`${clock(Date.parse(r.ended_at), a.now)}, while ICMM was away`];
  if (r.state === "failed") {
    const why = endedWhy(r, a);
    return { title, body: [...lead, why].filter(Boolean).join(" · ") };
  }
  const result = resultLine(r, a.dataset);
  // How long it fit, after its wait when that was a minute or more (#324, SR04).
  const fit = lead.length > 0 ? undefined : fitFor(r, a.now);
  const waited = fit === undefined ? undefined : waitOf(r);
  return {
    title,
    body: [
      ...lead,
      result,
      waited !== undefined && waited >= 60 ? `waited ${durationWords(waited)}` : undefined,
      fit === undefined ? undefined : `fit ${fit}`,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** How many runs an away notification names before it counts the rest. */
const NAMED_AWAY = 3;

/**
 * Several runs that ended while ICMM was away, in one notification: each
 * with when it ended; past three, the rest counted, since the earliest.
 * `runs` are the latest first, and `count` how many ended in all.
 */
export function awayNotice(
  runs: { id: number; state: string; ended_at: string }[],
  count: number,
  a: { platform: Platform; now: number },
): Notice {
  const title = `${whole(count)} runs ended on ${inSentence(a.platform)} while ICMM was away`;
  const at = (r: { ended_at: string }) => clock(Date.parse(r.ended_at), a.now);
  if (count <= NAMED_AWAY && runs.length === count) {
    return {
      title,
      body: runs.map((r) => `#${r.id} ${r.state} ${at(r)}`).join(" · "),
    };
  }
  const named = runs.slice(0, NAMED_AWAY).map((r) => `#${r.id} ${r.state}`);
  const earliest = runs.at(-1);
  const since = earliest === undefined ? "" : `, since ${at(earliest)}`;
  return {
    title,
    body: `${named.join(" · ")} · and ${whole(count - named.length)} more${since}`,
  };
}

// ── a dataset's runs, where its pages change it ───────────────────────────────────────────────

/**
 * What a new revision does to a dataset's runs, after "Saving makes a new
 * revision of herg-wt": ": its 8 runs keep the data they were fit to, and
 * the 4 fit to the current data move under On earlier data". Nothing
 * without runs (#236, LaptopDatasetDetail).
 */
export function revisionRunsWords(d: RunsDataset | undefined): string {
  if (d === undefined || d.runs === 0) return "";
  const current = d.runs - d.runs_earlier;
  const keep = `: its ${plural(d.runs, "run keeps", "runs keep")} the data ${d.runs === 1 ? "it was" : "they were"} fit to`;
  if (current === 0) return keep;
  return `${keep}, and the ${whole(current)} fit to the current data ${current === 1 ? "moves" : "move"} under On earlier data`;
}

/** After the name rules while renaming: " Its 8 runs follow it to the new name." */
export function renameRunsWords(d: RunsDataset | undefined): string {
  if (d === undefined || d.runs === 0) return "";
  return ` Its ${plural(d.runs, "run follows", "runs follow")} it to the new name.`;
}

/**
 * Deleting a dataset, after "It can’t be brought back.": " Its 8 runs keep
 * the data they were fit to and show herg-wt as deleted; the 2 still running
 * keep going."
 */
export function deleteRunsWords(
  d: RunsDataset | undefined,
  name: string,
  inFlight: number,
): string {
  if (d === undefined || d.runs === 0) return "";
  const keep = ` Its ${plural(d.runs, "run keeps", "runs keep")} the data ${d.runs === 1 ? "it was" : "they were"} fit to and ${d.runs === 1 ? "shows" : "show"} ${name} as deleted`;
  if (inFlight === 0) return `${keep}.`;
  return `${keep}; the ${whole(inFlight)} still running ${inFlight === 1 ? "keeps" : "keep"} going.`;
}

/**
 * Deleting a config, after "It can’t be brought back.": " Its 2 runs keep
 * the settings they were submitted with, and #214 keeps running." Nothing
 * without runs (LaptopConfigs).
 */
export function deleteConfigRunsWords(runs: Pick<RunSummary, "id" | "ended_at">[]): string {
  if (runs.length === 0) return "";
  const keep = ` Its ${plural(runs.length, "run keeps", "runs keep")} the settings ${runs.length === 1 ? "it was" : "they were"} submitted with`;
  const flying = runs.filter((r) => r.ended_at === null).map((r) => `#${r.id}`);
  if (flying.length === 0) return `${keep}.`;
  const named =
    flying.length === 1 ? flying[0] : `${flying.slice(0, -1).join(", ")} and ${flying.at(-1)}`;
  return `${keep}, and ${named} ${flying.length === 1 ? "keeps" : "keep"} running.`;
}
