/**
 * Run detail's bottom half (LaptopRunDetail, #232): the grid of the run's
 * topologies in the order they're sent, its progress chart, the ranked
 * topologies with their failed ones under them, and the spread of every
 * ranked topology. Past 2,000 topologies (#291) the grid is a bar of the
 * run's counts, and the chart goes under it, at the page's width. Each
 * topology is `#214/T12.3`; its Best start has the lowest Train RMSE, and
 * topologies rank by its Val RMSE (ADR-0006), or its Train RMSE in a run
 * without validation points.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { whole } from "../configs/words";
import { plural } from "../submit/estimate";
import type { FailedStarts, Run, StateGraph, TopologySummary } from "../wire/types.gen";
import {
  failedTopologyWords,
  gridColumns,
  parametersOf,
  phaseOf,
  rankedSub,
  stopped,
  topologiesMiddle,
  topologyId,
  topologyKey,
  type Chart,
  type ChartDrawn,
  type Grid,
  type StateBar,
  type Spread,
  type SpreadDot,
} from "./detail";
import { across, dotAt, SPAN } from "./stretch";
import { ChartLabel, StretchChart } from "./StretchChart";
import { rmse } from "./words";

// ── the grid ──────────────────────────────────────────────────────────────────────────────────

export function TopologyGrid({
  run,
  grid,
  total,
  startsEach,
  more,
}: {
  /** The run's number: each square opens its topology's page (#326). */
  run: number;
  grid: Grid;
  total: number;
  startsEach: number | undefined;
  /** How many topologies weren't read: the run has more than the page reads. */
  more: number;
}) {
  const cols = gridColumns(grid.cells.length);
  const gap = Math.max(1, Math.round((6 * 20) / cols));
  return (
    <div className="rd-topos">
      <div className="rd-sec-head">
        <h2 className="label">Topologies</h2>
        <span className="rd-sec-sub">
          one square each, in the order they’re sent
          {startsEach !== undefined && (
            <>
              {" "}
              · <span className="n">{whole(startsEach)}</span> starts each
            </>
          )}
          {more > 0 && grid.cells.length > 0 && (
            <> · the first {whole(grid.cells.length)} shown</>
          )}
        </span>
      </div>
      <div
        className={cols > 40 ? "rd-grid rd-grid-dense" : "rd-grid"}
        role="group"
        aria-label={`${plural(total, "topology", "topologies")}, in the order they’re sent. ${grid.legend.map((l) => l.t).join(", ")}.`}
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${gap}px` }}
      >
        {grid.cells.map((c) => (
          <Link
            key={c.key}
            to="/runs/$id/$topology"
            params={{ id: String(run), topology: c.id }}
            title={c.title}
            aria-label={c.title}
            className={`rd-cell rd-cell-${c.kind}${c.best ? " rd-cell-best" : ""}`}
            style={
              c.shade === undefined
                ? undefined
                : { background: `color-mix(in oklab, var(--cobalt) ${c.shade}%, var(--bg))` }
            }
          >
            {c.kind === "failed" && cols <= 40 && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            )}
            {c.fill !== undefined && (
              <span
                className={c.kind === "fitting" ? "rd-fill live" : "rd-fill"}
                style={{ height: `${(c.fill * 100).toFixed(1)}%` }}
              />
            )}
          </Link>
        ))}
      </div>
      <div className="rd-legend">
        <div className="rd-legend-items">
          {grid.legend.map((l) => (
            <span key={l.kind}>
              <span className={`rd-sw rd-sw-${l.kind}`} aria-hidden="true">
                {l.kind === "failed" && (
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M1 1l6 6M7 1 1 7" />
                  </svg>
                )}
                {l.kind === "fitting" && <span className="rd-sw-fill" />}
              </span>
              <span>{l.t}</span>
            </span>
          ))}
        </div>
        {grid.shade !== undefined && (
          <div className="rd-shade">
            <span>Shade of a complete square = its {grid.shade.metric}:</span>
            {grid.shade.lo === grid.shade.hi ? (
              // One value has no range: its shade and the value (#424 KF18).
              <span className="rd-shade-scale">
                <span className="rd-shade-swatch" aria-hidden="true" />
                <span className="mono">{grid.shade.lo}</span>
              </span>
            ) : (
              <>
                <span className="rd-shade-scale">
                  <span className="mono">{grid.shade.lo}</span>
                  <span className="rd-shade-bar" aria-hidden="true" />
                  <span className="mono">{grid.shade.hi}</span>
                </span>
                <span>(stronger color = lower)</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Past 2,000 topologies, the run's topologies by state: one bar, its counts under it. */
export function TopologyBar({
  bar,
  startsEach,
}: {
  bar: StateBar;
  startsEach: number | undefined;
}) {
  return (
    <div className="rd-topos">
      <div className="rd-sec-head">
        <h2 className="label">Topologies</h2>
        {startsEach !== undefined && (
          <span className="rd-sec-sub">
            <span className="n">{whole(startsEach)}</span> starts each
          </span>
        )}
      </div>
      <div className="rd-bar" role="img" aria-label={bar.aria}>
        {bar.segments.map((s) => (
          <span
            key={s.kind}
            className={s.kind === "fitting" ? "rd-bar-fitting live" : `rd-bar-${s.kind}`}
            style={{ flexGrow: s.n }}
          />
        ))}
      </div>
      <div className="rd-bar-legend">
        {bar.legend.map((l) => (
          <span key={l.kind}>
            <span className={`rd-bar-sw rd-bar-${l.kind}`} aria-hidden="true" />
            <span>{l.t}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── the chart ─────────────────────────────────────────────────────────────────────────────────

/** A tick's words: as few decimals as tell the three apart. */
function tickWords(ticks: [number, number, number]): string[] {
  for (let d = 2; d <= 6; d++) {
    const w = ticks.map((t) => t.toFixed(d));
    if (new Set(w).size === 3 && ticks.every((t, i) => Math.abs(Number(w[i]) - t) < 1e-9)) {
      return w;
    }
  }
  return ticks.map((t) => t.toPrecision(3));
}

/** Past this many dots, the chart's shrink and fade, so the best line reads through them. */
const DENSE_DOTS = 200;

export function ProgressChart({ chart }: { chart: Chart }) {
  const d = chart.drawn;
  return (
    <div className="rd-progress">
      <div className="rd-sec-head">
        <h2 className="label">Progress</h2>
        <span className="rd-sec-sub">{chart.caption}</span>
      </div>
      {d === undefined ? (
        <div className="rd-chart-empty">
          <p>{chart.empty?.what}</p>
          {chart.empty?.estimate !== "" && <p className="rd-meta">{chart.empty?.estimate}</p>}
        </div>
      ) : (
        <>
          {d.wide ? <WideChart d={d} /> : <NarrowChart d={d} />}
          <div className="rd-chart-legend">
            {!d.wide && (
              <span>
                <span className="rd-k-dot" aria-hidden="true" />a complete topology’s best
              </span>
            )}
            <span>
              <span className="rd-k-line" aria-hidden="true" />
              best of all finished starts
            </span>
            {d.projection !== undefined && (
              <span>
                <span className="rd-k-proj" aria-hidden="true" />
                {d.projection.word}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The chart beside the grid, 456 px wide, up to 2,000 topologies: a dot a complete topology. */
function NarrowChart({ d }: { d: ChartDrawn }) {
  const dense = d.dots.length > DENSE_DOTS;
  const mid = topologiesMiddle(d.topologies.total);
  return (
    <div className="rd-chart">
      <svg
        width="456"
        height="296"
        viewBox="0 0 456 296"
        fill="none"
        role="img"
        aria-label={d.aria}
      >
        <path
          className="rd-c-grid"
          d={`M48 116.5H452${mid === undefined ? "" : `M48 ${mid.y}H452`}M48 32.5H452`}
        />
        <text className="rd-ax" x="40" y="120" textAnchor="end">
          0
        </text>
        {mid !== undefined && (
          <text className="rd-ax" x="40" y={mid.y + 3.5} textAnchor="end">
            {whole(mid.n)}
          </text>
        )}
        <text className="rd-ax" x="40" y="36" textAnchor="end">
          {whole(d.topologies.total)}
        </text>
        {d.projection !== undefined && (
          <>
            <path className="rd-c-proj" d={d.projection.line} />
            <path className="rd-c-rule" d={`M${d.projection.etaX.toFixed(1)} 26V116`} />
          </>
        )}
        <path className="rd-c-line" d={d.topologies.line} />
        <circle className="rd-c-now-dot" cx={d.topologies.lastX} cy={d.topologies.lastY} r="3.5" />

        <path className="rd-c-grid" d="M48 256.5H452M48 214.5H452M48 172.5H452" />
        {tickWords(d.ticks).map((t, i) => (
          <text key={i} className="rd-ax" x="40" y={260 - i * 42} textAnchor="end">
            {t}
          </text>
        ))}
        {d.dots.map((p, i) => (
          <circle
            key={i}
            className={dense ? "rd-c-dot rd-c-dot-dense" : "rd-c-dot"}
            cx={p.x}
            cy={p.y}
            r={dense ? "1.5" : "2.5"}
          />
        ))}
        <path className="rd-c-step" d={d.step} />
        <path
          className="rd-c-now"
          d={`M${d.now.x.toFixed(1)} 26V116M${d.now.x.toFixed(1)} 166V256`}
        />
        <path className="rd-c-axis" d="M48 272.5H452" />
        {d.days.map((day) => (
          <g key={`${day.x}`}>
            <path className="rd-c-axis" d={`M${day.x.toFixed(1)} 272V277`} />
            <text className="rd-ax" x={day.x} y="290" textAnchor="middle">
              {day.label}
            </text>
          </g>
        ))}
      </svg>
      <ChartLabel x={0} y={13} anchor="start" sans>
        Topologies complete
      </ChartLabel>
      <ChartLabel x={0} y={150} anchor="start" sans>
        {d.title}
      </ChartLabel>
      <ChartLabel
        x={d.now.x > 300 ? d.now.x - 6 : d.now.x + 6.4}
        y={d.topologies.lastY + (d.now.x > 300 ? -8 : 4)}
        anchor={d.now.x > 300 ? "end" : "start"}
      >
        {whole(d.topologies.done)}
      </ChartLabel>
      <ChartLabel
        x={d.best.x > 300 ? d.best.x - 6 : d.best.x + 6.4}
        y={d.best.y + (d.best.x > 300 ? -8 : 4)}
        anchor={d.best.x > 300 ? "end" : "start"}
        tone="cobalt"
        ground
      >
        {d.best.value}
      </ChartLabel>
      <ChartLabel
        x={d.now.x}
        y={162}
        anchor={d.now.x > 300 ? "end" : d.now.x < 120 ? "start" : "middle"}
      >
        {d.now.text}
      </ChartLabel>
      {d.projection !== undefined && (
        <ChartLabel x={448} y={22} anchor="end" tone="ink-2">
          {d.projection.eta}
        </ChartLabel>
      )}
    </div>
  );
}

/** Past this share of the way across, the now point's words sit to its left. */
const LEFT_OF_NOW = 0.2;

/**
 * The chart at the page's width, past 2,000 topologies (#291): the run's
 * topologies complete and its best line, from its stretches, with no dots;
 * its words sit above and left of the now point.
 */
function WideChart({ d }: { d: ChartDrawn }) {
  const left = d.now.x / SPAN >= LEFT_OF_NOW;
  const at = across((left ? d.now.x - 4 : d.now.x + 4) / SPAN);
  const anchor = left ? "end" : "start";
  const p = d.projection;
  const mid = topologiesMiddle(d.topologies.total);
  return (
    <StretchChart
      height={296}
      aria={d.aria}
      axis={
        <>
          <text className="rd-ax" x="40" y="120" textAnchor="end">
            0
          </text>
          {mid !== undefined && (
            <text className="rd-ax" x="40" y={mid.y + 3.5} textAnchor="end">
              {whole(mid.n)}
            </text>
          )}
          <text className="rd-ax" x="40" y="36" textAnchor="end">
            {whole(d.topologies.total)}
          </text>
          {tickWords(d.ticks).map((t, i) => (
            <text key={i} className="rd-ax" x="40" y={260 - i * 42} textAnchor="end">
              {t}
            </text>
          ))}
        </>
      }
      plot={
        <>
          <path
            className="rd-c-grid"
            d={`M0 116.5H${SPAN}${mid === undefined ? "" : `M0 ${mid.y}H${SPAN}`}M0 32.5H${SPAN}`}
          />
          {p !== undefined && (
            <>
              <path className="rd-c-proj" d={p.line} />
              <path className="rd-c-rule" d={`M${p.etaX.toFixed(1)} 26V116`} />
            </>
          )}
          <path className="rd-c-line" d={d.topologies.line} />
          <path className="rd-c-now-mark" d={dotAt(d.topologies.lastX, d.topologies.lastY)} />
          <path className="rd-c-grid" d={`M0 256.5H${SPAN}M0 214.5H${SPAN}M0 172.5H${SPAN}`} />
          <path className="rd-c-step" d={d.step} />
          <path
            className="rd-c-now"
            d={`M${d.now.x.toFixed(1)} 26V116M${d.now.x.toFixed(1)} 166V256`}
          />
          <path className="rd-c-axis" d={`M0 272.5H${SPAN}`} />
          <path
            className="rd-c-axis"
            d={d.days.map((day) => `M${day.x.toFixed(1)} 272V277`).join("")}
          />
        </>
      }
    >
      <ChartLabel x={0} y={13} anchor="start" sans>
        Topologies complete
      </ChartLabel>
      <ChartLabel x={0} y={150} anchor="start" sans>
        {d.title}
      </ChartLabel>
      <ChartLabel x={at} y={d.topologies.lastY + (left ? -8 : 4)} anchor={anchor}>
        {whole(d.topologies.done)}
      </ChartLabel>
      <ChartLabel x={at} y={d.best.y + (left ? -8 : 4)} anchor={anchor} tone="cobalt" ground>
        {d.best.value}
      </ChartLabel>
      <ChartLabel x={across(d.now.x / SPAN)} y={162} anchor={anchor}>
        {d.now.text}
      </ChartLabel>
      {p !== undefined && (
        <ChartLabel x={across(1)} y={22} anchor="end" tone="ink-2">
          {p.eta}
        </ChartLabel>
      )}
      {d.days.map((day) => (
        <ChartLabel
          key={`${day.x}`}
          x={across(day.x / SPAN)}
          y={290}
          anchor="middle"
          tone="ink-3"
          small
        >
          {day.label}
        </ChartLabel>
      ))}
    </StretchChart>
  );
}

// ── ranked topologies ─────────────────────────────────────────────────────────────────────────

/** How many ranked topologies the table shows. */
const TOP = 8;

/** A spread's x in the 200-wide box: 0 to 0.6 across it. */
const BX = (v: number) => 4 + (Math.min(Math.max(v, 0), 0.6) / 0.6) * 192;

/** A typed limit, or `undefined` when it isn't a number. */
function limitOf(typed: string): number | undefined {
  const t = typed.trim().replace("−", "-");
  if (t === "" || !/^\d*\.?\d+$/.test(t)) return undefined;
  return Number(t);
}

export function RankedTopologies({
  run: r,
  ranked,
  rankedCount,
  failed,
  causes,
  graphs,
}: {
  run: Run;
  /** The ranked topologies read, best first. */
  ranked: TopologySummary[];
  rankedCount: number;
  /** The run's failed topologies, in the order they were sent. */
  failed: TopologySummary[];
  causes: Map<string, FailedStarts[]>;
  /** Each topology's state graph, for its parameters; missing until read. */
  graphs: ReadonlyMap<number, StateGraph> | undefined;
}) {
  const [maxTrain, setMaxTrain] = useState("");
  const [maxVal, setMaxVal] = useState("");
  const train = limitOf(maxTrain);
  const val = limitOf(maxVal);
  const withBest = ranked.filter((t) => t.best !== null);
  const shown = withBest
    .filter(
      (t) =>
        (train === undefined || (t.best?.train_rmse != null && t.best.train_rmse <= train)) &&
        (val === undefined || (t.best?.val_rmse != null && t.best.val_rmse <= val)),
    )
    .slice(0, TOP);
  const phase = phaseOf(r);
  const ended = stopped(phase);
  const provisional = withBest.filter((t) => t.provisional && t.state === "fitting").length;
  const params = (t: TopologySummary) => {
    const g = graphs?.get(t.graph);
    return g === undefined ? "—" : String(parametersOf(r.num_states, g.edges.length));
  };
  const val_ = r.validation;
  const filtered = train !== undefined || val !== undefined;
  const tableClass = val_ ? "rd-table" : "rd-table rd-noval";
  return (
    <section className="rd-ranked" aria-labelledby="rd-ranked-h">
      <div className="rd-sec-head rd-ranked-head">
        <h2 id="rd-ranked-h" className="label">
          Ranked topologies
        </h2>
        <span className="rd-sec-sub">{rankedSub(r, rankedCount, provisional, TOP)}</span>
        <div className="rd-filters">
          <label>
            <span>Max train RMSE</span>
            <input
              className="input input-sm mono"
              type="text"
              inputMode="decimal"
              placeholder="any"
              value={maxTrain}
              onChange={(e) => setMaxTrain(e.target.value)}
            />
          </label>
          {val_ && (
            <label>
              <span>Max val RMSE</span>
              <input
                className="input input-sm mono"
                type="text"
                inputMode="decimal"
                placeholder="any"
                value={maxVal}
                onChange={(e) => setMaxVal(e.target.value)}
              />
            </label>
          )}
        </div>
      </div>
      <div role="table" aria-label="Ranked topologies" className={tableClass}>
        <div className="rd-row rd-colhead" role="row">
          <span className="th rd-r" role="columnheader">
            Rank
          </span>
          <span className="th" role="columnheader">
            Topology
          </span>
          <span className="th" role="columnheader">
            Status
          </span>
          <span className="th rd-r" role="columnheader">
            Params
          </span>
          <span className="th rd-r" role="columnheader" title="Finished starts out of its starts">
            Starts
          </span>
          <span
            className="th rd-r"
            role="columnheader"
            title="Finished starts whose Train RMSE is within 1 % of the Best start’s, the Best start included"
          >
            Near best
          </span>
          <span className="th rd-r" role="columnheader">
            Train
          </span>
          {val_ && (
            <span className="th rd-r" role="columnheader">
              Val
            </span>
          )}
          <span className="rd-spread-h" role="columnheader">
            <span className="th rd-spread-w">Param spread · 0–0.6</span>
            <span className="th">Median</span>
          </span>
        </div>
        {shown.map((t) => {
          // A topology still fitting is in progress, and its live numbers are underlined (#370).
          const status = t.state === "fitting" ? (ended ? "unfinished" : "in progress") : t.state;
          const glyph =
            status === "in progress"
              ? "g g-running live"
              : status === "unfinished"
                ? "g g-canceled"
                : "g g-completed";
          const partial = t.state === "fitting";
          const liveN = partial && !ended ? "live-n" : undefined;
          const best = withBest.indexOf(t) === 0;
          const s = t.spread;
          return (
            <Link
              key={topologyKey(t)}
              to="/runs/$id/$topology"
              params={{ id: String(r.id), topology: topologyId(t) }}
              className={best ? "rd-row trow rd-best" : "rd-row trow"}
              role="row"
            >
              <span className="num rd-quiet" role="cell">
                {whole(withBest.indexOf(t) + 1)}
              </span>
              <span className="mono rd-tid" role="cell">
                <span className="rd-quiet">#{r.id}/</span>
                {topologyId(t)}
              </span>
              <span className="st" role="cell">
                <span className={glyph} aria-hidden="true" />
                {status}
              </span>
              <span className="num rd-ink2" role="cell">
                {params(t)}
              </span>
              <span className={partial ? "num" : "num rd-quiet"} role="cell">
                {whole(t.starts_finished)} / {whole(t.starts)}
              </span>
              <span className="num" role="cell">
                {t.near_best === null ? "—" : `${whole(t.near_best)} / ${whole(t.starts_finished)}`}
              </span>
              <span
                className={val_ ? "num rd-ink2" : best ? "num rd-key rd-cobalt" : "num rd-key"}
                role="cell"
              >
                <span className={liveN}>
                  {t.best?.train_rmse == null ? "—" : rmse(t.best.train_rmse)}
                </span>
              </span>
              {val_ && (
                <span className={best ? "num rd-key rd-cobalt" : "num rd-key"} role="cell">
                  <span className={liveN}>
                    {t.best?.val_rmse == null ? "—" : rmse(t.best.val_rmse)}
                  </span>
                </span>
              )}
              <span className="rd-spread" role="cell">
                <svg width="200" height="22" viewBox="0 0 200 22" fill="none" aria-hidden="true">
                  <path className="rd-sp-frame" d="M4 3V19M100 7V15M196 3V19" />
                  <path className="rd-sp-base" d="M4 11.5H196" />
                  {s !== null && (
                    <>
                      <path
                        className="rd-sp-whisker"
                        d={`M${BX(s.min).toFixed(1)} 11.5H${BX(s.q1).toFixed(1)}M${BX(s.q3).toFixed(1)} 11.5H${BX(s.max).toFixed(1)}`}
                      />
                      <rect
                        className={best ? "rd-sp-box rd-sp-box-best" : "rd-sp-box"}
                        x={BX(s.q1).toFixed(1)}
                        y="6"
                        width={Math.max(1, BX(s.q3) - BX(s.q1)).toFixed(1)}
                        height="11"
                        rx="1.5"
                      />
                      <path
                        className={best ? "rd-sp-med rd-sp-med-best" : "rd-sp-med"}
                        d={`M${BX(s.median).toFixed(1)} 4V19`}
                      />
                    </>
                  )}
                </svg>
                <span className="rd-median">
                  <span className={s === null || liveN === undefined ? "mono" : "mono live-n"}>
                    {s === null ? "—" : s.median.toFixed(2)}
                  </span>
                </span>
              </span>
            </Link>
          );
        })}
        {shown.length === 0 && (
          <p className="rd-empty">
            {filtered && withBest.length > 0
              ? "No ranked topology is within those limits."
              : r.progress.starts_finished === 0 && stopped(phase)
                ? "No start finished, so no topology ranks."
                : "Nothing ranks yet. A topology ranks here once one of its starts finishes."}
          </p>
        )}
        {failed.length > 0 && (
          <div role="rowgroup" aria-label="Failed">
            <div className="rd-fgrp" role="row">
              <span className="label" role="rowheader">
                Failed
              </span>
              <span className="mono rd-ink2">{whole(failed.length)}</span>
              <span className="rd-quiet">
                {failed.length === 1
                  ? "no start finished, so it doesn’t rank"
                  : "no start finished, so they don’t rank"}
              </span>
            </div>
            {failed.map((t) => (
              <Link
                key={topologyKey(t)}
                to="/runs/$id/$topology"
                params={{ id: String(r.id), topology: topologyId(t) }}
                className="rd-row trow"
                role="row"
              >
                <span className="num rd-quiet" role="cell">
                  —
                </span>
                <span className="mono rd-tid" role="cell">
                  <span className="rd-quiet">#{r.id}/</span>
                  {topologyId(t)}
                </span>
                <span className="st st-failed" role="cell">
                  <span className="g g-failed" aria-hidden="true" />
                  failed
                </span>
                <span className="num rd-ink2" role="cell">
                  {params(t)}
                </span>
                <span className="num rd-quiet" role="cell">
                  {whole(t.starts_finished)} / {whole(t.starts)}
                </span>
                <span className="num rd-quiet" role="cell">
                  —
                </span>
                <span className="num rd-quiet" role="cell">
                  —
                </span>
                {val_ && (
                  <span className="num rd-quiet" role="cell">
                    —
                  </span>
                )}
                <span className="rd-fwhy" role="cell">
                  {failedTopologyWords(t, causes.get(topologyKey(t)))}
                </span>
              </Link>
            ))}
          </div>
        )}
        <div className="rd-foot">
          {rankedCount > TOP && (
            <Link to="/results" search={{ dataset: r.dataset.id, run: r.id }} className="link">
              All {whole(rankedCount)} ranked topologies in Results →
            </Link>
          )}
          <span className="rd-footnote">
            Near best: finished starts within 1&#160;% of the Best start’s Train RMSE, the Best
            start included. Param spread: each parameter’s SD across the topology’s Top&#160;10
            starts by Train RMSE, as a share of its bound range; box = middle half of the
            parameters, whiskers = all, the open state’s pair left out.
            {!val_ &&
              ` ${r.dataset.name ?? "Its dataset"} has no validation points, so topologies rank by the Best start’s Train RMSE.`}
          </span>
        </div>
      </div>
    </section>
  );
}

// ── the spread of every ranked topology ───────────────────────────────────────────────────────

/** A median spread's y in the plot: 0 to 0.6 up it. */
const SY = (v: number) => 146 - (Math.min(Math.max(v, 0), 0.6) / 0.6) * 112;

const dot = (d: SpreadDot) => dotAt(d.x * SPAN, SY(d.median));

export function SpreadPlot({ spread: s }: { spread: Spread | undefined }) {
  if (s === undefined) return null;
  return (
    <details className="rd-ident">
      <summary>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M4 2.5 7.5 6 4 9.5" />
        </svg>
        <span className="label">{s.title}</span>
        <span className="rd-sec-sub">{s.sub}</span>
      </summary>
      <StretchChart
        className="rd-ident-plot"
        height={170}
        frame={192}
        aria={s.aria}
        axis={
          <>
            <text className="rd-ax" x="40" y="150" textAnchor="end">
              0
            </text>
            <text className="rd-ax" x="40" y="94" textAnchor="end">
              0.3
            </text>
            <text className="rd-ax" x="40" y="38" textAnchor="end">
              0.6
            </text>
          </>
        }
        plot={
          <>
            <path className="rd-c-grid" d={`M0 146.5H${SPAN}M0 90.5H${SPAN}M0 34.5H${SPAN}`} />
            <path
              className="rd-c-axis"
              d={s.ticks.map((t) => `M${t.at * SPAN} 146V151`).join("")}
            />
            <path
              className={s.dense ? "rd-sp-dots rd-sp-dots-dense" : "rd-sp-dots"}
              d={s.rest.map(dot).join("")}
            />
            {s.best !== undefined && <path className="rd-sp-dots-best" d={dot(s.best)} />}
          </>
        }
      >
        {s.ticks.map((t, k) => (
          <ChartLabel
            key={t.at}
            className="rd-sp-tick"
            x={across(t.at)}
            y={168}
            anchor={k === 0 ? "start" : k === s.ticks.length - 1 ? "end" : "middle"}
            tone="ink-3"
            small
          >
            {t.words}
          </ChartLabel>
        ))}
        <ChartLabel x="calc(100% - 4px)" y={186} anchor="end" sans>
          {s.word}
        </ChartLabel>
        {s.best !== undefined && (
          <ChartLabel
            x={across(s.best.x)}
            y={SY(s.best.median) - 12}
            anchor="start"
            tone="cobalt"
            ground
          >
            {s.best.name}
          </ChartLabel>
        )}
      </StretchChart>
    </details>
  );
}
