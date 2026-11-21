/**
 * Submit run's Platform aside (LaptopSubmitRun's "Where it runs"): the platform
 * the run goes to and the Job defaults it would use, a forecast of when it
 * would begin (the user's SLURM jobs against the cluster's job limit, or this
 * computer's slots, as blocks of the runs holding them), how long each start
 * takes and its pace per topology, and the stages after a submit.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { whole } from "../configs/words";
import { TryAgain } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { memory, upTo } from "../setup/units";
import { clock } from "../ui/clock";
import { besideProps, type Working } from "../ui/working";
import type { JobDefaults, SavedPlatform } from "../wire/types.gen";
import { etaWords, type Block, type Forecast } from "./forecast";
import { plural } from "./estimate";
import { whereProcesses, type Begins, type TimeView } from "./plan";
import { Stages } from "./Stages";
import type { JobsRetry, Plan } from "./usePlan";

/** The platform as far as it's known: an SSH platform's saved entry says its user and host. */
type Platform = Pick<SavedPlatform, "type" | "name"> & {
  user?: string;
  host?: string;
};

/** The most cells a track draws: past it the text carries the count, and the track is a bar. */
const MAX_CELLS = 120;
/** Past this many cells a track has no gaps, since its cells would be thinner than the gaps. */
const DENSE = 32;

/** A figure in the mono face. */
const N = ({ children }: { children: ReactNode }) => <span className="n">{children}</span>;

/** `text` with its numbers in the mono face: "1 h 30 min" as 1 and 30 in it. */
function numbered(text: string): ReactNode {
  return text.split(/(\d+)/).map((part, i) => (i % 2 === 1 ? <N key={i}>{part}</N> : part));
}

export function PlatformAside({
  platform,
  plan,
  now,
  working,
}: {
  platform: Platform;
  plan: Plan;
  now: number;
  /** Submit run's: while a submit is under way, no link here takes the page elsewhere. */
  working: Working;
}) {
  const { slurm } = plan;
  const ssh = platform.user !== undefined && platform.host !== undefined;
  return (
    <aside className="sub-aside sub-akv" aria-label="Where it runs">
      <section aria-labelledby="plat-h" className="sub-plat">
        <div className="sub-plat-head">
          <h2 id="plat-h" className="label">
            Platform
          </h2>
          <Link
            to="/settings"
            hash="platforms"
            className="link sub-plat-link"
            {...besideProps(working)}
          >
            Platform settings
          </Link>
        </div>
        <span className="sub-plat-name">{platform.name}</span>
        {slurm ? (
          <span className="mono sub-plat-sub">
            {ssh ? `${platform.user}@${platform.host} · SLURM` : "SLURM"}
          </span>
        ) : (
          <span className="sub-plat-sub">
            No scheduler · starts run as processes {whereProcesses(platform)}
          </span>
        )}
        <JobRows plan={plan} platform={platform} />
      </section>
      <Box
        begins={plan.begins}
        jobsRetry={plan.jobsRetry}
        slurm={slurm}
        etaPending={plan.etaPending}
        now={now}
        working={working}
      />
      {plan.time !== undefined && plan.job !== undefined && <Rows time={plan.time} />}
      {plan.stages !== undefined && <Stages stages={plan.stages} />}
    </aside>
  );
}

/** Jobs go to, Each start and At once, from the Job defaults; or why they aren't there. */
function JobRows({ plan, platform }: { plan: Plan; platform: Platform }) {
  const job = plan.job;
  if (job === undefined) {
    switch (plan.settings) {
      case "unset":
        return <p className="hint sub-plat-gap">Platform settings aren’t saved yet.</p>;
      case "failed":
        return <p className="hint sub-plat-gap">Couldn’t read Platform settings.</p>;
      case "offline":
        return (
          <p className="hint sub-plat-gap">
            {platform.name} keeps its settings in its Data folder, so they show here once it’s
            connected.
          </p>
        );
      default:
        return <Reading>Reading Platform settings…</Reading>;
    }
  }
  return (
    <dl className="sub-plat-rows">
      {job.type === "slurm" && (
        <Kv k="Jobs go to">
          {job.account !== null ? (
            <span className="nv">{job.account}</span>
          ) : (
            "your default account"
          )}{" "}
          on{" "}
          {job.partition !== null ? (
            <span className="nv">{job.partition}</span>
          ) : (
            "the cluster’s default partition"
          )}
        </Kv>
      )}
      <Kv k="Each start">
        <Each job={job} />
      </Kv>
      <Kv k="At once">
        up to <N>{whole(job.max_running_starts)}</N>{" "}
        {job.type === "slurm"
          ? `${job.max_running_starts === 1 ? "start" : "starts"} per run`
          : `${job.max_running_starts === 1 ? "start" : "starts"}, shared by all runs ${whereProcesses(platform)}`}
      </Kv>
    </dl>
  );
}

