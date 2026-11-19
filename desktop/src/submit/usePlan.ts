/**
 * What Submit run's tiles, Platform aside and stages are made of (#235): the
 * reads under them, and the plan (`plan.ts`) they put together. The reads of
 * the platform's own (its settings, its finished starts' timings, the config's
 * dataset) go in `Seen` and are kept once the connection goes away; the rest
 * (the user's jobs, the runs in flight and their ETAs, the cluster's job limit,
 * both folders' free space) say when a run would begin, which a
 * connection that's gone can't say.
 */
import { useMemo } from "react";
import { rawLine } from "../setup/form";
import {
  useFolderCheck,
  usePlatformSettings,
  useReadAgain,
  useSchedulerLookup,
} from "../setup/queries";
import type {
  Bounds,
  DatasetContent,
  JobDefaults,
  PlatformSettingsResult,
  RunTiming,
  SavedConfig,
  SavedPlatform,
} from "../wire/types.gen";
import { evaluationsPerStart, runningStartsOf, startOverheadS } from "./estimate";
import { localForecast, slurmForecast } from "./forecast";
import {
  admissionSpace,
  beginsOf,
  etaDueOf,
  etasOf,
  needsHostTiming,
  outputView,
  pointsOf,
  slurmOf,
  stagesOf,
  tilesOf,
  timeGap,
  timeView,
  timingOf,
  workOf,
  type Begins,
  type BeginsFrom,
  type HostTiming,
  type SettingsGap,
  type Stage,
  type Tile,
  type TimeView,
} from "./plan";
import {
  useDatasetContent,
  useEvaluationTime,
  useInFlightRuns,
  useRuns,
  useRunTimings,
  useUserJobs,
} from "./queries";
import type { Seen } from "./shown";
import { useShownPath } from "../ui/paths";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** No ETA is on its way. */
const NONE_PENDING: ReadonlySet<number> = new Set();

/** Stands for the timings of a platform that couldn't say, so they aren't read again and again. */
const NO_TIMINGS: RunTiming[] = [];

/** What `Seen` holds beyond the config: the platform's settings and timings, and the dataset's content. */
export interface NumberReads {
  settings: PlatformSettingsResult | undefined;
  /** The settings couldn't be read. */
  settingsFailed: boolean;
  timings: RunTiming[] | undefined;
  content: Seen["content"];
  /** The dataset's content couldn't be read. */
  contentFailed: boolean;
}

/**
 * The reads the numbers under the head are made from. The timings are read
 * once the settings are, and the dataset only when no finished start can say
 * how long an evaluation takes at this many states and CPUs.
 */
export function useNumberReads(ready: SavedConfig | undefined): NumberReads {
  const settings = usePlatformSettings();
  const job = settings.data?.saved?.settings.job_defaults;
  const timingsQ = useRunTimings(job !== undefined);
  const timings = timingsQ.data?.timings ?? (timingsQ.isError ? NO_TIMINGS : undefined);
  const numStates = ready?.config.topology.num_states ?? null;
  const dataset = ready?.dataset;
  const readable = dataset !== undefined && !dataset.deleted && dataset.unreadable === null;
  const wanted = needsHostTiming(timings, numStates, job) && readable;
  const content = useDatasetContent(wanted ? dataset.id : undefined);
  return {
    settings: settings.data,
    settingsFailed: settings.isError && settings.data === undefined,
    timings,
    content: content.data?.content,
    contentFailed: content.isError,
  };
}

