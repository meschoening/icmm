/**
 * A topology drawn (#212): its state graph's states and edges where `layOut`
 * places them (`useLayouts`), with its open state filled, or, for an id
 * without one, each state it's fit at ringed, dashed. Specific IDs draws it small; Find custom
 * topology (#222) and sections 4 and 5 take it larger, and may name the
 * states their own way. Find custom topology also marks the part of a typed
 * topology that breaks a rule: it in `--red`, the rest dimmed.
 */
import type { CSSProperties } from "react";
import type { StateGraph } from "../wire/types.gen";
import type { Spot } from "./layout";
import { placed, RING, SPECIFIC_IDS, type DrawingSize } from "./size";

export interface TopologyDrawingProps {
  /** Its state graph, as `read_state_graphs` answers it. */
  graph: Pick<StateGraph, "edges" | "open_states">;
  /** Where each state sits, as `layOut` places it. */
  spots: Spot[];
  /** The open state, filled; `null` for an id without one, which rings each of its open states. */
  open: number | null;
  /** The sentence a screen reader says for the drawing. */
  label: string;
  size?: DrawingSize;
  /** What each state is called, by ICMM's number; ICMM's own numbers by default. */
  names?: readonly string[];
  /** The states, and the edges by their place in `graph.edges`, that break a rule. */
  marked?: { states: ReadonlySet<number>; edges: ReadonlySet<number> };
}

/**
 * An SVG `role="img"` at its own size, which scales down with its `viewBox`
 * where its column is narrower.
 */
export function TopologyDrawing({
  graph,
  spots,
  open,
  label,
  size = SPECIFIC_IDS,
  names,
  marked,
}: TopologyDrawingProps) {
  const { at, width, height } = placed(spots, size);
  const r = size.state / 2;
  const path = (keep: (i: number) => boolean) =>
    graph.edges
      .flatMap(([a, b], i) => (keep(i) ? [`M${at[a].x} ${at[a].y}L${at[b].x} ${at[b].y}`] : []))
      .join("");
  const edges = path((i) => marked === undefined || !marked.edges.has(i));
  return (
    <svg
      className={marked === undefined ? "tdraw" : "tdraw marked"}
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ "--tdraw-font": `${size.font}px` } as CSSProperties}
    >
      <path className="tdraw-edges" d={edges} />
      {marked !== undefined && <path className="tdraw-bad" d={path((i) => marked.edges.has(i))} />}
      {open === null &&
        graph.open_states.map((s) => (
          <circle key={s} className="tdraw-ring" cx={at[s].x} cy={at[s].y} r={r + RING} />
        ))}
      {at.map((p, s) => (
        <g
          key={s}
          className={`tdraw-state${s === open ? " on" : ""}${marked?.states.has(s) ? " bad" : ""}`}
        >
          <circle cx={p.x} cy={p.y} r={r} />
          <text x={p.x} y={p.y}>
            {names?.[s] ?? String(s)}
          </text>
        </g>
      ))}
    </svg>
  );
}
