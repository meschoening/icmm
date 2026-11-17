/**
 * Runs (LaptopRuns, #231): the Active platform's runs, those in flight
 * newest first, then those that ended, by the day they ended. A run is
 * `#214 herg-wt-11state`, following its config's id. A run in flight shows
 * its progress, best so far and ETA, or why it waits, in plain words and the
 * scheduler's own; one that ended shows its numbers, how it compares with
 * its dataset's best, and why it ended short. A filter narrows the list by
 * name, number or dataset, and the datasets row by dataset.
 *
 * The change feed's `runs` reads it again. Not connected, the list it last
 * read stays, as of when the connection went, its glyphs still.
 */
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { useMinute, useRunsList, useRunsOverview } from "../runs/queries";
import { cancelingWhat, queuedOf } from "../runs/detail";
import { useTopologies } from "../runs/detailQueries";
import { useResume } from "../runs/resume";
import {
  againLine,
  barOf,
  byDay,
  capLine,
  comparedOf,
  endedWhy,
  etaParts,
  factsOf,
  fitFor,
  rmse,
  startsLine,
  topologiesLine,
  topologyName,
  waitingOf,
  type Around,
} from "../runs/words";
import { FailureBox } from "../setup/FailureBox";
import { inSentence } from "../setup/form";
import { usePlatformSettings, useReadAgain, useSchedulerLookup } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { etasOf, slurmOf } from "../submit/plan";
import { useRuns, useRunTimings, useUserJobs } from "../submit/queries";
import { runGlyph } from "../submit/words";
import { useKept } from "../submit/kept";
import { useBlocker } from "../ui/blocker";
import { clock } from "../ui/clock";
import { useLanding } from "../ui/landing";
import { ListEmpty, ReadingFacts } from "../ui/HeadFacts";
import { PageHeading } from "../ui/PageHeading";
import { WorkingButton } from "../ui/WorkingButton";
import type {
  JobDefaults,
  Run,
  RunsDataset,
  RunsOverview,
  RunSummary,
  RunTiming,
  SavedPlatform,
  WireError,
} from "../wire/types.gen";
import { useShownPath } from "../ui/paths";
import { Whole } from "../ui/Whole";
import { ReportFromHere } from "../report/ReportFromHere";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** Runs can open on a dataset's runs (Dataset detail's All runs) or a filter (a config's). */
export interface RunsSearch {
  dataset?: string;
  filter?: string;
}

/** What the page shows, read whole: kept as of the connection's end while it's gone. */
interface Reads {
  overview: RunsOverview;
  runs: RunSummary[];
  /** Whether more pages follow. */
  more: boolean;
  details: Run[] | undefined;
  timings: RunTiming[] | undefined;
  job: JobDefaults | undefined;
  jobs: number | undefined;
  limit: number | null | undefined;
}

const NO_TIMINGS: RunTiming[] = [];

export function RunsPage() {
  const search = useSearch({ from: "/runs" });
  const c = useConnection();
  const platform = useActivePlatform();
  const now = useMinute();
  // Home's All ended runs opens Runs at its Ended list (#398).
  const ended = useLanding("ended");
  const [typed, setTyped] = useState(search.filter ?? "");
  const filter = useSettled(typed);
  const [dataset, setDataset] = useState<string | null>(search.dataset ?? null);
  const live = c.status === "connected" || c.status === "reconnecting";

  const overviewQ = useRunsOverview();
  const listQ = useRunsList(filter, dataset);
  const settingsQ = usePlatformSettings();
  const job = settingsQ.data?.saved?.settings.job_defaults;
  const slurm = platform === undefined ? false : slurmOf(job, platform);
  const jobsQ = useUserJobs(slurm);
  const lookupQ = useSchedulerLookup(slurm);
  const timingsQ = useRunTimings();
  const listed = useMemo(() => listQ.data?.pages.flatMap((p) => p.runs), [listQ.data]);
  const running = (listed ?? []).filter(
    (r) => r.ended_at === null && r.progress.starts_running > 0,
  );
  const details = useSame(useRuns(running.map((r) => r.id)));

  // A filtered page can hold none of the runs it walked, with more to walk: go on.
  const pages = listQ.data?.pages;
  const lastEmpty = pages !== undefined && pages.at(-1)?.runs.length === 0;
  useEffect(() => {
    if (lastEmpty && listQ.hasNextPage && !listQ.isFetchingNextPage) void listQ.fetchNextPage();
  }, [lastEmpty, listQ]);

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
    overviewQ.data === undefined || listed === undefined
      ? undefined
      : {
          overview: overviewQ.data,
          runs: listed,
          more: listQ.hasNextPage,
          details,
          timings: timingsQ.data?.timings,
          job,
          jobs: jobsQ.data?.jobs?.running,
          limit,
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
  const failed = overviewQ.isError ? overviewQ.error : listQ.isError ? listQ.error : undefined;
  const read = useReadAgain(
    reads === undefined && failed !== undefined ? (failed as unknown as WireError) : undefined,
    () => Promise.all([overviewQ.refetch(), listQ.refetch()]),
  );
  const failure = useHeldFailure(
    read.failure,
    overviewQ.isFetching || listQ.isFetching,
    "all",
    reads !== undefined || !live,
  );
  const shown = kept.value;
  const counts = shown?.overview.counts;
  const total =
    counts === undefined
      ? undefined
      : counts.running + counts.canceling + counts.queued + counts.held + counts.ended;
  const empty = total === 0;
  // What the page shows, its facts line and its body alike.
  const shows =
    !live && shown === undefined
      ? "offline"
      : shown !== undefined
        ? "list"
        : failure !== undefined
          ? "failure"
          : c.status === "connected"
            ? "reading"
            : "offline";

  return (
    <div className="page">
      <section className="runs-head-wrap">
        <div className="runs-head">
          <div className="head-text">
            <PageHeading landing={!ended.at}>Runs</PageHeading>
            {platform === undefined ? null : shows === "list" ? (
              empty ? (
                <p className="facts">None on {inSentence(platform)} yet</p>
              ) : (
                <Facts overview={shown!.overview} now={now} asOf={kept.asOf} />
              )
            ) : shows === "failure" ? (
              <p className="facts">Couldn’t read the runs</p>
            ) : shows === "reading" ? (
              <ReadingFacts>Reading the runs on {inSentence(platform)}…</ReadingFacts>
            ) : (
              <p className="facts">Not connected to {inSentence(platform)}</p>
            )}
          </div>
          <Link to="/runs/submit" className="btn btn-primary">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            New run
          </Link>
        </div>
        <ReportFromHere name="Runs" />
        {shown !== undefined && !empty && (
          <div className="runs-filters">
            <label className="runs-filter">
              <span className="sr-only">Filter runs</span>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              <input
                className="input"
                type="search"
                placeholder="Filter by name, #id or dataset"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            <DatasetChoice
              datasets={shown.overview.datasets}
              chosen={dataset}
              onChoose={setDataset}
            />
          </div>
        )}
      </section>
      {platform === undefined || shows === "offline" ? (
        <ShowOnceConnected platform={platform} kind="Runs">
          its runs
        </ShowOnceConnected>
      ) : shows === "list" ? (
        empty ? (
          <ListEmpty>
            <p>
              A run fits one of your configs on {inSentence(platform)}: every start of every
              topology it draws. Submit one with New run, then follow it here as it runs.
            </p>
          </ListEmpty>
        ) : (
          <Lists
            reads={shown!}
            platform={platform}
            slurm={slurm}
            partition={partition}
            now={now}
            asOf={kept.asOf}
            filtered={filter.trim() !== "" || dataset !== null}
            landEnded={ended.land}
            loadMore={
              shown!.more && live
                ? {
                    busy: listQ.isFetchingNextPage,
                    load: () => void listQ.fetchNextPage(),
                  }
                : undefined
            }
          />
        )
      ) : shows === "failure" ? (
        <FailureBox
          error={failure!}
          task="runs"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      ) : null}
    </div>
  );
}

/** `value`, or the one before when it holds the same: so a read that answers alike is the same read. */
function useSame<T>(value: T): T {
  const [kept, setKept] = useState(value);
  const same = kept === value || JSON.stringify(kept) === JSON.stringify(value);
  if (!same) setKept(value);
  return same ? kept : value;
}

/** `value` once it has stood still for a moment, so a filter isn't read at every key. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 200);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** "2 running · 1 held · 14 ended since Sat, Aug 8 (5 failed · 1 canceled)", and when, not connected. */
function Facts({
  overview,
  now,
  asOf,
}: {
  overview: RunsOverview;
  now: number;
  asOf: number | undefined;
}) {
  const f = factsOf(overview.counts, now);
  return (
    <p className="facts">
      {f.live} · <span className="n">{f.ended.toLocaleString("en-US")}</span> ended
      {f.since !== undefined && <> since {f.since}</>}
      {f.paren !== "" && <span className="runs-quiet"> ({f.paren})</span>}
      {asOf !== undefined && <> · as of {clock(asOf, now)}</>}
    </p>
  );
}

/** All datasets, then each dataset with runs and how many, as buttons; a deleted one isn't one. */
function DatasetChoice({
  datasets,
  chosen,
  onChoose,
}: {
  datasets: RunsDataset[];
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) {
  const shown = datasets.filter((d) => !d.deleted && d.name !== null);
  if (shown.length < 2 && chosen === null) return null;
  return (
    <div className="seg runs-seg" role="group" aria-label="Dataset">
      <button type="button" aria-pressed={chosen === null} onClick={() => onChoose(null)}>
        All datasets
      </button>
      {shown.map((d) => (
        <button
          key={d.id}
          type="button"
          aria-pressed={chosen === d.id}
          onClick={() => onChoose(chosen === d.id ? null : d.id)}
        >
          {d.name} <span className="mono runs-seg-n">{d.runs.toLocaleString("en-US")}</span>
        </button>
      ))}
    </div>
  );
}

function Lists({
  reads,
  platform,
  slurm,
  partition,
  now,
  asOf,
  filtered,
  landEnded,
  loadMore,
}: {
  reads: Reads;
  platform: Platform;
  slurm: boolean;
  partition: string | null;
  now: number;
  /** When the connection went, while it's away: the ETAs are held there (#326). */
  asOf: number | undefined;
  filtered: boolean;
  /** The Ended heading's ref: a link that opens Runs at Ended lands there. */
  landEnded: (el: HTMLElement | null) => void;
  loadMore: { busy: boolean; load: () => void } | undefined;
}) {
  const inFlight = reads.runs.filter((r) => r.ended_at === null);
  const ended = reads.runs.filter((r) => r.ended_at !== null);
  const cap = reads.job?.max_running_starts;
  const etas = useMemo(
    () =>
      reads.job === undefined || reads.details === undefined
        ? new Map<number, number | undefined>()
        : etasOf(reads.details, {
            timings: reads.timings ?? NO_TIMINGS,
            cpus: reads.job.cpus_per_start,
            cap: reads.job.max_running_starts,
            now: asOf ?? now,
          }),
    [reads.details, reads.timings, reads.job, now, asOf],
  );
  const stale = asOf !== undefined;
  const shownPath = useShownPath(platform);
  const around: Around = {
    platform,
    slurm,
    partition,
    cap,
    jobs: reads.jobs,
    inFlight,
    shownPath,
    etas,
  };
  const datasets = new Map(reads.overview.datasets.map((d) => [d.id, d]));
  const account = reads.job?.type === "slurm" ? reads.job.account : null;
  const cap_ = capLine({
    platform,
    slurm,
    cap,
    jobs: reads.jobs,
    limit: reads.limit,
    inFlight,
  });
  const days = byDay(ended, now);
  const endedCount = filtered || reads.more ? ended.length : reads.overview.counts.ended;
  return (
    <div className={stale ? "runs-lists stale" : "runs-lists"}>
      {filtered && reads.runs.length === 0 && !reads.more && (
        <p className="ds-none">No runs on {inSentence(platform)} match.</p>
      )}
      {inFlight.length > 0 && (
        <section aria-labelledby="runs-inflight" className="runs-section">
          <div className="runs-section-head">
            <h2 id="runs-inflight" className="label">
              In flight
            </h2>
            <span className="mono runs-count">{inFlight.length.toLocaleString("en-US")}</span>
            {cap_ !== undefined && <span className="runs-cap">{cap_}</span>}
          </div>
          <div className="runs-box" role="table" aria-label="Runs in flight">
            <div className="igrid runs-colhead" role="row">
              <span className="th" role="columnheader">
                Status
              </span>
              <span className="th" role="columnheader">
                Run
              </span>
              <span className="th" role="columnheader">
                Progress
              </span>
              <span className="th runs-h-num" role="columnheader">
                Best val so far
              </span>
              <span className="th runs-h-num" role="columnheader">
                ETA
              </span>
            </div>
            {inFlight.map((r) => (
              <LiveRow key={r.id} run={r} around={around} eta={etas.get(r.id)} now={now} />
            ))}
          </div>
        </section>
      )}
      {(ended.length > 0 || (!filtered && inFlight.length > 0)) && (
        <section aria-labelledby="runs-ended" className="runs-section">
          <div className="runs-section-head">
            <h2 id="runs-ended" className="label lands" tabIndex={-1} ref={landEnded}>
              Ended
            </h2>
            <span className="mono runs-count">{endedCount.toLocaleString("en-US")}</span>
          </div>
          {ended.length > 0 && (
            <div role="table" aria-label="Runs that ended">
              <div className="fgrid runs-colhead" role="row">
                <span className="th" role="columnheader">
                  Status
                </span>
                <span className="th" role="columnheader">
                  Run
                </span>
                <span className="th runs-h-num" role="columnheader">
                  Topologies
                </span>
                <span className="th runs-h-num" role="columnheader">
                  Train
                </span>
                <span className="th runs-h-num" role="columnheader">
                  Val
                </span>
                <span className="th runs-cmp-h" role="columnheader">
                  Vs dataset best
                </span>
                <span className="th runs-h-num" role="columnheader">
                  Ended
                </span>
                <span
                  className="th runs-h-num"
                  role="columnheader"
                  title="Time it spent fitting: not its wait to begin, or time stopped"
                >
                  Duration
                </span>
                <span role="columnheader">
                  <span className="sr-only">Results</span>
                </span>
              </div>
              {days.map((d) => (
                <div key={d.day} role="rowgroup" aria-label={d.day}>
                  <div className="runs-day" role="row">
                    <span role="rowheader">{d.day}</span>
                    <span className="mono">{d.runs.length}</span>
                  </div>
                  {d.runs.map((r) => (
                    <EndedRow
                      key={r.id}
                      run={r}
                      platform={platform}
                      dataset={datasets.get(r.dataset.id)}
                      why={endedWhy(r, { platform, account, partition })}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {loadMore !== undefined && (
        <button
          type="button"
          className="btn btn-sm runs-more"
          aria-disabled={loadMore.busy || undefined}
          onClick={() => !loadMore.busy && loadMore.load()}
        >
          Show more runs
        </button>
      )}
    </div>
  );
}

/** A run in flight: running with its bar, best so far and ETA, or waiting, with why. */
function LiveRow({
  run: r,
  around,
  eta,
  now,
}: {
  run: RunSummary;
  around: Around;
  eta: number | undefined;
  now: number;
}) {
  const ds = r.dataset.name ?? "a dataset this platform never had";
  const meta = (
    <span className="meta">
      {ds}
      {r.dataset.earlier && (
        <>
          {" "}
          · <span className="qual-e">earlier data</span>
        </>
      )}
      {r.dataset.deleted && (
        <>
          {" "}
          · <span className="qual-e">deleted</span>
        </>
      )}{" "}
      · <span className="n">{r.num_states}</span> states · submitted{" "}
      {clock(Date.parse(r.submitted_at), now)}
    </span>
  );
  const name = (
    <span className="runs-name">
      <span className="mono runs-title">
        <span className="runs-quiet">#{r.id}</span> {r.config.name}
        {r.config.deleted && <span className="cfg-gone">deleted</span>}
      </span>
      {meta}
    </span>
  );
  if (r.canceling !== null && r.ended_at === null) {
    return <CancelingRow run={r} name={name} around={around} now={now} />;
  }
  if (r.state !== "running") {
    const w = waitingOf(r, around, now);
    return (
      <Link to="/runs/$id" params={{ id: String(r.id) }} className="igrid trow" role="row">
        <span className={r.state === "held" ? "st st-quiet" : "st"} role="cell">
          <span className={runGlyph(r.state)} aria-hidden="true" />
          {r.state}
        </span>
        <span role="cell">{name}</span>
        <span className="runs-wait" role="cell">
          <span className="runs-say">{w.say}</span>
          <span className="meta">
            {w.raw !== undefined && (
              <>
                <span className="mono">{w.raw}</span> ·{" "}
              </>
            )}
            {w.since}
          </span>
        </span>
      </Link>
    );
  }
  const bar = barOf(r.progress);
  const p = r.progress;
  const again = againLine(r, around.platform, now);
  const e = eta === undefined ? undefined : etaParts(eta, now);
  const best = r.best;
  const value = best === null ? null : (best.val_rmse ?? best.train_rmse);
  return (
    <Link to="/runs/$id" params={{ id: String(r.id) }} className="igrid trow" role="row">
      <span className="st" role="cell">
        <span className={runGlyph(r.state)} aria-hidden="true" />
        running
      </span>
      <span role="cell">{name}</span>
      <span className="runs-progress" role="cell">
        <span
          className="runs-bar"
          role="img"
          aria-label={`${p.topologies_complete} of ${p.topologies} topologies done, ${p.topologies_failed} failed, ${p.topologies_fitting} fitting, ${p.starts_running} starts running`}
        >
          <span className="runs-bar-done" style={{ flexBasis: pct(bar.done) }} />
          <span className="runs-bar-failed" style={{ flexBasis: pct(bar.failed) }} />
          <span className="runs-bar-fitting" style={{ flexBasis: pct(bar.fitting) }} />
        </span>
        <span className="runs-lines">
          <span className="runs-line">{topologiesLine(p)}</span>
          <span className="meta">{startsLine(p, around.cap)}</span>
          {again !== undefined && <span className="meta">{again}</span>}
        </span>
      </span>
      <span className="runs-best" role="cell">
        {best === null || value === null ? (
          <span className="mono runs-big runs-quiet">—</span>
        ) : (
          <>
            <span className="mono runs-big runs-sofar">{rmse(value)}</span>
            <span className="mono runs-of">
              {topologyName(r.id, best)}
              {best.val_rmse === null && <span className="runs-bytrain"> by train</span>}
            </span>
          </>
        )}
      </span>
      <span className="runs-eta" role="cell">
        {e === undefined ? (
          <span className="mono runs-big runs-quiet">—</span>
        ) : (
          <>
            <span className="runs-eta-day">{e.day}</span>
            <span className="mono runs-big">{e.time}</span>
            <span className="meta">{e.left}</span>
          </>
        )}
      </span>
    </Link>
  );
}

/**
 * A run canceling (#324, SR03): what its cancel is doing in Run detail's
 * words, naming the fitting topology's queued starts once it's read.
 */
function CancelingRow({
  run: r,
  name,
  around,
  now,
}: {
  run: RunSummary;
  name: React.ReactNode;
  around: Around;
  now: number;
}) {
  const fitting = useTopologies(r.id, "sent", "fitting", 1).data?.topologies.at(-1);
  const since = Date.parse(r.canceling ?? "");
  return (
    <Link to="/runs/$id" params={{ id: String(r.id) }} className="igrid trow" role="row">
      <span className="st" role="cell">
        <span className="g g-busy" aria-hidden="true" />
        canceling
      </span>
      <span role="cell">{name}</span>
      <span className="runs-wait" role="cell">
        <span className="runs-say">
          {cancelingWhat(r, {
            platform: around.platform,
            slurm: around.slurm,
            queued: queuedOf(r.id, fitting),
          })}
        </span>
        {!Number.isNaN(since) && <span className="meta">canceling since {clock(since, now)}</span>}
      </span>
    </Link>
  );
}

const pct = (x: number) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`;

/**
 * A run that ended: its numbers, how it compares, when it ended and for how
 * long, and why; Results once it completed, Resume if it failed or was canceled.
 */
function EndedRow({
  run: r,
  platform,
  dataset,
  why,
}: {
  run: RunSummary;
  platform: Platform;
  dataset: RunsDataset | undefined;
  why: string | undefined;
}) {
  const resume = useResume(r.id, platform.name);
  const p = r.progress;
  const c = comparedOf(r, dataset);
  const valTitle = !r.validation
    ? `${r.dataset.name ?? "Its dataset"} has no validation points`
    : undefined;
  const ended = r.ended_at === null ? NaN : Date.parse(r.ended_at);
  return (
    <div className="fgrid trow" role="row">
      <span className={r.state === "failed" ? "st st-failed" : "st"} role="cell">
        <span className={runGlyph(r.state)} aria-hidden="true" />
        {r.state}
      </span>
      <span className="runs-name" role="cell">
        <Link to="/runs/$id" params={{ id: String(r.id) }} className="mono row-link runs-title-sm">
          <span className="runs-quiet">#{r.id}</span> {r.config.name}
          {r.config.deleted && <span className="cfg-gone">deleted</span>}
        </Link>
        <span className="meta runs-ds">
          {r.dataset.name ?? "a dataset this platform never had"}
          {r.dataset.earlier && (
            <>
              {" "}
              · <span className="qual-e">earlier data</span>
            </>
          )}
          {r.dataset.deleted && (
            <>
              {" "}
              · <span className="qual-e">deleted</span>
            </>
          )}
          {!r.validation && (
            <>
              {" "}
              · <span className="qual-e">no validation points</span>
            </>
          )}{" "}
          · <span className="n">{r.num_states}</span> states
        </span>
        {why !== undefined && (
          <span className="runs-why">
            <Whole text={why} />
          </span>
        )}
        {resume.message !== undefined && (
          <span className="err" role="alert">
            {resume.message}
          </span>
        )}
      </span>
      <span className="runs-n" role="cell">
        {p.topologies_complete.toLocaleString("en-US")} / {p.topologies.toLocaleString("en-US")}
      </span>
      <span className="runs-n" role="cell">
        {r.best?.train_rmse == null ? "—" : rmse(r.best.train_rmse)}
      </span>
      <span className="runs-val" role="cell" title={valTitle}>
        {r.best?.val_rmse == null ? "—" : rmse(r.best.val_rmse)}
      </span>
      <span
        className={c.best ? "runs-cmp vbest" : c.word === "—" ? "runs-cmp runs-quiet" : "runs-cmp"}
        role="cell"
        title={c.title || undefined}
      >
        {c.word}
        {c.byTrain && c.word !== "—" && <span className="runs-bytrain"> by train</span>}
      </span>
      <span className="runs-n" role="cell">
        {Number.isNaN(ended) ? "—" : clock(ended, ended)}
      </span>
      <span className="runs-dur" role="cell">
        {/* Its fitting time, which ends with it (#324). */}
        {fitFor(r, ended) ?? "—"}
      </span>
      <span className="runs-act" role="cell">
        {r.state === "completed" && (
          <Link to="/results" search={{ dataset: r.dataset.id, run: r.id }} className="link act">
            Results →
          </Link>
        )}
        {(r.state === "failed" || r.state === "canceled") && (
          <ResumeButton resume={resume} platform={platform} />
        )}
      </span>
    </div>
  );
}

/** Resume, gray until the platform is connected, since only its agent can resume a run. */
function ResumeButton({
  resume,
  platform,
}: {
  resume: ReturnType<typeof useResume>;
  platform: Platform;
}) {
  const c = useConnection();
  const live = c.status === "connected" || c.status === "reconnecting";
  const off = useBlocker(live ? undefined : `Connect to ${inSentence(platform)} to resume`);
  return (
    <>
      <WorkingButton
        type="button"
        className="btn btn-sm"
        working={resume.working}
        words="Resuming…"
        title={live ? "Fits the starts it hasn’t finished, as the same run" : undefined}
        {...off.props}
        onClick={(e) => {
          off.props.onClick(e);
          if (live) void resume.resume();
        }}
      >
        Resume
      </WorkingButton>
      {off.bubble}
    </>
  );
}