/** What the page puts under its head, once the reads are in. */
export interface Plan {
  /** The jobs go to a SLURM cluster, else to processes on the platform. */
  slurm: boolean;
  /** How far the platform's settings are read: `job` is set only when they are. */
  settings: "read" | SettingsGap;
  job: JobDefaults | undefined;
  /** The four tiles, once the config can be read. */
  tiles: Tile[] | undefined;
  /** The Time tile's words and the rows under the forecast. */
  time: TimeView | undefined;
  begins: Begins;
  /** The in-flight runs whose ETA is on its way, so each keeps its line meanwhile. */
  etaPending: ReadonlySet<number>;
  /** Reads the user's SLURM jobs again, and when that last failed the same way (#452). */
  jobsRetry: JobsRetry;
  /** What happens after a submit, once the config and the settings are read. */
  stages: Stage[] | undefined;
}

/**
 * This computer's own timing of a config, when no finished start has timed
 * this many states at this many CPUs (`needed`): its dataset, states, box and
 * population, its starts run as the Job defaults run them (#508), kept as long
 * as the page lives. Not connected, a dataset that was never read can't be.
 * Submit run's, and the Config builder's Time (#471).
 */
export function useHostTiming(a: {
  /** No finished start can say: `needsHostTiming`. */
  needed: boolean;
  /** The dataset's content, once read. */
  content: DatasetContent | undefined;
  numStates: number | null;
  bounds: Bounds | undefined;
  population: number | undefined;
  job: JobDefaults | undefined;
  live: boolean;
  /** Its content couldn't be read, or it is deleted or unreadable. */
  unreadable: boolean;
}): HostTiming {
  const { needed, content, numStates, bounds, population } = a;
  const cpus = a.job?.cpus_per_start;
  const runningStarts = a.job === undefined ? undefined : runningStartsOf(a.job);
  // One object for as long as its parts are the same, so the timing is asked once.
  const input = useMemo(
    () =>
      needed &&
      content !== undefined &&
      numStates !== null &&
      bounds !== undefined &&
      population !== undefined &&
      cpus !== undefined &&
      runningStarts !== undefined
        ? { dataset: content, numStates, bounds, population, cpus, runningStarts }
        : undefined,
    [needed, content, numStates, bounds, population, cpus, runningStarts],
  );
  const query = useEvaluationTime(input);
  if (input !== undefined) {
    if (query.data !== undefined) {
      return { kind: "ready", seconds: query.data.seconds_per_evaluation };
    }
    return query.isError ? { kind: "failed" } : { kind: "pending" };
  }
  if (!a.live) return { kind: "offline" };
  if (a.unreadable) return { kind: "failed" };
  return { kind: "pending" };
}

/**
 * When a run would begin: the user's SLURM jobs against the partition's job
 * limit, or this computer's slots, with the runs in flight and their ETAs. All
 * of it is read from the agent, so with no connection it waits for one.
 */
