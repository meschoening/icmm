/**
 * What Compare reads (#342), for each of up to three starts from the
 * session's selection: its run (`read_run`), the start (`read_start`), its
 * topology (`read_topology`), its dataset's Ranking groups
 * (`list_ranking_groups`), which say whose data it was fit to, and its run's
 * revision; another of its topology's starts than its Best also reads the
 * topology's starts, for where it places. This computer's engine simulates
 * each start whose revision reads (ADR-0013). Each agent read is one bounded
 * query under the agent's `runs` key, so the change feed reads it again.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { templateWords } from "../datasets/detail/words";
import { useRankingGroups } from "../results/queries";
import { groupName } from "../results/words";
import { useStart, type StartRef } from "../runs/start/queries";
import { useStarts, useTopology, type TopologyRef } from "../runs/topology/queries";
import { fitFrom } from "../runs/topology/words";
import type { SelectedStart } from "../selection/selection";
import { canAsk, platformOf } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { revisionQuery, useStartSimulation } from "../simulation/queries";
import { useRun } from "../submit/queries";
import type {
  RankingGroups,
  Run,
  SavedDataset,
  Start,
  StartSimulation,
  StartSummary,
  Topology,
  WireError,
} from "../wire/types.gen";
import type { Candidate, CandidateData, CandidateProtocol } from "./words";

/** What one candidate's reads have answered. */
export interface CandidateReads {
  pick: SelectedStart;
  run: Run | undefined;
  start: Start | undefined;
  topology: Topology | undefined;
  groups: RankingGroups | undefined;
  /** Its topology's starts, for another start's place; `null` where it isn't needed. */
  starts: StartSummary[] | undefined | null;
  revision: SavedDataset | undefined;
  unreadable: "missing" | "damaged" | "newer" | undefined;
  simulation: StartSimulation | undefined;
  /** Why this computer's engine couldn't draw its fit. */
  drawError: WireError | undefined;
  /** The first of its reads that failed, but a revision that can't be read. */
  error: WireError | undefined;
  fetching: boolean;
  /** Whether every read the page needs before it shows has answered. */
  read: boolean;
  /** When its start was last read. */
  readAt: number;
  refetch: () => Promise<unknown>;
}

const errorOf = (e: unknown) => (e === null || e === undefined ? undefined : (e as WireError));

/** One candidate's reads, or none without a pick: called once a slot, so hooks keep their order. */
export function useCandidateReads(pick: SelectedStart | undefined): CandidateReads | undefined {
  const c = useConnection();
  const platform = platformOf(c);
  const ref = useMemo<StartRef | undefined>(
    () =>
      pick === undefined
        ? undefined
        : { run: pick.run, graph: pick.graph, openState: pick.open_state, start: pick.start },
    [pick],
  );
  const topologyRef = useMemo<TopologyRef | undefined>(
    () =>
      ref === undefined ? undefined : { run: ref.run, graph: ref.graph, openState: ref.openState },
    [ref],
  );
  const runQ = useRun(pick?.run);
  const startQ = useStart(ref);
  const topologyQ = useTopology(topologyRef);
  const groupsQ = useRankingGroups(pick?.dataset.id);
  const revisionQ = useQuery({
    ...revisionQuery(platform, runQ.data?.dataset),
    enabled: runQ.data !== undefined && canAsk(c),
  });
  const revisionError = errorOf(revisionQ.error);
  const unreadable = revisionError?.code === "unreadable" ? revisionError.data.problem : undefined;
  const start = startQ.data;
  const topology = topologyQ.data;
  const placing =
    start !== undefined &&
    topology !== undefined &&
    start.state === "finished" &&
    topology.best?.start !== start.start;
  const startsQ = useStarts(topologyRef, placing);
  const drawn = useStartSimulation(
    start?.best != null && revisionQ.data !== undefined ? ref : undefined,
  );
  const error =
    errorOf(runQ.error) ??
    errorOf(startQ.error) ??
    errorOf(topologyQ.error) ??
    errorOf(groupsQ.error) ??
    (unreadable === undefined ? revisionError : undefined) ??
    (placing ? errorOf(startsQ.error) : undefined);
  if (pick === undefined) return undefined;
  const read =
    runQ.data !== undefined &&
    start !== undefined &&
    topology !== undefined &&
    groupsQ.data !== undefined &&
    (revisionQ.data !== undefined || unreadable !== undefined) &&
    (!placing || startsQ.starts !== undefined);
  return {
    pick,
    run: runQ.data,
    start,
    topology,
    groups: groupsQ.data,
    starts: placing ? startsQ.starts : null,
    revision: revisionQ.data,
    unreadable,
    simulation: drawn.data,
    drawError: errorOf(drawn.error),
    error,
    fetching:
      runQ.isFetching ||
      startQ.isFetching ||
      topologyQ.isFetching ||
      groupsQ.isFetching ||
      revisionQ.isFetching,
    read,
    readAt: startQ.dataUpdatedAt,
    refetch: () =>
      Promise.all(
        [runQ, startQ, topologyQ, groupsQ, revisionQ, ...(placing ? [startsQ] : [])]
          .filter((q) => q.isError)
          .map((q) => q.refetch()),
      ),
  };
}

