/**
 * Run detail (LaptopRunDetail, #232, #237), at `/runs/<id>`: where Submit
 * lands once a run is accepted, and where Runs' rows lead. It's headed
 * `#214 herg-wt-11state` with the run's state above and its facts line under;
 * its actions sit at the right: Resume (on a failed or canceled run) beside
 * Submit again…, and ··· with Copy run path, Export its config…, Report a
 * problem… (#470), whose panel opens under the head, Cancel run… while it's
 * in flight and Delete run… once it has ended. Under the heading: the run's facts, its
 * stages, with the share of its finished starts still improving under them
 * while Mark still-improving starts is on (#234), the box that says what's on
 * the cluster now, why it waits or why it stopped, the grid of its topologies
 * with its progress chart, and its ranked topologies. Past 2,000 topologies
 * (#291) the grid is a bar of its counts, with the chart under it at the
 * page's width from its stretches, and the page reads only the topologies it
 * names, those fitting, next and failed, never every one in the order sent.
 *
 * The change feed's `runs` reads it all again. Not connected, the page it
 * last read stays, as of when the connection went, its glyphs still; a run
 * this platform doesn't have says so.
 */
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import {
  boxOf,
  cancelWords,
  chartOf,
  deleteWords,
  earlierOf,
  factsOf,
  gridOf,
  improvingNote,
  paceOf,
  pastSquares,
  phaseOf,
  queuedOf,
  runEtaOf,
  spreadOf,
  stagesOf,
  stopped,
  submitTotalOf,
  topologyBarOf,
  topologyId,
  topologyKey,
  wideChartOf,
  type Phase,
} from "../runs/detail";
import {
  useFailedCauses,
  useRevision,
  useRunStretches,
  useTopologies,
  useTopology,
  type Revision,
  type Topologies,
} from "../runs/detailQueries";
import { useEtas, useTick } from "../runs/queries";
import { useResume, useRunWrite } from "../runs/resume";
import { RunMenu } from "../runs/RunMenu";
import { configJson } from "../runs/configFile";
import { FileIn } from "../export/Exported";
import { fileStem } from "../export/names";
import { useSave, type Saving } from "../export/useSave";
import {
  RunBox,
  RunFacts,
  Stages,
  StillImproving,
  UnreadableLine,
  type LiveCards,
} from "../runs/RunParts";
import {
  ProgressChart,
  RankedTopologies,
  SpreadPlot,
  TopologyBar,
  TopologyGrid,
} from "../runs/RunTopologies";
import { topologyName, waitingOf } from "../runs/words";
import { FailureBox } from "../setup/FailureBox";
import { useOpened } from "../shell/palette/recents";
import { Reading } from "../setup/PlatformSetup";
import { usePreferences } from "../settings/preferences";
import { inSentence } from "../setup/form";
import { canAsk, usePlatformSettings, useReadAgain, useSchedulerLookup } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { aboutWords, startOverheadS } from "../submit/estimate";
import { useKept } from "../submit/kept";
import { slurmOf } from "../submit/plan";
import { useInFlightRuns, useRun, useRunTimings, useUserJobs } from "../submit/queries";
import { runGlyph } from "../submit/words";
import { useStateGraphs } from "../topology/queries";
import { useBlocker } from "../ui/blocker";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PageHeading } from "../ui/PageHeading";
import { PAGE_HEADING_ATTR } from "../ui/pageChangeFocus";
import { WorkingButton } from "../ui/WorkingButton";
import { submitted, useReportFromHere } from "../report/fromHere";
import { useReport } from "../report/useReport";
import type { Working } from "../ui/working";
import type {
  FailedStarts,
  JobDefaults,
  Run,
  RunStretches,
  RunSummary,
  RunTiming,
  SavedPlatform,
  StateGraph,
  Topology,
  WireError,
} from "../wire/types.gen";
import { useShownPath } from "../ui/paths";
import { commands } from "../wire/api.gen";
import { ReportFromHere } from "../report/ReportFromHere";

/** No runs, the same array each render. */
const NO_RUNS: RunSummary[] = [];

type Platform = Pick<SavedPlatform, "type" | "name">;

/** A run's number from the path, or `undefined` when it isn't one. */
function numberOf(param: string): number | undefined {
  const id = /^[1-9]\d*$/.test(param) ? Number(param) : undefined;
  return id !== undefined && Number.isSafeInteger(id) ? id : undefined;
}