function useBegins(a: {
  platform: Platform;
  live: boolean;
  job: JobDefaults | undefined;
  gap: SettingsGap | undefined;
  timings: RunTiming[] | undefined;
  /** Submit run is blocked by the config, which says why: there's no forecast to make. */
  blocked: boolean;
  /** Admission inputs are still being read, and may hold the run for space. */
  spacePending: boolean;
  spaceUnknown: boolean;
  work: ReturnType<typeof workOf>;
  bytesPerStart: number | null | undefined;
  folders: ReturnType<typeof useFolderCheck>["data"];
  outputFolder: string;
  dataFolder: string;
  now: number;
}): {
  begins: Begins;
  etaPending: ReadonlySet<number>;
  partition: string | null;
  jobsRetry: JobsRetry;
} {
  const { platform, live, job, gap, now } = a;
  const slurm = slurmOf(job, platform);
  const reading = live && job !== undefined;
  const jobsQ = useUserJobs(reading && slurm);
  const lookupQ = useSchedulerLookup(reading && slurm);
  const inFlightQ = useInFlightRuns(reading);
  const inFlight = inFlightQ.data;
  const flying = inFlight?.filter((r) => r.progress.starts_running > 0) ?? [];
  const runs = useRuns(reading ? flying.map((r) => r.id) : []);

  // Jobs go to the partition the settings name, else the cluster's default.
  const partition =
    job?.type === "slurm"
      ? (job.partition ?? lookupQ.data?.slurm?.default_partition ?? null)
      : null;
  const limit =
    partition === null
      ? null
      : (lookupQ.data?.slurm?.partitions.find((p) => p.name === partition)?.max_jobs_per_user ??
        null);
  const jobs = jobsQ.data?.jobs;
  // A read that failed after it had an answer goes on with that answer, until the next one.
  const runsFailed = inFlight === undefined && inFlightQ.isError;
  // Its failure stays while Try again reads, so the box and its focus keep their place (#452).
  const jobsRead = useReadAgain(
    jobsQ.data === undefined && jobsQ.isError ? jobsQ.error : undefined,
    jobsQ.refetch,
  );
  const jobsFailed =
    slurm && (jobsRead.failure !== undefined || (jobsQ.data !== undefined && jobs === null));

  let from: BeginsFrom;
  if (!live) from = { kind: "offline" };
  else if (job === undefined) {
    from =
      gap === "unset"
        ? { kind: "unset" }
        : gap === "failed"
          ? { kind: "failed", what: "settings" }
          : { kind: "reading" };
  } else if (a.blocked) {
    from = { kind: "blocked" };
  } else if (runsFailed) {
    from = { kind: "failed", what: "runs" };
  } else if (jobsFailed) {
    from = {
      kind: "failed",
      what: "jobs",
      raw: jobsRead.failure === undefined ? undefined : rawLine(jobsRead.failure),
    };
  } else if (
    inFlight === undefined ||
    a.spacePending ||
    // Which runs an ETA can come for is known from the finished starts.
    (flying.length > 0 && a.timings === undefined) ||
    (slurm && (jobs === undefined || (lookupQ.data === undefined && !lookupQ.isError)))
  ) {
    from = { kind: "reading" };
  } else if (
    a.spaceUnknown ||
    (a.work !== undefined && (a.bytesPerStart == null || (slurm && !lookupQ.data?.slurm)))
  ) {
    from = { kind: "space_unknown" };
  } else {
    const cap = job.max_running_starts;
    const space =
      a.work !== undefined && a.bytesPerStart != null && a.folders !== undefined
        ? admissionSpace({
            work: a.work,
            cap,
            maxArraySize: lookupQ.data?.slurm?.max_array_size ?? null,
            bytesPerStart: a.bytesPerStart,
            folders: a.folders,
            outputFolder: a.outputFolder,
            dataFolder: a.dataFolder,
          })
        : null;
    const etas = etasOf(runs ?? [], {
      timings: a.timings ?? NO_TIMINGS,
      cpus: job.cpus_per_start,
      cap,
      overheadS: startOverheadS(job),
      now,
    });
    from = {
      kind: "forecast",
      forecast:
        slurm && jobs !== undefined && jobs !== null
          ? slurmForecast({ jobs, limit, cap, partition, inFlight, etas, space })
          : localForecast({ platform, cap, inFlight, etas, space }),
    };
  }
  return {
    begins: beginsOf(from, { slurm, platform }),
    // The line of an ETA that can come is kept while its run is read; one that can't isn't.
    etaPending:
      reading && runs === undefined
        ? etaDueOf(flying, { timings: a.timings, cpus: job?.cpus_per_start ?? 1 })
        : NONE_PENDING,
    partition,
    jobsRetry: { retry: jobsRead.retry, again: jobsRead.again },
  };
}

export interface JobsRetry {
  retry: () => Promise<void>;
  again: number | undefined;
}

