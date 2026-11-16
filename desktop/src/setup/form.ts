/**
 * Platform setup's form (LaptopFirstRun's `setup`, `lookup-failed` and
 * `local` views): what it prefills from the agent's lookup, the Account and
 * Partition menus with why each is preselected, the cluster-limit line, and
 * the checks that turn its fields into the Platform settings it saves. Pure,
 * so every state can be tested without a platform.
 *
 * Account and Partition are menus of what SLURM says the user may use, and
 * text fields when it wouldn't say (blank then sends no `-A` or `-p`). A
 * cluster without a default partition, like McKelvey, needs one chosen.
 */
import { failureOf } from "../failure";
import type {
  ContainerRuntime,
  Partition,
  PlatformSettings,
  SavedPlatform,
  SchedulerLookup,
} from "../wire/types.gen";
import { memory, parseMemory, parseTime, timeLimit, upTo } from "./units";

/** The form's fields, as typed. This computer uses `output`, `cpus` and `running`. */
export interface SetupFields {
  output: string;
  account: string;
  partition: string;
  cpus: string;
  memory: string;
  time: string;
  running: string;
  excluded: string;
  coordinator: string;
  checkEvery: string;
  container: boolean;
  runtime: ContainerRuntime;
  image: string;
}

export type SetupField = keyof SetupFields;

export function initialFields(lookup: SchedulerLookup): SetupFields {
  const fields = fieldsOf(lookup.proposed);
  if (fields.partition === "" && menus(lookup, fields).kind === "menus") {
    return withAccount(lookup, fields, fields.account);
  }
  return fields;
}

/** Platform settings as the form's fields, in the units people write. */
export function fieldsOf({ output_folder, job_defaults: jobs }: PlatformSettings): SetupFields {
  if (jobs.type === "local") {
    return {
      ...BLANK,
      output: output_folder,
      cpus: String(jobs.cpus_per_start),
      running: String(jobs.max_running_starts),
    };
  }
  return {
    output: output_folder,
    account: jobs.account ?? "",
    partition: jobs.partition ?? "",
    cpus: String(jobs.cpus_per_start),
    memory: memory(jobs.memory_per_start_mb),
    time: timeLimit(jobs.time_limit_per_start_min),
    running: String(jobs.max_running_starts),
    excluded: jobs.excluded_nodes.join(", "),
    coordinator: timeLimit(jobs.run_coordinator_time_limit_min),
    checkEvery: String(jobs.check_for_results_every_s),
    container: jobs.container !== null,
    runtime: jobs.container?.runtime ?? "apptainer",
    image: jobs.container?.image ?? "",
  };
}

/** What a field says, apart from its spacing: the excluded nodes as a list. */
function said(f: SetupFields, field: SetupField): string {
  const value = f[field];
  if (typeof value === "boolean") return String(value);
  if (field === "excluded")
    return value
      .split(/[\s,]+/)
      .filter((n) => n !== "")
      .join(",");
  return value.trim();
}

const differs = (a: SetupFields, b: SetupFields, field: SetupField) =>
  said(a, field) !== said(b, field);

/**
 * The fields `now` changes from `before`, in the form's order. The runtime
 * and image count only while a container was and still is on.
 */
export function changedFields(before: SetupFields, now: SetupFields): SetupField[] {
  return FIELDS.filter((field) => {
    if ((field === "runtime" || field === "image") && !(before.container && now.container)) {
      return false;
    }
    return differs(before, now, field);
  });
}

/** What a changed field was, for its “Changed · was …”. */
export function was(field: SetupField, before: SetupFields): string {
  if (field === "container") return before.container ? "on" : "off";
  const text = said(before, field);
  if (text !== "") return field === "excluded" ? before.excluded.trim() : text;
  return field === "account" || field === "partition" ? "the cluster’s default" : "none";
}

/**
 * The form after Reload, once another computer saved `theirs` over `before`:
 * each field you changed keeps your value, and the rest take theirs.
 */
export function reloaded(before: SetupFields, mine: SetupFields, theirs: SetupFields): SetupFields {
  const next = { ...theirs };
  for (const field of FIELDS) {
    if (differs(before, mine, field)) (next as Record<SetupField, unknown>)[field] = mine[field];
  }
  return next;
}