/** A protocol's RMSE from its raw SSE over its points; `null` with a failed point or none. */
const protocolRmse = (sse: number | undefined, points: number, failed: number | undefined) =>
  sse === undefined || failed === undefined || failed > 0 || points === 0
    ? null
    : Math.sqrt(sse / points);

/** Where `start` places among its topology's finished starts by Train RMSE, from 1. */
function rankOf(start: number, starts: readonly StartSummary[]): number | undefined {
  const finished = starts
    .filter((s) => s.state === "finished" && s.train_rmse !== null)
    .sort((a, b) => a.train_rmse! - b.train_rmse! || a.start - b.start);
  const at = finished.findIndex((s) => s.start === start);
  return at < 0 ? undefined : at + 1;
}

/**
 * A candidate from its reads, once `read`: its data from the Ranking group
 * that holds its run, its protocols from its revision, with its fit where
 * this computer's engine has drawn it. `edges` is its topology's, from its
 * state graph; `now` dates a fitting topology's wall time.
 */
/** What a candidate is made from: its reads' answers. */
type Answers = Pick<
  CandidateReads,
  | "run"
  | "start"
  | "topology"
  | "groups"
  | "starts"
  | "revision"
  | "unreadable"
  | "simulation"
  | "drawError"
>;

export function candidateOf(r: Answers, edges: number | undefined, now: number): Candidate {
  const run = r.run!;
  const start = r.start!;
  const topology = r.topology!;
  const group = r.groups?.groups.find((g) => g.runs.some((x) => x.id === run.id));
  const name = r.groups?.dataset.name ?? run.dataset.name ?? run.dataset.id;
  const revision = r.revision;
  // An unreadable revision's protocols are named as its run recorded them, each with its
  // stored scores and no points or line, as its Start page names them (#387, #449).
  const stored = (i: number) => ({
    val: protocolRmse(start.val_sse?.[i], start.val_points?.[i] ?? 0, start.val_failed?.[i]),
    train: protocolRmse(
      start.train_sse?.[i],
      start.train_points?.[i] ?? 0,
      start.train_failed?.[i],
    ),
  });
  const unread: CandidateProtocol[] | undefined =
    r.unreadable === undefined || start.train_sse == null
      ? undefined
      : Array.from({ length: start.train_sse.length }, (_, i) => {
          const p = run.protocols[i];
          return {
            name: p?.name ?? `Protocol ${i + 1}`,
            label: p === undefined ? "" : templateWords(p.template, null),
            logx: false,
            points: [],
            model: undefined,
            line: undefined,
            ...stored(i),
            ...(start.val_points == null ? {} : { valPoints: start.val_points[i] ?? 0 }),
          };
        });
  const protocols: CandidateProtocol[] | undefined = revision?.content.protocols.map((p, i) => {
    const sim = r.simulation?.protocols[i];
    return {
      name: p.name,
      label: templateWords(revision.templates[i], p.steps.length),
      logx: p.interpolation.log_x,
      points: p.points,
      model: sim?.points.map((s, k) => ({ x: p.points[k].x, value: s.value })),
      line: sim?.line.x.map((x, k) => ({ x, value: sim.line.value[k] })),
      ...stored(i),
    };
  });
  const data: CandidateData = {
    dataset: run.dataset.id,
    name,
    digest: group?.scoring_digest ?? `revision ${run.dataset.revision}`,
    current: group?.current ?? !run.dataset.earlier,
    range: group === undefined || group.current ? undefined : groupName(group, now),
    validation:
      revision === undefined
        ? run.validation
          ? undefined
          : 0
        : revision.content.protocols.reduce(
            (sum, p) => sum + p.points.filter((x) => x.validation).length,
            0,
          ),
  };
  const sent =
    topology.first_sent_at === null ? NaN : fitFrom(Date.parse(topology.first_sent_at), run);
  const ended = topology.provisional
    ? now
    : topology.last_ended_at === null
      ? NaN
      : Date.parse(topology.last_ended_at);
  const search = run.settings?.search;
  return {
    run: run.id,
    graph: topology.graph,
    openState: topology.open_state,
    start: start.start,
    runName: run.config.name,
    numStates: run.num_states,
    edges,
    population: search?.population,
    budget: search === undefined ? undefined : search.evaluation_budget,
    data,
    state: start.state,
    val: run.validation ? start.val_rmse : null,
    train: start.train_rmse,
    stillImproving: start.still_improving,
    change: start.still_improving_change,
    place: {
      best: topology.best?.start === start.start,
      rank: r.starts == null ? undefined : rankOf(start.start, r.starts),
      of: topology.starts_finished,
    },
    topology: {
      fitting: topology.provisional,
      starts: topology.starts,
      finished: topology.starts_finished,
      nearBest: topology.near_best,
      spread: topology.spread,
      wallS: Number.isNaN(sent) || Number.isNaN(ended) ? null : Math.max(0, ended - sent) / 1000,
      top10: topology.top_10.map((t) => t.best),
      spreads: topology.parameter_spreads,
    },
    best: start.best,
    bounds: run.settings?.bounds,
    revision: run.dataset.revision,
    protocols: r.unreadable === undefined ? protocols : unread,
    unreadable: r.unreadable,
    drift: r.simulation?.drift ?? null,
    drawing:
      start.best !== null &&
      revision !== undefined &&
      r.unreadable === undefined &&
      r.simulation === undefined &&
      r.drawError === undefined,
  };
}

/**
 * A slot's candidate once its reads are in, the same object while they and
 * `edges` and `now` are: kept views compare their reads field by field.
 */
export function useCandidate(
  r: CandidateReads | undefined,
  edges: number | undefined,
  now: number,
): Candidate | undefined {
  const read = r?.read === true;
  const run = r?.run;
  const start = r?.start;
  const topology = r?.topology;
  const groups = r?.groups;
  const starts = r?.starts;
  const revision = r?.revision;
  const unreadable = r?.unreadable;
  const simulation = r?.simulation;
  const drawError = r?.drawError;
  return useMemo(
    () =>
      read
        ? candidateOf(
            { run, start, topology, groups, starts, revision, unreadable, simulation, drawError },
            edges,
            now,
          )
        : undefined,
    [
      read,
      run,
      start,
      topology,
      groups,
      starts,
      revision,
      unreadable,
      simulation,
      drawError,
      edges,
      now,
    ],
  );
}