function Each({ job }: { job: JobDefaults }) {
  const cpus = (
    <>
      <N>{whole(job.cpus_per_start)}</N> {job.cpus_per_start === 1 ? "CPU" : "CPUs"}
    </>
  );
  if (job.type !== "slurm") return cpus;
  return (
    <>
      {cpus} · <N>{memory(job.memory_per_start_mb)}</N> memory · up to{" "}
      {numbered(upTo(job.time_limit_per_start_min))}
    </>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="sub-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ── the forecast ─────────────────────────────────────────────────────────────────────────────

/** The forecast box: when this run would begin, with the runs holding the slots. */
function Box({
  begins,
  jobsRetry,
  slurm,
  etaPending,
  now,
  working,
}: {
  begins: Begins;
  jobsRetry: JobsRetry;
  slurm: boolean;
  etaPending: ReadonlySet<number>;
  now: number;
  working: Working;
}) {
  const box = begins.box;
  if (box.kind === "none") return null;
  return (
    <div className="sub-fc" role="note">
      {box.kind === "message" ? (
        <p className="hint sub-fc-msg">{box.text}</p>
      ) : box.kind === "jobs_failed" ? (
        // The three lines of a failed read, in the box's own gray: nothing blocks submitting
        // (LaptopSubmitRun's `jobs-failed`, #452).
        <div className="sub-fc-fail">
          <div className="fail-say">
            <p className="fail-what">{box.what}</p>
            <p className="fail-next">{box.next}</p>
            {box.raw !== undefined && <p className="term fail-raw">{box.raw}</p>}
            {jobsRetry.again !== undefined && (
              <p className="hint">
                Tried again at {clock(jobsRetry.again, jobsRetry.again)} · same error
              </p>
            )}
          </div>
          <TryAgain onRetry={jobsRetry.retry} />
        </div>
      ) : (
        <Forecasted
          f={box.forecast}
          slurm={slurm}
          etaPending={etaPending}
          now={now}
          working={working}
        />
      )}
    </div>
  );
}

function Forecasted({
  f,
  slurm,
  etaPending,
  now,
  working,
}: {
  f: Forecast;
  slurm: boolean;
  etaPending: ReadonlySet<number>;
  now: number;
  working: Working;
}) {
  // Two to a row on SLURM, as the board draws them; This computer's few runs fit in one.
  const columns = Math.max(1, Math.min(f.blocks.length, slurm ? 2 : 3));
  return (
    <>
      <div className="sub-fc-head">
        <p className="facts sub-fc-title">{f.head}</p>
        <span className="sub-fc-count">
          <span className="mono">{whole(f.count)}</span>
          {f.of === null ? (
            " running"
          ) : (
            <>
              {" of "}
              <span className="mono">{whole(f.of)}</span>
              {f.tail}
            </>
          )}
        </span>
      </div>
      <div
        className="sub-fc-blocks"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {f.blocks.map((b) => (
          <BlockView
            key={b.kind === "run" ? `run-${b.run}` : b.kind}
            block={b}
            etaPending={etaPending}
            now={now}
            working={working}
          />
        ))}
      </div>
      <div className="sub-fc-say">
        <p className="sub-fc-line">
          {f.glyph !== undefined && <span className={`g g-${f.glyph}`} aria-hidden="true" />}
          <span>{f.say}</span>
        </p>
        {f.raw !== undefined && <span className="mono sub-fc-raw">{f.raw}</span>}
        {f.hint !== undefined && <p className="hint sub-fc-hint">{f.hint}</p>}
      </div>
    </>
  );
}

/** A block of the bar: a track of cells for its jobs or slots, and what they are. */
function BlockView({
  block,
  etaPending,
  now,
  working,
}: {
  block: Block;
  etaPending: ReadonlySet<number>;
  now: number;
  working: Working;
}) {
  const n = block.kind === "run" ? block.starts : block.n;
  const drawn = Math.min(n, MAX_CELLS);
  const cell =
    block.kind === "run"
      ? "sub-cell on live"
      : block.kind === "other"
        ? "sub-cell used"
        : "sub-cell";
  return (
    <div className="sub-block">
      <div
        className={`sub-track${n > DENSE ? " dense" : ""}`}
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${drawn}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: drawn }, (_, i) => (
          <span key={i} className={cell} />
        ))}
      </div>
      {block.kind === "run" ? (
        <Link
          to="/runs/$id"
          params={{ id: String(block.run) }}
          className="row-link sub-block-text"
          {...besideProps(working)}
        >
          <span className="mono sub-block-id">#{block.run}</span> ·{" "}
          {plural(block.starts, "start", "starts")}
          {(block.eta !== undefined || etaPending.has(block.run)) && (
            <span className="sub-eta">
              {block.eta === undefined ? "" : etaWords(block.eta, now)}
            </span>
          )}
        </Link>
      ) : (
        <span className="sub-block-text sub-block-quiet">
          {block.kind === "other"
            ? `${plural(block.n, "other job", "other jobs")}`
            : `${whole(block.n)} free`}
        </span>
      )}
    </div>
  );
}

// ── the rows ─────────────────────────────────────────────────────────────────────────────────

/** Each start and Pace, with the time limit a start runs against. */
function Rows({ time }: { time: TimeView }) {
  return (
    <dl className="sub-rows">
      <Kv k="Each start">
        {time.each}
        {time.limit !== undefined && <span className="sub-dim"> · {time.limit}</span>}
        {time.over && (
          <span className="sub-warn">
            <span className="g g-failed" aria-hidden="true" />
            <span>
              Longer than the time limit, so starts would stop without finishing and fail. Raise
              Time limit per start in Platform settings, or use fewer evaluations.
            </span>
          </span>
        )}
      </Kv>
      <Kv k="Pace">{time.pace}</Kv>
    </dl>
  );
}