/** What the page shows, read whole: kept as of the connection's end while it's gone. */
interface Reads {
  run: Run;
  /** Every topology in the order sent; past 2,000, only those fitting, next and failed. */
  sent: Topologies;
  /** Past 2,000 topologies, its stretches, for the chart. */
  stretches: RunStretches | undefined;
  ranked: Topologies;
  fitting: Topology | undefined;
  job: JobDefaults | undefined;
  partition: string | null;
  limit: number | null | undefined;
  jobs: number | undefined;
  inFlight: RunSummary[] | undefined;
  timings: RunTiming[] | undefined;
  revision: Revision;
  graphs: ReadonlyMap<number, StateGraph> | undefined;
  causes: Map<string, FailedStarts[]>;
}

/**
 * `value`, or the one before when `key` says it holds the same: so a read
 * remade at each render (a Map, an object of reads) is the same view, and
 * the page's kept reads (`useKept`) only move when what they hold does.
 */
function useSameBy<T>(value: T, key: (v: T) => string): T {
  const [kept, setKept] = useState<{ value: T; key: string }>(() => ({ value, key: key(value) }));
  const k = key(value);
  if (k !== kept.key) {
    setKept({ value, key: k });
    return value;
  }
  return kept.value;
}

/** How often a going run's page reads the time. */
const GOING_TICK_MS = 5_000;

/** How many ranked topologies' state graphs are read, for the table's Params as a filter moves. */
const GRAPHS_READ = 40;

