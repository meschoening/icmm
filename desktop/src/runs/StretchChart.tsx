/**
 * A chart that stretches with the window (#291): its y axis' words in a fixed
 * 48 px at the left, and the plot across the rest, x from 0 to `SPAN` in its
 * own units at any width (`preserveAspectRatio="none"`). Its strokes keep
 * their width (`vector-effect: non-scaling-stroke`), so a dot is a round-cap
 * stroke too short to see (`dotAt`), and its words are HTML (`ChartLabel`)
 * placed with `across` (`stretch.ts`). Run detail's spread plot draws in it.
 */
import type { ReactNode } from "react";
import { SPAN } from "./stretch";

export function StretchChart({
  height,
  frame = height,
  axis,
  plot,
  aria,
  className,
  children,
}: {
  /** The plot's height, in px and in its own units. */
  height: number;
  /** The frame's height, when words go under the plot. */
  frame?: number;
  /** The y axis' words, in 48 × `height`. */
  axis: ReactNode;
  /** What's drawn, in `SPAN` × `height`. */
  plot: ReactNode;
  aria: string;
  className?: string;
  /** The words over it: `ChartLabel`s. */
  children?: ReactNode;
}) {
  return (
    <div className={className ? `rd-sc ${className}` : "rd-sc"} style={{ height: `${frame}px` }}>
      <svg
        className="rd-sc-axis"
        width="48"
        height={height}
        viewBox={`0 0 48 ${height}`}
        fill="none"
        aria-hidden="true"
      >
        {axis}
      </svg>
      <svg
        className="rd-sc-plot"
        viewBox={`0 0 ${SPAN} ${height}`}
        preserveAspectRatio="none"
        fill="none"
        role="img"
        aria-label={aria}
        style={{ height: `${height}px` }}
      >
        {plot}
      </svg>
      {children}
    </div>
  );
}

/**
 * A label over a chart, in HTML so it takes the page's fonts: at `x` px, or
 * at a CSS length (`across`), with `y` 12 px under its top. `ground` keeps the
 * page's ground behind it, so what's drawn never covers it.
 */
export function ChartLabel({
  x,
  y,
  anchor,
  sans,
  small,
  ground,
  tone,
  className,
  children,
}: {
  x: number | string;
  y: number;
  anchor: "start" | "middle" | "end";
  sans?: boolean;
  small?: boolean;
  ground?: boolean;
  tone?: "cobalt" | "ink-2" | "ink-3";
  className?: string;
  children: ReactNode;
}) {
  const shift =
    anchor === "end" ? "translateX(-100%)" : anchor === "middle" ? "translateX(-50%)" : "none";
  const cls = [
    "rd-c-label",
    sans && "rd-c-label-sans",
    small && "rd-c-small",
    ground && "rd-c-ground",
    tone && `rd-c-${tone}`,
    className,
  ];
  return (
    <span
      aria-hidden="true"
      className={cls.filter(Boolean).join(" ")}
      style={{
        left: typeof x === "number" ? `${x.toFixed(1)}px` : x,
        top: `${(y - 12).toFixed(1)}px`,
        transform: shift,
      }}
    >
      {children}
    </span>
  );
}