export function usePlan(a: {
  platform: Platform;
  /** The connection is up, or reconnecting: what's read can be read again. */
  live: boolean;
  seen: Seen | undefined;
  /** The config, once it's read and the page is on it. */
  ready: SavedConfig | undefined;
  /** Something blocks Submit run, which says what: Begins forecasts nothing (#326). */
  blocked: boolean;
  reads: Pick<NumberReads, "settingsFailed" | "contentFailed"> & { countsFailed: boolean };
  dataFolder: string;
  /** When the reads are from: now, or as of when the connection went, which holds the ETAs (#326). */
  now: number;
}): Plan {
  const { platform, live, seen, ready, now } = a;
  const result = seen?.settings;
  const settings = result?.saved?.settings;
  const job = settings?.job_defaults;
  const slurm = slurmOf(job, platform);
  let gap: SettingsGap | undefined;
  if (job === undefined) {
    if (result?.saved === null) gap = "unset";
    else if (!live) gap = "offline";
    else gap = a.reads.settingsFailed ? "failed" : "loading";
  }

  const cpus = job?.cpus_per_start ?? 1;
  const numStates = ready?.config.topology.num_states ?? null;
  const timings = seen?.timings;
  const host = useHostTiming({
    needed: needsHostTiming(timings, numStates, job),
    content: seen?.content,
    numStates,
    bounds: ready?.config.bounds,
    population: ready?.config.search.population,
    job,
    live,
    unreadable:
      a.reads.contentFailed || !!ready?.dataset.deleted || ready?.dataset.unreadable != null,
  });

  const folder = settings?.output_folder ?? "";
  const folderQ = useFolderCheck(folder);
  const spacePending = live && folder !== "" && folderQ.data === undefined && !folderQ.isError;

  const work =
    ready === undefined
      ? undefined
      : workOf({ search: ready.config.search, saved: ready, counts: seen?.counts });
  // The folders as This computer's OS writes them, on Windows in full (#326); read as they're saved.
  const shownPath = useShownPath(platform);
  const output = outputView({
    starts: work?.starts,
    folder: settings?.output_folder === undefined ? undefined : shownPath(settings.output_folder),
    free: folderQ.data === undefined ? undefined : folderQ.data.output_folder.free_bytes,
    live,
    platform,
  });

  const { begins, etaPending, partition, jobsRetry } = useBegins({
    platform,
    live,
    job,
    gap,
    timings,
    blocked: a.blocked,
    spacePending:
      spacePending || (ready !== undefined && seen?.counts === undefined && !a.reads.countsFailed),
    spaceUnknown:
      ready !== undefined &&
      (a.reads.countsFailed ||
        (folderQ.data === undefined && folderQ.isError) ||
        (seen?.counts !== undefined && work === undefined)),
    work,
    bytesPerStart: seen?.counts?.work.bytes_per_start,
    folders: folderQ.data,
    outputFolder: shownPath(folder),
    dataFolder: shownPath(a.dataFolder),
    now,
  });

  if (ready === undefined) {
    return {
      slurm,
      settings: gap ?? "read",
      job,
      tiles: undefined,
      time: undefined,
      begins,
      etaPending,
      jobsRetry,
      stages: undefined,
    };
  }
  const { search, topology } = ready.config;
  const time =
    job === undefined
      ? timeGap(gap ?? "loading")
      : timeView({
          work,
          evaluations: evaluationsPerStart(search.evaluation_budget, search.population),
          cap: job.max_running_starts,
          overheadS: startOverheadS(job),
          limitMin: job.type === "slurm" ? job.time_limit_per_start_min : null,
          timing: timingOf({ timings, numStates, cpus, host, live }),
        });
  const stages =
    job === undefined
      ? undefined
      : stagesOf({
          platform,
          slurm,
          partition,
          cap: job.max_running_starts,
          which: topology.which,
          states: topology.num_states,
          all: seen?.counts?.counts?.topologies,
          work,
          dataset: ready.dataset.name ?? ready.dataset.id,
          points: pointsOf(seen?.summary),
        });
  return {
    slurm,
    settings: gap ?? "read",
    job,
    tiles: tilesOf({ work, time, begins, output }),
    time,
    begins,
    etaPending,
    jobsRetry,
    stages,
  };
}