/** Each field's label, as the form shows it and a sentence names it. */
const NAMES: Record<SetupField, string> = {
  output: "Output folder",
  account: "Account",
  partition: "Partition",
  cpus: "CPUs per start",
  memory: "Memory per start",
  time: "Time limit per start",
  running: "Max running starts",
  excluded: "Excluded nodes",
  coordinator: "Coordinating job’s time limit",
  checkEvery: "Look for finished starts every",
  container: "Run starts in a container",
  runtime: "Runtime",
  image: "Image path",
};

/** The fields Advanced holds. */
export const ADVANCED: SetupField[] = [
  "excluded",
  "coordinator",
  "checkEvery",
  "container",
  "runtime",
  "image",
];

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What the note says once another computer saved: the fields it changed, and what Reload does. */
export interface ElsewhereNotice {
  /** The sentence naming them; `undefined` when no field differs. */
  fields: string | undefined;
  reload: string;
}

/**
 * The note after another computer saved `theirs` over `base`, which the form
 * holds as `now`: their fields by name, and that Reload keeps yours, naming
 * any field you both changed (#118's U15).
 */
export function elsewhereNotice(
  base: SetupFields,
  theirs: SetupFields,
  now: SetupFields,
): ElsewhereNotice {
  const changed = changedFields(base, theirs);
  const mine = changedFields(base, now);
  const both = mine.filter((field) => changed.includes(field) && differs(theirs, now, field));
  let reload = "Reload shows theirs.";
  if (both.length > 0) {
    reload = `Reload shows theirs. You both changed ${listed(both.map((x) => NAMES[x]))}, so it keeps yours.`;
  } else if (mine.length > 0) {
    const fields = mine.length === 1 ? "the field" : `the ${mine.length} fields`;
    reload = `Reload shows theirs and keeps ${fields} you changed.`;
  }
  return {
    fields:
      changed.length === 0
        ? undefined
        : `Another computer changed ${listed(changed.map((x) => NAMES[x]))} since you opened these settings.`,
    reload,
  };
}

/**
 * Under a field: you changed it (Changed · was …), another computer did
 * (From another computer · was …), or both, which keeps yours and says
 * what they saved.
 */
export type FieldMark =
  | { kind: "mine"; was: string }
  | { kind: "theirs"; was: string }
  | { kind: "both"; was: string; saved: string };

/**
 * Each marked field of a form `opened` on its settings, reloaded since onto
 * `base`, and holding `now`. Before any Reload, `base` is what it opened on.
 */
export function fieldMarks(
  opened: SetupFields,
  base: SetupFields,
  now: SetupFields,
): Partial<Record<SetupField, FieldMark>> {
  const mine = changedFields(base, now);
  const theirs = changedFields(opened, base);
  const marks: Partial<Record<SetupField, FieldMark>> = {};
  for (const field of FIELDS) {
    const m = mine.includes(field);
    const t = theirs.includes(field);
    if (m && t) marks[field] = { kind: "both", was: was(field, opened), saved: was(field, base) };
    else if (m) marks[field] = { kind: "mine", was: was(field, base) };
    else if (t) marks[field] = { kind: "theirs", was: was(field, opened) };
  }
  return marks;
}

/**
 * How many of Advanced's fields another computer changed, for its closed
 * row: only those it shows with the form holding `now`, so a container's
 * runtime and image count only while the container is on.
 */
export function advancedElsewhere(
  marks: Partial<Record<SetupField, FieldMark>>,
  now: SetupFields,
): number {
  return ADVANCED.filter((field) => {
    if ((field === "runtime" || field === "image") && !now.container) return false;
    const kind = marks[field]?.kind;
    return kind === "theirs" || kind === "both";
  }).length;
}

/** Every field, in the form's order. */
const BLANK_KEYS: Record<SetupField, true> = {
  output: true,
  account: true,
  partition: true,
  cpus: true,
  memory: true,
  time: true,
  running: true,
  excluded: true,
  coordinator: true,
  checkEvery: true,
  container: true,
  runtime: true,
  image: true,
};
const FIELDS = Object.keys(BLANK_KEYS) as SetupField[];

