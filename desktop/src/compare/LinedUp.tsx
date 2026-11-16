/**
 * Compare's Parameters lined up (LaptopCompare's `pair` and `mixed`, #361):
 * when every candidate has one topology, its rows as a start's page draws
 * them (`parameterRows`), made canonical by this computer's engine
 * (`useCanonicalParameters`, ADR-0007, ADR-0013). Each part has a value
 * column per candidate and one strip with every candidate's mark: A solid,
 * B dashed, C dotted. On one run they share its Top 10, so the strip draws
 * its range and the part its spread; across runs each run has its own, so
 * neither is drawn.
 */
import type { ReactNode } from "react";
import { fixed, short } from "../datasets/format";
import { EdgeGlyph, StateGlyph } from "../parameters/ParameterRows";
import { useCanonicalParameters, type Canonical } from "../parameters/queries";
import { parameterRows, type PartRef } from "../parameters/rows";
import { spreadWords } from "../runs/topology/parameters";
import type { ParameterRange } from "../wire/types.gen";
import { candidateName, LETTERS, type Candidate } from "./words";

const MARKS = ["a", "b", "c"] as const;

/** A candidate's mark: its line's stroke, upright. */
const Mark = ({ i }: { i: number }) => <i className={`cmp-lm ${MARKS[i]}`} aria-hidden="true" />;

/** Where `v` sits across `range`, in % of the strip, kept inside it. */
function along(v: number, { min, max }: ParameterRange): number {
  if (!(max > min)) return 50;
  return ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
}

type Shown = Extract<Canonical<readonly number[]>, { kind: "shown" }>;

/** One candidate's vectors as shown, with its own box: its best, then (on one run) its Top 10. */
function useShown(c: Candidate | undefined, withTop: boolean): Canonical<readonly number[]> {
  return useCanonicalParameters(
    c === undefined || c.best === null || c.bounds === undefined
      ? undefined
      : {
          numStates: c.numStates,
          graph: c.graph,
          openState: c.openState,
          bounds: c.bounds,
          items: withTop ? [c.best, ...c.topology.top10] : [c.best],
          raw: (v) => v,
        },
  );
}

export function LinedUp({
  candidates,
  name,
  oneRun,
}: {
  candidates: readonly Candidate[];
  /** `#214/T12.3` on one run, `T9.3` across runs. */
  name: string;
  oneRun: boolean;
}) {
  // A call a slot, so hooks keep their order; each candidate's own box sets its ranges.
  const s0 = useShown(candidates[0], oneRun);
  const s1 = useShown(candidates[1], false);
  const s2 = useShown(candidates[2], false);
  const shown = [s0, s1, s2].slice(0, candidates.length);
  const [first] = candidates;
  const count = first.edges === undefined ? undefined : 2 * first.numStates + 2 * first.edges + 2;

  let body: ReactNode;
  const unset = candidates.find((c) => c.best === null);
  const newer = candidates.find((c) => c.bounds === undefined);
  const failed = shown.find((s) => s.kind === "failed");
  if (unset !== undefined) {
    body = (
      <p className="cmp-asub">
        Start {unset.start}’s parameters show here once its first generation is logged.
      </p>
    );
  } else if (newer !== undefined) {
    body = (
      <p className="cmp-asub">
        #{newer.run} was submitted by a newer ICMM, so its parameters can’t be drawn here.
      </p>
    );
  } else if (failed?.kind === "failed") {
    body = <p className="cmp-asub">{failed.error.message}</p>;
  } else if (shown.some((s) => s.kind !== "shown")) {
    body = <p className="cmp-asub">Reading their parameters…</p>;
  } else {
    body = <Table candidates={candidates} oneRun={oneRun} shown={shown as Shown[]} />;
  }

  return (
    <section className="cmp-lu" aria-labelledby="cmp-lu-h">
      <div className="cmp-luhead">
        <h2 id="cmp-lu-h" className="label">
          Parameters
        </h2>
        <span className="cmp-lufacts">
          {name}
          {count !== undefined && <> · {count} parameters</>} · <span className="mono">ln</span>{" "}
          units and mV · read relative to open state <span className="n">{first.openState}</span>,
          with b&#160;&gt;&#160;0
        </span>
      </div>
      <div className="cmp-lukey" aria-hidden="true">
        {candidates.map((c, i) => (
          <span key={i} className="k">
            <Mark i={i} />
            {LETTERS[i]} · {oneRun ? "" : `#${c.run} `}start {c.start}
          </span>
        ))}
        {oneRun ? (
          first.topology.top10.length > 0 && (
            <span className="k">
              <span className="kband" />
              range of {name}’s top 10 by Train RMSE
            </span>
          )
        ) : (
          <span className="k">
            Each run has its own top 10, so no range is drawn: Parameter spread has each.
          </span>
        )}
      </div>
      {body}
    </section>
  );
}

