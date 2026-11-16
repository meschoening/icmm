/**
 * Home's Live (LaptopMain, #388): up to 3 runs in flight as cards, in Runs'
 * order and words, then one line naming the rest, with All runs. A running
 * card has its progress, ETA and best so far, live (`.live-n`), with its
 * sparkline; a queued or held one says why it waits, as on Runs, and whose
 * jobs fill the limit.
 */
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { cancelingWhat, firstDueOf } from "../runs/detail";
import { useRunStretches } from "../runs/detailQueries";
import { barOf, againLine, rmse, topologiesLine, topologyName, waitingOf } from "../runs/words";
import { etasOf } from "../submit/plan";
import { runGlyph } from "../submit/words";
import { plural } from "../submit/estimate";
import { useShownPath } from "../ui/paths";
import { LiveN } from "../ui/LiveN";
import { HoverWord } from "../ui/TipWord";
import type { Tooltip } from "../ui/Tooltip";
import { clock, clockInSentence, monthDay } from "../ui/clock";
import type { RunSummary, SavedPlatform } from "../wire/types.gen";
import { useEarlierTip } from "./earlier";
import type { HomeReads } from "./reads";
import { etaLine, LIVE_CARDS, runningLine, sparkOf, SPARK_H, SPARK_W } from "./words";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** A running card's best on hover: it's live (#373). */
export const BEST_TIP = "In progress: these change as its starts finish.";

const pct = (x: number) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`;

export function Live({
  reads,
  platform,
  slurm,
  now,
  asOf,
}: {
  reads: HomeReads;
  platform: Platform;
  slurm: boolean;
  now: number;
  /** When the connection went, while it's away: the ETAs and sparklines stop there. */
  asOf: number | undefined;
}) {
  const inFlight = reads.runs.filter((r) => r.ended_at === null);
  const cards = inFlight.slice(0, LIVE_CARDS);
  const rest = inFlight.slice(LIVE_CARDS);
  const c = reads.overview.counts;
  const restCount = Math.max(
    rest.length,
    c.running + c.canceling + c.queued + c.held - cards.length,
  );
  const cap = reads.job?.max_running_starts;
  const at = asOf ?? now;
  const { etas, dues } = useMemo(() => {
    if (reads.job === undefined || reads.details === undefined) {
      return { etas: new Map<number, number | undefined>(), dues: new Map<number, number>() };
    }
    const around = {
      timings: reads.timings ?? [],
      cpus: reads.job.cpus_per_start,
      cap: reads.job.max_running_starts,
      now: at,
    };
    // Before a run's first topology ends, when it's due (#399, HF05).
    const dues = new Map<number, number>();
    for (const d of reads.details) {
      const due = firstDueOf(d, around);
      if (due !== undefined) dues.set(d.id, due);
    }
    return { etas: etasOf(reads.details, around), dues };
  }, [reads.details, reads.timings, reads.job, at]);
  const began = new Map((reads.details ?? []).map((r) => [r.id, r.first_array_at]));
  const shownPath = useShownPath(platform);
  const around = {
    platform,
    slurm,
    partition: reads.partition,
    cap,
    jobs: reads.jobs,
    inFlight,
    shownPath,
    etas,
  };
  return (
    <section className="home-live" aria-labelledby="home-live">
      <div className="home-region-head">
        <h2 id="home-live" className="label">
          Live
        </h2>
        <Link to="/runs" className="link">
          All runs
        </Link>
      </div>
      {cards.length === 0 && (
        <p className="home-none">Nothing in flight. A run you submit shows here while it fits.</p>
      )}
      {cards.map((r) =>
        r.canceling !== null ? (
          <WaitingCard
            key={r.id}
            run={r}
            word="canceling"
            glyph="g g-busy"
            say={cancelingWhat(r, { platform, slurm, queued: undefined })}
            raw={undefined}
            since={`canceling since ${clock(Date.parse(r.canceling), now)}`}
            now={now}
          />
        ) : r.state === "running" ? (
          <RunningCard
            key={r.id}
            run={r}
            cap={cap}
            eta={etas.get(r.id)}
            due={dues.get(r.id)}
            began={began.get(r.id) ?? null}
            again={againLine(r, platform, now)}
            now={now}
            asOf={asOf}
          />
        ) : (
          <WaitingCard
            key={r.id}
            run={r}
            word={r.state}
            glyph={runGlyph(r.state)}
            {...waitingOf(r, around, now)}
            now={now}
          />
        ),
      )}
      {restCount > 0 && (
        <div className="home-more">
          <span>{restCount.toLocaleString("en-US")} more in flight:</span>
          {rest.map((r) => (
            <span key={r.id} className="home-more-run">
              <span
                className={r.canceling !== null ? "g g-busy" : runGlyph(r.state)}
                aria-hidden="true"
              />
              <Link
                to="/runs/$id"
                params={{ id: String(r.id) }}
                className="mono link home-more-link"
              >
                <span className="home-rid">#{r.id}</span> {r.config.name}
              </Link>
              <span>{r.canceling !== null ? "canceling" : r.state}</span>
            </span>
          ))}
          <span className="home-grow" />
          <Link to="/runs" className="link">
            All runs
          </Link>
        </div>
      )}
    </section>
  );
}

/**
 * "herg-wt · earlier data · 11 states · submitted Sat, Aug 8, 5:58 AM", after the run's word;
 * "earlier data" opens `earlier`, which the card names (#398).
 */
function Facts({
  run: r,
  earlier,
  now,
}: {
  run: RunSummary;
  earlier: Tooltip | undefined;
  now: number;
}) {
  return (
    <>
      {" "}
      · {r.dataset.name ?? "a dataset this platform never had"}
      {earlier !== undefined && (
        <>
          {" "}
          · <HoverWord tip={earlier}>earlier data</HoverWord>
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
    </>
  );
}

function Name({ run: r }: { run: RunSummary }) {
  return (
    <span className="mono home-name">
      <span className="home-rid">#{r.id}</span> {r.config.name}
    </span>
  );
}

function RunningCard({
  run: r,
  cap,
  eta,
  due,
  began,
  again,
  now,
  asOf,
}: {
  run: RunSummary;
  cap: number | undefined;
  eta: number | undefined;
  /** When its first topology is due, before one ends. */
  due: number | undefined;
  began: string | null;
  again: string | undefined;
  now: number;
  asOf: number | undefined;
}) {
  const p = r.progress;
  const bar = barOf(p);
  const best = r.best;
  const value = best === null ? null : (best.val_rmse ?? best.train_rmse);
  const eta_ = etaLine(eta, p, now, asOf);
  const earlier = useEarlierTip(r.dataset);
  return (
    <Link
      to="/runs/$id"
      params={{ id: String(r.id) }}
      className="row-link home-card home-lcard"
      aria-describedby={earlier?.id}
    >
      <span className="home-lmain">
        <span className="home-head">
          <Name run={r} />
          <span className="home-st">
            <span className={runGlyph(r.state)} aria-hidden="true" />
            <span>
              <span className="home-word">running</span>
              <Facts run={r} earlier={earlier} now={now} />
            </span>
          </span>
        </span>
        <span className="home-progress">
          <span
            className="runs-bar"
            role="img"
            aria-label={`${p.topologies_complete} of ${p.topologies} topologies done, ${p.topologies_failed} failed, ${p.topologies_fitting} fitting`}
          >
            <span className="runs-bar-done" style={{ flexBasis: pct(bar.done) }} />
            <span className="runs-bar-failed" style={{ flexBasis: pct(bar.failed) }} />
            <span className="runs-bar-fitting" style={{ flexBasis: pct(bar.fitting) }} />
          </span>
          <span className="home-meta">
            <span>
              {topologiesLine(p)} · {runningLine(p, cap)}
            </span>
            {eta_ !== undefined && <span>{eta_}</span>}
            {again !== undefined && <span>{again}</span>}
          </span>
        </span>
      </span>
      <span className="home-best">
        <span className="label">{r.validation ? "Best val RMSE" : "Best train RMSE"}</span>
        {best === null || value === null ? (
          <>
            <span className="home-big home-quiet">—</span>
            <span className="home-meta home-right home-due">
              {due === undefined
                ? "once a topology finishes"
                : `first topology due around\u00a0${clockInSentence(due, now)}`}
            </span>
          </>
        ) : (
          <>
            <span className="home-big">
              <LiveN tip={BEST_TIP}>{rmse(value)}</LiveN>
            </span>
            <span className="home-of">{topologyName(r.id, best)}</span>
            <Sparkline run={r} began={began} asOf={asOf} now={now} />
          </>
        )}
      </span>
    </Link>
  );
}

/**
 * The run's best so far, from its **Stretches**, from its first array to now,
 * or while stale to when the connection went (`asOf`, #399, HF11).
 */
function Sparkline({
  run: r,
  began,
  asOf,
  now,
}: {
  run: RunSummary;
  began: string | null;
  asOf: number | undefined;
  now: number;
}) {
  const stop = asOf ?? now;
  const stretches = useRunStretches(r.id).data;
  const start = began === null ? NaN : Date.parse(began);
  const spark =
    stretches === undefined
      ? undefined
      : sparkOf(stretches, { began: start, stop, validation: r.validation });
  if (spark === undefined) return null;
  // One value is a flat line, which reads as stuck: it says how far it's got instead (#399, HF06).
  if (spark.values < 2) {
    const done = r.progress.topologies_complete;
    return done > 0 ? (
      <span className="home-meta home-right home-sofar">
        {plural(done, "topology", "topologies")} so far
      </span>
    ) : null;
  }
  return (
    <>
      <svg
        className="home-spark"
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        fill="none"
        aria-hidden="true"
      >
        <path d={`M2 30.5H${SPARK_W - 2}`} className="home-spark-base" />
        <path d={spark.d} className="home-spark-line" />
        <circle cx={SPARK_W - 2} cy={spark.endY} r="2.5" className="home-spark-end" />
      </svg>
      <span className="mono home-spark-axis" aria-hidden="true">
        <span>
          {rmse(spark.first)} · {monthDay(start, now)}
        </span>
        <span>{asOf === undefined ? "now" : clock(asOf, now)}</span>
      </span>
    </>
  );
}

/** A queued, held or canceling card: why it waits, in Runs' words, and the scheduler's own. */
function WaitingCard({
  run: r,
  word,
  glyph,
  say,
  raw,
  since,
  now,
}: {
  run: RunSummary;
  word: string;
  glyph: string;
  say: string;
  raw: string | undefined;
  since: string;
  now: number;
}) {
  const earlier = useEarlierTip(r.dataset);
  return (
    <Link
      to="/runs/$id"
      params={{ id: String(r.id) }}
      className="row-link home-card home-wcard"
      aria-describedby={earlier?.id}
    >
      <Name run={r} />
      <span className="home-st">
        <span className={glyph} aria-hidden="true" />
        <span>
          <span className="home-word">{word}</span>
          <Facts run={r} earlier={earlier} now={now} />
        </span>
      </span>
      <span className="home-say">{say}</span>
      <span className="home-say home-quiet">
        {raw !== undefined && (
          <>
            <span className="mono home-raw">{raw}</span> ·{" "}
          </>
        )}
        {since}
      </span>
    </Link>
  );
}