const BLANK: SetupFields = {
  output: "",
  account: "",
  partition: "",
  cpus: "",
  memory: "",
  time: "",
  running: "",
  excluded: "",
  coordinator: "",
  checkEvery: "",
  container: false,
  runtime: "apptainer",
  image: "",
};

export type Menus =
  | {
      kind: "menus";
      accounts: string[];
      /** The partitions the chosen account may use. */
      partitions: string[];
      /** Why the account shown is the one shown. */
      accountHint: string | undefined;
      partitionHint: string | undefined;
    }
  | { kind: "text" };

export function menus(lookup: SchedulerLookup, f: SetupFields): Menus {
  const slurm = lookup.slurm;
  if (slurm === null || slurm.accounts.length === 0 || slurm.partitions.length === 0) {
    return { kind: "text" };
  }
  const partitions = usable(lookup, f.account).map((p) => p.name);
  let accountHint: string | undefined;
  if (slurm.accounts.length === 1 && f.account === slurm.accounts[0]) accountHint = "your only one";
  else if (f.account !== "" && f.account === slurm.default_account) accountHint = "your default";
  let partitionHint: string | undefined;
  if (f.partition !== "" && f.partition === slurm.default_partition) {
    partitionHint = "the cluster’s default";
  } else if (partitions.length === 1 && f.partition === partitions[0]) {
    partitionHint = "your only one";
  } else if (f.partition === "" && slurm.default_partition === null) {
    partitionHint = "no default here";
  }
  return { kind: "menus", accounts: slurm.accounts, partitions, accountHint, partitionHint };
}

/** The partitions `account` may use; every one before an account is chosen. */
function usable(lookup: SchedulerLookup, account: string): Partition[] {
  const all = lookup.slurm?.partitions ?? [];
  return account === "" ? all : all.filter((p) => p.accounts.includes(account));
}

/**
 * The fields with `account` chosen. The partition stays if the account may
 * use it; otherwise it's the cluster's default, or the account's only one,
 * or none until the user picks.
 */
export function withAccount(lookup: SchedulerLookup, f: SetupFields, account: string): SetupFields {
  const names = usable(lookup, account).map((p) => p.name);
  const fallback = lookup.slurm?.default_partition;
  let partition = "";
  if (names.includes(f.partition)) partition = f.partition;
  else if (fallback != null && names.includes(fallback)) partition = fallback;
  else if (names.length === 1) partition = names[0];
  return { ...f, account, partition };
}

const count = (n: number) => n.toLocaleString("en-US");

/** How little a run writes, under the Output folder (#117's U13; the lab's 0.35 GB per 12,000 starts). */
export const OUTPUT_SIZE =
  "Each start’s results and logs, about 30 KB a start: 10,000 starts take about 300 MB.";

/** The size, said in a refused folder's sentence in place of the hint under it. */
export const REFUSED_SIZE = "A run writes only about 30 KB a start.";

/** What a start is, before what limits how many run (#117's U11). */
const START =
  "Each start is one fit of one topology, from its own random starting point, run as its own";

/**
 * The line under the job row: what a start is, then the chosen partition's
 * per-user limits, or who can tell you one ICMM couldn't read.
 */
export function limitLine(lookup: SchedulerLookup, f: SetupFields): string {
  const start = `${START} job.`;
  if (menus(lookup, f).kind === "text") {
    return `${start} ICMM couldn’t read your cluster’s job limit; your cluster’s admins can tell you what it is. Keep Max running starts under it.`;
  }
  const limits = clusterLimits(lookup, f.partition);
  if (limits === undefined) return start;
  return `${start} Your cluster limits you to ${limits} at once, across all your runs.`;
}

/** A partition's per-user limits, “200 jobs and 200 CPUs”; `undefined` without any. */
export function clusterLimits(lookup: SchedulerLookup, partition: string): string | undefined {
  const p = lookup.slurm?.partitions.find((x) => x.name === partition);
  const limits = [
    p?.max_jobs_per_user != null ? `${count(p.max_jobs_per_user)} jobs` : undefined,
    p?.max_cpus_per_user != null ? `${count(p.max_cpus_per_user)} CPUs` : undefined,
  ].filter((x) => x !== undefined);
  return limits.length === 0 ? undefined : limits.join(" and ");
}

