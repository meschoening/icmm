/**
 * The Parameters rows as a table (#41, built in #287): State, Edge and
 * Voltage dependence curve heads, each part's title with its name and the
 * range its strip spans; the open state's row, tinted, first among the
 * states; a row per other state and per edge, each labeled with its glyph as
 * the topology drawing draws it.
 *
 * A page draws each part itself, with its own strip: Topology every finished
 * start against its Top 10, Start one start against the Top 10's band. It
 * says how a part's cells are laid out (`columns`, the strip in column
 * `before + 1`) and what heads the cells after the strip. Start draws its
 * start's Voltage dependence curve beside a and b (`curve`), in taller rows.
 */
import type { CSSProperties, ReactNode } from "react";
import { short } from "../datasets/format";
import type { ParameterRange } from "../wire/types.gen";
import type { ParameterRows as Rows, PartRef } from "./rows";

/** A state as the drawing draws it: a numbered circle, filled for the open state. */
export function StateGlyph({ state, open }: { state: number; open: boolean }) {
  return <span className={open ? "state-g open" : "state-g"}>{state}</span>;
}

/** An edge as the drawing draws it: its two states joined, the open one filled. */
export function EdgeGlyph({ i, j, open }: { i: number; j: number; open: number }) {
  return (
    <span className="edge-g">
      <StateGlyph state={i} open={i === open} />
      <i aria-hidden="true" />
      <span className="sr-only">–</span>
      <StateGlyph state={j} open={j === open} />
    </span>
  );
}

export interface ParameterRowsProps {
  rows: Rows;
  /** Each parameter's range as shown, in layout order: its strip's two ends. */
  ranges: readonly ParameterRange[];
  /** The table's name: whose parameters, against what. */
  label: string;
  /** The open state's row, after its glyph. */
  openNote: ReactNode;
  /** One part's cells, as CSS grid columns: Topology's are its strip and its spread. */
  columns: string;
  /** How many of those cells come before the strip. */
  before?: number;
  /** The heads of the cells after the strip. */
  after: ReactNode[];
  /** A part's cells: as many as `columns` lays out. */
  part: (p: PartRef, range: ParameterRange) => ReactNode;
  /** In place of a and b's row: the curve they set, drawn with them, under the curve's head. */
  curve?: ReactNode;
  /** Rows 34 px tall, as Start draws them, rather than 24. */
  roomy?: boolean;
}

export function ParameterRows({
  rows,
  ranges,
  label,
  openNote,
  columns,
  before = 0,
  after,
  part,
  curve,
  roomy = false,
}: ParameterRowsProps) {
  const head = (title: ReactNode, p: PartRef) => (
    <div role="columnheader" className="prm-part prm-phead">
      <span className="prm-title">{title}</span>
      {Array.from({ length: before }, (_, k) => (
        <span key={k} />
      ))}
      <span className="prm-ends">
        <span>{short(ranges[p.index].min)}</span>
        <span>
          {short(ranges[p.index].max)}
          {p.mV && " mV"}
        </span>
      </span>
      {after.map((a, k) => (
        <span key={k} className="prm-after">
          {a}
        </span>
      ))}
    </div>
  );
  const cells = (constant: PartRef, voltage: PartRef) => (
    <>
      <div role="cell" className="prm-part">
        {part(constant, ranges[constant.index])}
      </div>
      <span aria-hidden="true" />
      <div role="cell" className="prm-part">
        {part(voltage, ranges[voltage.index])}
      </div>
    </>
  );
  const pair = (first: StateOrEdge, second: StateOrEdge) => (
    <>
      {head(first.title, first.ref)}
      <span aria-hidden="true" />
      {head(second.title, second.ref)}
    </>
  );
  const [state] = rows.states;
  const [edge] = rows.edges;
  return (
    <div
      role="table"
      aria-label={label}
      className={roomy ? "prm prm-roomy" : "prm"}
      style={{ "--prm-part": columns } as CSSProperties}
    >
      {state !== undefined && (
        <div role="row" className="prm-row prm-head">
          <span role="columnheader" className="prm-kind">
            State
          </span>
          {pair(
            {
              title: (
                <Named
                  title="Favorability"
                  name={
                    <>
                      s<sub>i</sub>
                    </>
                  }
                />
              ),
              ref: state.constant,
            },
            {
              title: (
                <Named
                  title="Voltage sensitivity"
                  name={
                    <>
                      s<sub>i</sub>
                      <sup>v</sup>
                    </>
                  }
                />
              ),
              ref: state.voltage,
            },
          )}
        </div>
      )}
      <div role="row" className="prm-row prm-open">
        <span role="rowheader" className="prm-label">
          <StateGlyph state={rows.open} open />
        </span>
        <span role="cell" className="prm-note">
          {openNote}
        </span>
      </div>
      {rows.states.map((s) => (
        <div role="row" key={s.state} className="prm-row">
          <span role="rowheader" className="prm-label">
            <StateGlyph state={s.state} open={false} />
          </span>
          {cells(s.constant, s.voltage)}
        </div>
      ))}
      {edge !== undefined && (
        <div role="row" className="prm-row prm-head">
          <span role="columnheader" className="prm-kind">
            Edge
          </span>
          {pair(
            {
              title: (
                <Named
                  title="Speed"
                  name={
                    <>
                      e<sub>i,j</sub>
                    </>
                  }
                />
              ),
              ref: edge.constant,
            },
            {
              title: (
                <Named
                  title="Voltage sensitivity"
                  name={
                    <>
                      e<sub>i,j</sub>
                      <sup>v</sup>
                    </>
                  }
                />
              ),
              ref: edge.voltage,
            },
          )}
        </div>
      )}
      {rows.edges.map((e) => (
        <div role="row" key={`${e.i}-${e.j}`} className="prm-row">
          <span role="rowheader" className="prm-label">
            <EdgeGlyph i={e.i} j={e.j} open={rows.open} />
          </span>
          {cells(e.constant, e.voltage)}
        </div>
      ))}
      {curve === undefined ? (
        <>
          <div role="row" className="prm-row prm-head prm-curve">
            <span role="columnheader" className="prm-kind prm-curvename">
              Voltage dependence curve
            </span>
            <span aria-hidden="true" />
            {pair(
              { title: "a · half-way at −a", ref: rows.a },
              { title: "b · most of its change within ±b", ref: rows.b },
            )}
          </div>
          <div role="row" className="prm-row">
            <span role="rowheader" className="prm-label">
              <span className="sr-only">a and b</span>
            </span>
            {cells(rows.a, rows.b)}
          </div>
        </>
      ) : (
        <>
          <div role="row" className="prm-row prm-head prm-curvehead">
            <span role="columnheader" className="prm-kind prm-curvename">
              Voltage dependence curve
              <span className="prm-follows">
                {" "}
                · every transition’s voltage sensitivity follows it
              </span>
            </span>
          </div>
          {curve}
        </>
      )}
    </div>
  );
}

interface StateOrEdge {
  title: ReactNode;
  ref: PartRef;
}

/** A part's title, its name beside it: "Favorability sᵢ". */
function Named({ title, name }: { title: string; name: ReactNode }) {
  return (
    <>
      {title}
      <span className="prm-name">{name}</span>
    </>
  );
}
