/**
 * A start's curves (#88). No start's simulated outputs are stored, and a
 * cluster's login node computes nothing (ADR-0013): the agent reads what a
 * simulation needs, and this computer's own engine simulates it, whatever the
 * Active platform. The start's fit is read under the agent's `runs` key, so a
 * new try's best reads it again; its run's revision never changes, so it's read
 * once per platform and kept by its id, past changes and reconnects.
 */
import { useQuery } from "@tanstack/react-query";
import { agentKey, canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { DatasetContent, SimulatedProtocol, StartFit } from "../wire/types.gen";

/** A model's value along a protocol's x, as its fit chart's line draws it. */
export type ModelAlong = readonly { x: number; value: number | null }[];

/** A protocol's line as `simulate_start` draws it (#367): its model along its grid and points' x. */
export function lineOf(p: SimulatedProtocol | undefined): ModelAlong {
  return p === undefined ? [] : p.line.x.map((x, k) => ({ x, value: p.line.value[k] }));
}

/** A start, written `#214/T12.3 start 37`. */
export interface StartRef {
  run: number;
  graph: number;
  openState: number;
  start: number;
}

/**
 * A run's dataset revision, as `read_dataset_revision` reads it: it never
 * changes, so it's read once per platform and kept by its id, past changes
 * and reconnects. Topology reads it too, to say when it can't be read.
 */
export function revisionQuery(
  platform: string | null,
  dataset: { id: string; revision: number } | undefined,
) {
  return {
    queryKey: ["revision", platform, dataset?.id, dataset?.revision],
    queryFn: () => commands.read_dataset_revision({ id: dataset!.id, revision: dataset!.revision }),
    staleTime: Infinity,
    gcTime: Infinity,
  };
}

/**
 * The start simulated by this computer's engine: each sweep, each point's
 * value and each protocol's score, and whether its costs drift from the stored
 * ones. Its error is the first read that failed, the agent's or the engine's;
 * `fit` is what it simulated, as `read_start_fit` read it, which Export writes
 * from (#344).
 */
export function useStartSimulation(ref: StartRef | undefined) {
  const c = useConnection();
  const platform = platformOf(c);
  const fit = useQuery({
    queryKey: agentKey(platform, "runs", "start_fit", ref),
    queryFn: () =>
      commands.read_start_fit({
        run: ref!.run,
        graph: ref!.graph,
        open_state: ref!.openState,
        start: ref!.start,
      }),
    enabled: ref !== undefined && canAsk(c),
  });
  const pinned = fit.data;
  const revision = useQuery({
    ...revisionQuery(
      platform,
      pinned === undefined
        ? undefined
        : { id: pinned.dataset_id, revision: pinned.dataset_revision },
    ),
    enabled: pinned !== undefined && canAsk(c),
  });
  const dataset = revision.data?.content;
  const drawn = useQuery({
    queryKey: ["host", "simulate_start", platform, pinned],
    queryFn: () => commands.simulate_start({ dataset: dataset!, fit: pinned! }),
    enabled: pinned !== undefined && dataset !== undefined,
    staleTime: Infinity,
    retry: false,
  });
  return { ...drawn, error: fit.error ?? revision.error ?? drawn.error, fit: pinned };
}

/**
 * A running start's line (#362): its Live snapshot's best simulated by this
 * computer's engine along each protocol's grid, at each new best, as an
 * ended start's is. The snapshot's values at the points stay its worker's;
 * its fit has no stored scores, so the drawing's drift says nothing. While a
 * new best draws, the last one's line stays.
 */
export function useSnapshotLines(
  o:
    | {
        run: number;
        graph: number;
        openState: number;
        start: number;
        numStates: number;
        dataset: { id: string; revision: number; content: DatasetContent };
        best: readonly number[];
      }
    | undefined,
) {
  const platform = platformOf(useConnection());
  const fit: StartFit | undefined =
    o === undefined
      ? undefined
      : {
          run: o.run,
          graph: o.graph,
          open_state: o.openState,
          start: o.start,
          num_states: o.numStates,
          dataset_id: o.dataset.id,
          dataset_revision: o.dataset.revision,
          parameters: [...o.best],
          engine: null,
          scores: [],
        };
  const start = fit === undefined ? undefined : [fit.run, fit.graph, fit.open_state, fit.start];
  return useQuery({
    queryKey: ["host", "simulate_start", "snapshot", platform, fit],
    queryFn: () => commands.simulate_start({ dataset: o!.dataset.content, fit: fit! }),
    enabled: fit !== undefined,
    staleTime: Infinity,
    retry: false,
    // The last best's line, while the new one draws: never another start's.
    placeholderData: (previous, query) =>
      sameStart(query?.queryKey[4] as StartFit | undefined, start) ? previous : undefined,
  });
}

/** Whether `fit` is of the start `start` names: run, graph, open state and index. */
function sameStart(fit: StartFit | undefined, start: number[] | undefined): boolean {
  return (
    fit !== undefined &&
    start !== undefined &&
    [fit.run, fit.graph, fit.open_state, fit.start].every((v, i) => v === start[i])
  );
}