export function RunPage() {
  const { id: param } = useParams({ from: "/runs/$id" });
  const id = numberOf(param);
  const c = useConnection();
  const platform = useActivePlatform();
  const live = c.status === "connected" || c.status === "reconnecting";

  const runQ = useRun(id);
  const run = runQ.data;
  useOpened(run === undefined ? undefined : { kind: "run", run: run.id, name: run.config.name });
  const settingsQ = usePlatformSettings();
  const job = settingsQ.data?.saved?.settings.job_defaults;
  const slurm = platform === undefined ? false : slurmOf(job, platform);
  const lookupQ = useSchedulerLookup(slurm);
  const jobsQ = useUserJobs(slurm);
  const inFlightQ = useInFlightRuns();
  const timingsQ = useRunTimings();
  const many = run !== undefined && pastSquares(run);
  const sentQ = useTopologies(run === undefined || many ? undefined : id, "sent");
  const rankQ = useTopologies(run === undefined ? undefined : id, "rank");
  // Past 2,000, only the topologies the page names: those fitting, failed, and the next.
  const fittingListQ = useTopologies(many ? id : undefined, "sent", "fitting");
  const failedListQ = useTopologies(many ? id : undefined, "sent", "failed");
  const going = run !== undefined && !stopped(phaseOf(run));
  // Every few seconds while it goes, so pace and ETA don't jump a minute at a time (#538).
  const now = useTick(going ? GOING_TICK_MS : 60_000);
  const nextListQ = useTopologies(many && going ? id : undefined, "sent", "next", 1);
  const stretchesQ = useRunStretches(many ? id : undefined);
  const listed = useMemo((): Topologies | undefined => {
    if (!many) return sentQ.data;
    const next = going ? nextListQ.data : { topologies: [], ranked: 0, more: false };
    if (fittingListQ.data === undefined || failedListQ.data === undefined || next === undefined) {
      return undefined;
    }
    const named = [
      ...fittingListQ.data.topologies,
      ...failedListQ.data.topologies,
      ...next.topologies.slice(0, 1),
    ].sort((x, y) => x.position - y.position);
    return { topologies: named, ranked: fittingListQ.data.ranked, more: true };
  }, [many, going, sentQ.data, fittingListQ.data, failedListQ.data, nextListQ.data]);
  const lists = many ? [fittingListQ, failedListQ, nextListQ, stretchesQ] : [sentQ];
  const sent = listed?.topologies;
  const fittingNow = useMemo(
    () => (sent ?? []).filter((t) => t.state === "fitting").at(-1),
    [sent],
  );
  const fittingQ = useTopology(fittingNow === undefined ? undefined : id, fittingNow);
  const failed = useMemo(() => (sent ?? []).filter((t) => t.state === "failed"), [sent]);
  const causes = useSameBy(useFailedCauses(id, failed), (m) => JSON.stringify([...m]));
  const revision = useSameBy(useRevision(run?.dataset), (r) => JSON.stringify(r));
  const graphIds = useMemo(
    () => [
      ...(rankQ.data?.topologies ?? []).slice(0, GRAPHS_READ).map((t) => t.graph),
      ...failed.map((t) => t.graph),
    ],
    [rankQ.data, failed],
  );
  const graphs = useSameBy(
    useStateGraphs(run?.num_states ?? 0, run === undefined ? [] : graphIds),
    (m) => (m === undefined ? "" : JSON.stringify([...m])),
  );

  const partition =
    job?.type === "slurm"
      ? (job.partition ?? lookupQ.data?.slurm?.default_partition ?? null)
      : null;
  const limit =
    !slurm || lookupQ.data === undefined
      ? undefined
      : partition === null
        ? null
        : (lookupQ.data.slurm?.partitions.find((p) => p.name === partition)?.max_jobs_per_user ??
          null);
  const reads: Reads | undefined =
    run === undefined ||
    listed === undefined ||
    rankQ.data === undefined ||
    (many && stretchesQ.data === undefined)
      ? undefined
      : {
          run,
          sent: listed,
          stretches: many ? stretchesQ.data : undefined,
          ranked: rankQ.data,
          fitting: fittingQ.data,
          job,
          partition,
          limit,
          jobs: jobsQ.data?.jobs?.running,
          inFlight: inFlightQ.data,
          timings: timingsQ.data?.timings,
          revision,
          graphs,
          causes,
        };
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
  const failedRead = [runQ, ...lists, rankQ].find((q) => q.isError)?.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failedRead !== undefined
      ? (failedRead as unknown as WireError)
      : undefined,
    () => Promise.all([runQ, ...lists, rankQ].map((q) => q.refetch())),
  );
  const failure = useHeldFailure(
    read.failure,
    [runQ, ...lists, rankQ].some((q) => q.isFetching),
    param,
    reads !== undefined || !live,
  );
  const shown = kept.value;

  // Reads run only while connected: reconnecting with nothing kept, it says when it shows (KF17).
  if (platform === undefined || (!canAsk(c) && shown === undefined)) {
    return (
      <Frame id={param}>
        <ShowOnceConnected platform={platform} kind="Runs" one>
          this run
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (id === undefined) return <NotHere platform={platform} />;
  if (shown !== undefined) {
    return (
      <Detail
        reads={shown}
        platform={platform}
        slurm={slurm}
        now={now}
        asOf={kept.asOf}
        live={live}
      />
    );
  }
  if (failure?.code === "not_found") return <NotHere platform={platform} />;
  if (failure !== undefined) {
    return (
      <Frame id={param}>
        <FailureBox
          error={failure}
          task="run"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      </Frame>
    );
  }
  return (
    <Frame id={param}>
      <Reading>
        {/* One flex item, so the number sits in the sentence. */}
        <span>
          Reading run <span className="mono">#{param}</span> on {inSentence(platform)}…
        </span>
      </Reading>
    </Frame>
  );
}

/** The page's head before the run is read: the breadcrumb and its number. */
function Frame({ id, children }: { id: string; children?: React.ReactNode }) {
  return (
    <div className="page rd">
      <section className="ds-head">
        <Crumbs id={id} />
        <PageHeading>
          <span className="title-id rd-quiet-id">#{id}</span>
        </PageHeading>
      </section>
      <ReportFromHere name={`#${id}`} mono />
      {children}
    </div>
  );
}

function Crumbs({ id }: { id: string }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/runs" className="link">
        Runs
      </Link>
      <span aria-hidden="true">/</span>
      <span className="mono" aria-current="page">
        #{id}
      </span>
    </nav>
  );
}

/** A run this platform doesn't have: deleted, or never submitted here, or not a number. */
function NotHere({ platform }: { platform: Platform }) {
  return (
    <div className="page">
      <PageHeading>Run not found</PageHeading>
      <p className="facts">This run isn’t on {inSentence(platform)} any more.</p>
      <ReportFromHere name="Run not found" />
      <p>
        <Link to="/runs" className="link">
          Go to Runs
        </Link>
      </p>
    </div>
  );
}

/** The state above the heading: its glyph and word, Canceling and Resuming while they act. */
function stateOf(r: Run, phase: Phase): { glyph: string; word: string; failed: boolean } {
  if (phase === "canceling") return { glyph: "g g-busy", word: "canceling", failed: false };
  if (phase === "resuming") return { glyph: "g g-busy", word: "resuming", failed: false };
  return { glyph: runGlyph(r.state), word: r.state, failed: r.state === "failed" };
}

