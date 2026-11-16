/**
 * Topology (LaptopTopology, #233; built in #238): a run's topology,
 * `#214/T12.3`, at `/runs/214/T12.3`. Its header opens with its drawing, the
 * engine's real state graph with its open state filled, then its status
 * line, heading, buttons and fact tiles, its rank in its run and on its
 * dataset (#364); under it its 100 starts' grid with the list that counts
 * them, where the finished starts ended, Optimization progress (#286), Best
 * starts by Train RMSE and a Failed group at their content's width, then the
 * parameters across its Top 10 (#287). A finished start opens its Result, a
 * sent one its Start, from its square or its dot, which light together; a
 * failed one's Open, its job log (#289).
 *
 * The change feed's `runs` reads it again. Not connected, what it last read
 * stays, as of when the connection went, its glyphs still; nothing on it
 * simulates, so a revision that can't be read only takes a sentence.
 */
import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { count } from "../datasets/format";
import { ParameterRows } from "../parameters/ParameterRows";
import { useCanonicalParameters } from "../parameters/queries";
import { parameterRows } from "../parameters/rows";
import { ImprovingMark } from "../runs/ImprovingMark";
import { useMinute } from "../runs/queries";
import { runNumberOf } from "../runs/words";
import { useSelection } from "../selection/selection";
import { dotsOf, WIDTH, type Dot } from "../runs/topology/chart";
import { OptimizationProgress } from "../runs/topology/OptimizationProgress";
import {
  emptyParameters,
  keyOf,
  spreadWords,
  STRIP_WIDTH,
  stripOf,
  type Drawn,
} from "../runs/topology/parameters";
import {
  segmentOf,
  topologyOf,
  useAhead,
  useProgress,
  useStarts,
  useTopology,
  useUnreadable,
  type TopologyRef,
} from "../runs/topology/queries";
import {
  bestRowsOf,
  bestSub,
  causesOf,
  countsOf,
  emptyWords,
  endedOf,
  etaOf,
  failedRowsOf,
  failedSub,
  gridWords,
  heldWords,
  listOf,
  queueEmptiesIn,
  queuedWords,
  squaresOf,
  STILL_IMPROVING,
  stageLook,
  stageOf,
  statusParts,
  tilesOf,
  tracksOf,
  unreadableWords,
  type Kind,
  type Part,
  type Square,
  type Stage,
} from "../runs/topology/words";
import { usePreferences } from "../settings/preferences";
import { FailureBox, SaidBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { canAsk, usePlatformSettings, useReadAgain, useSchedulerLookup } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { evaluationsPerStart, fromRuns } from "../submit/estimate";
import { useKept } from "../submit/kept";
import { slurmOf } from "../submit/plan";
import { useRun, useRunTimings } from "../submit/queries";
import { TopologyDrawing } from "../topology/Drawing";
import { useStateGraphs } from "../topology/queries";
import { TOPOLOGY_PAGE } from "../topology/size";
import { useLayouts } from "../topology/useLayouts";
import { NewerRevision } from "../runs/NewerRevision";
import { LiveN } from "../ui/LiveN";
import { PageHeading } from "../ui/PageHeading";
import { useOpened } from "../shell/palette/recents";
import type {
  JobDefaults,
  Run,
  RunTiming,
  SavedPlatform,
  StartCurve,
  StartSummary,
  StateGraph,
  Topology,
  UnreadableProblem,
  WireError,
} from "../wire/types.gen";

type Platform = Pick<SavedPlatform, "type" | "name">;

/**
 * What the page shows, read whole, with what it says it by: kept as of the
 * connection's end while it's gone, since the agent's reads go with it.
 */
interface Reads {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  /** Its starts' Progress curves, for Optimization progress. */
  curves: StartCurve[];
  /** Its state graph, for the drawing; `undefined` while it's read. */
  graph: StateGraph | undefined;
  job: JobDefaults | undefined;
  partition: string | null;
  timings: RunTiming[] | undefined;
  /** For a topology next: the one ahead of it; `null` when its page doesn't hold it. */
  ahead: Topology | null | undefined;
  unreadable: UnreadableProblem | undefined;
}

export function TopologyPage() {
  const params = useParams({ from: "/runs/$id/$topology" });
  const id = runNumberOf(params.id);
  const which = topologyOf(params.topology);
  const ref: TopologyRef | undefined =
    id === undefined || which === undefined ? undefined : { run: id, ...which };
  const name = `#${params.id}/${params.topology}`;
  const c = useConnection();
  const platform = useActivePlatform();
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";

  const runQ = useRun(ref?.run);
  const topologyQ = useTopology(ref);
  const startsQ = useStarts(ref, topologyQ.data !== undefined);
  const progressQ = useProgress(ref, topologyQ.data !== undefined);
  const run = runQ.data;
  const topology = topologyQ.data;
  useOpened(
    run === undefined || topology === undefined || ref === undefined
      ? undefined
      : {
          kind: "topology",
          run: ref.run,
          graph: ref.graph,
          open_state: ref.openState,
          name: run.config.name,
        },
  );
  const job = usePlatformSettings().data?.saved?.settings.job_defaults;
  const slurm = platform !== undefined && slurmOf(job, platform);
  const lookup = useSchedulerLookup(slurm && job?.type === "slurm" && job.partition === null);
  const partition =
    job?.type === "slurm" ? (job.partition ?? lookup.data?.slurm?.default_partition ?? null) : null;
  const timings = useRunTimings().data?.timings;
  const graph = useStateGraphs(
    run?.num_states ?? 0,
    topology === undefined ? [] : [topology.graph],
  )?.get(topology?.graph ?? -1);
  const next = run !== undefined && topology !== undefined && stageOf(topology, run) === "next";
  const ahead = useAhead(next ? run.id : undefined, next ? topology.position : undefined).data;
  const unreadable = useUnreadable(run?.dataset);
  const reads = useMemo<Reads | undefined>(
    () =>
      run === undefined ||
      topology === undefined ||
      startsQ.starts === undefined ||
      progressQ.curves === undefined
        ? undefined
        : {
            run,
            topology,
            starts: startsQ.starts,
            curves: progressQ.curves,
            graph,
            job,
            partition,
            timings,
            ahead,
            unreadable,
          },
    [
      run,
      topology,
      startsQ.starts,
      progressQ.curves,
      graph,
      job,
      partition,
      timings,
      ahead,
      unreadable,
    ],
  );
  const kept = useKept(
    reads,
    {
      connected: c.status === "connected",
      live,
      platform: c.status === "none" ? "" : c.platformId,
      heardAt: heardAtOf(c),
    },
    now,
  );
  const failed = runQ.error ?? topologyQ.error ?? startsQ.error ?? progressQ.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failed !== null && failed !== undefined
      ? (failed as unknown as WireError)
      : undefined,
    // Only the read that failed: Try again knows it failed again from its answer.
    () =>
      runQ.isError
        ? runQ.refetch()
        : topologyQ.isError
          ? topologyQ.refetch()
          : startsQ.isError
            ? startsQ.refetch()
            : progressQ.refetch(),
  );
  const failure = useHeldFailure(
    read.failure,
    runQ.isFetching || topologyQ.isFetching || startsQ.isFetching || progressQ.isFetching,
    name,
    reads !== undefined || !live,
  );
  const shown = kept.value;

  // Reads run only while connected: reconnecting with nothing kept, it says when it shows (KF17).
  if (platform === undefined || (!canAsk(c) && shown === undefined)) {
    return (
      <Frame name={name} run={undefined}>
        <ShowOnceConnected platform={platform} kind="Runs" one>
          this topology
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (ref === undefined || failure?.code === "not_found") {
    return <NotHere name={name} platform={platform} />;
  }
  if (shown !== undefined) {
    return <Shown reads={shown} platform={platform} now={now} asOf={kept.asOf} />;
  }
  if (failure !== undefined) {
    return (
      <Frame name={name} run={runQ.data}>
        <FailureBox
          error={failure}
          task={{ reading: name }}
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      </Frame>
    );
  }
  return (
    <Frame name={name} run={runQ.data}>
      <Reading>
        <span>
          Reading {name} on {inSentence(platform)}…
        </span>
      </Reading>
    </Frame>
  );
}

/** The crumb: "Runs / #214 herg-wt-11state / #214/T12.3"; the run's own link once it's read. */
function Crumbs({ name, run }: { name: string; run: Pick<Run, "id" | "config"> | undefined }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/runs" className="link">
        Runs
      </Link>
      <span aria-hidden="true">/</span>
      {run !== undefined && (
        <>
          <Link to="/runs/$id" params={{ id: String(run.id) }} className="link">
            <span className="mono">#{run.id}</span> {run.config.name}
          </Link>
          <span aria-hidden="true">/</span>
        </>
      )}
      <span className="mono" aria-current="page">
        {name}
      </span>
    </nav>
  );
}

/** `#214/T12.3`, the run's part quieter. */
function Title({ name }: { name: string }) {
  const slash = name.indexOf("/") + 1;
  return (
    <PageHeading>
      <span className="title-id">
        <span className="topo-of">{name.slice(0, slash)}</span>
        {name.slice(slash)}
      </span>
    </PageHeading>
  );
}

/** The page while its topology isn't there to show: the crumb, the heading, then why. */
function Frame({
  name,
  run,
  children,
}: {
  name: string;
  run: Pick<Run, "id" | "config"> | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="page topo-page">
      <section className="topo-head">
        <Crumbs name={name} run={run} />
        <Title name={name} />
        <div className="topo-wait">{children}</div>
      </section>
    </div>
  );
}

/** A topology this platform doesn't have: its run gone, one it doesn't fit, or not one. */
function NotHere({ name, platform }: { name: string; platform: Platform }) {
  return (
    <div className="page">
      <PageHeading>Topology not found</PageHeading>
      <p className="facts">
        {name} isn’t on {inSentence(platform)}: its run is gone, or doesn’t fit it.
      </p>
      <p>
        <Link to="/runs" className="link">
          Go to Runs
        </Link>
      </p>
    </div>
  );
}

/** A line's parts, its numbers in mono. */
/** A fitting topology's live numbers, on hover (#373). */
const LIVE_TIP = "Still fitting: these change as its starts finish.";

function Said({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.cls}>
          {p.t}
        </span>
      ))}
    </>
  );
}