/**
 * The line of a platform whose starts run as processes, This computer or an
 * SSH host without SLURM: what a start is, then what Max running starts of
 * the CPUs per start ask of its cores, and when they ask for more than it has.
 */
export function coresLine(
  platform: Pick<SavedPlatform, "type" | "name">,
  cores: number | undefined,
  cpusText: string,
  runningText: string,
): string {
  const start = `${START} process.`;
  if (cores === undefined) return start;
  const has = `has ${count(cores)} ${cores === 1 ? "core" : "cores"}`;
  const cpus = wholeNumber(cpusText);
  const running = wholeNumber(runningText);
  if (cpus === undefined || running === undefined || cpus < 1 || running < 1) {
    return `${start} ${asSubject(platform)} ${has}.`;
  }
  const used = cpus * running;
  const one = running === 1;
  const starts = `${count(running)} ${one ? "start" : "starts"} of ${count(cpus)} ${cpus === 1 ? "CPU" : "CPUs"}`;
  if (used > cores) {
    return `${start} ${starts} ${one ? "asks" : "ask"} for ${count(used)} CPUs, and ${inSentence(platform)} ${has}. They’d share them, so each start runs slower.`;
  }
  const use = one ? "uses" : "use";
  const its = `${inSentence(platform)}’s`;
  if (cores === 1) return `${start} ${starts} ${use} ${its} only core.`;
  if (used === cores) return `${start} ${starts} ${use} all ${count(cores)} of ${its} cores.`;
  return `${start} ${starts} ${use} ${count(used)} of ${its} ${count(cores)} cores.`;
}

