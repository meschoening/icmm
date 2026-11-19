/**
 * Compare's sections (LaptopCompare, #54): the chips, the fit by protocol,
 * Metrics, the spread across each Top 10, the parameters per candidate and
 * each topology drawn. Each takes what `words.ts` says; nothing here reads.
 */
import { Link } from "@tanstack/react-router";
import { useMemo, type Ref } from "react";
import { ImprovingMark } from "../runs/ImprovingMark";
import { OVERLAY, STRIP, overlayOf, type Label } from "../runs/start/charts";
import { pickKey, pickName, type SelectedStart } from "../selection/selection";
import { TopologyDrawing } from "../topology/Drawing";
import { TOPOLOGY_PAGE } from "../topology/size";
import { useLayouts } from "../topology/useLayouts";
import { useBlocker } from "../ui/blocker";
import { GetNewest } from "../ui/GetNewest";
import { LiveN } from "../ui/LiveN";
import { ProtocolNames } from "../ui/ProtocolNames";
import type { StateGraph } from "../wire/types.gen";
import {
  LETTERS,
  SLOTS,
  topologyName,
  type Candidate,
  type DataGroup,
  type MetricRow,
  type ShownProtocol,
  type Warning,
} from "./words";

/** A candidate's line, as its legend shows it. */
export function Swatch({ i, width = 20 }: { i: number; width?: number }) {
  const s = SLOTS[i];
  return (
    <svg width={width} height="8" viewBox={`0 0 ${width} 8`} fill="none" aria-hidden="true">
      <path
        d={`M1 4h${width - 2}`}
        stroke={s.stroke}
        strokeWidth="1.8"
        strokeDasharray={s.dash || undefined}
      />
    </svg>
  );
}

const startParams = (p: Pick<SelectedStart, "run" | "graph" | "open_state" | "start">) => ({
  id: String(p.run),
  topology: `T${p.graph}.${p.open_state}`,
  start: String(p.start),
});

/** `#211/`, quieter, then `T12.0 · start 37`. */
function PickId({ pick }: { pick: SelectedStart }) {
  return (
    <span className="cid">
      <span className="rid">#{pick.run}/</span>T{pick.graph}.{pick.open_state} · start {pick.start}
    </span>
  );
}

// ── the chips ─────────────────────────────────────────────────────────────────────────────────

export interface Chip {
  pick: SelectedStart;
  /** Its data, when the candidates' data differ. */
  data: string | undefined;
  fitting: boolean;
}

/**
 * The selection's starts, each a chip that opens its start's page, with × to
 * take it out; then Add candidate, which opens Results with the selection
 * kept, grayed once Compare holds 3.
 */