/** Resume while it resumes: its working state, held until a coordinator takes the run up. */
const RESUMING: Working = {
  busy: () => true,
  pending: true,
  shown: true,
  run: () => new Promise(() => {}),
};

function Detail({
  reads,
  platform,
  slurm,
  now,
  asOf,
  live,
}: {
  reads: Reads;
  platform: Platform;
  slurm: boolean;
  now: number;
  asOf: number | undefined;
  live: boolean;
}) {
  const r = reads.run;
  const many = pastSquares(r);
  const c = useConnection();
  // Paths as This computer's OS writes them, on Windows in full (#326).
  const shownPath = useShownPath(platform);
  const folder = shownPath(r.folder);
  const navigate = useNavigate();
  // The heading Submit and Runs land on is the reading frame's, which this one replaces: focus
  // that went with it comes to this one (old ADR-0029).
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) {
      document.querySelector<HTMLElement>(`[${PAGE_HEADING_ATTR}]`)?.focus();
    }
  }, []);
  const phase = phaseOf(r);
  // Delete run… once it has ended, and while it resumes (gray then); Cancel run… before.
  const ended = stopped(phase);
  const resume = useResume(r.id, platform.name);
  const state = stateOf(r, phase);
  const sent = reads.sent.topologies;
  const inFlight = reads.inFlight ?? [];
  // A queued run on This computer starts around when the run holding its slots ends (#399, HF10).
  const etas = useEtas(phase === "waiting" && !slurm ? inFlight : NO_RUNS, asOf ?? now);
  const engineNow = c.status === "connected" ? c.engineVersion : null;

  // The numbers are as of `asOf` while the connection is away: the pace and the ETA are held
  // there, rather than sliding as if the run had stood still (#326).
  const pace = paceOf(r, asOf ?? now);
  const overheadS = reads.job === undefined ? undefined : startOverheadS(reads.job);
  const eta = runEtaOf(r, {
    timings: reads.timings ?? [],
    cpus: reads.job?.cpus_per_start,
    cap: reads.job?.max_running_starts,
    overheadS,
    now: asOf ?? now,
  });
  const total = submitTotalOf(r, {
    timings: reads.timings,
    job: reads.job,
    overheadS: overheadS ?? 0,
  });
  // No finished runs here at its states and CPUs: its ETA waits for its own pace (#542).
  const untimed =
    reads.timings !== undefined &&
    reads.job !== undefined &&
    r.settings !== null &&
    total === undefined;

  const fitting = sent.filter((t) => t.state === "fitting").at(-1);
  const rest =
    fitting === undefined
      ? 0
      : Math.max(
          0,
          fitting.starts - fitting.starts_finished - fitting.starts_failed - fitting.starts_running,
        );
  const queued = queuedOf(r.id, fitting, reads.fitting);
  // Past 2,000 the page doesn't read every topology, so it can't say which went first or failed.
  const first = many ? undefined : sent.find((t) => t.starts_finished < t.starts);
  const withFailures = many ? [] : sent.filter((t) => t.starts_failed > 0);
  const failed = sent.filter((t) => t.state === "failed");
  const waiting = sent.filter((t) => t.state === "next");
  const p = r.progress;
  const notSent = Math.max(
    0,
    p.topologies - p.topologies_complete - p.topologies_failed - p.topologies_fitting,
  );
  const nextIn =
    pace === undefined || fitting === undefined || rest === 0
      ? undefined
      : `in ${aboutWords((rest * pace) / Math.max(1, fitting.starts))}`;

  const around = {
    platform,
    slurm,
    partition: reads.partition,
    cap: reads.job?.max_running_starts,
    jobs: reads.jobs,
    inFlight,
    allInFlight: reads.inFlight,
    shownPath,
    etas,
  };
  const box = boxOf(r, {
    platform,
    slurm,
    job: reads.job,
    partition: reads.partition,
    jobs: reads.jobs,
    limit: reads.limit,
    inFlight,
    queued,
    firstUnfinished:
      first === undefined
        ? undefined
        : { name: topologyName(r.id, first), starts: first.starts - first.starts_finished },
    waiting: phase === "waiting" ? waitingOf(r, around, now) : undefined,
    failedIn: withFailures.length === 1 ? topologyName(r.id, withFailures[0]) : undefined,
    replacedEngine: resume.replied?.id === r.id ? resume.replied.replaced_engine : undefined,
    engineNow,
    now,
    asOf,
  });
  const cards: LiveCards | undefined =
    box?.live && fitting !== undefined
      ? {
          run: r.id,
          firstRunningAt: r.first_running_at,
          fitting,
          detail: reads.fitting,
          next: waiting[0],
          nextIn,
          waiting: Math.max(0, notSent - 1),
          earlier: earlierOf(sent, fitting),
          slurm,
          now,
        }
      : undefined;
  const stages = stagesOf(r, {
    platform,
    slurm,
    partition: reads.partition,
    inFlight,
    cap: reads.job?.max_running_starts,
    allInFlight: reads.inFlight,
    eta,
    total: total?.seconds,
    untimed,
    now,
  });
  const rankOf = useMemo(
    () =>
      new Map(
        reads.ranked.topologies
          .filter((t) => t.best !== null)
          .map((t, i) => [topologyKey(t), i + 1]),
      ),
    [reads.ranked],
  );
  const grid = useMemo(() => (many ? undefined : gridOf(r, sent, rankOf)), [many, r, sent, rankOf]);
  const chartAround = { eta, pace, total, untimed, slurm, on: `on ${inSentence(platform)}`, now };
  const chart =
    many && reads.stretches !== undefined
      ? wideChartOf(r, reads.stretches, chartAround)
      : chartOf(r, sent, chartAround);
  const spread = useMemo(
    () => spreadOf(r, reads.ranked.topologies, reads.ranked.ranked),
    [r, reads.ranked],
  );
  const facts = factsOf(r, { eta, total: total?.seconds, untimed, now, asOf });
  const marking = usePreferences().data?.mark_still_improving === true;
  const improving = marking ? improvingNote(r, phase) : undefined;

  // The writes.
  const menuButton = useRef<HTMLButtonElement>(null);
  const saving = useSave();
  const [asking, setAsking] = useState<"cancel" | "delete" | undefined>();
  const cancel = useRunWrite("cancel", r.id, platform.name);
  const del = useRunWrite("delete", r.id, platform.name, () => {
    setAsking(undefined);
    void navigate({ to: "/runs" });
  });
  const offline = useBlocker(live ? undefined : `Connect to ${inSentence(platform)} to resume`);
  // Report a problem… from its ··· or ⌘K (#470): the run and its config.
  const report = useReport({
    key: `run ${r.id}`,
    look: "page",
    page: {
      kind: "run",
      row: (
        <>
          <span className="mono">#{r.id}</span> <span className="mono">{r.config.name}</span>, with
          its config
        </>
      ),
      read: async () => ({
        kind: "run",
        name: `#${r.id} ${r.config.name}`,
        job_log: null,
        run: submitted(r),
      }),
    },
  });
  useReportFromHere(["about ", { mono: `#${r.id}` }], report.start);
  const writeWhy = !live
    ? `Connect to ${inSentence(platform)} to ${ended ? "delete" : "cancel"} it`
    : phase === "canceling"
      ? "It’s canceling now"
      : phase === "resuming"
        ? "It’s resuming now"
        : undefined;
  const closeAsk = () => {
    setAsking(undefined);
    menuButton.current?.focus();
  };
  const startsEach = r.settings?.search.starts_per_topology;
  const stale = asOf !== undefined;
  const resumable = r.state === "failed" || r.state === "canceled" || phase === "resuming";

  return (
    <div className={stale ? "page rd stale" : "page rd"}>
      <section className="rd-headwrap">
        <div className="rd-head">
          <div className="rd-head-text">
            <Crumbs id={String(r.id)} />
            <span className={state.failed ? "st st-failed rd-state" : "st rd-state"}>
              <span className={state.glyph} aria-hidden="true" />
              {state.word}
            </span>
            <PageHeading>
              <span className="title-id">
                <span className="rd-quiet-id">#{r.id}</span> {r.config.name}
                {r.config.deleted && <span className="cfg-gone">deleted</span>}
              </span>
            </PageHeading>
            <p className="facts rd-factsline">
              {facts.map((f, i) =>
                f.kind === "n" ? (
                  <span key={i} className="n">
                    {f.t}
                  </span>
                ) : f.kind === "topology" && r.best !== null ? (
                  <Link
                    key={i}
                    to="/runs/$id/$topology"
                    params={{ id: String(r.id), topology: topologyId(r.best) }}
                    className="link"
                  >
                    <span className="mono n">{f.t}</span>
                  </Link>
                ) : f.kind === "best" ? (
                  <span key={i} className="n vbest">
                    {f.t}
                  </span>
                ) : (
                  <span key={i}>{f.t}</span>
                ),
              )}
            </p>
          </div>
          <div className="rd-actions">
            <div className="rd-buttons">
              {ended && (
                <Link to="/runs/submit" search={{ config: r.config.id }} className="btn">
                  Submit again…
                </Link>
              )}
              {resumable && (
                <>
                  <WorkingButton
                    type="button"
                    className="btn btn-primary"
                    working={phase === "resuming" ? RESUMING : resume.working}
                    words="Resuming…"
                    {...offline.props}
                    onClick={(e) => {
                      offline.props.onClick(e);
                      if (live && phase !== "resuming") void resume.resume();
                    }}
                  >
                    Resume
                  </WorkingButton>
                  {offline.bubble}
                </>
              )}
              <RunMenu
                id={r.id}
                write={ended ? "delete" : "cancel"}
                why={writeWhy}
                buttonRef={menuButton}
                onCopy={() => void navigator.clipboard?.writeText(folder).catch(() => {})}
                onExport={() => void exportConfig(saving, r)}
                exportWhy={
                  r.settings === null
                    ? "A newer ICMM submitted it, in a config format this one can’t read."
                    : undefined
                }
                onWrite={() => {
                  (ended ? del : cancel).clear();
                  setAsking(ended ? "delete" : "cancel");
                }}
                onReport={report.start}
              />
            </div>
            {resume.message !== undefined && (
              <p className="err rd-err" role="alert">
                {resume.message}
              </p>
            )}
          </div>
        </div>
        {report.panel}
        <RunFacts run={r} revision={reads.revision} platform={platform} job={reads.job} />
        <UnreadableLine run={r} revision={reads.revision} />
        <Stages stages={stages} />
        {improving !== undefined && <StillImproving run={r} note={improving} />}
        {saving.outcome}
      </section>

      {box !== undefined && <RunBox run={r.id} box={box} cards={cards} />}

      <section className={many ? "rd-pair rd-pair-wide" : "rd-pair"}>
        {grid === undefined ? (
          <TopologyBar bar={topologyBarOf(r)} startsEach={startsEach} />
        ) : (
          <TopologyGrid
            run={r.id}
            grid={grid}
            total={r.progress.topologies}
            startsEach={startsEach}
            more={Math.max(0, r.progress.topologies - sent.length)}
          />
        )}
        <ProgressChart chart={chart} />
      </section>

      <RankedTopologies
        run={r}
        ranked={reads.ranked.topologies}
        rankedCount={reads.ranked.ranked}
        failed={failed}
        causes={reads.causes}
        graphs={reads.graphs}
      />

      <SpreadPlot spread={spread} />

      {asking === "cancel" && (
        <ConfirmDialog
          title={`Cancel run #${r.id} ${r.config.name}?`}
          keep="Keep running"
          confirm="Cancel run"
          working={{ working: cancel.working, words: "Canceling…" }}
          message={cancel.message}
          onKeep={closeAsk}
          onConfirm={() => {
            void cancel.send().then((done) => done && closeAsk());
          }}
        >
          {cancelWords(r, { slurm, queued })}
        </ConfirmDialog>
      )}
      {asking === "delete" && (
        <ConfirmDialog
          title={`Delete run #${r.id} ${r.config.name}?`}
          keep="Keep run"
          confirm="Delete run"
          working={{ working: del.working, words: "Deleting…" }}
          message={del.message}
          after={<span className="dialog-path">{folder}</span>}
          onKeep={closeAsk}
          onConfirm={() => void del.send()}
        >
          {deleteWords(platform, r.folder_bytes)}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Export its config… (#344, #336 decision 10): the config as the run
 * recorded it at submit, in the config format (ADR-0016), with its dataset
 * named beside its id and the seed it ran with (RF13, #368). It's what the
 * run fit, so it works while not connected.
 */
async function exportConfig(saving: Saving, r: Run) {
  const settings = r.settings;
  if (settings === null) return;
  await saving.save({
    ask: () =>
      commands.choose_export_file({
        title: `Export #${r.id}’s config`,
        name: `${fileStem(`${settings.name}-${r.id}`)}-config.json`,
        folder: null,
        formats: ["json"],
      }),
    write: (path) =>
      commands.write_export_file({
        path,
        text: configJson(settings, r.dataset, r.search_seed),
      }),
    said: (path) => ({
      lead: (
        <>
          Exported #{r.id}’s config to <FileIn path={path} />.
        </>
      ),
      hint: `${settings.name} as #${r.id} recorded it at submit, with its dataset named and the seed it ran with.`,
    }),
    what: "the config",
  });
}