function wholeNumber(text: string): number | undefined {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

const WHOLE = "Enter a whole number.";
const MEMORY_FORMAT = "Write it as SLURM does, such as 4G or 500M.";
const timeFormat = (example: string) =>
  `Write it as SLURM does, such as ${example}, or 2-00:00:00 for two days.`;
const SECONDS = "Use whole minutes, such as 01:30:00 for an hour and a half.";
/**
 * A start's shortest time limit, in minutes: a minute past the 3 min warning
 * its job gets before the limit, as the engine's check has it
 * (`MIN_TIME_LIMIT_PER_START_MIN`, #323).
 */
const SHORTEST_START_MIN = 4;
const TOO_SHORT = "At least 4\u00a0min: each start is warned 3\u00a0min before its limit.";

export type Checked =
  { settings: PlatformSettings } | { issues: Partial<Record<SetupField, string>> };

/**
 * The Platform settings the fields make, or each field's issue. The agent
 * checks ranges and folders; this checks what only the form can: the
 * notation, and a partition and time limit the cluster will take.
 */
export function checkSetup(lookup: SchedulerLookup, f: SetupFields, platform: string): Checked {
  const issues: Partial<Record<SetupField, string>> = {};
  const whole = (field: SetupField): number => {
    const n = wholeNumber(f[field] as string);
    if (n === undefined) issues[field] = WHOLE;
    return n ?? 0;
  };
  const minutes = (field: SetupField, example: string): number => {
    const t = parseTime(f[field] as string);
    if (t === "format") issues[field] = timeFormat(example);
    else if (t === "seconds") issues[field] = SECONDS;
    return typeof t === "object" ? t.minutes : 0;
  };

  const output_folder = f.output.trim();
  if (lookup.proposed.job_defaults.type === "local") {
    const cpus_per_start = whole("cpus");
    const max_running_starts = whole("running");
    if (Object.keys(issues).length > 0) return { issues };
    return {
      settings: {
        output_folder,
        job_defaults: { type: "local", cpus_per_start, max_running_starts },
      },
    };
  }

  const shown = menus(lookup, f);
  const account = f.account.trim();
  const partition = f.partition.trim();
  if (shown.kind === "menus") {
    if (account === "") issues.account = "Choose an account.";
    if (partition === "") {
      if (account !== "" && shown.partitions.length === 0) {
        issues.partition = `${account} can’t use any partition here. Choose another account.`;
      } else {
        issues.partition =
          lookup.slurm?.default_partition == null
            ? `Choose a partition. ${platform} has no default one.`
            : "Choose a partition.";
      }
    }
  }
  const cpus_per_start = whole("cpus");
  const memory_per_start_mb = parseMemory(f.memory);
  if (memory_per_start_mb === undefined) issues.memory = MEMORY_FORMAT;
  const time_limit_per_start_min = minutes("time", "24:00:00");
  const max = lookup.slurm?.partitions.find((p) => p.name === partition)?.max_time_min;
  if (issues.time === undefined && time_limit_per_start_min < SHORTEST_START_MIN) {
    issues.time = TOO_SHORT;
  } else if (issues.time === undefined && max != null && time_limit_per_start_min > max) {
    issues.time = `${partition} allows at most ${upTo(max)}.`;
  }
  const max_running_starts = whole("running");
  const run_coordinator_time_limit_min = minutes("coordinator", "12:00:00");
  // It runs on the starts' partition, so the same longest holds.
  if (issues.coordinator === undefined && max != null && run_coordinator_time_limit_min > max) {
    issues.coordinator = `${partition} allows at most ${upTo(max)}.`;
  }
  const check_for_results_every_s = whole("checkEvery");
  if (Object.keys(issues).length > 0) return { issues };

  return {
    settings: {
      output_folder,
      job_defaults: {
        type: "slurm",
        account: account === "" ? null : account,
        partition: partition === "" ? null : partition,
        cpus_per_start,
        memory_per_start_mb: memory_per_start_mb ?? 0,
        time_limit_per_start_min,
        max_running_starts,
        excluded_nodes: f.excluded.split(/[\s,]+/).filter((n) => n !== ""),
        run_coordinator_time_limit_min,
        check_for_results_every_s,
        container: f.container ? { runtime: f.runtime, image: f.image.trim() } : null,
      },
    },
  };
}

/** Where each of the agent's issue paths lands, under `settings`. */
const PATHS: [string, SetupField][] = [
  ["output_folder", "output"],
  ["job_defaults.account", "account"],
  ["job_defaults.partition", "partition"],
  ["job_defaults.cpus_per_start", "cpus"],
  ["job_defaults.memory_per_start_mb", "memory"],
  ["job_defaults.time_limit_per_start_min", "time"],
  ["job_defaults.max_running_starts", "running"],
  ["job_defaults.excluded_nodes", "excluded"],
  ["job_defaults.run_coordinator_time_limit_min", "coordinator"],
  ["job_defaults.check_for_results_every_s", "checkEvery"],
  ["job_defaults.container.image", "image"],
];

/** Where an issue's path, under `settings`, lands in the form. */
function settingsField(path: string[]): SetupField | undefined {
  const [top, ...rest] = path;
  if (top !== "settings") return undefined;
  const at = rest.join(".");
  return PATHS.find(([p]) => at === p || at.startsWith(`${p}.`))?.[1];
}

/** A failed save: the agent's issues on their fields, and a sentence for the rest. */
export function issuesOf(error: unknown): {
  fields: Partial<Record<SetupField, string>>;
  message: string | undefined;
} {
  return failureOf(error, settingsField);
}

/** How a platform reads mid-sentence: “Set up this computer”, “once McKelvey HPC is set up”. */
export function inSentence(p: Pick<SavedPlatform, "type" | "name">): string {
  return p.type === "local" ? "this computer" : p.name;
}

/** Where a platform's starts run as processes: “here” on This computer, else “on Lab workstation”. */
export function onPlatform(p: Pick<SavedPlatform, "type" | "name">): string {
  return p.type === "local" ? "here" : `on ${p.name}`;
}

/** How a platform starts a sentence: “This computer runs…”, “McKelvey HPC runs…”. */
export function asSubject(p: Pick<SavedPlatform, "type" | "name">): string {
  return p.type === "local" ? "This computer" : p.name;
}

/**
 * What a failed read or write was doing: the lookup, the settings read, or
 * their save; reading the platform's datasets or configs, or one of them, or
 * a run; or submitting a run.
 */
export type SetupTask =
  | "lookup"
  | "settings"
  | "save"
  | "datasets"
  | "dataset"
  | "configs"
  | "config"
  | "runs"
  | "run"
  | "submit"
  /** Reading a run's topology or start, by its name: `#214/T12.3`, `start 71 of #214/T12.3`. */
  | { reading: string };

/**
 * A failed read or save as its box says it (#116's three lines): what
 * happened, the next step worded for whose move it is, and the raw line.
 * Report a problem… shows for ICMM's own errors, and Try again wherever
 * reading again can help; a save's retry is Save, and a submit's is Submit run.
 */
export interface FailureBox {
  what: string;
  next: string | undefined;
  raw: string;
  /** ICMM's own error's log reference, which ends the raw line. */
  logRef?: string;
  report: boolean;
  retry: boolean;
}

function doing(task: SetupTask, p: Pick<SavedPlatform, "type" | "name">): string {
  const whose = p.type === "local" ? "this computer’s" : `${p.name}’s`;
  if (typeof task === "object") return `reading ${task.reading} on ${inSentence(p)}`;
  switch (task) {
    case "lookup":
      return p.type === "local"
        ? "counting the cores on this computer"
        : `reading your accounts and partitions on ${p.name}`;
    case "settings":
      return `reading ${whose} Platform settings`;
    case "save":
      return `saving ${whose} Platform settings`;
    case "datasets":
      return `reading ${whose} datasets`;
    case "dataset":
      return `reading this dataset on ${inSentence(p)}`;
    case "configs":
      return `reading ${whose} configs`;
    case "config":
      return `reading this config on ${inSentence(p)}`;
    case "runs":
      return `reading ${whose} runs`;
    case "run":
      return `reading this run on ${inSentence(p)}`;
    case "submit":
      return "submitting this run";
  }
}

export function failureBox(
  error: unknown,
  task: SetupTask,
  p: Pick<SavedPlatform, "type" | "name">,
): FailureBox {
  const e = (error ?? {}) as { code?: string; message?: unknown; data?: Record<string, unknown> };
  // A write's retry is its own button, so its box has no Try again.
  const write = task === "save" || task === "submit";
  const retry = !write;
  const again = task === "save" ? "Save again" : task === "submit" ? "Submit again" : "Try again";
  switch (e.code) {
    case "internal":
      return {
        what: `ICMM’s engine hit an error while ${doing(task, p)}.`,
        next: `That’s a problem in ICMM, not something you did. ${again}; if it fails again, report it.`,
        raw: `internal error · log ${String(e.data?.log_ref ?? "")}`,
        logRef: String(e.data?.log_ref ?? ""),
        report: true,
        retry,
      };
    case "timeout":
      return {
        what: `ICMM’s engine didn’t answer in time while ${doing(task, p)}.`,
        next: `${p.type === "local" ? "This computer" : "The cluster"} may be busy. ${again} in a minute.`,
        raw: "timeout",
        report: false,
        retry,
      };
    case "not_connected":
      return {
        what: `The connection dropped while ICMM was ${doing(task, p)}.`,
        next: write
          ? `${again} once ${inSentence(p)} reconnects.`
          : `ICMM reads ${typeof task === "object" || ["lookup", "dataset", "config", "run"].includes(task) ? "it" : "them"} again once ${inSentence(p)} reconnects.`,
        raw: "not_connected",
        report: false,
        retry: false,
      };
  }
  return {
    what: typeof e.message === "string" ? e.message : `Something went wrong: ${String(error)}`,
    next: undefined,
    raw: rawLine(error),
    report: false,
    retry,
  };
}

/**
 * A failure's raw line: its code, and what it said where it says more (`unavailable · squeue:
 * Socket timed out…`); an engine error's log tag.
 */
export function rawLine(error: unknown): string {
  const e = (error ?? {}) as { code?: string; data?: Record<string, unknown> };
  if (e.code === "internal") return `internal error · log ${String(e.data?.log_ref ?? "")}`;
  const details = e.data?.details ?? e.data?.detail;
  return [e.code ?? "error", typeof details === "string" ? details : undefined]
    .filter((x) => x !== undefined)
    .join(" · ");
}

/** Whether a retry's failure is the one before it again: the same code, and the same sentence. */
export function sameFailure(before: unknown, now: unknown): boolean {
  const a = before as { code?: unknown; message?: unknown } | undefined;
  const b = now as { code?: unknown; message?: unknown } | undefined;
  return a?.code !== undefined && a.code === b?.code && a.message === b?.message;
}