export function Chips({
  chips,
  full,
  onRemove,
  chipRef,
  addRef,
  still,
}: {
  chips: readonly Chip[];
  full: boolean;
  onRemove: (pick: SelectedStart, at: number) => void;
  chipRef: (at: number) => Ref<HTMLButtonElement>;
  addRef: Ref<HTMLAnchorElement>;
  /** Not connected: running glyphs hold still. */
  still: boolean;
}) {
  const add = useBlocker(full ? "Compare holds 3. Remove one first." : undefined);
  return (
    <div className="cmp-chips">
      {chips.map((c, i) => (
        <div key={pickKey(c.pick)} className="cchip">
          <Link
            to="/runs/$id/$topology/$start"
            params={startParams(c.pick)}
            className="open"
            aria-label={`Open ${pickName(c.pick)}`}
          >
            <Swatch i={i} width={28} />
            <span className="let">{LETTERS[i]}</span>
            <PickId pick={c.pick} />
            {c.data !== undefined && <span className="cds">{c.data}</span>}
            {c.fitting && (
              <span className="cfit">
                <span className={`g g-running${still ? "" : " live"}`} aria-hidden="true" />
                fitting
              </span>
            )}
          </Link>
          <button
            ref={chipRef(i)}
            type="button"
            className="icon-btn btn-sm"
            aria-label={`Remove ${pickName(c.pick)} from the selection`}
            onClick={() => onRemove(c.pick, i)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="m2 2 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      ))}
      <span className="cmp-blk l">
        <Link to="/results" ref={addRef} className="addc" {...add.props}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Add candidate
        </Link>
        {add.bubble}
      </span>
    </div>
  );
}

// ── the fit by protocol ───────────────────────────────────────────────────────────────────────

/** Labels laid over a drawing of `width`, each at its place. */
function Labels({ labels }: { labels: Label[] }) {
  return (
    <>
      {labels.map((l, i) => (
        <span
          key={i}
          className={`sp-lab${l.align ? ` ${l.align}` : ""}`}
          style={{ left: l.left, top: l.top }}
          aria-hidden="true"
        >
          {l.t}
        </span>
      ))}
    </>
  );
}

/** A row's RMSE as a screen reader says it: "—" as its meaning, none as its note, its metric's word. */
const said = (r: { value: string; note: string; metric: string | undefined; why?: string }) =>
  r.value === "—"
    ? `none, ${r.why ?? "a sweep failed"}`
    : r.value === ""
      ? r.note
      : r.metric === undefined
        ? r.value
        : `${r.metric} ${r.value}`;

function ProtocolFit({
  p,
  letters,
  fromLine,
}: {
  p: ShownProtocol;
  letters: readonly string[];
  /** Whether a chart of the band says whose points it draws, so each keeps the line. */
  fromLine: boolean;
}) {
  const o = useMemo(() => overlayOf(p.points, p.lines, p.logx), [p]);
  const low = p.rows.filter((r) => r.lowest).map((r) => r.letter);
  const aria =
    `${p.name}, ${p.label}: ` +
    `${letters.filter((_, i) => p.lines[i] !== undefined).join(", ") || "no"} fit${p.lines.filter(Boolean).length === 1 ? "" : "s"} over ${p.over}. ` +
    `${p.metric === undefined ? "" : `${p.metric} `}RMSE: ${p.rows.map((r) => `${r.letter} ${said(r)}`).join(", ")}` +
    (low.length > 0 ? `; lowest ${low.join(" and ")}.` : ".");
  return (
    <div className="cmp-fcell">
      <div className="cmp-fname">
        <span className="mono">{p.name}</span>
        <span className="cmp-flabel">{p.label}</span>
        {fromLine && (
          <span className="cmp-pfrom" title={p.from}>
            {p.from}
          </span>
        )}
      </div>
      <span className="cmp-plot">
        <svg
          width={OVERLAY.width}
          height={OVERLAY.height}
          viewBox={`0 0 ${OVERLAY.width} ${OVERLAY.height}`}
          fill="none"
          role="img"
          aria-label={aria}
        >
          <path className="sp-grid" d={o.grid} />
          <path className="sp-base" d={o.base} />
          <path className="cmp-whisk" d={o.whiskers} />
          {[...o.models.keys()]
            .reverse()
            .map((i) =>
              o.models[i] === "" ? null : (
                <path
                  key={i}
                  d={o.models[i]}
                  stroke={SLOTS[i].stroke}
                  strokeWidth="1.8"
                  strokeDasharray={SLOTS[i].dash || undefined}
                />
              ),
            )}
          <path className="sp-k-dot" d={o.dots} />
          <path className="sp-k-ring" d={o.rings} />
          <path className="sp-k-dot" d={o.diamonds} />
          <path className="sp-k-ring" d={o.hollow} />
        </svg>
        <Labels labels={o.labels} />
      </span>
      <span className="cmp-strip">
        <svg
          width={STRIP.width}
          height={STRIP.height}
          viewBox={`0 0 ${STRIP.width} ${STRIP.height}`}
          fill="none"
          aria-hidden="true"
        >
          <path className="cmp-sbox" d={o.strip.box} />
          <path className="cmp-szero" d={o.strip.zero} />
          {[...o.strip.lines.keys()]
            .reverse()
            .map((i) =>
              o.strip.lines[i] === "" ? null : (
                <path
                  key={i}
                  d={o.strip.lines[i]}
                  stroke={SLOTS[i].stroke}
                  strokeWidth="1.6"
                  strokeDasharray={SLOTS[i].dash || undefined}
                />
              ),
            )}
        </svg>
        <Labels labels={o.strip.labels} />
      </span>
      <div
        role="table"
        aria-label={`${p.metric === undefined ? "" : `${p.metric} `}RMSE on ${p.name} by candidate`}
        className="cmp-stab"
      >
        {p.rows.map((r, i) => (
          <div role="row" key={r.letter} className="srow">
            <Swatch i={i} />
            <span role="rowheader" className="sl">
              {r.letter}
            </span>
            <span role="cell" className="sn" title={r.note || undefined}>
              {r.note}
            </span>
            <span className={r.lowest ? "ldot on" : "ldot"} aria-hidden="true" />
            <span role="cell" className={`sv${r.lowest ? " lo" : ""}`}>
              {r.metric !== undefined && <span className="mw">{r.metric} </span>}
              {r.value}
              {r.lowest && <span className="sr-only"> (lowest)</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const Info = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
    <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6.5 5.6v3.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="6.5" cy="3.8" r=".8" fill="currentColor" />
  </svg>
);

export function FitSection({
  protocols,
  groups,
  pointsFrom,
  onPointsFrom,
  validation,
  caveat,
  warnings,
  foot,
}: {
  protocols: readonly ShownProtocol[];
  groups: readonly DataGroup[];
  pointsFrom: number;
  onPointsFrom: (i: number) => void;
  /** Whether any shown data has validation points, for the legend. */
  validation: boolean;
  caveat: { lead: string; rest: string } | undefined;
  warnings: readonly Warning[];
  foot: { says: string; low: string };
}) {
  const span = groups.length > 1;
  const letters = LETTERS.slice(0, protocols[0]?.rows.length ?? 0);
  const fromLine = protocols.some((p) => p.from !== undefined);
  return (
    <section className="cmp-fit" aria-labelledby="cmp-fit-h">
      <div className="cmp-fhead">
        <h2 id="cmp-fit-h" className="label">
          Fit by protocol
        </h2>
        {span && (
          <div className="cmp-ptsw">
            <span id="cmp-pts">Points from</span>
            <div className="seg seg-sm" role="group" aria-labelledby="cmp-pts">
              {groups.map((g, i) => (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={i === pointsFrom}
                  onClick={() => onPointsFrom(i)}
                >
                  {g.seg}
                  <span className="who">{g.letters.join(", ")}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <span className="cmp-grow" />
        <div className="cmp-legend" aria-hidden="true">
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
              <path d="M12 1.4 14.6 4 12 6.6 9.4 4Z" className="sp-k-ring" />
            </svg>
            interpolated
          </span>
          <span>{span ? "lower strip: model − its own data" : "lower strip: model − data"}</span>
        </div>
      </div>
      {caveat !== undefined && (
        <p className="cmp-cav" role="note">
          <Info />
          <span>
            <b>{caveat.lead}</b> {caveat.rest}
          </span>
        </p>
      )}
      {warnings.map((w) => (
        <p key={w.letter} className="cmp-warn">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" />
            <path d="M7 3.8v4M7 9.6v.6" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span>
            <span className="wl">
              <Swatch i={LETTERS.indexOf(w.letter as (typeof LETTERS)[number])} />
              {w.letter}:
            </span>
            {w.text}
            {w.names !== undefined && (
              <>
                {" "}
                <ProtocolNames names={w.names} />
              </>
            )}
            {w.newer !== undefined && (
              <>
                {" "}
                <GetNewest /> to draw it, or see{" "}
                <Link to="/datasets/$id" params={{ id: w.newer.dataset }} className="link nw">
                  {w.newer.name}’s revisions
                </Link>
                .
              </>
            )}
            {w.tail !== undefined && <> {w.tail}</>}
          </span>
        </p>
      ))}
      <div className="cmp-fgrid">
        {protocols.map((p) => (
          <ProtocolFit key={p.name} p={p} letters={letters} fromLine={fromLine} />
        ))}
      </div>
      <p className="cmp-foot">
        {foot.says}{" "}
        <span className="k">
          <span className="ldot on" aria-hidden="true" />
          {foot.low}
        </span>
      </p>
    </section>
  );
}

// ── Metrics ───────────────────────────────────────────────────────────────────────────────────

/** A fitting topology's wall time, on hover (#373). */
const LIVE_TIP = "Still fitting: this changes until its last start finishes.";

export function Metrics({
  candidates,
  groups,
  rows,
  foot,
}: {
  candidates: readonly Candidate[];
  groups: readonly DataGroup[];
  rows: readonly MetricRow[];
  foot: { low: string; improving: string | undefined; dash: string | undefined };
}) {
  const span = groups.length > 1;
  // Columns sized to their content from the left, the spare width after the last (#358's rule).
  const grid = {
    gridTemplateColumns: `max-content repeat(${Math.max(candidates.length, 1)}, minmax(0, max-content)) minmax(0, 1fr)`,
  };
  return (
    <section className="cmp-met" aria-labelledby="cmp-met-h">
      <h2 id="cmp-met-h" className="label">
        Metrics
      </h2>
      <div role="table" aria-label="Metrics by candidate" className="mtab" style={grid}>
        <div role="row" className="mrow mh">
          <span role="columnheader">
            <span className="sr-only">Metric</span>
          </span>
          {candidates.map((c, i) => (
            <span role="columnheader" key={i} className="mhc">
              <span className="l1">
                <Swatch i={i} />
                <Link
                  to="/runs/$id/$topology/$start"
                  params={startParams({
                    run: c.run,
                    graph: c.graph,
                    open_state: c.openState,
                    start: c.start,
                  })}
                  className="link"
                >
                  {LETTERS[i]} · {topologyName(c)}
                </Link>
              </span>
              <span className="l2">start {c.start}</span>
              {span && (
                <span className="l3" title={groups.find((g) => g.members.includes(i))?.short}>
                  {groups.find((g) => g.members.includes(i))?.short}
                </span>
              )}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div role="row" key={r.label} className={`mrow${r.kind === "run" ? " k-run" : ""}`}>
            <span role="rowheader" className="ml">
              {r.label}
            </span>
            {r.cells.map((v, i) => (
              <span role="cell" key={i} className="mc">
                <span className={v.lowest ? "ldot on" : "ldot"} aria-hidden="true" />
                <span
                  className={`mt${v.mono ? " mono" : ""}${v.lowest ? " lo" : ""}${v.live ? " lv" : ""}`}
                  title={v.title}
                >
                  {v.improving && <ImprovingMark className="impa" label="still improving" />}
                  {v.run !== undefined ? (
                    <Link to="/runs/$id" params={{ id: String(v.run) }} className="rl">
                      <span className="dim">#{v.run}</span> <span className="rn">{v.text}</span>
                    </Link>
                  ) : v.live ? (
                    <LiveN tip={LIVE_TIP} tab>
                      {v.text}
                    </LiveN>
                  ) : (
                    v.text
                  )}
                  {v.lowest && <span className="sr-only"> (lowest)</span>}
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="cmp-mfoot">
        <span className="k">
          <span className="ldot on" aria-hidden="true" />
          {foot.low}
        </span>
        {foot.improving !== undefined && (
          <>
            {" "}
            <ImprovingMark className="impa" />
            {foot.improving}
          </>
        )}
        {foot.dash !== undefined && <> {foot.dash}</>}
      </p>
    </section>
  );
}

// ── the spread across each Top 10, and the parameters ─────────────────────────────────────────

/** Where the spread's axis ends: 0.6, or further to hold the widest. */
const spreadTop = (candidates: readonly Candidate[]) =>
  Math.max(0.6, ...candidates.map((c) => Math.ceil((c.topology.spread?.max ?? 0) * 10) / 10));

const SPREAD_W = 316;
/** Room at the strip's end for the median's label, so it stays inside the rows (#449's SF17). */
const SPREAD_LABEL_W = 44;
/** Half a cap's stroke, so the caps at 0 and at the axis's end draw whole. */
const SPREAD_INSET = 1;

/**
 * The spread across each Top 10: a box a candidate, or one for their topology when one run fit
 * them all (`one`), since they share its Top 10.
 */
export function Spread({ candidates, one }: { candidates: readonly Candidate[]; one: boolean }) {
  const top = spreadTop(candidates);
  const plot = SPREAD_W - SPREAD_LABEL_W - 2 * SPREAD_INSET;
  const sx = (v: number) => (SPREAD_INSET + (Math.min(v, top) / top) * plot).toFixed(1);
  const ticks = Array.from({ length: Math.round(top * 10) + 1 }, (_, k) => k / 10);
  const grid = ticks.map((t) => `M${sx(t)} 0V24`).join("");
  return (
    <>
      <h2 className="label">Parameter spread across the top 10</h2>
      <p className="cmp-asub">
        {one
          ? "One box for their topology: each parameter’s SD across its top 10 starts by Train RMSE, as a share of its bound range."
          : "One box per candidate: each parameter’s SD across its topology’s top 10 starts by Train RMSE, as a share of its bound range."}
      </p>
      <div className="cmp-spread">
        {(one ? candidates.slice(0, 1) : candidates).map((c, i) => {
          const q = c.topology.spread;
          const who = one ? LETTERS.slice(0, candidates.length).join(", ") : LETTERS[i];
          const basis = `top 10${c.topology.fitting ? " so far" : ""}`;
          return (
            <div key={i} className="cmp-srow">
              <span className="cmp-who">
                <span className="cmp-whoid">
                  {!one && <Swatch i={i} />}
                  <span className="mono">
                    {one ? topologyName(c) : `${LETTERS[i]} ${topologyName(c)}`}
                  </span>
                </span>
                <span className={one ? "cmp-basis np" : "cmp-basis"}>
                  {one ? `${who} · ${basis}` : basis}
                </span>
              </span>
              {q === null ? (
                <span className="cmp-snone">Needs 2 finished starts.</span>
              ) : (
                <span
                  className="cmp-sbox"
                  role="img"
                  aria-label={`${who}: spread ${q.median.toFixed(2)}, from ${q.min.toFixed(2)} to ${q.max.toFixed(2)} across its parameters`}
                >
                  <svg width={SPREAD_W} height="24" viewBox={`0 0 ${SPREAD_W} 24`} fill="none">
                    <path className="cmp-sgrid" d={grid} />
                    <path
                      className="cmp-swhisk"
                      d={`M${sx(q.min)} 12H${sx(q.max)}M${sx(q.min)} 7V17M${sx(q.max)} 7V17`}
                    />
                    <path className="cmp-sq" d={`M${sx(q.q1)} 4H${sx(q.q3)}V20H${sx(q.q1)}Z`} />
                    <path className="cmp-smed" d={`M${sx(q.median)} 3V21`} />
                  </svg>
                  <span className="cmp-smedn" style={{ left: `${Number(sx(q.max)) + 8}px` }}>
                    {q.median.toFixed(2)}
                  </span>
                </span>
              )}
            </div>
          );
        })}
        <div className="cmp-saxis" aria-hidden="true">
          <span />
          <span className="cmp-sticks mono">
            {ticks.map((t, k) => (
              <span
                key={k}
                style={{
                  left: `${sx(t)}px`,
                  transform:
                    k === 0
                      ? undefined
                      : k === ticks.length - 1
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                }}
              >
                {t === 0 ? "0" : t.toFixed(1)}
              </span>
            ))}
          </span>
        </div>
      </div>
    </>
  );
}

const paramsOf = (c: Candidate) =>
  c.edges === undefined ? undefined : 2 * c.numStates + 2 * c.edges + 2;

export function Parameters({ candidates }: { candidates: readonly Candidate[] }) {
  return (
    <>
      <h2 className="label cmp-ph">Parameters</h2>
      <p className="cmp-asub">
        Their topologies differ, so parameters are compared per candidate, not lined up.
      </p>
      <div className="cmp-plines">
        {candidates.map((c, i) => (
          <div key={i} className="cmp-prow">
            <span className="cmp-whoid">
              <Swatch i={i} />
              <span className="mono">
                {LETTERS[i]} {topologyName(c)}
              </span>
            </span>
            <span className="cmp-pn">
              <span className="n">{paramsOf(c) ?? "—"}</span> parameters
            </span>
            <span className="cmp-po">
              open state <span className="n">{c.openState}</span>
            </span>
            <Link
              to="/runs/$id/$topology/$start"
              params={startParams({
                run: c.run,
                graph: c.graph,
                open_state: c.openState,
                start: c.start,
              })}
              className="link"
              aria-label={`Open ${topologyName(c)} · start ${c.start}`}
            >
              Open start {c.start}
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}

// ── the topologies ────────────────────────────────────────────────────────────────────────────

function Drawn({ c, graph, name }: { c: Candidate; graph: StateGraph; name: string }) {
  const laid = useMemo(
    () => [{ numStates: c.numStates, edges: graph.edges }],
    [c.numStates, graph.edges],
  );
  const spots = useLayouts(laid)?.[0];
  if (spots === undefined) return null;
  const e = graph.edges.length;
  return (
    <TopologyDrawing
      graph={graph}
      spots={spots}
      open={c.openState}
      size={TOPOLOGY_PAGE}
      label={`Topology ${name}: ${c.numStates} states, ${e} ${e === 1 ? "transition" : "transitions"}, open state ${c.openState}.`}
    />
  );
}

/**
 * Their one topology, drawn once beside Metrics when every candidate has it (#361): named for
 * its run when one run fit them all (`#214/T12.3`), else alone (`T9.3`).
 */
export function OneTopology({
  c,
  graph,
  oneRun,
}: {
  c: Candidate;
  graph: StateGraph | undefined;
  oneRun: boolean;
}) {
  const name = oneRun ? topologyName(c) : `T${c.graph}.${c.openState}`;
  return (
    <>
      <h2 className="label cmp-ph">Topology</h2>
      <div className="cmp-tone">
        <div className="cmp-tbox">
          {graph !== undefined && <Drawn c={c} graph={graph} name={name} />}
        </div>
        <div className="cmp-tcap">
          <span className="tid">
            {oneRun && <span className="rid">#{c.run}/</span>}T{c.graph}.{c.openState}
          </span>
          <span className="tc">
            <span className="n">{c.numStates}</span> states
            {c.edges !== undefined && (
              <>
                {" "}
                · <span className="n">{c.edges}</span>{" "}
                {c.edges === 1 ? "transition" : "transitions"}
              </>
            )}{" "}
            · open state <span className="n">{c.openState}</span>
          </span>
        </div>
      </div>
    </>
  );
}

export function Topologies({
  candidates,
  graphs,
}: {
  candidates: readonly Candidate[];
  graphs: readonly (StateGraph | undefined)[];
}) {
  return (
    <section className="cmp-tsec" aria-labelledby="cmp-top-h">
      <h2 id="cmp-top-h" className="label">
        Topologies
      </h2>
      <div className="cmp-tgrid">
        {candidates.map((c, i) => {
          const g = graphs[i];
          return (
            <div key={i} className="cmp-tcol">
              <div className="cmp-tbox">
                {g !== undefined && <Drawn c={c} graph={g} name={topologyName(c)} />}
              </div>
              <div className="cmp-tcap">
                <Swatch i={i} />
                <span className="tid">
                  <span className="rid">#{c.run}/</span>T{c.graph}.{c.openState}
                </span>
                <span className="tc">
                  <span className="n">{c.numStates}</span> states
                  {c.edges !== undefined && (
                    <>
                      {" "}
                      · <span className="n">{c.edges}</span>{" "}
                      {c.edges === 1 ? "transition" : "transitions"}
                    </>
                  )}
                </span>
                <span className="cmp-grow" />
                <Link
                  to="/runs/$id/$topology/$start"
                  params={startParams({
                    run: c.run,
                    graph: c.graph,
                    open_state: c.openState,
                    start: c.start,
                  })}
                  className="link"
                  aria-label={`Open ${topologyName(c)} · start ${c.start}`}
                >
                  Open start {c.start}
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
