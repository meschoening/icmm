/**
 * The Config builder's Time (#471, LaptopConfigBuilder): Submit run's own
 * estimate of the config's run, for the platform it is on. The rate is read
 * as Submit reads it, from the platform's finished starts at these states and
 * CPUs, else timed on this computer (ADR-0013), so the two pages agree. Typing
 * evaluations or starts only does the arithmetic again; a new dataset or
 * number of states (or box) times again.
 */
import { usePlatformSettings } from "../../setup/queries";
import { useConnection } from "../../shell/connection";
import {
  needsHostTiming,
  timeGap,
  timeView,
  timingOf,
  type SettingsGap,
  type TimeView,
  type Timing,
  type Work,
} from "../../submit/plan";
import { useDatasetContent, useRunTimings } from "../../submit/queries";
import { useHostTiming } from "../../submit/usePlan";
import type { Bounds, JobDefaults, RunTiming } from "../../wire/types.gen";

/** Why the run can't be counted, for all the Time knows of its starts. */
export type Uncounted = "ids" | "over";

/** A run of one start: what a start's own time is said against while the run isn't counted. */
const ONE_START: Work = { topologies: 1, startsPerTopology: 1, starts: 1 };

/** Stands for the timings of a platform that couldn't say, so they aren't read again and again. */
const NO_TIMINGS: RunTiming[] = [];

/**
 * What Time says. Without a dataset or a number of states it says which it
 * waits for; with them, Submit run's `timeView`, but that a run it can't count
 * (no ids, or more starts than a run holds) gives no total, only each start's
 * time. Past the time limit, the limit leaves the row, which says it in red.
 */
export function builderTime(a: {
  /** What it waits for the user to choose: "a dataset", "a number of states", or both. */
  need: string | undefined;
  /** The platform's job settings, once read; `gap` says why they aren't. */
  job: JobDefaults | undefined;
  gap: SettingsGap | undefined;
  timing: Timing;
  /** The run's work, once counted. */
  work: Work | undefined;
  /** What each start runs, as the engine counts it; `null` until it can. */
  evaluations: number | null;
  uncounted: Uncounted | undefined;
}): TimeView {
  const { job } = a;
  const limitMin = job?.type === "slurm" ? job.time_limit_per_start_min : null;
  const view = (timing: Timing, work: Work | undefined) =>
    timeView({
      work,
      evaluations: a.evaluations ?? 0,
      cap: job?.max_running_starts ?? 1,
      limitMin,
      timing,
    });
  if (a.need !== undefined) {
    // Nothing to time yet: no time, and the time limit (SLURM) when the settings say it.
    return { ...view({ kind: "failed" }, undefined), hint: `Estimated once you choose ${a.need}.` };
  }
  if (job === undefined) return timeGap(a.gap ?? "loading");
  const counted = a.uncounted === undefined && a.work !== undefined;
  const shown = view(a.timing, counted ? a.work : ONE_START);
  const time = { ...shown, limit: shown.over ? undefined : shown.limit };
  if (counted || a.timing.kind !== "ready") return time;
  return {
    ...time,
    big: "—",
    after: undefined,
    hint:
      a.uncounted === "ids"
        ? "Estimated once you write ids."
        : a.uncounted === "over"
          ? "Estimated once the run holds 100,000 starts or fewer."
          : undefined,
    topology: "—",
  };
}

/** The config as its latest check read it, when that check is for the fields' dataset and states. */
export interface Checked {
  datasetId: string;
  numStates: number;
  bounds: Bounds;
}

/** Time, from the platform's settings and finished starts, or this computer's timing. */
export function useBuilderTime(a: {
  need: string | undefined;
  checked: Checked | undefined;
  work: Work | undefined;
  evaluations: number | null;
  uncounted: Uncounted | undefined;
}): TimeView {
  const c = useConnection();
  const live = c.status === "connected" || c.status === "reconnecting";
  const settings = usePlatformSettings();
  const result = settings.data;
  const job = result?.saved?.settings.job_defaults;
  let gap: SettingsGap | undefined;
  if (job === undefined) {
    if (result?.saved === null) gap = "unset";
    else if (!live) gap = "offline";
    else gap = settings.isError ? "failed" : "loading";
  }
  const timingsQ = useRunTimings(job !== undefined);
  const timings = timingsQ.data?.timings ?? (timingsQ.isError ? NO_TIMINGS : undefined);
  const { checked } = a;
  const numStates = checked?.numStates ?? null;
  const needed = checked !== undefined && needsHostTiming(timings, numStates, job);
  const content = useDatasetContent(needed ? checked.datasetId : undefined);
  const host = useHostTiming({
    needed,
    content: content.data?.content,
    numStates,
    bounds: checked?.bounds,
    live,
    unreadable: content.isError,
  });
  const timing: Timing =
    checked === undefined
      ? { kind: live ? "reading" : "offline" }
      : timingOf({ timings, numStates, cpus: job?.cpus_per_start ?? 1, host, live });
  return builderTime({ ...a, job, gap, timing });
}
