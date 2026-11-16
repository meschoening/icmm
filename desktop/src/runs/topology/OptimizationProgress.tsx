/**
 * Topology's Optimization progress (LaptopTopology, #233; built in #286):
 * each start's best Train RMSE so far against CMA-ES evaluations, from the
 * Progress curves its run's coordinator keeps (`topology_progress`), as All
 * starts or as the finished starts' Median · 10–90 %. Until a start has a
 * line to draw, it says why by the topology's stage.
 */
import { useState } from "react";
import { evaluationsPerStart } from "../../submit/estimate";
import type { FailedStarts, Run, StartCurve, StartSummary, Topology } from "../../wire/types.gen";
import {
  budgetParts,
  PROGRESS_HEIGHT,
  PROGRESS_WIDTH,
  progressOf,
  progressWords,
} from "./progress";
import { segmentOf } from "./queries";
import type { Stage } from "./words";

const drawable = (c: StartCurve) => c.evaluations.length > 0;

export function OptimizationProgress({
  run,
  topology: t,
  starts,
  curves,
  stage,
  causes,
}: {
  run: Run;
  topology: Topology;
  starts: StartSummary[];
  curves: StartCurve[];
  stage: Stage;
  causes: FailedStarts[];
}) {
  const [band, setBand] = useState(false);
  const search = run.settings?.search;
  // Without its settings, a start runs as far as the furthest line goes.
  const perStart =
    search === undefined
      ? Math.max(1, ...curves.map((c) => c.evaluations[c.evaluations.length - 1] ?? 0))
      : evaluationsPerStart(search.evaluation_budget, search.population);
  const budget = budgetParts(perStart);
  const words = progressWords(stage, {
    starts: t.starts,
    queued: t.starts_queued,
    ended: starts.filter((s) => s.state === "finished" || s.state === "canceled").length,
    curves,
    causes,
  });
  const finished = curves.filter((c) => c.state === "finished" && drawable(c)).length;
  const toggles = words === undefined && finished > 0;
  return (
    <section className="topo-progress">
      <div className="topo-h topo-progress-h">
        <h2 className="label">Optimization progress</h2>
        <span className="topo-hint">
          best train RMSE so far against CMA-ES evaluations · every start runs its full{" "}
          <span className="n">{budget.n}</span>
          {budget.unit} evaluations
        </span>
        {toggles && (
          <div className="seg" role="group" aria-label="Progress view">
            <button type="button" aria-pressed={!band} onClick={() => setBand(false)}>
              All starts
            </button>
            <button type="button" aria-pressed={band} onClick={() => setBand(true)}>
              Median · 10–90 %
            </button>
          </div>
        )}
      </div>
      {words === undefined ? (
        <ProgressChart
          curves={curves}
          best={
            t.best === null || t.best.train_rmse === null
              ? null
              : { start: t.best.start, train: t.best.train_rmse }
          }
          perStart={perStart}
          band={toggles && band}
          name={`#${run.id}/${segmentOf(t)}`}
        />
      ) : (
        <div className="chart-empty topo-empty topo-progress-empty">
          <p>{words.lead}</p>
          {words.meta !== "" && <p className="meta">{words.meta}</p>}
        </div>
      )}
    </section>
  );
}

function ProgressChart({
  curves,
  best,
  perStart,
  band,
  name,
}: {
  curves: StartCurve[];
  best: { start: number; train: number } | null;
  perStart: number;
  band: boolean;
  name: string;
}) {
  const p = progressOf(curves, { best, perStart, band, name });
  return (
    <>
      <div className="topo-prog">
        <svg
          width="100%"
          height={PROGRESS_HEIGHT}
          viewBox={`0 0 ${PROGRESS_WIDTH} ${PROGRESS_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={p.aria}
        >
          <path className="topo-prog-grid" d={p.grid} />
          {band ? (
            <>
              <path className="topo-prog-band" d={p.band} />
              <path className="topo-prog-median" d={p.median} />
            </>
          ) : (
            <>
              <path className="topo-prog-done" d={p.done} />
              <path className="topo-prog-stopped" d={p.stopped} />
              <path className="topo-prog-live" d={p.live} />
              <path className="topo-prog-end" d={p.liveEnds} />
            </>
          )}
          <path className="topo-prog-best" d={p.best} />
          {p.bestEnd !== null && (
            <circle className="topo-prog-bestend" cx={p.bestEnd.x} cy={p.bestEnd.y} r="3.5" />
          )}
        </svg>
        {p.labels.map((l) => (
          <span
            key={`${l.kind} ${l.t}`}
            className={`topo-tlab topo-plab-${l.kind}${l.align ? ` ${l.align}` : ""}`}
            style={{ left: l.left, top: l.top }}
            aria-hidden="true"
          >
            {l.t}
          </span>
        ))}
      </div>
      <div className="topo-dotkey topo-prog-key" aria-hidden="true">
        {p.bestEnd !== null && (
          <span>
            <span className="topo-key-line best" />
            best start
          </span>
        )}
        {band ? (
          <span>
            <span className="topo-key-line band" />
            middle 80 % of finished starts
          </span>
        ) : (
          <>
            {p.counts.finished > 0 && (
              <span>
                <span className="topo-key-line" />
                <span>
                  finished · <span className="n">{p.counts.finished}</span>
                </span>
              </span>
            )}
            {p.counts.running > 0 && (
              <span>
                <span className="topo-key-line live" />
                <span>
                  running, so far · <span className="n">{p.counts.running}</span>
                </span>
              </span>
            )}
            {p.counts.canceled > 0 && (
              <span>
                <span className="topo-key-line stopped" />
                <span>
                  canceled, where they stopped · <span className="n">{p.counts.canceled}</span> ·
                  not counted
                </span>
              </span>
            )}
          </>
        )}
      </div>
    </>
  );
}
