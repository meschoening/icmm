/**
 * The log view (LaptopLogs, #288; built in #289): a page under a start,
 * `#214/T12.3 · start 71 · logs` at `/runs/214/T12.3/71/logs`, its Start log
 * and job log as tabs for one try (`?log=job`), with a try switch for a
 * start sent more than once (`?try=2`), its latest chosen; and under a run,
 * `#214 · coordinating job log` at `/runs/214/logs`, a generation of its
 * coordinator's own log by a select (`?generation=9`).
 *
 * A log opens at its end and reads its earlier lines as the reader scrolls
 * up. While its try or generation runs, Follow keeps it at its newest line:
 * scrolling up turns Follow off, and "N new lines below" goes back down and
 * turns it on. Copy copies the whole log, Copy path its path on a cluster,
 * and on This computer, Show in Finder shows it. Not connected, the log stays
 * as read, its glyphs still.
 */
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { COPIED_FOR_MS } from "../connection/ConnectionStrip";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { revealWords } from "../datasets/detail/exportFile";
import { webviewInfo } from "../ipc";
import { useMinute } from "../runs/queries";
import {
  readWhole,
  useCoordinatingJobs,
  useLog,
  type Log,
  type LogRead,
  type LogSource,
} from "../runs/logs/queries";
import {
  bytesWords,
  chosenGeneration,
  generationEnd,
  generationWords,
  logHead,
  logLine,
  textLines,
  tryEnd,
  tryWords,
} from "../runs/logs/words";
import { useStart, type StartRef } from "../runs/start/queries";
import { clockSeconds, lookOf, phaseOf, statusParts, type Part } from "../runs/start/words";
import { topologyOf } from "../runs/topology/queries";
import { runNumberOf } from "../runs/words";
import { FailureBox, SaidBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { asSubject, inSentence } from "../setup/form";
import { usePlatformSettings, useReadAgain } from "../setup/queries";
import { slurmOf } from "../submit/plan";
import { heardAtOf, useConnection } from "../shell/connection";
import { useKept } from "../submit/kept";
import { useRun } from "../submit/queries";
import { runGlyph } from "../submit/words";
import { useBlocker } from "../ui/blocker";
import { clock } from "../ui/clock";
import { PageHeading } from "../ui/PageHeading";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { commands } from "../wire/api.gen";
import type {
  CoordinatingJob,
  JobDefaults,
  Run,
  SavedPlatform,
  Start,
  StartLogPoint,
  WireError,
} from "../wire/types.gen";
import { useShownPath } from "../ui/paths";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** `?log=job` opens the job log, `?try=2` a try before the latest. */
export interface LogsSearch {
  log?: "job";
  try?: number;
}

/** `?generation=9` opens that generation of the run's coordinator. */
export interface CoordinatorLogSearch {
  generation?: number;
}

// ── a start's logs ────────────────────────────────────────────────────────────────────────────

/** What the page shows of a start's logs, read whole, kept while the connection is gone. */
interface StartReads {
  run: Run;
  start: Start;
  /** Which log `log` is, `start-2` or `job-2`: kept, it shows only while that one's chosen. */
  which: string;
  /** The shown log as read; `undefined` while it's read, or when it couldn't be. */
  log: LogRead | undefined;
  /** The Start log's points as read, for the status line's ETA and the end's generation. */
  points: StartLogPoint[];
  /** The Job defaults, whose scheduler says whether its start is a SLURM job; once read. */
  job: JobDefaults | undefined;
}

export function StartLogsPage() {
  const params = useParams({ from: "/runs/$id/$topology/$start/logs" });
  const search = useSearch({ from: "/runs/$id/$topology/$start/logs" });
  const navigate = useNavigate({ from: "/runs/$id/$topology/$start/logs" });
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
  const title = `#${params.id}/${params.topology}`;
  const name = `start ${params.start} of ${title}’s logs`;
  const c = useConnection();
  const platform = useActivePlatform();
  const job = usePlatformSettings().data?.saved?.settings.job_defaults;
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";

  const runQ = useRun(ref?.run);
  const startQ = useStart(ref);
  const start = startQ.data;
  const latest = start?.try_number ?? 0;
  const tryNumber = search.try !== undefined && search.try < latest ? search.try : latest;
  const tab = search.log === "job" ? "job" : "start";
  const running = tryNumber === latest && (start?.state === "running" || start?.state === "queued");
  const follows = running && c.status === "connected";
  const startSource = useMemo<LogSource | undefined>(
    () => (ref === undefined || tryNumber === 0 ? undefined : { kind: "start", ref, tryNumber }),
    [ref, tryNumber],
  );
  const jobSource = useMemo<LogSource | undefined>(
    () => (ref === undefined || tryNumber === 0 ? undefined : { kind: "job", ref, tryNumber }),
    [ref, tryNumber],
  );
  // The Start log's last page is read on either tab: its points time the status line's ETA.
  const startLog = useLog(startSource, follows && tab === "start");
  const jobLog = useLog(tab === "job" ? jobSource : undefined, follows);
  const log = tab === "job" ? jobLog : startLog;

  const run = runQ.data;
  const reads = useMemo<StartReads | undefined>(
    () =>
      run === undefined || start === undefined
        ? undefined
        : {
            run,
            start,
            which: `${tab}-${tryNumber}`,
            log: log.read,
            points: startLog.read?.points ?? NONE,
            job,
          },
    [run, start, tab, tryNumber, log.read, startLog.read?.points, job],
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
  const failed = runQ.error ?? startQ.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failed !== null && failed !== undefined
      ? (failed as unknown as WireError)
      : undefined,
    () => (runQ.isError ? runQ.refetch() : startQ.refetch()),
  );
  const failure = useHeldFailure(
    read.failure,
    runQ.isFetching || startQ.isFetching,
    name,
    reads !== undefined || !live,
  );
  const shown = kept.value;
  const crumbs = (r: Pick<Run, "id" | "config"> | undefined) => (
    <StartCrumbs title={title} start={params.start} run={r} />
  );
  const heading = <StartTitle title={title} start={params.start} />;

  if (platform === undefined || (!live && shown === undefined)) {
    return (
      <Frame crumbs={crumbs(undefined)} heading={heading}>
        <ShowOnceConnected platform={platform} kind="Runs" one>
          this start’s logs
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (ref === undefined || failure?.code === "not_found") {
    return <NotHere name={`${title} · start ${params.start}`} platform={platform} />;
  }
  if (shown === undefined) {
    return (
      <Frame crumbs={crumbs(run)} heading={heading}>
        {failure !== undefined ? (
          <FailureBox
            error={failure}
            task={{ reading: `start ${params.start}` }}
            platform={platform}
            onRetry={read.retry}
            again={read.again}
          />
        ) : (
          <Reading>
            <span>
              Reading start {params.start} of {title} on {inSentence(platform)}…
            </span>
          </Reading>
        )}
      </Frame>
    );
  }

  const { start: s } = shown;
  // Without SLURM, its starts are processes on the platform (#281).
  const slurm = slurmOf(shown.job, platform);
  const n = s.start;
  const asOf = kept.asOf;
  const phase =
    s.state === "queued" && shown.points.length > 0
      ? "running"
      : phaseOf(s, shown.points.length > 0);
  const look = lookOf(phase);
  const context = { run: shown.run, start: s, points: shown.points, platform, slurm, now, asOf };
  // As shown, which is as last read while not connected.
  const tries = s.try_number;
  const shownNumber = search.try !== undefined && search.try < tries ? search.try : tries;
  const shownRunning = shownNumber === tries && (s.state === "running" || s.state === "queued");
  const shownTry = s.tries.find((t) => t.try_number === shownNumber);
  const ended = shownTry?.ended_at != null ? shownTry : undefined;
  const lastPoint = tab === "start" ? shown.log?.points.at(-1) : undefined;
  const whose = `start ${n}’s ${tab === "job" ? "job log" : "Start log"}`;
  const go = (to: LogsSearch) => void navigate({ search: to, replace: true });

  return (
    <div className={asOf === undefined ? "page lg-page" : "page lg-page stale"}>
      <section className="lg-head">
        {crumbs(shown.run)}
        <p className="st sp-status">
          <span
            className={`${look.glyph}${phase === "running" && asOf === undefined ? " live" : ""}`}
            aria-hidden="true"
          />
          <span className={look.red ? "sp-word sp-red" : "sp-word"}>{look.word}</span>
          <span className="sp-line">
            <Said parts={statusParts(phase, context)} />
          </span>
        </p>
        {heading}
      </section>
      <LogBox
        key={`${tab}-${shownNumber}`}
        kind={tab === "job" ? "text" : "start"}
        log={log}
        read={shown.which === `${tab}-${shownNumber}` ? shown.log : undefined}
        whose={whose}
        validation={shown.run.validation}
        everyGenerations={shown.run.settings?.search.log_every_generations}
        running={shownRunning}
        asOf={asOf}
        now={now}
        platform={platform}
        slurm={slurm}
        source={tab === "job" ? jobSource : startSource}
        known={shownNumber !== tries ? undefined : tab === "job" ? s.job_log : s.log}
        end={
          ended === undefined ? undefined : tryEnd(n, ended, s.tries, lastPoint?.generation, now)
        }
        empty={(read) =>
          startEmpty({
            start: s,
            tab,
            tryNumber: shownNumber,
            running: shownRunning,
            read,
            slurm,
          })
        }
        controls={
          <>
            <div className="seg" role="tablist" aria-label="Which log">
              {(["start", "job"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => go({ ...search, log: t === "job" ? "job" : undefined })}
                >
                  {t === "job" ? "Job log" : "Start log"}
                </button>
              ))}
            </div>
            {tries > 1 && (
              <div className="seg seg-sm" role="group" aria-label="Which try">
                {Array.from({ length: tries }, (_, i) => i + 1).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={t === shownNumber}
                    onClick={() => go({ ...search, try: t === tries ? undefined : t })}
                  >
                    {tryWords(t)}
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
    </div>
  );
}

const NONE: StartLogPoint[] = [];

/** What a start's log says when it has nothing to show: not out yet, empty, or gone. */
function startEmpty({
  start,
  tab,
  tryNumber,
  running,
  read,
  slurm,
}: {
  start: Start;
  tab: "start" | "job";
  tryNumber: number;
  running: boolean;
  read: LogRead | undefined;
  slurm: boolean;
}): { say: string; meta: string } | undefined {
  const n = start.start;
  if (tryNumber === 0) {
    return {
      say: `Nothing logged yet: start ${n} hasn’t gone out.`,
      meta: "Its logs begin once it starts.",
    };
  }
  if (read === undefined) return undefined;
  const empty = read.size === 0 || (tab === "start" ? read.points.length === 0 : read.text === "");
  if (read.found && !empty) return undefined;
  const gone = {
    say: "This log isn’t there any more: nothing is at its path.",
    meta:
      "Its file, or the run’s folder in the Output folder, was moved or deleted." +
      (start.best !== null && tryNumber === start.try_number
        ? ` Start ${n}’s numbers are in the runs database, so it still shows and ranks.`
        : ""),
  };
  if (tab === "job") {
    if (!read.found && !running) return gone;
    const own = slurm ? " or SLURM’s own messages" : "";
    return {
      say: running
        ? `Start ${n} hasn’t written anything to its job log.`
        : `Start ${n} wrote nothing to its job log.`,
      meta: `A start that runs cleanly leaves it empty: its progress is in its Start log. An error${own} would show here.`,
    };
  }
  if (running) {
    return {
      say: `Nothing logged yet: start ${n} is ${start.state === "queued" ? "queued" : "starting up"}.`,
      meta: "Its first line comes with its first generation, and the log follows from there.",
    };
  }
  const logged = tryNumber === start.try_number && (start.evaluations ?? 0) > 0;
  if (!read.found && (logged || tryNumber < start.try_number)) return gone;
  return {
    say: `Nothing logged: start ${n} stopped before its first generation.`,
    meta: "Its job log says why.",
  };
}

/** "Runs / #214 herg-wt-11state / #214/T12.3 / start 71 / logs"; the run's once it's read. */
function StartCrumbs({
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
      <Link to="/runs/$id/$topology/$start" params={{ id, topology, start }} className="link">
        start {start}
      </Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">logs</span>
    </nav>
  );
}

/** `#214/T12.3 · start 71 · logs`, all but the last word quieter. */
function StartTitle({ title, start }: { title: string; start: string }) {
  return (
    <PageHeading>
      <span className="title-id">
        <span className="topo-of">
          {title} · start {start} ·{" "}
        </span>
        logs
      </span>
    </PageHeading>
  );
}

// ── a run's coordinating job log ──────────────────────────────────────────────────────────────

interface CoordinatorReads {
  run: Run;
  jobs: CoordinatingJob[];
  /** The generation `log` is of: kept, it shows only while that one's chosen. */
  generation: number | undefined;
  log: LogRead | undefined;
}

export function CoordinatorLogPage() {
  const params = useParams({ from: "/runs/$id/logs" });
  const search = useSearch({ from: "/runs/$id/logs" });
  const navigate = useNavigate({ from: "/runs/$id/logs" });
  const id = runNumberOf(params.id);
  const c = useConnection();
  const platform = useActivePlatform();
  // Without SLURM, starts and coordinators are processes on the platform (#281).
  const defaults = usePlatformSettings().data?.saved?.settings.job_defaults;
  const slurm = platform !== undefined && slurmOf(defaults, platform);
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";
  const name = `#${params.id}’s coordinating job log`;

  const runQ = useRun(id);
  const jobsQ = useCoordinatingJobs(id);
  const run = runQ.data;
  const jobs = jobsQ.data?.jobs;
  const generation =
    search.generation !== undefined && jobs?.some((j) => j.generation === search.generation)
      ? search.generation
      : jobs === undefined
        ? undefined
        : chosenGeneration(jobs, run?.failure?.cause ?? null);
  const job = jobs?.find((j) => j.generation === generation);
  const running = job !== undefined && job.ended_at === null;
  const source = useMemo<LogSource | undefined>(
    () =>
      id === undefined || generation === undefined
        ? undefined
        : { kind: "coordinator", run: id, generation },
    [id, generation],
  );
  const log = useLog(source, running && c.status === "connected");
  const reads = useMemo<CoordinatorReads | undefined>(
    () =>
      run === undefined || jobs === undefined
        ? undefined
        : { run, jobs, generation, log: log.read },
    [run, jobs, generation, log.read],
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
  const failed = runQ.error ?? jobsQ.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failed !== null && failed !== undefined
      ? (failed as unknown as WireError)
      : undefined,
    () => (runQ.isError ? runQ.refetch() : jobsQ.refetch()),
  );
  const failure = useHeldFailure(
    read.failure,
    runQ.isFetching || jobsQ.isFetching,
    name,
    reads !== undefined || !live,
  );
  const shown = kept.value;
  const crumbs = (r: Pick<Run, "id" | "config"> | undefined) => (
    <RunCrumbs id={params.id} run={r} />
  );
  const heading = (
    <PageHeading>
      <span className="title-id">
        <span className="topo-of">#{params.id} · </span>coordinating job log
      </span>
    </PageHeading>
  );

  if (platform === undefined || (!live && shown === undefined)) {
    return (
      <Frame crumbs={crumbs(undefined)} heading={heading}>
        <ShowOnceConnected platform={platform} kind="Runs" one>
          this run’s coordinating job log
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (id === undefined || failure?.code === "not_found") {
    return <NotHere name={`#${params.id}’s coordinating job log`} platform={platform} />;
  }
  if (shown === undefined) {
    return (
      <Frame crumbs={crumbs(run)} heading={heading}>
        {failure !== undefined ? (
          <FailureBox
            error={failure}
            task={{ reading: name }}
            platform={platform}
            onRetry={read.retry}
            again={read.again}
          />
        ) : (
          <Reading>
            <span>
              Reading {name} on {inSentence(platform)}…
            </span>
          </Reading>
        )}
      </Frame>
    );
  }

  const r = shown.run;
  const asOf = kept.asOf;
  const shownGeneration =
    search.generation !== undefined && shown.jobs.some((j) => j.generation === search.generation)
      ? search.generation
      : chosenGeneration(shown.jobs, r.failure?.cause ?? null);
  const shownJob = shown.jobs.find((j) => j.generation === shownGeneration);
  const ended = r.ended_at === null ? undefined : Date.parse(r.ended_at);
  return (
    <div className={asOf === undefined ? "page lg-page" : "page lg-page stale"}>
      <section className="lg-head">
        {crumbs(r)}
        <p className="st sp-status">
          <span
            className={`${runGlyph(r.state)}${r.state === "running" && asOf === undefined ? " live" : ""}`}
            aria-hidden="true"
          />
          <span className={r.state === "failed" ? "sp-word sp-red" : "sp-word"}>{r.state}</span>
          <span className="sp-line">
            {asOf !== undefined && ` · as of ${clock(asOf, now)}`}
            {r.failure?.cause === "coordinator" && " · its coordinating job kept failing"}
            {ended !== undefined && !Number.isNaN(ended) && ` · ended ${clock(ended, now)}`}
          </span>
        </p>
        {heading}
      </section>
      {shown.jobs.length === 0 ? (
        <div className="lg-main">
          <div className="lg-empty">
            <p>No coordinating job has run for #{r.id} yet.</p>
            <p className="meta">Its first one starts once the run is sent.</p>
          </div>
        </div>
      ) : (
        <LogBox
          key={shownGeneration}
          kind="text"
          log={log}
          read={shown.generation === shownGeneration ? shown.log : undefined}
          whose={`#${r.id}’s coordinating job log, generation ${shownGeneration}`}
          validation={false}
          everyGenerations={undefined}
          running={shownJob !== undefined && shownJob.ended_at === null}
          asOf={asOf}
          now={now}
          platform={platform}
          slurm={slurm}
          source={source}
          end={shownJob?.ended_at == null ? undefined : generationEnd(shownJob, now)}
          empty={(read) => coordinatorEmpty(shownJob, read)}
          controls={
            <select
              className="input input-sm lg-gen"
              aria-label="Which generation"
              value={shownGeneration}
              onChange={(e) =>
                void navigate({
                  search: { generation: Number(e.target.value) },
                  replace: true,
                })
              }
            >
              {shown.jobs.map((j) => (
                <option key={j.generation} value={j.generation}>
                  {generationWords(j, now)}
                </option>
              ))}
            </select>
          }
        />
      )}
    </div>
  );
}

/** What a generation's log says when it has nothing to show: empty, or gone. */
function coordinatorEmpty(
  job: CoordinatingJob | undefined,
  read: LogRead | undefined,
): { say: string; meta: string } | undefined {
  if (job === undefined || read === undefined) return undefined;
  if (read.found && read.size > 0) return undefined;
  if (!read.found && job.ended_at !== null) {
    return {
      say: "This log isn’t there any more: nothing is at its path.",
      meta: "Its file, or the run’s folder in the Output folder, was moved or deleted.",
    };
  }
  return {
    say:
      job.ended_at === null
        ? `Generation ${job.generation} hasn’t written anything to its log.`
        : `Generation ${job.generation} wrote nothing to its log.`,
    meta: "A coordinating job that runs cleanly leaves it empty.",
  };
}

/** "Runs / #214 herg-wt-11state / coordinating job log"; the run's once it's read. */
function RunCrumbs({ id, run }: { id: string; run: Pick<Run, "id" | "config"> | undefined }) {
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
      <span aria-current="page">coordinating job log</span>
    </nav>
  );
}

// ── around them ───────────────────────────────────────────────────────────────────────────────

/** The page while what it shows isn't there: the crumb, the heading, then why. */
function Frame({
  crumbs,
  heading,
  children,
}: {
  crumbs: ReactNode;
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page sp-page">
      <section className="sp-head">
        {crumbs}
        {heading}
        <div className="sp-wait">{children}</div>
      </section>
    </div>
  );
}

/** A log of something this platform doesn't have: its run gone, or not one. */
function NotHere({ name, platform }: { name: string; platform: Platform }) {
  return (
    <div className="page">
      <PageHeading>Log not found</PageHeading>
      <p className="facts">
        {name} isn’t on {inSentence(platform)}: its run is gone, or doesn’t hold it.
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

// ── the log ───────────────────────────────────────────────────────────────────────────────────

/** How close to the end counts as at it, in px: a line's fraction. */
const AT_END_PX = 4;
/** How close to the start an earlier page is read, in px: a few lines. */
const EARLIER_AT_PX = 160;

/**
 * The bar and the log under it: its controls, Follow, Copy and Copy path or
 * Show in Finder, then its path and size, and its lines, from where it's
 * read back to, with what it says at either end.
 */
function LogBox({
  kind,
  log,
  read,
  whose,
  validation,
  everyGenerations,
  running,
  asOf,
  now,
  platform,
  slurm,
  source,
  known,
  end,
  empty,
  controls,
}: {
  kind: "start" | "text";
  log: Log;
  /** The log as read, or as kept while not connected. */
  read: LogRead | undefined;
  /**
   * Its path as known before its read answers, from the start's own read, so its line and Copy
   * path stay while it reads or fails (#449's SF04); its read's path wins once in.
   */
  known?: string | null;
  /** "start 71’s Start log". */
  whose: string;
  validation: boolean;
  everyGenerations: number | undefined;
  /** Its try or generation still runs: it may log more. */
  running: boolean;
  asOf: number | undefined;
  now: number;
  platform: Platform;
  /** Whether SLURM runs its jobs; else they're processes on the platform. */
  slurm: boolean;
  source: LogSource | undefined;
  /** How it ended, once it has. */
  end: string | undefined;
  empty: (read: LogRead | undefined) => { say: string; meta: string } | undefined;
  controls: ReactNode;
}) {
  const offline = asOf !== undefined;
  const shownPath = useShownPath(platform);
  const [follow, setFollow] = useState(true);
  /** Lines below the view when Follow went off: the count of new ones starts there. */
  const [seen, setSeen] = useState<number>();
  const scroller = useRef<HTMLDivElement>(null);
  const logId = useId();
  const offId = useId();

  const lines = useMemo(() => {
    if (read === undefined) return [];
    if (kind === "start") {
      const last = read.points.length - 1;
      return read.points.map((p, i) => ({
        t: logLine(p, validation),
        cls: running && i === last ? "ink" : undefined,
      }));
    }
    return textLines(read.text).map((l) => ({ t: l.t, cls: l.err ? "err" : undefined }));
  }, [read, kind, validation, running]);
  /** The lines from the last page on, which is where new ones are counted from. */
  const tail = lines.length - (read === undefined ? 0 : earlierLines(read, kind));
  const following = follow && running && !offline;
  const newer = !following && running && seen !== undefined ? Math.max(0, tail - seen) : 0;
  const whole = read !== undefined && read.next >= read.size;
  const said = empty(read);
  const first = read?.begins === 0;
  const path = read?.path ?? known ?? null;

  const toEnd = () => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };
  // It opens at its end, and stays there while it follows. Earlier lines coming in above keep
  // what's in view where it is; new ones below move nothing.
  const opened = useRef(false);
  const shown = useRef({ height: 0, begins: undefined as number | undefined });
  const begins = read?.begins;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const before = shown.current;
    if (!opened.current && lines.length > 0) {
      opened.current = true;
      toEnd();
    } else if (following) {
      toEnd();
    } else if (begins !== undefined && before.begins !== undefined && begins < before.begins) {
      el.scrollTop += el.scrollHeight - before.height;
    }
    shown.current = { height: el.scrollHeight, begins };
    // Only a change in what's shown moves it.
  }, [lines.length, following, begins]);

  // A last page too short to scroll reads the one before it at once.
  const { reading, error: earlierError, read: readEarlier } = log.earlier;
  useEffect(() => {
    const el = scroller.current;
    if (el === null || read === undefined || first || offline || reading || earlierError) return;
    if (el.scrollHeight <= el.clientHeight + EARLIER_AT_PX) readEarlier();
  }, [read, first, offline, reading, earlierError, readEarlier]);

  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (el === null) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX;
    const up = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    if (el.scrollTop <= EARLIER_AT_PX && !first && !offline && !reading && !earlierError) {
      readEarlier();
    }
    if (!running || offline) return;
    if (up && !atEnd && follow) {
      setFollow(false);
      setSeen(tail);
    } else if (atEnd && !follow) {
      setFollow(true);
      setSeen(undefined);
    }
  };
  const followOn = () => {
    setFollow(true);
    setSeen(undefined);
    toEnd();
  };

  const note = !following
    ? ""
    : kind === "start" && lines.length > 0
      ? "a few new lines every 5 s"
      : "checks every 5 s";
  const reveal = platform.type === "local";

  return (
    <div className="lg-main">
      <div className="lg-bar">
        {controls}
        <span className="lg-grow" />
        {running && (
          <>
            <label className="lg-follow">
              <span className="switch">
                <input
                  type="checkbox"
                  checked={following}
                  aria-disabled={offline || undefined}
                  aria-describedby={offline ? offId : note ? `${offId}-note` : undefined}
                  onChange={() => {
                    if (offline) return;
                    if (following) {
                      setFollow(false);
                      setSeen(tail);
                    } else followOn();
                  }}
                />
                <span className="trk" />
              </span>
              Follow
            </label>
            {note && (
              <span className="hint lg-follow-note" id={`${offId}-note`}>
                {note}
              </span>
            )}
          </>
        )}
        <CopyButtons
          source={source}
          read={read}
          whole={whole}
          kind={kind}
          validation={validation}
          offline={offline}
          platform={platform}
          reveal={reveal}
          nothing={said !== undefined || read === undefined}
          path={path}
        />
      </div>
      {path !== null && (
        <p className="lg-path">
          <span className="mono" title={shownPath(path)}>
            {shownPath(path)}
          </span>
          {read?.found === true && (
            <span className="lg-size">
              · {bytesWords(read.size)}
              {kind === "start" && everyGenerations !== undefined && read.size > 0
                ? ` · a line every ${everyGenerations} generations`
                : ""}
            </span>
          )}
        </p>
      )}
      {offline && (
        <p className="lg-off" id={offId}>
          <span className="g g-off" aria-hidden="true" />
          <span>
            Not connected: this is {whose} as read at {clockSeconds(asOf, now)}.
            {running ? " It follows again once ICMM reconnects." : ""}
          </span>
        </p>
      )}
      {read === undefined ? (
        offline ? (
          <div className="lg-empty">
            <p>
              {whose[0].toUpperCase()}
              {whose.slice(1)} shows here once {inSentence(platform)} is connected.
            </p>
          </div>
        ) : log.error !== null ? (
          <LogFailure
            error={log.error as unknown as WireError}
            whose={whose}
            platform={platform}
            slurm={slurm}
            onRetry={log.refetch}
          />
        ) : (
          <Reading>
            <span>
              Reading {whose} on {inSentence(platform)}…
            </span>
          </Reading>
        )
      ) : said !== undefined ? (
        <div className="lg-empty">
          <p>{said.say}</p>
          <p className="meta">{said.meta}</p>
        </div>
      ) : (
        <div className="lg-log" role="log" tabIndex={0} aria-label={whose} id={logId}>
          {kind === "start" && <span className="lh">{logHead(validation)}</span>}
          <div className="lg-scroll" ref={scroller} onScroll={onScroll}>
            <div className={kind === "start" ? "lg-lines" : "lg-lines top"}>
              {reading && (
                <span className="rd" role="status">
                  <span className="dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  Reading earlier lines…
                </span>
              )}
              {earlierError !== undefined && !reading && (
                <span className="rd">
                  Earlier lines didn’t load: {earlierError.message}
                  <button type="button" className="link" onClick={readEarlier}>
                    Try again
                  </button>
                </span>
              )}
              {first && <span className="mk">Start of the log</span>}
              {lines.map((l, i) => (
                <span key={i} className={kind === "start" ? `lg-table ${l.cls ?? ""}` : l.cls}>
                  {l.t}
                </span>
              ))}
              {end !== undefined && whole && <span className="mk">End of the log · {end}</span>}
            </div>
          </div>
          {newer > 0 && (
            <button type="button" className="lg-newer" onClick={followOn}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {newer} new {newer === 1 ? "line" : "lines"} below
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Why a log didn't open: an Output folder that can't be read now in the log
 * view's own words (LaptopLogs' `failure`), anything else as every read's.
 */
function LogFailure({
  error,
  whose,
  platform,
  slurm,
  onRetry,
}: {
  error: WireError;
  whose: string;
  platform: Platform;
  slurm: boolean;
  onRetry: () => Promise<unknown>;
}) {
  if (error.code === "unavailable" && error.data.source === "filesystem") {
    const where = platform.type === "local" ? "This computer" : platform.name;
    return (
      <SaidBox
        said={{
          what: `${where} couldn’t read the Output folder just now, so ${whose} didn’t open.`,
          next: `${slurm ? "The cluster’s" : `${asSubject(platform)}’s`} storage may be busy. Try again in a minute.`,
          raw: "unavailable · Output folder",
          report: false,
          retry: true,
        }}
        onRetry={onRetry}
      />
    );
  }
  return (
    <FailureBox error={error} task={{ reading: whose }} platform={platform} onRetry={onRetry} />
  );
}

/** How many of the lines shown are from pages read back from the last. */
function earlierLines(read: LogRead, kind: "start" | "text"): number {
  return kind === "start" ? read.earlierPoints : read.earlierLines;
}

/**
 * Copy, which reads every page of the log, so it's a working button; then
 * Copy path on a cluster, or Show in Finder on This computer. Each says
 * Copied for 2 s after it copies.
 */
function CopyButtons({
  source,
  read,
  whole,
  kind,
  validation,
  offline,
  platform,
  reveal,
  nothing,
  path,
}: {
  source: LogSource | undefined;
  read: LogRead | undefined;
  whole: boolean;
  kind: "start" | "text";
  validation: boolean;
  offline: boolean;
  platform: Platform;
  reveal: boolean;
  nothing: boolean;
  /** Its path, `null` where none is known: its try hasn't gone out. */
  path: string | null;
}) {
  const copying = useWorking();
  const [copied, setCopied] = useState<"log" | "path">();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [revealFailed, setRevealFailed] = useState<string>();
  // Outside the app (tests) the webview says nothing: Finder's words then.
  const os = useQuery({
    queryKey: ["webview_info"],
    queryFn: async () => (await webviewInfo()) ?? null,
    staleTime: Infinity,
  }).data?.os;
  const inMemory = read !== undefined && read.begins === 0 && whole;
  const blocker = nothing
    ? "Nothing to copy yet."
    : offline && !inMemory
      ? `Connect to ${platform.name} to copy the whole log.`
      : undefined;
  const b = useBlocker(blocker);
  const show = (what: "log" | "path") => {
    setCopied(what);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), COPIED_FOR_MS);
  };
  const copy = () => {
    if (blocker !== undefined || read === undefined || (!inMemory && source === undefined)) return;
    void copying
      .run(async () => {
        const text = inMemory
          ? kind === "start"
            ? [logHead(validation), ...read.points.map((p) => logLine(p, validation))].join("\n") +
              "\n"
            : read.text
          : await readWhole(source!, validation);
        await navigator.clipboard?.writeText(text);
      })
      .then(() => show("log"))
      .catch(() => {});
  };
  // Copy path says why it can't, as Copy does (ADR-0027).
  const pathBlocker = useBlocker(path === null ? "Nothing to copy yet." : undefined);
  return (
    <>
      <WorkingButton
        type="button"
        className="btn btn-sm"
        working={copying}
        words="Copying…"
        {...b.props}
        onClick={(e) => {
          b.props.onClick(e);
          if (!e.defaultPrevented) copy();
        }}
      >
        <Swap on={copied === "log"} at="Copy" />
      </WorkingButton>
      {b.bubble}
      <BesideButton
        type="button"
        className="btn btn-sm"
        working={copying}
        {...pathBlocker.props}
        onClick={(e) => {
          pathBlocker.props.onClick(e);
          if (e.defaultPrevented || path === null) return;
          if (reveal) {
            setRevealFailed(undefined);
            commands.reveal_log({ path }).catch((e: WireError) => setRevealFailed(e.message));
          } else {
            void navigator.clipboard?.writeText(path).then(
              () => show("path"),
              () => {},
            );
          }
        }}
      >
        {reveal ? revealWords(os) : <Swap on={copied === "path"} at="Copy path" />}
      </BesideButton>
      {pathBlocker.bubble}
      {revealFailed !== undefined && (
        <span className="hint" role="status">
          {revealFailed}
        </span>
      )}
    </>
  );
}

/** A label that says Copied for a while, as wide as the wider of the two. */
function Swap({ on, at }: { on: boolean; at: string }) {
  return (
    <span className="swap" aria-live="polite">
      <span aria-hidden={on || undefined}>{at}</span>
      <span aria-hidden={!on || undefined}>Copied</span>
    </span>
  );
}