function Shown({
  reads,
  platform,
  now,
  asOf,
}: {
  reads: Reads;
  platform: Platform;
  now: number;
  asOf: number | undefined;
}) {
  const { run, topology: t, starts, job, partition, timings, ahead, unreadable } = reads;
  const name = `#${run.id}/${segmentOf(t)}`;
  const stage = stageOf(t, run);
  const look = stageLook(stage);
  const slurm = slurmOf(job, platform);
  const cap = job?.max_running_starts;
  const search = run.settings?.search;
  const perEvaluation =
    job === undefined ? undefined : fromRuns(timings ?? [], run.num_states, job.cpus_per_start);
  const perStartS =
    perEvaluation === undefined || search === undefined
      ? undefined
      : perEvaluation.seconds * evaluationsPerStart(search.evaluation_budget, search.population);
  const causes = causesOf(starts);
  // Held at the time the reads are from while the connection is away (#326).
  const eta =
    stage === "fitting" || stage === "queued"
      ? etaOf(starts, { now: asOf ?? now, slots: cap ?? 1, perStartS })
      : undefined;
  const status = statusParts(stage, t, {
    run,
    platform,
    slurm,
    partition,
    cap,
    now,
    eta,
    ahead:
      ahead === undefined || ahead === null
        ? undefined
        : {
            name: `#${run.id}/${segmentOf(ahead)}`,
            inAbout: queueEmptiesIn(ahead.starts_waiting, cap ?? 1, perStartS),
          },
    causes,
    asOf,
  });
  const best = t.best;
  const hasBest = best !== null && stage !== "failed";
  const selection = useSelection();

  return (
    <div className={asOf === undefined ? "page topo-page" : "page topo-page stale"}>
      <section className="topo-head">
        <Crumbs name={name} run={run} />
        <div className="topo-header">
          <Structure run={run} topology={t} graph={reads.graph} name={name} />
          <div className="topo-headtext">
            <p className="st topo-status">
              <span className={look.glyph} aria-hidden="true" />
              <span className="topo-word">{look.word}</span>
              <span className="topo-line">
                <Said parts={status} />
              </span>
            </p>
            <div className="topo-titlerow">
              <Title name={name} />
              {hasBest && (
                <div className="topo-acts">
                  {/* Compare opens with the Best start added to the session's selection. */}
                  <Link
                    to="/results/compare"
                    className="btn"
                    onClick={() =>
                      selection.add([
                        {
                          run: run.id,
                          graph: t.graph,
                          open_state: t.open_state,
                          start: best.start,
                          dataset: { id: run.dataset.id, name: run.dataset.name },
                          num_states: run.num_states,
                        },
                      ])
                    }
                  >
                    Compare…
                  </Link>
                  <Link
                    to="/runs/$id/$topology/$start"
                    params={{
                      id: String(run.id),
                      topology: segmentOf(t),
                      start: String(best.start),
                    }}
                    className="btn btn-primary"
                  >
                    Open best start
                  </Link>
                </div>
              )}
            </div>
            {unreadable !== undefined && (
              <p className="topo-unread">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M7 3.8v4M7 9.6v.6" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span>
                  {unreadable === "newer" ? (
                    <NewerRevision
                      dataset={run.dataset}
                      so="so this run’s starts don’t draw their fits."
                      then="to draw them."
                    />
                  ) : (
                    unreadableWords(run.dataset.name, run.dataset.revision, unreadable)
                  )}
                </span>
              </p>
            )}
            <dl className="topo-tiles">
              {tilesOf(t, {
                validation: run.validation,
                run,
                causes,
                live: stage === "fitting",
              }).map((tile) => (
                <div key={tile.label}>
                  <dt className="term">{tile.label}</dt>
                  {tile.lines.map((line, i) => (
                    <dd key={i}>
                      {line.map((p, j) =>
                        p.live ? (
                          <LiveN key={j} tip={LIVE_TIP} tab={tile.tab} className={p.cls}>
                            {p.t}
                          </LiveN>
                        ) : (
                          <span key={j} className={p.cls}>
                            {p.t}
                          </span>
                        ),
                      )}
                    </dd>
                  ))}
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>
      <Starts
        run={run}
        topology={t}
        starts={starts}
        stage={stage}
        local={slurm ? undefined : platform}
        partition={partition}
        causes={causes}
      />
      <OptimizationProgress
        run={run}
        topology={t}
        starts={starts}
        curves={reads.curves}
        stage={stage}
        causes={causes}
      />
      <section className="topo-low">
        <BestStarts run={run} topology={t} starts={starts} stage={stage} causes={causes} />
      </section>
      <TopParameters run={run} topology={t} starts={starts} stage={stage} />
    </div>
  );
}

/** The drawing, from the engine's lists and #212's layout, with its caption. */
function Structure({
  run,
  topology: t,
  graph,
  name,
}: {
  run: Run;
  topology: Topology;
  graph: StateGraph | undefined;
  name: string;
}) {
  const n = run.num_states;
  const edges = graph?.edges.length;
  return (
    <figure className="topo-struct">
      <div className="topo-sbox">
        {graph !== undefined && <Drawn graph={graph} n={n} open={t.open_state} name={name} />}
      </div>
      <figcaption className="topo-cap">
        <span className="mono">{segmentOf(t)}</span> · open state{" "}
        <span className="n">{t.open_state}</span> · <span className="n">{n}</span> states
        {edges !== undefined && (
          <>
            {" "}
            · <span className="n">{edges}</span> {edges === 1 ? "transition" : "transitions"} ·{" "}
            <span className="n">{2 * n + 2 * edges + 2}</span> parameters
          </>
        )}
      </figcaption>
    </figure>
  );
}

function Drawn({
  graph,
  n,
  open,
  name,
}: {
  graph: StateGraph;
  n: number;
  open: number;
  name: string;
}) {
  const laid = useMemo(() => [{ numStates: n, edges: graph.edges }], [n, graph.edges]);
  const spots = useLayouts(laid)?.[0];
  if (spots === undefined) return null;
  return (
    <TopologyDrawing
      graph={graph}
      spots={spots}
      open={open}
      size={TOPOLOGY_PAGE}
      label={`${name}: ${count(n, "state")}, ${count(graph.edges.length, "transition")}, open state ${open}.`}
    />
  );
}

/** Whether this computer marks the starts still improving at their end (#234). */
const useMarking = () => usePreferences().data?.mark_still_improving === true;

/** What a start's square or dot does as the pointer or focus meets it: lights both, or neither. */
interface Lit {
  /** The start whose square and dot are lit, if any. */
  start: number | null;
  set: (start: number | null) => void;
}

/** The pointer and focus handlers that light start `n`'s square and dot together (#359). */
const lights = (lit: Lit, n: number) => ({
  onPointerEnter: () => lit.set(n),
  onPointerLeave: () => lit.set(null),
  onFocus: () => lit.set(n),
  onBlur: () => lit.set(null),
});

/**
 * The starts' grid beside where the finished starts ended. A finished start's
 * square and its dot light together, hovered or focused, either one (#359).
 */
function Starts({
  run,
  topology: t,
  starts,
  stage,
  local,
  partition,
  causes,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  stage: Stage;
  /** Without SLURM, the platform whose slots its queued starts wait for. */
  local: Platform | undefined;
  partition: string | null;
  causes: ReturnType<typeof causesOf>;
}) {
  const [start, set] = useState<number | null>(null);
  const lit: Lit = { start, set };
  const waiting =
    stage === "held" ? heldWords(run.held) : queuedWords(run.queued?.reason ?? null, partition);
  const mark = useMarking();
  const squares = squaresOf(starts, { best: t.best, stage, local, waiting, mark });
  return (
    <section className="topo-starts">
      <StartsGrid
        run={run}
        topology={t}
        starts={starts}
        squares={squares}
        stage={stage}
        local={local}
        lit={lit}
      />
      <Ended
        run={run}
        topology={t}
        starts={starts}
        squares={squares}
        stage={stage}
        causes={causes}
        lit={lit}
      />
    </section>
  );
}

/** The 10-across grid of starts and the list that counts them, the still-improving starts marked. */
function StartsGrid({
  run,
  topology: t,
  starts,
  squares,
  stage,
  local,
  lit,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  squares: Square[];
  stage: Stage;
  local: Platform | undefined;
  lit: Lit;
}) {
  const mark = useMarking();
  const words = gridWords(countsOf(starts, stage), starts.length);
  const segment = segmentOf(t);
  return (
    <div className="topo-gridcol">
      <div className="topo-h">
        <h2 className="label">Starts</h2>
        <span className="topo-hint">{words.hint}</span>
      </div>
      <div role="group" aria-label={words.aria} className="topo-grid">
        {squares.map((q) => {
          const cls = `topo-sq sq-${q.kind}${q.best ? " sq-best" : ""}`;
          if (q.to === null) return <span key={q.start} className={cls} title={q.title} />;
          const params = { id: String(run.id), topology: segment, start: String(q.start) };
          return (
            <Link
              key={q.start}
              to="/runs/$id/$topology/$start"
              params={params}
              className={lit.start === q.start ? `${cls} is-hover` : cls}
              title={q.title}
              aria-label={q.title}
              {...lights(lit, q.start)}
            >
              {q.improving && <ImprovingMark className="topo-imp" />}
            </Link>
          );
        })}
      </div>
      <ul className="topo-list">
        {listOf(starts, stage, { best: t.best, local, mark }).map((l) => (
          <li key={l.kind}>
            {l.kind === "improving" ? (
              <ImprovingMark className="topo-sw topo-imp-sw" size={12} />
            ) : (
              <span className={`topo-sw sq-${l.kind satisfies Kind}`} aria-hidden="true" />
            )}
            <span className={l.red ? "topo-ln topo-red" : "topo-ln"}>{l.n}</span>
            <span className="topo-lw">
              {l.word}
              {l.sub !== undefined && <span className="topo-lsub"> · {l.sub}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where the finished starts ended: the dot chart and its buckets, or what shows there later. */
function Ended({
  run,
  topology: t,
  starts,
  squares,
  stage,
  causes,
  lit,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  squares: Square[];
  stage: Stage;
  causes: ReturnType<typeof causesOf>;
  lit: Lit;
}) {
  const finished = starts.flatMap((s) =>
    s.state === "finished" && s.train_rmse !== null
      ? [{ start: s.start, train: s.train_rmse }]
      : [],
  );
  const best = t.best;
  const shown =
    best !== null && best.train_rmse !== null && finished.length > 0 && stage !== "failed";
  const empty = emptyWords(stage, t.starts, causes);
  return (
    <div className="topo-ended">
      <div className="topo-h">
        <h2 className="label">Where the finished starts ended</h2>
        <span className="topo-hint">
          final train RMSE of each finished start · one dot per start · log scale
          {shown && " · select one to open it"}
        </span>
      </div>
      {shown ? (
        <EndedChart
          run={run}
          topology={t}
          finished={finished}
          best={{ start: best.start, train: best.train_rmse! }}
          starts={starts}
          squares={squares}
          lit={lit}
        />
      ) : (
        <div className="chart-empty topo-empty">
          <p>{empty.dist}</p>
          <p className="meta">{empty.distMeta}</p>
        </div>
      )}
    </div>
  );
}

function EndedChart({
  run,
  topology: t,
  finished,
  best,
  starts,
  squares,
  lit,
}: {
  run: Run;
  topology: Topology;
  finished: { start: number; train: number }[];
  best: { start: number; train: number };
  starts: StartSummary[];
  squares: Square[];
  lit: Lit;
}) {
  const d = dotsOf(finished, best);
  const b = endedOf(starts, { train_rmse: best.train });
  const said = new Map(squares.map((q) => [q.start, q.title]));
  const segment = segmentOf(t);
  return (
    <>
      <div className="topo-dots">
        <svg
          width="100%"
          height="182"
          viewBox={`0 0 ${WIDTH} 182`}
          preserveAspectRatio="none"
          role="img"
          aria-label={d.aria}
        >
          <rect className="topo-band" x={d.band.x} y="26" width={d.band.width} height="110" />
          <path className="topo-lead" d={d.lead} />
          <path className="topo-axis" d="M40 136.5H932" />
          <path className="topo-axis" d={d.ticks} />
          <path className="topo-guide" d={d.guides} />
        </svg>
        {/* A pointer shortcut: the grid is the keyboard's and a screen reader's way to each start. */}
        <div className="topo-dotlayer" aria-hidden="true">
          {d.dots.map((o) => (
            <DotLink
              key={o.start}
              dot={o}
              params={{ id: String(run.id), topology: segment, start: String(o.start) }}
              said={said.get(o.start) ?? `Start ${o.start}`}
              lit={lit}
            />
          ))}
        </div>
        {d.labels.map((l) => (
          <span
            key={l.t}
            className={`topo-tlab${l.align ? ` ${l.align}` : ""}${l.kind ? ` ${l.kind}` : ""}`}
            style={{ left: l.left, top: l.top }}
            aria-hidden="true"
          >
            {l.t}
          </span>
        ))}
      </div>
      <div className="topo-dotkey" aria-hidden="true">
        <span>
          <span className="topo-dot near" />
          within 1 % of best
        </span>
        <span>
          <span className="topo-dot" />
          further from best
        </span>
      </div>
      <dl className="topo-buckets">
        <dt className="th">Within 1 %</dt>
        <dt className="th">Within 10 %</dt>
        <dt className="th">Within 50 %</dt>
        <dt className="th">Further</dt>
        <dt className="th">Median start</dt>
        {[b.c1, b.c10, b.c50, b.far].map((n, i) => (
          <dd key={i}>
            <span className="n">{n}</span> <span className="topo-of">of {b.of}</span>
          </dd>
        ))}
        <dd>
          <span className="n">{b.median}</span> <span className="topo-of">train RMSE</span>
        </dd>
      </dl>
    </>
  );
}

/** A finished start's dot: it opens its start, and lit, it's ringed with its square's words. */
function DotLink({
  dot: o,
  params,
  said,
  lit,
}: {
  dot: Dot;
  params: { id: string; topology: string; start: string };
  said: string;
  lit: Lit;
}) {
  const on = lit.start === o.start;
  const cls = ["topo-pt", o.near && "near", o.best && "best", on && "is-hover"];
  return (
    <Link
      to="/runs/$id/$topology/$start"
      params={params}
      tabIndex={-1}
      className={cls.filter(Boolean).join(" ")}
      style={{ left: o.left, top: o.top, width: o.size, height: o.size }}
      {...lights(lit, o.start)}
    >
      {on && <span className={`tooltip topo-dtip ${o.tip}`}>{said}</span>}
    </Link>
  );
}

/** Best starts by Train RMSE, then the Failed group. */
function BestStarts({
  run,
  topology: t,
  starts,
  stage,
  causes,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  stage: Stage;
  causes: ReturnType<typeof causesOf>;
}) {
  const mark = useMarking();
  const rows = stage === "failed" ? [] : bestRowsOf(starts, t.best, mark);
  const marked = rows.some((r) => r.improving);
  const failed = failedRowsOf(starts);
  const empty = emptyWords(stage, t.starts, causes);
  const segment = segmentOf(t);
  // Failed shares Best starts' first three tracks, so its Start and Train sit under theirs.
  const tracks = tracksOf(rows, failed, marked);
  const sized = {
    "--topo-rank": `${tracks.rank}px`,
    "--topo-start": `${tracks.start}px`,
    "--topo-train": `${tracks.train}px`,
  } as React.CSSProperties;
  return (
    <div className="topo-bestcol" style={sized}>
      <div className="topo-h">
        <h2 className="label">Best starts</h2>
        <span className="topo-hint">
          <span>{bestSub(starts, stage)}</span>
          {marked && (
            <>
              {" · "}
              <span className="topo-imp-key">
                <ImprovingMark className="topo-imp-row" />
                {STILL_IMPROVING}
              </span>
            </>
          )}
        </span>
      </div>
      {rows.length > 0 ? (
        <div
          className={[
            "topo-scroll topo-table",
            run.validation ? "" : "noval",
            rows.length > 10 ? "" : "short",
          ]
            .filter(Boolean)
            .join(" ")}
          role="region"
          aria-label="Finished starts, best first"
          tabIndex={0}
        >
          <div className="topo-row topo-shead">
            <span className="th topo-num">Rank</span>
            <span className="th">Start</span>
            <span className="th topo-num">Train</span>
            {run.validation && <span className="th topo-num">Val</span>}
            <span className="th topo-num">Vs best</span>
            <span className="th topo-num">Wall time</span>
          </div>
          {rows.map((r) => (
            <Link
              key={r.start}
              to="/runs/$id/$topology/$start"
              params={{ id: String(run.id), topology: segment, start: String(r.start) }}
              className={r.best ? "topo-row topo-trow topo-best" : "topo-row topo-trow"}
            >
              <span className="topo-num topo-rank">{r.rank}</span>
              <span className="mono topo-start">{r.start}</span>
              <span className="topo-num topo-train">
                {r.improving && <ImprovingMark className="topo-imp-row" label={STILL_IMPROVING} />}
                {r.train}
              </span>
              {run.validation && <span className="topo-num topo-val">{r.val}</span>}
              <span className="topo-num topo-val">{r.delta}</span>
              <span className="topo-wall">
                <Said parts={r.wall} />
              </span>
            </Link>
          ))}
          <div className="topo-fade" aria-hidden="true" />
        </div>
      ) : (
        empty.table !== undefined && <p className="tbl-empty topo-tempty">{empty.table}</p>
      )}
      {failed.length > 0 && (
        <div className="topo-failed">
          <div className="topo-fgrp">
            <span className="label topo-red">Failed</span>
            <span className="n">{failed.length}</span>
            <span className="topo-hint">{failedSub(stage, causes, run.ended_at !== null)}</span>
          </div>
          <div
            className={
              failed.length > 5 ? "topo-fscroll topo-ftable" : "topo-fscroll topo-ftable short"
            }
            role="region"
            aria-label="Failed starts"
            tabIndex={0}
          >
            <div className="topo-row topo-shead">
              <span />
              <span className="th">Start</span>
              <span className="th topo-num">Train</span>
              <span className="th">Try</span>
              <span className="th">Cause</span>
              <span className="th">What happened</span>
              <span className="th">Log</span>
            </div>
            {failed.map((r) => (
              <div key={r.start} className="topo-row topo-ftrow">
                <span />
                <Link
                  to="/runs/$id/$topology/$start"
                  params={{ id: String(run.id), topology: segment, start: String(r.start) }}
                  className="row-link mono topo-start"
                >
                  {r.start}
                </Link>
                <span className="topo-num topo-dash">—</span>
                <span className="topo-try">{r.tryWord}</span>
                <span className="topo-cause">
                  <span className="g g-failed" aria-hidden="true" />
                  {r.cause}
                </span>
                <span className="topo-why" title={r.why}>
                  {r.why}
                </span>
                <span className="topo-open">
                  <Link
                    to="/runs/$id/$topology/$start/logs"
                    params={{ id: String(run.id), topology: segment, start: String(r.start) }}
                    search={{ log: "job" }}
                    className="link"
                    aria-label={`Open start ${r.start}’s job log`}
                  >
                    Open
                  </Link>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A start the strips draw: one of the Top 10, best first, or another finished start. */
interface Drawable {
  start: number;
  best: number[];
  top: boolean;
}

/**
 * Parameters across the top 10 starts (#287): the shared rows, each part's
 * strip with every finished start's value, canonical from this computer's
 * engine, against the Top 10, and its spread over them. Its Top 10 needs 2
 * starts, and a run's settings from a newer ICMM have no bounds to draw against.
 */
function TopParameters({
  run,
  topology: t,
  starts,
  stage,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  stage: Stage;
}) {
  const bounds = run.settings?.bounds;
  const top = t.top_10;
  const drawable = top.length >= 2 && stage !== "failed";
  const items = useMemo((): Drawable[] => {
    const inTop = new Set(top.map((s) => s.start));
    return [
      ...top.map((s) => ({ start: s.start, best: s.best, top: true })),
      ...starts.flatMap((s) =>
        s.state === "finished" && s.best !== null && !inTop.has(s.start)
          ? [{ start: s.start, best: s.best, top: false }]
          : [],
      ),
    ];
  }, [top, starts]);
  const shown = useCanonicalParameters<Drawable>(
    drawable && bounds !== undefined
      ? {
          numStates: run.num_states,
          graph: t.graph,
          openState: t.open_state,
          bounds,
          items,
          raw: (d) => d.best,
        }
      : undefined,
  );
  const name = `#${run.id}/${segmentOf(t)}`;
  let body: React.ReactNode = null;
  if (!drawable) {
    body = <p className="tbl-empty topo-tempty">{emptyParameters(stage, top)}</p>;
  } else if (bounds === undefined) {
    body = (
      <p className="tbl-empty topo-tempty">
        #{run.id} was submitted by a newer ICMM, so its parameters can’t be drawn here.
      </p>
    );
  } else if (shown.kind === "failed") {
    const e = shown.error;
    const issues = e.code === "invalid" ? e.data.issues.map((i) => i.message) : [];
    body = (
      <SaidBox
        said={{
          what: e.message,
          next: undefined,
          raw: issues.length > 0 ? issues.join(" · ") : `${e.code} error`,
          logRef: e.code === "internal" ? String(e.data?.log_ref ?? "") : undefined,
          report: e.code === "internal",
          retry: e.code !== "invalid",
        }}
        onRetry={shown.retry}
      />
    );
  } else if (shown.kind === "shown") {
    const rows = parameterRows(run.num_states, t.open_state, shown.edges);
    const of = (inTop: boolean) =>
      shown.shown.flatMap((s) =>
        s.item.top === inTop ? [{ start: s.item.start, values: s.values }] : [],
      );
    const drawn: Drawn = { top: of(true), others: of(false) };
    body = (
      <>
        <ParameterRows
          rows={rows}
          ranges={shown.ranges}
          label={`Parameters across ${name}’s top 10 starts by Train RMSE`}
          openNote={
            <>
              <b>Open state</b> · the reference: <span className="n">0</span> and{" "}
              <span className="n">0</span> in every start.
            </>
          }
          columns="minmax(0, 1fr) 48px"
          after={["Spread"]}
          part={(p, range) => {
            const strip = stripOf(p, range, drawn);
            return (
              <>
                <svg
                  className="prm-strip"
                  width="100%"
                  height="18"
                  viewBox={`0 0 ${STRIP_WIDTH} 18`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={strip.aria}
                >
                  <path className="prm-axis" d={`M0 9.5H${STRIP_WIDTH}`} />
                  <path className="prm-stops" d={`M0.5 3V16M${STRIP_WIDTH - 0.5} 3V16`} />
                  <path className="prm-others" d={strip.others} />
                  <path className="prm-near" d={strip.near} />
                  <path className="prm-tick" d={strip.tick} />
                </svg>
                <span className="prm-spread">{spreadWords(t.parameter_spreads?.[p.index])}</span>
              </>
            );
          }}
        />
        <ul className="prm-key" aria-label="What the strips show">
          {keyOf(drawn).map((k) => (
            <li key={k.swatch ?? "spread"}>
              {k.swatch !== null && (
                <span className={`prm-sw prm-sw-${k.swatch}`} aria-hidden="true" />
              )}
              <span>
                <Said parts={k.parts} />
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <section className="topo-params">
      <div className="topo-h">
        <h2 className="label">Parameters across the top 10 starts</h2>
        <span className="topo-hint">
          one row per state or edge · where each start put it · read relative to open state{" "}
          <span className="n">{t.open_state}</span>, with b&#160;&gt;&#160;0
        </span>
      </div>
      {body}
    </section>
  );
}
