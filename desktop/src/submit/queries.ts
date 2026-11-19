/**
 * What Submit run reads (LaptopSubmitRun): the platform's finished starts'
 * timings, the user's jobs on the cluster, the runs in flight and each one's
 * detail (for its ETA), the page of one run, and the time of an evaluation on this computer.
 * Every read of the agent is kept under `agentKey`, so the runs database's
 * change feed reads it again (`useAgentDataFollowsChanges`) and a disconnect
 * forgets it. The evaluation's timing is this computer's own, no agent's, so
 * it isn't under the agent's key and a disconnect leaves it.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { datasetKey } from "../datasets/detail/read";
import { agentKey, canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { Bounds, DatasetContent, Run, RunSummary } from "../wire/types.gen";

/**
 * The finished starts' time per evaluation by number of states and CPUs per
 * start. A run's end changes it, so the `runs` topic reads it again.
 */
export function useRunTimings(enabled = true) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "timings"),
    queryFn: commands.run_timings,
    enabled: enabled && canAsk(c),
  });
}

/**
 * The user's jobs on the cluster, while `enabled` (SLURM's): one `squeue` read by
 * the agent when the page opens, and again whenever the runs in flight start or
 * end jobs, as the change feed reads them again: their starts running, queued or
 * held, or their state (a coordinating job), so the count beside their starts
 * keeps up with them (#469 R06). Nothing in the runs database says another job of
 * the user's started, so those count from the latest read; nothing reads on a timer.
 */
export function useUserJobs(enabled: boolean) {
  const c = useConnection();
  const client = useQueryClient();
  const platform = platformOf(c);
  const flight = useInFlightRuns(enabled).data;
  const jobs = flight === undefined ? undefined : jobsOfRuns(flight);
  const seen = useRef(jobs);
  useEffect(() => {
    if (jobs === undefined) return;
    const before = seen.current;
    seen.current = jobs;
    if (before !== undefined && before !== jobs) {
      const queryKey = agentKey(platform, "user_jobs");
      // A read under way began before this change: its reply is older, so drop it and read
      // again. Invalidating alone keeps a first read, which has no data to cancel back to.
      void client
        .cancelQueries({ queryKey, exact: true })
        .then(() => client.invalidateQueries({ queryKey, exact: true }));
    }
  }, [jobs, client, platform]);
  return useQuery({
    queryKey: agentKey(platform, "user_jobs"),
    queryFn: commands.user_jobs,
    enabled: enabled && canAsk(c),
    staleTime: 30_000,
  });
}

/** What of the runs in flight holds jobs on the cluster, as one string to compare. */
function jobsOfRuns(runs: RunSummary[]): string {
  return runs
    .map(({ id, state, progress: p }) =>
      [id, state, p.starts_running, p.starts_queued, p.starts_held].join(" "),
    )
    .join(",");
}

/**
 * The runs in flight, newest first. `list_runs` lists those first and then the
 * ones that ended, so it pages until a page has an ended run, and keeps the
 * rest: a few cheap queries however many runs ended.
 */
async function runsInFlight(): Promise<RunSummary[]> {
  const found: RunSummary[] = [];
  let after: string | null = null;
  do {
    const page = await commands.list_runs({ filter: null, dataset: null, config: null, after });
    found.push(...page.runs.filter((r) => r.ended_at === null));
    if (page.runs.some((r) => r.ended_at !== null)) break;
    after = page.next;
  } while (after !== null);
  return found;
}

export function useInFlightRuns(enabled = true) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "in_flight"),
    queryFn: runsInFlight,
    enabled: enabled && canAsk(c),
  });
}

/**
 * Each run `ids` names as `read_run` answers it, in order; `undefined` until
 * every read has an answer. A run that can't be read (ended and deleted since
 * it was listed) is left out.
 */
export function useRuns(ids: number[]): Run[] | undefined {
  const c = useConnection();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: agentKey(platformOf(c), "runs", "one", id),
      queryFn: () => commands.read_run({ id }),
      enabled: canAsk(c),
    })),
    combine: (results) =>
      results.some((r) => r.isPending)
        ? undefined
        : results.flatMap((r) => (r.data === undefined ? [] : [r.data])),
  });
}

/**
 * One run as `read_run` answers it, under the key `useRuns` keeps it at, so
 * the change feed's `runs` reads it again and the two share an answer.
 * `undefined` (a number that isn't one) asks nothing.
 */
export function useRun(id: number | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "one", id),
    queryFn: () => commands.read_run({ id: id! }),
    enabled: id !== undefined && canAsk(c),
  });
}

/**
 * A dataset's current revision as `read_dataset` answers it, for the host
 * timing's content, under the key Dataset detail's `useDataset` keeps it at,
 * so the two share an answer and the change feed's `datasets` reads it again.
 * `undefined` asks nothing.
 */
export function useDatasetContent(id: string | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: datasetKey(c, id ?? ""),
    queryFn: () => commands.read_dataset({ id: id! }),
    enabled: id !== undefined && canAsk(c),
  });
}

/**
 * What `time_evaluations` times: a dataset as the builder holds it, a number of
 * states and the box, and how the run's starts run (#508): its population, and
 * the Job defaults' CPUs per start and starts at once (`runningStartsOf`).
 */
export interface EvaluationInput {
  dataset: DatasetContent;
  numStates: number;
  bounds: Bounds;
  population: number;
  cpus: number;
  runningStarts: number;
}

/**
 * The time of one of a start's evaluations on this computer's engine, for a
 * platform whose finished starts can't say (#229). It follows from its input
 * alone, so it's kept as long as the page lives; a timing that failed isn't
 * tried again on its own, since its issues say what to change. `undefined`
 * times nothing.
 */
export function useEvaluationTime(input: EvaluationInput | undefined) {
  const params =
    input === undefined
      ? undefined
      : {
          dataset: input.dataset,
          num_states: input.numStates,
          bounds: input.bounds,
          population: input.population,
          cpus_per_start: input.cpus,
          running_starts: input.runningStarts,
        };
  const body = params === undefined ? null : JSON.stringify(params);
  return useQuery({
    queryKey: ["host", "time_evaluations", body],
    queryFn: () => commands.time_evaluations(params!),
    enabled: params !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}