function Table({
  candidates,
  oneRun,
  shown,
}: {
  candidates: readonly Candidate[];
  oneRun: boolean;
  shown: Shown[];
}) {
  const [first] = candidates;
  const rows = parameterRows(first.numStates, first.openState, shown[0].edges);
  const values = shown.map((s) => s.shown[0].values);
  const tops = oneRun ? shown[0].shown.slice(1).map((s) => s.values) : [];
  // Each part's strip spans every candidate's box.
  const ranges = shown[0].ranges.map((_, k) => ({
    min: Math.min(...shown.map((s) => s.ranges[k].min)),
    max: Math.max(...shown.map((s) => s.ranges[k].max)),
  }));
  const spreads = first.topology.spreads;
  const n = candidates.length;
  const band = oneRun && tops.length > 0;
  const part = `repeat(${n}, 64px) minmax(0, 1fr)${oneRun ? " 44px" : ""}`;
  const cols = { gridTemplateColumns: `44px ${part} ${part}` };
  const span = n + 1 + (oneRun ? 1 : 0);
  const heads = [
    { gridColumn: `2 / span ${span}`, gridTemplateColumns: part },
    { gridColumn: `${span + 2} / -1`, gridTemplateColumns: part },
  ];

  const head = (kind: string, titles: [ReactNode, ReactNode], refs: [PartRef, PartRef]) => (
    <div role="row" className="cmp-luh" style={cols}>
      <span role="columnheader" className="cmp-lukind">
        {kind}
      </span>
      {refs.map((p, k) => (
        <span role="columnheader" key={k} className="cmp-luk" style={heads[k]}>
          <span className="cmp-lutitle">{titles[k]}</span>
          {candidates.map((_, i) => (
            <span key={i} className="cmp-lul">
              <Mark i={i} />
              {LETTERS[i]}
            </span>
          ))}
          <span className="cmp-luends" aria-hidden="true">
            <span>{short(ranges[p.index].min)}</span>
            <span>{short(ranges[p.index].max)}</span>
          </span>
          {oneRun && <span className="cmp-luspr">Spread</span>}
        </span>
      ))}
    </div>
  );

  const cells = (p: PartRef) => {
    const range = ranges[p.index];
    const at = tops.map((v) => v[p.index]);
    const lo = along(Math.min(...at), range);
    const hi = along(Math.max(...at), range);
    return (
      <>
        {values.map((v, i) => (
          <span role="cell" key={i} className="cmp-luv">
            <span className="sr-only">{LETTERS[i]} </span>
            {fixed(v[p.index], p.mV ? 1 : 3)}
          </span>
        ))}
        <span className="cmp-lus" title={p.name} aria-hidden="true">
          <span className="ax" />
          <span className="e0" />
          <span className="e1" />
          <span className="md" />
          {band && (
            <span className="bd" style={{ left: `${lo}%`, width: `max(3px, ${hi - lo}%)` }} />
          )}
          {values.map((v, i) => (
            <span
              key={i}
              className={`cmp-lm ${MARKS[i]}`}
              style={{ left: `calc(${along(v[p.index], range).toFixed(2)}% - 1px)` }}
            />
          ))}
        </span>
        {oneRun && (
          <span role="cell" className="cmp-luspr">
            <span className="sr-only">spread </span>
            {spreadWords(spreads?.[p.index])}
          </span>
        )}
      </>
    );
  };

  const nameOf = (s: string, sub: ReactNode) => (
    <>
      {s}
      <span className="cmp-lupn">{sub}</span>
    </>
  );

  return (
    <div
      role="table"
      aria-label={`Parameters of ${candidates.map(candidateName).join(" and ")}, lined up`}
      className="cmp-lut"
    >
      {rows.states.length > 0 &&
        head(
          "State",
          [
            nameOf(
              "Favorability",
              <>
                s<sub>i</sub>
              </>,
            ),
            nameOf(
              "Voltage sensitivity",
              <>
                s<sub>i</sub>
                <sup>v</sup>
              </>,
            ),
          ],
          [rows.states[0].constant, rows.states[0].voltage],
        )}
      <div role="row" className="cmp-lur open" style={cols}>
        <span role="rowheader" className="cmp-lulabel">
          <StateGlyph state={rows.open} open />
        </span>
        <span role="cell" className="cmp-lunote">
          <b>Open state</b> · the reference: its favorability and voltage sensitivity are{" "}
          <span className="n">0</span>, and every other state’s are read against them.
        </span>
      </div>
      {rows.states.map((s) => (
        <div role="row" key={s.state} className="cmp-lur" style={cols}>
          <span role="rowheader" className="cmp-lulabel">
            <StateGlyph state={s.state} open={false} />
          </span>
          {cells(s.constant)}
          {cells(s.voltage)}
        </div>
      ))}
      {rows.edges.length > 0 &&
        head(
          "Edge",
          [
            nameOf(
              "Speed",
              <>
                e<sub>i,j</sub>
              </>,
            ),
            nameOf(
              "Voltage sensitivity",
              <>
                e<sub>i,j</sub>
                <sup>v</sup>
              </>,
            ),
          ],
          [rows.edges[0].constant, rows.edges[0].voltage],
        )}
      {rows.edges.map((e) => (
        <div role="row" key={`${e.i}-${e.j}`} className="cmp-lur" style={cols}>
          <span role="rowheader" className="cmp-lulabel">
            <EdgeGlyph i={e.i} j={e.j} open={rows.open} />
          </span>
          {cells(e.constant)}
          {cells(e.voltage)}
        </div>
      ))}
      {head(
        "Curve",
        [
          <>
            Voltage dependence<span className="cmp-lupn">a</span> · mV
          </>,
          <>
            <span className="cmp-lupn first">b</span> · mV
          </>,
        ],
        [rows.a, rows.b],
      )}
      <div role="row" className="cmp-lur" style={cols}>
        <span role="rowheader" className="cmp-lulabel">
          <span className="sr-only">a and b</span>
        </span>
        {cells(rows.a)}
        {cells(rows.b)}
      </div>
    </div>
  );
}
