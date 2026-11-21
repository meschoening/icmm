/**
 * A start's page (LaptopStart, #196; built in #239), `#214/T12.3 · start
 * 71`, at `/runs/214/T12.3/71`: where Topology's starts lead, and Results'
 * topologies their Best start's. Its status line, heading and tiles; why it ended, if
 * it stopped short; its best Train RMSE so far against evaluations; its fit
 * per protocol and its parameters against its topology's Top 10, with the
 * rates they set at a voltage; and beside them where it runs and its log's
 * last lines.
 *
 * A running start's page follows its Start log and Live snapshot through
 * `watch_start`; its fit and parameters are its best so far. A start that
 * stopped short shows its best, which never counts, simulated on this
 * computer (ADR-0013).
 *
 * A finished start's page is its Result (#336, #340; built in #346): where
 * it stands, the Best start by its rank in its Ranking group and another
 * by its place in its topology, then its fit first, its cards choosing the
 * protocol its inspector draws, its parameters (the Best start's with each
 * part's Spread) beside its topology drawn, and its progress last. Next
 * best → walks its topology by Train RMSE, and Compare with… adds it to the
 * session's selection. A start that finishes while it's watched turns into
 * it, keeping its fit until this computer draws its own. Not connected, what it last
 * read stays, as of when the connection went, its glyphs still. Open full
 * log, above its Log box and in its ···, and Why it ended's Open job log open
 * its logs page (#289).
 */
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { whole } from "../configs/words";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { templateWords } from "../datasets/detail/words";
import { count, fixed } from "../datasets/format";
import { EdgeGlyph, ParameterRows } from "../parameters/ParameterRows";
import { useCanonicalParameters } from "../parameters/queries";
import { parameterRows, type PartRef } from "../parameters/rows";
import { useMinute } from "../runs/queries";
import {
  bandOf,
  curveOf,
  CURVE,
  FIT,
  finishedWords,
  fitOf,
  PROGRESS,
  progressOf,
  type Beside,
} from "../runs/start/charts";
import { FitInspector, Labels } from "../runs/start/FitInspector";
import { StartExport } from "../runs/start/StartExport";
import { StartMenu } from "../runs/start/StartMenu";
import { failureOf } from "../failure";
import { submitted, useReportFromHere } from "../report/fromHere";
import { useReport } from "../report/useReport";
import { commands } from "../wire/api.gen";
import { useSave } from "../export/useSave";
import {
  useEdgeRates,
  useGroupRank,
  useJobLogTail,
  useStart,
  useStartLive,
  type StartRef,
} from "../runs/start/queries";
import {
  budgetOf,
  clusterOf,
  endedShort,
  exceptionOf,
  fitUnreadableWords,
  logTail,
  lookOf,
  nextDown,
  nextRunning,
  phaseOf,
  placeOf,
  protocolRmse,
  rateWords,
  statusParts,
  storedRmse,
  tilesOf,
  tracebackOf,
  whyOf,
  type Part,
  type Phase,
  type Standing,
  type StartContext,
} from "../runs/start/words";
import {
  topologyOf,
  useProgress,
  useStarts,
  useTopology,
  type TopologyRef,
} from "../runs/topology/queries";
import { evaluationsWords } from "../runs/topology/words";
import { engineVersion } from "../runs/detail";
import { rmse, runNumberOf } from "../runs/words";
import { FailureBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { canAsk, platformOf, usePlatformSettings, useReadAgain } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import {
  lineOf,
  revisionQuery,
  useSnapshotLines,
  useStartSimulation,
  type ModelAlong,
} from "../simulation/queries";
import { ImprovingMark } from "../runs/ImprovingMark";
import { NewerRevision } from "../runs/NewerRevision";
import { pickKey, useSelection, type SelectedStart } from "../selection/selection";
import { usePreferences, useSetPreferences } from "../settings/preferences";
import { SelectionBar } from "../selection/SelectionBar";
import { useKept } from "../submit/kept";
import { slurmOf } from "../submit/plan";
import { useRun } from "../submit/queries";
import { TopologyDrawing } from "../topology/Drawing";
import { spreadWords } from "../runs/topology/parameters";
import { useStateGraphs } from "../topology/queries";
import { TOPOLOGY_PAGE } from "../topology/size";
import { useLayouts } from "../topology/useLayouts";
import { clock } from "../ui/clock";
import { useLanding, useLandsOn } from "../ui/landing";
import { PageHeading } from "../ui/PageHeading";
import { ProtocolNames } from "../ui/ProtocolNames";
import { useOpened } from "../shell/palette/recents";
import { ReportFromHere } from "../report/ReportFromHere";
import type {
  Drift,
  DriftDismissal,
  JobDefaults,
  LiveSnapshot,
  GroupRank,
  ParameterRange,
  Protocol,
  ProtocolScore,
  Run,
  SavedDataset,
  SavedPlatform,
  SimulatedPoint,
  Start,
  StartCurve,
  StartFit,
  StartLogPoint,
  StartSimulation,
  StartSummary,
  StateGraph,
  Template,
  Topology,
  WireError,
} from "../wire/types.gen";

type Platform = Pick<SavedPlatform, "type" | "name">;

/**
 * What the page shows, read whole, with what it says it by: kept as of the
 * connection's end while it's gone, since the agent's reads go with it.
 */
interface Reads {
  run: Run;
  start: Start;
  /** Its topology, for its Best start and each parameter's spread; once read. */
  topology: Topology | undefined;
  /** Its topology's rank in its Ranking group, for its Best start; once read. */
  rank: GroupRank | undefined;
  /** The topology's starts, for where it would rank and the next running one; once read. */
  starts: StartSummary[] | undefined;
  /** The topology's Progress curves, for the finished starts beside its own line; once read. */
  curves: StartCurve[] | undefined;
  points: StartLogPoint[];
  snapshot: LiveSnapshot | null;
  /** When it was last read or heard from. */
  readAt: number;
  revision: SavedDataset | undefined;
  /** Why its run's revision can't be read, if it can't. */
  revisionError: WireError | undefined;
  /** The end of its job log, for a start that failed with an error. */
  jobLog: string | undefined;
  /** Its topology's state graph, for its drawing and count of parameters; once read. */
  graph: StateGraph | undefined;
  /** Its best simulated on this computer, for a start that ended; once drawn. */
  simulation: StartSimulation | undefined;
  /** What it was simulated from, which Export writes from (#344); once read. */
  fit: StartFit | undefined;
  /** Why its best can't be simulated here, if it can't. */
  simulationError: WireError | undefined;
  /** The Job defaults, whose scheduler says whether its start is a SLURM job; once read. */
  job: JobDefaults | undefined;
}

export function StartPage() {
  const params = useParams({ from: "/runs/$id/$topology/$start" });
  const id = runNumberOf(params.id);
  const which = topologyOf(params.topology);
  const index = /^(0|[1-9]\d{0,8})$/.test(params.start) ? Number(params.start) : undefined;
  const ref = useMemo<StartRef | undefined>(
    () =>
      id === undefined || which === undefined || index === undefined
        ? undefined
        : { run: id, graph: which.graph, openState: which.openState, start: index },
    [id, which?.graph, which?.openState, index], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const topologyRef = useMemo<TopologyRef | undefined>(
    () =>
      ref === undefined ? undefined : { run: ref.run, graph: ref.graph, openState: ref.openState },
    [ref],
  );
  const name = `start ${params.start} of #${params.id}/${params.topology}`;
  const c = useConnection();
  const platform = useActivePlatform();
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";

  const runQ = useRun(ref?.run);
  const startQ = useStart(ref);
  const start = startQ.data;
  useOpened(
    runQ.data === undefined || start === undefined || ref === undefined
      ? undefined
      : {
          kind: "start",
          run: ref.run,
          graph: ref.graph,
          open_state: ref.openState,
          start: ref.start,
          name: runQ.data.config.name,
        },
  );
  const topologyQ = useTopology(topologyRef);
  const isBest = start?.state === "finished" && topologyQ.data?.best?.start === start.start;
  const rankQ = useGroupRank(topologyRef, isBest);
  const startsQ = useStarts(topologyRef, start !== undefined);
  const progressQ = useProgress(topologyRef, start !== undefined);
  const stillLogging = start?.state === "running" || start?.state === "queued";
  const log = useStartLive(ref, start, stillLogging);
  const revisionQ = useQuery({
    ...revisionQuery(platformOf(c), runQ.data?.dataset),
    enabled: runQ.data !== undefined && c.status === "connected",
  });
  const failedWithError = start?.state === "failed" && (start.cause ?? "error") === "error";
  const jobLogQ = useJobLogTail(ref, start?.try_number ?? 0, failedWithError);
  const job = usePlatformSettings().data?.saved?.settings.job_defaults;
  const run = runQ.data;
  // A start that ended, finished or short, is simulated here from its stored best (ADR-0013).
  const ended =
    start !== undefined &&
    (start.state === "finished" || endedShort(phaseOf(start, true))) &&
    start.best !== null;
  const simulated = useStartSimulation(ended ? ref : undefined);
  const graph = useStateGraphs(run?.num_states ?? 0, ref === undefined ? [] : [ref.graph])?.get(
    ref?.graph ?? -1,
  );
  const logRead = start !== undefined && (start.try_number === 0 || log.read);
  const reads = useMemo<Reads | undefined>(
    () =>
      run === undefined || start === undefined || !logRead
        ? undefined
        : {
            run,
            start,
            topology: topologyQ.data,
            rank: rankQ.data,
            starts: startsQ.starts,
            curves: progressQ.curves,
            points: log.points,
            snapshot: log.snapshot,
            readAt: log.readAt ?? startQ.dataUpdatedAt,
            revision: revisionQ.data,
            revisionError: (revisionQ.error ?? undefined) as WireError | undefined,
            jobLog: jobLogQ.data?.found ? jobLogQ.data.text : undefined,
            graph,
            simulation: ended ? simulated.data : undefined,
            fit: ended ? simulated.fit : undefined,
            simulationError: ended
              ? ((simulated.error ?? undefined) as WireError | undefined)
              : undefined,
            job,
          },
    [
      run,
      start,
      logRead,
      topologyQ.data,
      rankQ.data,
      startsQ.starts,
      progressQ.curves,
      log.points,
      log.snapshot,
      log.readAt,
      startQ.dataUpdatedAt,
      revisionQ.data,
      revisionQ.error,
      jobLogQ.data,
      graph,
      ended,
      simulated.data,
      simulated.error,
      simulated.fit,
      job,
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
  const failed = runQ.error ?? startQ.error ?? log.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failed !== null && failed !== undefined
      ? (failed as unknown as WireError)
      : undefined,
    () => (runQ.isError ? runQ.refetch() : startQ.isError ? startQ.refetch() : log.refetch()),
  );
  const failure = useHeldFailure(
    read.failure,
    runQ.isFetching || startQ.isFetching,
    name,
    reads !== undefined || !live,
  );
  const shown = kept.value;
  const title = `#${params.id}/${params.topology}`;

  // Reads run only while connected: reconnecting with nothing kept, it says when it shows (KF17).
  if (platform === undefined || (!canAsk(c) && shown === undefined)) {
    return (
      <Frame title={title} start={params.start} run={undefined}>
        <ShowOnceConnected platform={platform} kind="Runs" one>
          this start
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (ref === undefined || failure?.code === "not_found") {
    return <NotHere name={`${title} · start ${params.start}`} platform={platform} />;
  }
  if (shown !== undefined) {
    return <Shown reads={shown} startRef={ref} platform={platform} now={now} asOf={kept.asOf} />;
  }
  if (failure !== undefined) {
    return (
      <Frame title={title} start={params.start} run={run}>
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
    <Frame title={title} start={params.start} run={run}>
      <Reading>
        <span>
          Reading {name} on {inSentence(platform)}…
        </span>
      </Reading>
    </Frame>
  );
}

/** The crumb: "Runs / #214 herg-wt-11state / #214/T12.3 / start 71"; the run's once it's read. */
function Crumbs({
  title,
  start,
  run,
}: {
  title: string;
  start: string;
  run: Pick<Run, "id" | "config"> | undefined;
}) {
  const [id, topology] = title.slice(1).split("/");
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/runs" className="link">
        Runs
      </Link>
      <span aria-hidden="true">/</span>
      {run !== undefined && (
        <>
          <Link to="/runs/$id" params={{ id }} className="link">
            <span className="mono">#{run.id}</span> {run.config.name}
          </Link>
          <span aria-hidden="true">/</span>
        </>
      )}
      <Link to="/runs/$id/$topology" params={{ id, topology }} className="link mono">
        {title}
      </Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">start {start}</span>
    </nav>
  );
}

/** `#214/T12.3 · start 71`, the topology quieter. */
function Title({ title, start }: { title: string; start: string }) {
  // Home's drift note opens the start at its fit, where its Drift box is (#398).
  const drift = useLandsOn("drift");
  return (
    <PageHeading landing={!drift}>
      <span className="title-id">
        <span className="topo-of">{title} · </span>start {start}
      </span>
    </PageHeading>
  );
}

/** The page while its start isn't there to show: the crumb, the heading, then why. */
function Frame({
  title,
  start,
  run,
  children,
}: {
  title: string;
  start: string;
  run: Pick<Run, "id" | "config"> | undefined;
  children: ReactNode;
}) {
  return (
    <div className="page sp-page">
      <section className="sp-head">
        <Crumbs title={title} start={start} run={run} />
        <Title title={title} start={start} />
        <div className="sp-wait">{children}</div>
      </section>
      <ReportFromHere name={`${title} · start ${start}`} mono />
    </div>
  );
}

/** A start this platform doesn't have: its run gone, one its topology doesn't hold, or not one. */
function NotHere({ name, platform }: { name: string; platform: Platform }) {
  return (
    <div className="page">
      <PageHeading>Start not found</PageHeading>
      <p className="facts">
        {name} isn’t on {inSentence(platform)}: its run is gone, or doesn’t hold it.
      </p>
      <ReportFromHere name="Start not found" />
      <p>
        <Link to="/runs" className="link">
          Go to Runs
        </Link>
      </p>
    </div>
  );
}

/** A line's parts, its numbers in mono. */
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
  startRef,
  platform,
  now,
  asOf,
}: {
  reads: Reads;
  startRef: StartRef;
  platform: Platform;
  now: number;
  asOf: number | undefined;
}) {
  const { run, start, starts, curves, points, snapshot } = reads;
  const fitLanding = useLanding("drift");
  const segment = `T${startRef.graph}.${startRef.openState}`;
  const title = `#${run.id}/${segment}`;
  const n = start.start;
  // A start can log before its coordinator's next sweep says it runs.
  const phase: Phase =
    start.state === "queued" && points.length > 0 ? "running" : phaseOf(start, points.length > 0);
  const look = lookOf(phase);
  // Without SLURM its starts are processes on the platform, which aren't jobs (#281).
  const slurm = slurmOf(reads.job, platform);
  const c: StartContext = { run, start, points, platform, slurm, now, asOf };
  const short = endedShort(phase);
  const isBest = phase === "finished" && reads.topology?.best?.start === n;
  const place = phase === "finished" ? placeOf(starts, n) : undefined;
  const standing: Standing | undefined =
    phase !== "finished"
      ? undefined
      : isBest
        ? {
            best: true,
            rank: reads.rank,
            dataset: { name: run.dataset.name ?? run.dataset.id, deleted: run.dataset.deleted },
          }
        : { best: false, place };
  const finished = (starts ?? []).flatMap((s) =>
    s.state === "finished" && s.train_rmse !== null ? [s.train_rmse] : [],
  );
  // The best finished start by Train RMSE, as the tiles weigh it.
  const bestFinished = (starts ?? []).reduce<{ start: number; train: number } | null>(
    (b, s) =>
      s.state === "finished" && s.train_rmse !== null && (b === null || s.train_rmse < b.train)
        ? { start: s.start, train: s.train_rmse }
        : b,
    null,
  );
  const beside = curves === undefined ? undefined : { curves, best: bestFinished };
  const next =
    phase === "running" || phase === "starting" || phase === "time_limit"
      ? nextRunning(starts, n)
      : undefined;
  const tb =
    phase === "error" && reads.jobLog !== undefined ? tracebackOf(reads.jobLog) : undefined;
  const why = whyOf(phase, c, segment, tb === undefined ? undefined : exceptionOf(tb));
  const done = phase === "finished";
  const best = phase === "running" ? (snapshot?.best ?? null) : short || done ? start.best : null;
  const hasLog = points.length > 0 || ((short || done) && start.best !== null);
  // A watched start that finishes keeps its last snapshot's fit until this computer draws its own.
  const [lastSnapshot, setLastSnapshot] = useState(snapshot);
  if (snapshot !== null && snapshot !== lastSnapshot) setLastSnapshot(snapshot);
  const jobId = slurm ? (start.ran_with?.job_id ?? null) : null;
  const down = nextDown(place, isBest, title);
  const selection = useSelection();
  const pick: SelectedStart = {
    run: run.id,
    graph: startRef.graph,
    open_state: startRef.openState,
    start: n,
    dataset: { id: run.dataset.id, name: run.dataset.name },
    num_states: run.num_states,
  };
  const held = selection.has(pickKey(pick));
  const saving = useSave();
  // Settings' Mark still-improving starts (#234).
  const marking = usePreferences().data?.mark_still_improving === true;
  const budget = budgetOf(run);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const logs = { id: String(run.id), topology: segment, start: String(n) };
  const name = `start ${n} of ${title}`;
  // What a report from here holds: the start, the end of its job log, read now (the page's read
  // may not have come yet), and its run.
  const readStart = async () => ({
    kind: "start" as const,
    name,
    job_log: await commands
      .read_job_log({
        run: run.id,
        graph: startRef.graph,
        open_state: startRef.openState,
        start: n,
        try_number: null,
        after: null,
        before: null,
      })
      .then(
        (page) => (page.found ? page.text : "Its job log wasn’t found."),
        (e: unknown) => reads.jobLog ?? `ICMM couldn’t read its job log: ${failureOf(e).message}`,
      ),
    run: submitted(run),
  });
  // An error's report carries the end of its job log and its run (#126). Its
  // words gain the error's name once the job log is read: the same report.
  const report = useReport({
    key: `${run.id}/${segment}/${n}/${start.try_number}`,
    failure: why?.report === true ? { what: why.what, next: why.next, raw: null } : undefined,
    page: {
      kind: "start",
      row: (
        <>
          <span className="mono">{title}</span> · start <span className="mono">{n}</span>, with its
          run’s config
        </>
      ),
      read: readStart,
    },
    look: "boxed",
  });
  // Report a problem… from its ··· or ⌘K (#470), under the page head; on a failed start, its
  // failure's own panel.
  const fromHere = useReport({
    key: `${run.id}/${segment}/${n}`,
    look: "page",
    page: {
      kind: "start",
      row: (
        <>
          start <span className="mono">{n}</span> of <span className="mono">{title}</span>, with its
          run’s config and the end of its job log
        </>
      ),
      read: readStart,
    },
  });
  const reportStart = why?.report === true ? report.start : fromHere.start;
  useReportFromHere(["about ", { mono: title }, " · start ", { mono: String(n) }], reportStart);
  const logBlocked =
    asOf !== undefined
      ? `Connect to ${inSentence(platform)} to open its log.`
      : points.length > 0
        ? undefined
        : phase === "error"
          ? "Nothing was logged; Open job log has its error."
          : "Opens once its first generation is logged.";

  return (
    <div className={asOf === undefined ? "page sp-page" : "page sp-page stale"}>
      <section className="sp-head">
        <Crumbs title={title} start={String(n)} run={run} />
        <div className="sp-headtext">
          <p className="st sp-status">
            <span
              className={`${look.glyph}${phase === "running" && asOf === undefined ? " live" : ""}`}
              aria-hidden="true"
            />
            <span className={look.red ? "sp-word sp-red" : "sp-word"}>{look.word}</span>
            <span className="sp-line">
              <Said parts={statusParts(phase, c, isBest ? title : undefined)} />
            </span>
          </p>
          <div className="sp-titlerow">
            <Title title={title} start={String(n)} />
            <div className="sp-acts">
              {next !== undefined && (
                <Link
                  to="/runs/$id/$topology/$start"
                  params={{ id: String(run.id), topology: segment, start: String(next) }}
                  className="btn"
                  aria-label={`Next running start: start ${next}`}
                >
                  <span>Next running: start {next}</span>
                  <Arrow />
                </Link>
              )}
              {down !== undefined && place?.next !== undefined && (
                <Link
                  to="/runs/$id/$topology/$start"
                  params={{ id: String(run.id), topology: segment, start: String(place.next) }}
                  className="btn"
                  aria-label={down.aria}
                >
                  <span>{down.label}</span>
                  <Arrow />
                </Link>
              )}
              {phase === "finished" && (
                <StartExport
                  saving={saving}
                  shown={{
                    run,
                    start,
                    graph: startRef.graph,
                    openState: startRef.openState,
                    fit: reads.fit,
                    revision: reads.revision,
                    unreadable: reads.revisionError?.code === "unreadable",
                    simulation: reads.simulation,
                    stateGraph: reads.graph,
                  }}
                />
              )}
              {phase === "finished" && (
                <button
                  type="button"
                  className={held ? "btn" : "btn btn-primary"}
                  aria-pressed={held}
                  aria-label={
                    held
                      ? `Start ${n} is in the selection; press to remove it`
                      : `Compare start ${n} with others: adds it to the session’s selection`
                  }
                  onClick={() => selection.toggle(pick)}
                >
                  {held ? (
                    <>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path d="M2.5 6.2 5 8.6l4.6-5" stroke="currentColor" strokeWidth="1.6" />
                      </svg>
                      In the selection
                    </>
                  ) : (
                    "Compare with…"
                  )}
                </button>
              )}
              <StartMenu
                start={n}
                buttonRef={menuButton}
                onOpenLog={() =>
                  void navigate({ to: "/runs/$id/$topology/$start/logs", params: logs })
                }
                logBlocked={logBlocked}
                onCopy={
                  jobId === null
                    ? undefined
                    : () => void navigator.clipboard?.writeText(jobId).catch(() => {})
                }
                onReport={reportStart}
              />
            </div>
          </div>
          <Facts run={run} edges={reads.graph?.edges.length} />
        </div>
        {fromHere.panel}
        <dl className="sp-tiles">
          {tilesOf(phase, c, finished, segment, standing).map((tile) => (
            <div key={tile.label} className="sp-tile">
              <dt className="term">{tile.label}</dt>
              <dd>
                <Said parts={tile.parts} />
                {tile.bar !== undefined && (
                  <span
                    className="sp-bar"
                    role="img"
                    aria-label={`${Math.round(tile.bar.done * 100)} % of evaluations done`}
                  >
                    <span
                      className={`sp-fill ${tile.bar.look}`}
                      style={{ width: `${(tile.bar.done * 100).toFixed(2)}%` }}
                    />
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {done && start.still_improving === true && marking && (
          <p className="sp-imp">
            <ImprovingMark size={12} />
            <span>
              <b>Still improving at its end:</b> its Train RMSE fell more than 1 % over its last{" "}
              {budget === undefined ? "tenth of its" : whole(Math.round(budget / 10))} evaluations.
              More evaluations per start may fit better.
            </span>
          </p>
        )}
        {saving.outcome}
      </section>

      {why !== undefined && (
        <section aria-labelledby="sp-why-h" className="sp-why">
          <div className="sp-whyleft">
            <h2 id="sp-why-h" className="label">
              {why.label}
            </h2>
            <div className="sp-big">
              <span className="mono">{why.big}</span>
              <span>{why.bigOf}</span>
            </div>
            <span className="sp-cap">{why.cap}</span>
          </div>
          <div className="sp-say">
            <p className="sp-what">
              <span className={why.glyph} aria-hidden="true" />
              <span>{why.what}</span>
            </p>
            <p className="sp-next">{why.next}</p>
            <p className="sp-hint">{why.hint}</p>
            {tb !== undefined && (
              <div
                className="sp-tb"
                role="log"
                aria-label={`The end of start ${n}’s job log`}
                // It scrolls sideways, so a keyboard reaches it.
                tabIndex={0}
              >
                {tb.map((l, i) => (
                  <span key={i} className={l.err ? "err" : undefined}>
                    {l.t}
                  </span>
                ))}
              </div>
            )}
            <p className="sp-open">
              <Link
                to="/runs/$id/$topology/$start/logs"
                params={logs}
                search={{ log: "job" }}
                className="btn btn-sm"
              >
                Open job log
              </Link>
              {why.report === true && report.button}
            </p>
            {why.report === true && report.sentence}
            {why.report === true && report.panel}
          </div>
        </section>
      )}

      {!done && <ProgressSection c={c} phase={phase} title={title} beside={beside} />}

      {(hasLog || !short) && (
        <FitSection
          c={c}
          startRef={startRef}
          phase={phase}
          revision={reads.revision}
          revisionError={reads.revisionError}
          snapshot={done ? lastSnapshot : snapshot}
          simulation={reads.simulation}
          fit={reads.fit}
          simulationError={reads.simulationError}
          hasLog={hasLog}
          land={fitLanding.land}
        />
      )}

      <div className="sp-low">
        <div className="sp-main">
          {(hasLog || !short) && (
            <ParametersSection
              run={run}
              start={start}
              startRef={startRef}
              best={best}
              short={short}
              done={done}
              isBest={isBest}
              spreads={reads.topology?.parameter_spreads ?? undefined}
              title={title}
            />
          )}
          {!hasLog && short && <LogSection c={c} phase={phase} logs={logs} />}
        </div>
        <aside className="sp-aside">
          {done && <TopologyBox run={run} startRef={startRef} graph={reads.graph} title={title} />}
          <ClusterBox phase={phase} c={c} readAt={reads.readAt} />
          {best !== null && (
            <RatesBox
              numStates={run.num_states}
              startRef={startRef}
              best={best}
              whose={
                done ? `start ${n}’s parameters` : `start ${n}’s best${short ? "" : " so far"}`
              }
            />
          )}
          {(hasLog || !short) && <LogSection c={c} phase={phase} logs={logs} />}
        </aside>
      </div>
      {done && <ProgressSection c={c} phase={phase} title={title} beside={beside} best={isBest} />}
      <SelectionBar shown={run.dataset.id} />
    </div>
  );
}

/** The arrow a "Next" button ends with. */
function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** "herg-wt · 11 states · 46 parameters · CMA-ES, population 50 · seed 2849105537 · random start points". */
function Facts({ run, edges }: { run: Run; edges: number | undefined }) {
  const search = run.settings?.search;
  return (
    <p className="facts">
      {run.dataset.name ?? run.dataset.id}
      {(run.dataset.deleted || run.dataset.earlier) && (
        <>
          {" "}
          · <span className="qual-e">{run.dataset.deleted ? "deleted" : "earlier data"}</span>
        </>
      )}{" "}
      · <span className="n">{run.num_states}</span> states
      {edges !== undefined && (
        <>
          {" "}
          · <span className="n">{2 * run.num_states + 2 * edges + 2}</span> parameters
        </>
      )}
      {search !== undefined && (
        <>
          {" "}
          · CMA-ES, population <span className="n">{whole(search.population)}</span>
        </>
      )}{" "}
      · seed <span className="n">{run.search_seed}</span>
      {search !== undefined && ` · ${search.sobol_start_points ? "Sobol" : "random"} start points`}
    </p>
  );
}

// ── Optimization progress ─────────────────────────────────────────────────────────────────────

function ProgressSection({
  c,
  phase,
  title,
  beside,
  best,
}: {
  c: StartContext;
  phase: Phase;
  title: string;
  beside: Beside | undefined;
  /** A finished start's: whether it's its topology's Best start. */
  best?: boolean;
}) {
  const budget = budgetOf(c.run);
  const done = phase === "finished";
  const n = c.start.start;
  const end =
    phase === "time_limit"
      ? "time limit"
      : phase === "canceled"
        ? "canceled"
        : endedShort(phase)
          ? "ended"
          : c.asOf !== undefined
            ? `as of ${clock(c.asOf, c.now)}`
            : "now";
  const chart =
    budget === undefined
      ? undefined
      : progressOf(c.points, budget, {
          start: n,
          end,
          beside,
          finished: done ? { best: best === true } : undefined,
        });
  const bestStart = chart !== undefined && chart.best !== "" ? beside?.best?.start : undefined;
  const drawn = chart?.finished ?? 0;
  const live = phase === "running" && c.asOf === undefined;
  const of = budget === undefined ? "its" : `its full ${evaluationsWords(budget)}`;
  // Unless it ends there, finished, as its step size overflows (#468).
  const runs = `Every start runs ${of} evaluations unless CMA-ES’s step size overflows first.`;
  const empty =
    phase === "queued" || phase === "waiting"
      ? {
          say: "Its best so far shows here once it starts and logs its first generation.",
          meta: runs,
        }
      : phase === "starting"
        ? {
            say: "Starting up: its best so far shows here once its first generation is logged.",
            meta: runs,
          }
        : {
            say: "It stopped before its first generation, so it has no best to show.",
            meta: phase === "error" ? "Why it failed is above." : "Why it ended is above.",
          };
  return (
    <section className="sp-sec">
      <div className="topo-h">
        <h2 className="label">Optimization progress</h2>
        <span className="topo-hint">
          best train RMSE so far against CMA-ES evaluations,{" "}
          {drawn > 0 ? `beside the ${finishedWords(drawn)} of ${title}` : `in ${title}`}
        </span>
      </div>
      {chart !== undefined ? (
        <>
          <div className="sp-pg">
            <svg
              className="fluid"
              width="100%"
              height={PROGRESS.height}
              viewBox={`0 0 ${PROGRESS.width} ${PROGRESS.height}`}
              preserveAspectRatio="none"
              fill="none"
              role="img"
              aria-label={chart.aria}
            >
              <path className="sp-band" d={chart.band} />
              <path className="sp-grid" d={chart.grid} />
              <path className="sp-vgrid" d={chart.vgrid} />
              <path className="sp-median" d={chart.median} />
              <path className="sp-others" d={chart.others} />
              <path className="sp-best" d={chart.best} />
              <path className="sp-now" d={chart.now} />
              <path className="sp-base" d={chart.base} />
              <path className="sp-me" d={chart.me} />
            </svg>
            <span
              className={`sp-dot${live ? " live" : endedShort(phase) ? " still" : ""}`}
              aria-hidden="true"
              style={{
                left: `calc(${((chart.dot.x / PROGRESS.width) * 100).toFixed(3)}% - 4.5px)`,
                top: chart.dot.y - 4.5,
              }}
            />
            <Labels labels={chart.labels} />
          </div>
          <div className="sp-key" aria-hidden="true">
            <span>
              <span className="sp-sw me" />
              start {n}
              {best === true && " · best start"}
            </span>
            {bestStart !== undefined && (
              <span>
                <span className="sp-sw best" />
                start {bestStart} · best start
              </span>
            )}
            {chart.median !== "" && (
              <span>
                <span className="sp-sw median" />
                median of the {whole(drawn)} finished
              </span>
            )}
            {chart.otherCount > 0 && (
              <span>
                <span className="sp-sw median" />
                the other {whole(chart.otherCount)} finished
              </span>
            )}
            {chart.band !== "" && (
              <span>
                <span className="sp-sw middle" />
                middle 80 % of the {whole(drawn)} finished
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="sp-empty tall">
          <p>{empty.say}</p>
          <p className="meta">{empty.meta}</p>
        </div>
      )}
    </section>
  );
}

// ── the fit ───────────────────────────────────────────────────────────────────────────────────

interface Card {
  protocol: Protocol;
  template: Template;
  label: string;
  /** The model along its x, as its line is drawn; `undefined` until it's drawn. */
  line: ModelAlong | undefined;
  /** Its sweeps simulated here, for the inspector: a start that ended. */
  simulated: SimulatedPoint[] | undefined;
  train: number | null;
  val: number | null;
}

function FitSection({
  c,
  startRef,
  phase,
  revision,
  revisionError,
  snapshot,
  simulation,
  fit,
  simulationError,
  hasLog,
  land,
}: {
  c: StartContext;
  startRef: StartRef;
  phase: Phase;
  revision: SavedDataset | undefined;
  revisionError: WireError | undefined;
  snapshot: LiveSnapshot | null;
  simulation: StartSimulation | undefined;
  /** What it was simulated from, with its stored scores; once read. */
  fit: StartFit | undefined;
  simulationError: WireError | undefined;
  hasLog: boolean;
  /** Its heading's ref: Home's drift note lands there (#398). */
  land: (el: HTMLElement | null) => void;
}) {
  const [chosen, setChosen] = useState(0);
  const done = phase === "finished";
  // A start that ended is scored as its run stored it and drawn on this computer.
  const stored = endedShort(phase) || done;
  const validation = c.run.validation;
  const latest = c.points[c.points.length - 1];
  const n = c.start.start;
  const unreadable = revisionError?.code === "unreadable" ? revisionError.data.problem : undefined;
  // Its Live snapshot's best, drawn here along each protocol's grid at each new best (#362).
  const snapshotLines = useSnapshotLines(
    snapshot === null || revision === undefined
      ? undefined
      : {
          ...startRef,
          numStates: c.run.num_states,
          dataset: { id: revision.id, revision: revision.revision, content: revision.content },
          best: snapshot.best,
        },
  ).data;
  const failure =
    unreadable !== undefined
      ? undefined
      : (revisionError ?? (stored ? simulationError : undefined));
  const cards: Card[] | undefined = revision?.content.protocols.map((protocol, i) => {
    const counts = {
      train: protocol.points.filter((p) => !p.validation).length,
      val: protocol.points.filter((p) => p.validation).length,
    };
    const sim = stored ? simulation?.protocols[i] : undefined;
    const snap =
      sim === undefined ? snapshot?.protocols.find((p) => p.name === protocol.name) : undefined;
    // An ended start's line is its stored best's; a running one's, its snapshot's best drawn
    // here, or until that's drawn (or if it can't be), its snapshot's values at the points.
    const drawn = sim ?? (snap === undefined ? undefined : snapshotLines?.protocols[i]);
    const line: ModelAlong | undefined =
      drawn !== undefined ? lineOf(drawn) : snap?.x.map((x, k) => ({ x, value: snap.value[k] }));
    const steps = protocol.steps.length;
    return {
      protocol,
      template: revision.templates[i],
      label: templateWords(revision.templates[i], steps),
      line,
      simulated: sim?.points,
      train: stored
        ? storedRmse(c.start, i, false)
        : protocolRmse(latest?.train_sse?.[i], counts.train, latest?.train_failed?.[i]),
      val: stored
        ? storedRmse(c.start, i, true)
        : protocolRmse(latest?.val_sse?.[i], counts.val, latest?.val_failed?.[i]),
    };
  });
  const drift = stored ? simulation?.drift : null;
  const which = validation ? "train and val RMSE" : "train RMSE";
  const hint =
    unreadable !== undefined
      ? stored
        ? `${which} per protocol, as its run stored them`
        : undefined
      : `${which} per protocol · ${stored ? "simulated on this computer" : "redrawn at each new best"}`;
  const key = hasLog && unreadable === undefined && (
    <span className={done ? "sp-fitkey sp-fitrow" : "sp-fitkey"} aria-hidden="true">
      <span>
        <svg width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="2.6" className="sp-k-dot" />
        </svg>
        train data
      </span>
      {validation && (
        <span>
          <svg width="8" height="8" viewBox="0 0 8 8">
            <circle cx="4" cy="4" r="2.6" className="sp-k-ring" />
          </svg>
          validation data
        </span>
      )}
      <span>
        <svg width="16" height="8" viewBox="0 0 16 8">
          <path d="M4 1.2 6.8 4 4 6.8 1.2 4Z" className="sp-k-dot" />
          {validation && <path d="M12 1.4 14.6 4 12 6.6 9.4 4Z" className="sp-k-ring" />}
        </svg>
        interpolated
      </span>
      <span>
        <svg width="18" height="8" viewBox="0 0 18 8">
          <path d="M1 4h16" className="sp-k-line" />
        </svg>
        simulated, start {n}
      </span>
    </span>
  );
  let body: ReactNode;
  if (!hasLog) {
    body = (
      <div className="sp-empty short">
        <p>Its fit draws here from its best parameters so far.</p>
      </div>
    );
  } else if (unreadable !== undefined) {
    // Numbers, no curves: the revision can't be read, so its protocols are named as its run
    // recorded them (#387).
    const count = stored ? (c.start.train_sse?.length ?? 0) : 0;
    const numbered = Array.from({ length: count }, (_, i) => {
      const p = c.run.protocols[i];
      return {
        name: p?.name ?? `Protocol ${i + 1}`,
        label: p === undefined ? undefined : templateWords(p.template, null),
        train: storedRmse(c.start, i, false),
        val: storedRmse(c.start, i, true),
      };
    });
    body = (
      <>
        <div className="sp-empty sp-unread">
          <p className="sp-unreadsay">
            <InfoGlyph />
            <span>
              {unreadable === "newer" ? (
                <NewerRevision
                  dataset={c.run.dataset}
                  so={`so start ${n}’s fit can’t be drawn here.`}
                  then="to draw it."
                />
              ) : (
                fitUnreadableWords(
                  c.run.dataset.name ?? c.run.dataset.id,
                  c.run.dataset.revision,
                  unreadable,
                  n,
                )
              )}
            </span>
          </p>
          <p className="meta">
            {stored
              ? "Its scores, parameters and rates below are the ones its run stored."
              : "Its scores so far are in its log, below."}
          </p>
        </div>
        {numbered.length > 0 && (
          <div className="sp-cards">
            {numbered.map((card) => (
              <div
                key={card.name}
                role="group"
                className="sp-card sp-numbers"
                aria-label={
                  `${card.name}${card.label === undefined ? "" : `, ${card.label}`}, as its run ` +
                  `stored it: train RMSE ${rmseOr(card.train)}` +
                  (validation ? `, val RMSE ${rmseOr(card.val)}` : "")
                }
              >
                <CardWords
                  name={card.name}
                  label={card.label}
                  train={card.train}
                  val={card.val}
                  validation={validation}
                />
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (failure !== undefined) {
    body = <p className="topo-tempty">{failure.message}</p>;
  } else if (cards === undefined) {
    body = <p className="sp-reading">Reading its dataset…</p>;
  } else {
    const pick = cards[Math.min(chosen, cards.length - 1)];
    body = (
      <>
        <div className="sp-cards">
          {cards.map((card, i) => (
            <FitCard
              key={card.protocol.name}
              card={card}
              validation={validation}
              so={!stored}
              n={n}
              pressed={done ? i === chosen : undefined}
              onPress={() => setChosen(i)}
            />
          ))}
        </div>
        {done && pick !== undefined && (
          <FitInspector
            protocol={pick.protocol}
            template={pick.template}
            label={pick.label}
            line={pick.line}
            simulated={pick.simulated}
            validation={validation}
            start={n}
          />
        )}
      </>
    );
  }
  return (
    <section className="sp-sec">
      <div className="topo-h sp-fithead">
        <h2 className="label lands" tabIndex={-1} ref={land}>
          {stored ? "Fit with its best parameters" : "Fit with the best parameters so far"}
        </h2>
        {hasLog && hint !== undefined && <span className="topo-hint sp-grow">{hint}</span>}
        {!done && key}
      </div>
      {done && key}
      {drift != null && simulation !== undefined && (
        <DriftNotice
          drift={drift}
          simulation={simulation}
          fit={fit}
          validation={validation}
          startRef={startRef}
        />
      )}
      {body}
    </section>
  );
}

/** The dismissals kept: the latest, so the list stays small. */
const DISMISSALS_KEPT = 200;

/**
 * The Drift box (#360, RF11): the start drawn here scores some protocols
 * differently from its stored scores. It says who drew it and who scored
 * it, then each drifting protocol's stored RMSE (`read_start_fit`'s) beside
 * the redrawn (`simulate_start`'s). Its × dismisses it for this start on
 * this computer until a different engine draws it, a preference keyed by the
 * start and the engine; dismissed, one gray line stays, whose Show the
 * numbers brings the box back. Focus moves to what takes the pressed
 * control's place.
 */
function DriftNotice({
  drift,
  simulation,
  fit,
  validation,
  startRef,
}: {
  drift: Drift;
  simulation: StartSimulation;
  fit: StartFit | undefined;
  validation: boolean;
  startRef: StartRef;
}) {
  const connection = useConnection();
  const platformId = connection.status === "none" ? undefined : connection.platformId;
  const preferences = usePreferences();
  const setPreferences = useSetPreferences();
  const saved = preferences.data;
  const isThis = (d: DriftDismissal) =>
    d.platform_id === platformId &&
    d.run === startRef.run &&
    d.graph === startRef.graph &&
    d.open_state === startRef.openState &&
    d.start === startRef.start;
  const dismissed =
    saved?.drift_dismissed.some((d) => isThis(d) && d.engine === drift.drawn_engine) === true;
  // A press moves focus to what takes its control's place, once it's there.
  const moving = useRef(false);
  const dismiss = useRef<HTMLButtonElement>(null);
  const show = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moving.current) return;
    moving.current = false;
    (dismissed ? show : dismiss).current?.focus();
  }, [dismissed]);
  // Until this computer's choices are read, neither shows; one it can't read leaves it shown.
  if (saved === undefined && !preferences.isError) return null;
  const change = (hidden: boolean) => {
    if (saved === undefined || platformId === undefined) return;
    const others = saved.drift_dismissed.filter((d) => !isThis(d));
    const next: DriftDismissal[] = hidden
      ? [
          ...others,
          {
            platform_id: platformId,
            run: startRef.run,
            graph: startRef.graph,
            open_state: startRef.openState,
            start: startRef.start,
            engine: drift.drawn_engine,
          },
        ].slice(-DISMISSALS_KEPT)
      : others;
    moving.current = true;
    void setPreferences({ ...saved, drift_dismissed: next }).catch(() => {});
  };
  if (dismissed) {
    return (
      <p className="sp-dline">
        <InfoGlyph />
        <span>
          This computer’s engine scores <ProtocolNames names={drift.protocols} /> differently from
          the stored errors.
        </span>
        <button type="button" className="btn-text" ref={show} onClick={() => change(false)}>
          Show the numbers
        </button>
      </p>
    );
  }
  const drawn = engineVersion(drift.drawn_engine);
  const scored = engineVersion(drift.fit_engine);
  const rmses = (score: ProtocolScore | undefined) => ({
    train:
      score === undefined
        ? null
        : protocolRmse(score.train_sse, score.train_points, score.train_failed),
    val:
      score === undefined ? null : protocolRmse(score.val_sse, score.val_points, score.val_failed),
  });
  const rows = drift.protocols.map((name) => {
    const i = simulation.protocols.findIndex((p) => p.name === name);
    return {
      name,
      stored: rmses(fit?.scores[i]),
      redrawn: rmses(simulation.protocols[i]?.score),
    };
  });
  const pair = (r: { train: number | null; val: number | null }) => (
    <span role="cell" className="sp-dv">
      <span>
        train <span className="mono">{rmseOr(r.train)}</span>
      </span>
      {validation && (
        <span>
          val <span className="mono">{rmseOr(r.val)}</span>
        </span>
      )}
    </span>
  );
  return (
    <div className="sp-dnote" role="note" aria-label="Drift">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 4.6v4.4" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="11.3" r="0.9" fill="currentColor" />
      </svg>
      <div className="sp-dsay">
        <p>
          Drawn by this computer’s engine{drawn === undefined ? "" : `, ICMM ${drawn}`}: its errors
          for <ProtocolNames names={drift.protocols} /> differ from the stored ones
          {scored === undefined ? "" : `, which ICMM ${scored} scored`}. The tiles, the cards and
          the rank use the stored ones.
        </p>
        <div
          className="sp-dtab"
          role="table"
          aria-label={`Stored and redrawn RMSE of ${drift.protocols.join(", ").replace(/, ([^,]*)$/, " and $1")}`}
        >
          <div role="row" className="sp-dth">
            <span role="columnheader">Protocol</span>
            <span role="columnheader">Stored{scored === undefined ? "" : ` · ICMM ${scored}`}</span>
            <span role="columnheader">Redrawn{drawn === undefined ? "" : ` · ICMM ${drawn}`}</span>
          </div>
          {rows.map((r) => (
            <div key={r.name} role="row">
              <span role="rowheader" className="sp-dpr">
                {r.name}
              </span>
              {pair(r.stored)}
              {pair(r.redrawn)}
            </div>
          ))}
        </div>
      </div>
      {saved !== undefined && (
        <button
          type="button"
          className="icon-btn btn-sm sp-dx"
          aria-label="Dismiss the drift notice"
          ref={dismiss}
          onClick={() => change(true)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 3l6 6M9 3 3 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

const rmseOr = (x: number | null) => (x === null ? "—" : rmse(x));

/** The ⓘ a note leads with. */
function InfoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 3.8v4M7 9.6v.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** A card's words: its protocol's name, its template, and its RMSEs. */
function CardWords({
  name,
  label,
  train,
  val,
  validation,
}: {
  name: string;
  label?: string;
  train: number | null;
  val: number | null;
  validation: boolean;
}) {
  return (
    <span className="sp-cardwords">
      <span className="sp-stem">
        <span className="mono">{name}</span>
      </span>
      {label !== undefined && <span className="sp-proto">{label}</span>}
      <span className="sp-rmses">
        <span>
          train <span className="mono">{rmseOr(train)}</span>
        </span>
        {validation && (
          <span>
            val <span className="mono sp-val">{rmseOr(val)}</span>
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * A protocol's card: its fit, small, over its words. A finished start's
 * cards are buttons that choose the protocol its inspector draws.
 */
function FitCard({
  card,
  validation,
  so,
  n,
  pressed,
  onPress,
}: {
  card: Card;
  validation: boolean;
  so: boolean;
  n: number;
  /** Whether it's the chosen one, on a finished start's page; else it's a figure. */
  pressed: boolean | undefined;
  onPress: () => void;
}) {
  const { protocol } = card;
  const fit = fitOf(protocol.points, card.line ?? [], protocol.interpolation.log_x, {
    validation,
  });
  const aria =
    `${protocol.name}, ${card.label}: ` +
    (card.line === undefined
      ? "its data; the simulation draws once it's read"
      : `simulated with start ${n}’s best parameters${so ? " so far" : ""} over the data`) +
    `; train RMSE ${rmseOr(card.train)}${validation ? `, val RMSE ${rmseOr(card.val)}` : ""}`;
  const inner = (
    <>
      <span className="sp-plot">
        <svg
          className="fluid"
          width="100%"
          height={FIT.height}
          viewBox={`0 0 ${FIT.width} ${FIT.height}`}
          preserveAspectRatio="none"
          fill="none"
          aria-hidden="true"
        >
          <path className="sp-grid" d={fit.grid} />
          <path className="sp-base" d={fit.base} />
          <path className="sp-whisk" d={fit.whiskers} />
          <path className="sp-model" d={fit.model} />
          <path className="sp-k-dot" d={fit.dots} />
          <path className="sp-k-ring" d={fit.rings} />
          <path className="sp-k-dot" d={fit.diamonds} />
          <path className="sp-k-ring" d={fit.hollow} />
        </svg>
        <Labels labels={fit.labels} />
      </span>
      <CardWords
        name={protocol.name}
        label={card.label}
        train={card.train}
        val={card.val}
        validation={validation}
      />
    </>
  );
  return pressed === undefined ? (
    <figure className="sp-card" role="img" aria-label={aria}>
      {inner}
    </figure>
  ) : (
    <button
      type="button"
      className="sp-card sp-pcard"
      aria-pressed={pressed}
      aria-label={aria}
      onClick={onPress}
    >
      {inner}
    </button>
  );
}

// ── Parameters ────────────────────────────────────────────────────────────────────────────────

/** A vector the parameters show: this start's, or one of the Top 10's. */
interface Shown {
  start: number;
  best: readonly number[];
  me: boolean;
}

function ParametersSection({
  run,
  start,
  startRef,
  best,
  short,
  done,
  isBest,
  spreads,
  title,
}: {
  run: Run;
  start: Start;
  startRef: StartRef;
  best: number[] | null;
  short: boolean;
  /** Finished: the Best start's are drawn as its Result drew them, with each part's Spread. */
  done: boolean;
  isBest: boolean;
  /** Each part's spread over the Top 10, as its topology has them. */
  spreads: readonly (number | null)[] | undefined;
  title: string;
}) {
  const n = start.start;
  const bounds = run.settings?.bounds;
  const top = start.top_10;
  const items = useMemo(
    (): Shown[] =>
      best === null
        ? []
        : [
            { start: n, best, me: true },
            ...top.map((s) => ({ start: s.start, best: s.best, me: false })),
          ],
    [best, top, n],
  );
  const shown = useCanonicalParameters<Shown>(
    best !== null && bounds !== undefined
      ? {
          numStates: run.num_states,
          graph: startRef.graph,
          openState: startRef.openState,
          bounds,
          items,
          raw: (s) => s.best,
        }
      : undefined,
  );
  const whose = done ? `start ${n}’s parameters` : `start ${n}’s best${short ? "" : " so far"}`;
  const bestStart = top[0]?.start;
  let body: ReactNode;
  let sub: ReactNode = null;
  if (best === null) {
    body = (
      <div className="sp-empty short">
        <p>Its parameters show here once its first generation is logged.</p>
      </div>
    );
  } else if (bounds === undefined) {
    body = (
      <p className="topo-tempty">
        #{run.id} was submitted by a newer ICMM, so its parameters can’t be drawn here.
      </p>
    );
  } else if (shown.kind === "failed") {
    body = <p className="topo-tempty">{shown.error.message}</p>;
  } else if (shown.kind === "pending") {
    body = <p className="sp-reading">Reading its parameters…</p>;
  } else {
    const rows = parameterRows(run.num_states, startRef.openState, shown.edges);
    const mine = shown.shown.find((s) => s.item.me)!.values;
    const tops = shown.shown.filter((s) => !s.item.me).map((s) => s.values);
    const open = new Set([2 * startRef.openState, 2 * startRef.openState + 1]);
    const parts = Array.from({ length: rows.count }, (_, i) => i).filter((i) => !open.has(i));
    const bands = new Map(
      parts.map((i) => [
        i,
        bandOf(
          mine[i],
          tops.map((v) => v[i]),
          shown.ranges[i],
        ),
      ]),
    );
    const outside = [...bands.values()].filter((b) => b.outside).length;
    // A start in the Top 10 is inside its range, so it isn't counted against it (#360, RF23).
    const inTop = top.some((s) => s.start === n);
    sub = isBest ? (
      <>
        <span className="n">{rows.count}</span> · <span className="mono">ln</span> units and mV ·
        read relative to open state <span className="n">{startRef.openState}</span>, with
        b&#160;&gt;&#160;0
      </>
    ) : tops.length > 0 ? (
      <>
        {whose}, against {title}’s top 10 by Train RMSE
        {!inTop && (
          <>
            {" "}
            · <span className="n">{outside}</span> of <span className="n">{parts.length}</span>{" "}
            outside it
          </>
        )}{" "}
        · read relative to open state <span className="n">{startRef.openState}</span>, with
        b&#160;&gt;&#160;0
      </>
    ) : (
      <>
        {whose} · none of {title}’s starts has finished to read it against · read relative to open
        state <span className="n">{startRef.openState}</span>, with b&#160;&gt;&#160;0
      </>
    );
    const strip = (p: PartRef, range: ParameterRange, inline = false) => {
      const b = bands.get(p.index)!;
      const v = mine[p.index];
      return (
        <>
          <span className="vnum">{fixed(v, p.mV ? 1 : 3)}</span>
          {inline && <span className="sp-end lo">{fixed(range.min, 0)}</span>}
          <Strip band={b} name={p.name} me={!isBest} />
          {inline && <span className="sp-end">{fixed(range.max, 0)}</span>}
          {isBest ? (
            <span className="sp-out sp-spread">{spreadWords(spreads?.[p.index])}</span>
          ) : (
            <span className="sp-out">{b.outside ? "outside" : ""}</span>
          )}
        </>
      );
    };
    const a = mine[rows.a.index];
    const bOf = mine[rows.b.index];
    const curve = curveOf(a, bOf);
    body = (
      <>
        <div className="sp-key" aria-hidden="true">
          {!isBest && (
            <span>
              <span className="sp-mdot" />
              start {n}
            </span>
          )}
          {tops.length > 0 && (
            <>
              <span>
                <span className="sp-sw tick" />
                start {bestStart} · best start
              </span>
              <span>
                <span className="sp-sw band" />
                range of the top 10 by Train RMSE
              </span>
            </>
          )}
        </div>
        <ParameterRows
          rows={rows}
          ranges={shown.ranges}
          label={`Parameters of start ${n} against ${title}’s top 10`}
          openNote={
            <>
              <b>Open state</b> · the reference: its favorability and voltage sensitivity are{" "}
              <span className="n">0</span>, and every other state’s are read against them.
            </>
          }
          columns="72px minmax(0, 1fr) 52px"
          before={1}
          after={
            isBest
              ? ["Spread"]
              : [
                  <span key="note" className="sr-only">
                    Note
                  </span>,
                ]
          }
          roomy
          part={(p, range) => strip(p, range)}
          curve={
            <div role="row" className="sp-curve">
              <div role="cell" className="sp-curvebox">
                <svg
                  width={CURVE.width}
                  height={CURVE.height}
                  viewBox={`0 0 ${CURVE.width} ${CURVE.height}`}
                  fill="none"
                  role="img"
                  aria-label={curve.aria}
                >
                  <path className="sp-cband" d={curve.band} />
                  <path className="sp-base" d={curve.axis} />
                  <path className="sp-now" d={curve.mid} />
                  <path className="sp-ccurve" d={curve.curve} />
                </svg>
                <Labels labels={curve.labels} />
              </div>
              <div role="cell" className="sp-ab">
                {[rows.a, rows.b].map((p) => (
                  <div key={p.name} className="sp-abrow">
                    <span className="pn">{p.name}</span>
                    {strip(p, shown.ranges[p.index], true)}
                  </div>
                ))}
              </div>
            </div>
          }
        />
        <p className="hint sp-pmhint">
          {isBest ? (
            <ReadingHint
              favorability={shown.ranges[2 * (startRef.openState === 0 ? 1 : 0)].max}
              b={shown.ranges[rows.b.index].max}
            />
          ) : done ? (
            `Outside the top-10 range can mean start ${n} found a different optimum, or that the fit barely depends on that parameter.`
          ) : short ? (
            `Outside the top-10 range can mean start ${n} was heading for a different optimum, or hadn’t settled when it ended.`
          ) : (
            `Outside the top-10 range can mean start ${n} is heading for a different optimum, or that the fit barely depends on that parameter: the search keeps trying such a parameter across its range while the RMSE stays put.`
          )}
        </p>
      </>
    );
  }
  return (
    <section className="sp-sec">
      <div className="topo-h">
        <h2 className="label">Parameters</h2>
        {sub !== null && <span className="topo-hint">{sub}</span>}
      </div>
      {body}
    </section>
  );
}

/**
 * How the Best start's parameters read, as its Result said it: what a
 * favorability and a speed are at the half-way voltage, and how far each can
 * reach, `favorability` either way from the open state's and `b` up to its own.
 */
function ReadingHint({ favorability, b }: { favorability: number; b: number }) {
  return (
    <>
      At the half-way voltage, favorability is <span className="mono">ln</span>(P<sub>i</sub> / P
      <sub>open</sub>) at steady state, and speed is <span className="mono">ln</span>(k
      <sub>i→j</sub> · k<sub>j→i</sub>); away from it, each moves by up to its voltage sensitivity.
      Favorabilities are differences from the open state, so each can reach{" "}
      <span className="nw">
        <span className="n">±{fixed(favorability, 0)}</span>;
      </span>{" "}
      b shows positive, so it can reach{" "}
      <span className="nw">
        <span className="n">{fixed(b, 0)}</span>.
      </span>
    </>
  );
}

/**
 * A part's strip: its range's ends and middle, the Top 10's band, the best
 * start's tick, and this start's dot, unless it's the best start, on its tick.
 */
function Strip({
  band: b,
  name,
  me = true,
}: {
  band: ReturnType<typeof bandOf>;
  name: string;
  me?: boolean;
}) {
  return (
    <span className="sp-strip" title={name}>
      <span className="ax" />
      <span className="e0" />
      <span className="e1" />
      <span className="md" />
      {b.band !== undefined && (
        <span
          className="bd"
          style={{ left: `${b.band.left}%`, width: `max(3px, ${b.band.width}%)` }}
        />
      )}
      {b.tick !== undefined && <span className="tk" style={{ left: `calc(${b.tick}% - 1px)` }} />}
      {me && <span className="sp-mdot" style={{ left: `calc(${b.me}% - 5px)` }} />}
    </span>
  );
}

// ── the aside ─────────────────────────────────────────────────────────────────────────────────

/** A finished start's topology, drawn over its facts, with the way to its page. */
function TopologyBox({
  run,
  startRef,
  graph,
  title,
}: {
  run: Run;
  startRef: StartRef;
  graph: StateGraph | undefined;
  title: string;
}) {
  const n = run.num_states;
  const edges = graph?.edges.length;
  const laid = useMemo(
    () => (graph === undefined ? [] : [{ numStates: n, edges: graph.edges }]),
    [n, graph],
  );
  const spots = useLayouts(laid)?.[0];
  const segment = `T${startRef.graph}.${startRef.openState}`;
  return (
    <section className="sp-asec sp-topo">
      <div className="sp-topohead">
        <h2 className="label">Topology</h2>
        <Link
          to="/runs/$id/$topology"
          params={{ id: String(run.id), topology: segment }}
          className="link"
          aria-label={`Open ${title}`}
        >
          Open <span className="mono">{title}</span>
        </Link>
      </div>
      <div className="topo-sbox">
        {graph !== undefined && spots !== undefined && (
          <TopologyDrawing
            graph={graph}
            spots={spots}
            open={startRef.openState}
            size={TOPOLOGY_PAGE}
            label={`${title}: ${count(n, "state")}, ${count(graph.edges.length, "transition")}, open state ${startRef.openState}.`}
          />
        )}
      </div>
      <p className="topo-cap">
        <span className="mono">{segment}</span> · open state{" "}
        <span className="n">{startRef.openState}</span> · <span className="n">{n}</span> states
        {edges !== undefined && (
          <>
            {" "}
            · <span className="n">{edges}</span> {edges === 1 ? "transition" : "transitions"} ·{" "}
            <span className="n">{2 * n + 2 * edges + 2}</span> parameters
          </>
        )}
      </p>
    </section>
  );
}

function ClusterBox({ phase, c, readAt }: { phase: Phase; c: StartContext; readAt: number }) {
  const box = clusterOf(phase, c, readAt);
  return (
    <section className="sp-asec">
      <div className="topo-h">
        <h2 className="label">{box.title}</h2>
        <span className="topo-hint">{box.asOf}</span>
      </div>
      <dl className="kv sp-kv">
        {box.rows.map((r) => (
          <div key={r.k} className="sp-kvrow">
            <dt>{r.k}</dt>
            <dd>
              <span>
                <Said parts={r.parts} />
              </span>
              {r.bar !== undefined && (
                <span className="sp-bar mem">
                  <span
                    className="sp-fill ended"
                    style={{ width: `${(r.bar * 100).toFixed(1)}%` }}
                  />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RatesBox({
  numStates,
  startRef,
  best,
  whose,
}: {
  numStates: number;
  startRef: StartRef;
  best: number[];
  whose: string;
}) {
  const [typed, setTyped] = useState("0");
  const [voltage, setVoltage] = useState(0);
  const rates = useEdgeRates(
    { numStates, graph: startRef.graph, openState: startRef.openState },
    best,
    voltage,
  );
  const at = Number(typed.replace("−", "-"));
  const valid = typed.trim() !== "" && Number.isFinite(at);
  return (
    <section className="sp-asec sp-rates">
      <div className="sp-rhead">
        <h2 className="label">Rates</h2>
        <label className="sp-at">
          at{" "}
          <input
            className="input input-sm mono"
            value={typed}
            aria-label="Voltage, mV"
            aria-invalid={!valid || undefined}
            inputMode="decimal"
            onChange={(e) => {
              setTyped(e.target.value);
              const v = Number(e.target.value.replace("−", "-"));
              if (e.target.value.trim() !== "" && Number.isFinite(v)) setVoltage(v);
            }}
          />{" "}
          mV
        </label>
      </div>
      {rates.isError ? (
        <p className="topo-tempty">{(rates.error as unknown as WireError).message}</p>
      ) : (
        <div
          role="table"
          aria-label={`Each edge’s rates at ${voltage} mV, in ms⁻¹`}
          className="sp-rtable"
        >
          <div role="row" className="sp-rrow sp-rh">
            <span role="columnheader" className="th">
              Edge
            </span>
            <span role="columnheader" className="th sp-num">
              i → j
            </span>
            <span role="columnheader" className="th sp-num">
              j → i
            </span>
          </div>
          {(rates.data?.rates ?? []).map((r) => (
            <div role="row" key={`${r.i}-${r.j}`} className="sp-rrow">
              <span role="rowheader" className="prm-label">
                <EdgeGlyph i={r.i} j={r.j} open={startRef.openState} />
              </span>
              <span role="cell" className="vnum sp-num">
                {rateWords(r.i_to_j)}
              </span>
              <span role="cell" className="vnum sp-num">
                {rateWords(r.j_to_i)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">In ms⁻¹, from {whose}; i is the lower-numbered state.</p>
    </section>
  );
}

function LogSection({
  c,
  phase,
  logs,
}: {
  c: StartContext;
  phase: Phase;
  logs: { id: string; topology: string; start: string };
}) {
  const n = c.start.start;
  const { head, lines } = logTail(c.points, c.run.validation);
  return (
    <section className="sp-asec">
      <div className="topo-h sp-loghead">
        <h2 className="label">Log</h2>
        <span className="topo-hint">last {lines.length || 8} lines</span>
        {lines.length > 0 && (
          <Link to="/runs/$id/$topology/$start/logs" params={logs} className="btn btn-sm">
            Open full log
          </Link>
        )}
      </div>
      {lines.length > 0 ? (
        <div className="sp-log" role="log" aria-label={`The last lines of the start ${n} log`}>
          <span className="lh">{head}</span>
          {lines.map((l, i) => (
            <span key={i} className={i === lines.length - 1 ? "now" : undefined}>
              {l}
            </span>
          ))}
        </div>
      ) : (
        <div className="sp-empty short">
          <p>
            {endedShort(phase)
              ? phase === "error"
                ? "Nothing logged: the end of its job log is under Why it failed."
                : "Nothing logged."
              : "Nothing logged yet."}
          </p>
        </div>
      )}
    </section>
  );
}
