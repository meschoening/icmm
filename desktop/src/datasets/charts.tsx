/**
 * The Dataset wizard's charts: a sheet's preview (LaptopWizSheets), a
 * protocol's data and its voltage command (LaptopWizProtocols), and the
 * decay window's sketch, which the Protocol builder shares (#50). Each is an
 * image with its summary in words; colors come from tokens.
 */
import { useRef, useState } from "react";
import type { Point, Step } from "../wire/types.gen";
import { decades, ticks, valueRange } from "./axes";
import { fixed, minus, short } from "./format";
import type { PointWords } from "./points";

/** A sheet's points beside its row on the Sheets step: 212 × 132, its ends labeled. */
export function SheetPreview({
  points,
  xUnit,
  signed,
  logx,
}: {
  points: Point[];
  xUnit: string;
  signed: boolean;
  logx: boolean;
}) {
  if (points.length === 0) return <div className="sheet-preview" />;
  const X0 = 34;
  const X1 = 200;
  const YT = 10.5;
  const YB = 104.5;
  const r = 2.4;
  const xs = points.map((p) => p.x);
  const [yLo, yHi] = valueRange(points.map((p) => p.value));
  const lx = (x: number) => (logx ? Math.log10(x) : x);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const px = (x: number) =>
    xHi === xLo ? (X0 + X1) / 2 : X0 + ((lx(x) - lx(xLo)) / (lx(xHi) - lx(xLo))) * (X1 - X0);
  const py = (y: number) => YB - ((y - yLo) / (yHi - yLo)) * (YB - YT);
  let dots = "";
  let whiskers = "";
  for (const p of points) {
    const x = px(p.x);
    const y = py(p.value);
    if (p.sd !== null && p.sd > 0) {
      const a = py(p.value + p.sd);
      const b = py(p.value - p.sd);
      if (b - a > 2 * r + 2) {
        whiskers += `M${x.toFixed(1)} ${a.toFixed(1)}V${b.toFixed(1)}M${(x - 3).toFixed(1)} ${a.toFixed(1)}h6M${(x - 3).toFixed(1)} ${b.toFixed(1)}h6`;
      }
    }
    dots += `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  return (
    <div className="sheet-preview" aria-hidden="true">
      <svg width="212" height="132" viewBox="0 0 212 132" fill="none">
        <path d="M28 10.5H206" className="grid" />
        <path d="M28 104.5H206" className="base" />
        <path d={whiskers} className="whisker" />
        <path d={dots} className="dot" />
      </svg>
      <span className="ax" style={{ left: 0, top: 2, width: 22, textAlign: "right" }}>
        {short(yHi)}
      </span>
      <span className="ax" style={{ left: 0, top: 96, width: 22, textAlign: "right" }}>
        {short(yLo)}
      </span>
      <span className="ax" style={{ left: 28, top: 112 }}>
        {short(xLo, signed)}
      </span>
      <span className="ax" style={{ right: 6, top: 112 }}>
        {short(xHi, signed)} {xUnit}
      </span>
    </div>
  );
}

const pc = (v: number) => `${v.toFixed(2)}%`;

/** A point's x as its button and tip say it: at most one decimal, true minus. */
const xWords = (x: number, unit: string) => `${minus(String(Math.round(x * 10) / 10))} ${unit}`;

/** Of `points`, the one nearest `left` (a percent across the plot) along x. */
function nearestAlongX<T>(points: T[], leftOf: (p: T) => number, left: number): T | undefined {
  let best: T | undefined;
  let gap = Infinity;
  for (const p of points) {
    const d = Math.abs(leftOf(p) - left);
    if (d < gap) {
      best = p;
      gap = d;
    }
  }
  return best;
}

/**
 * One hit layer over a plot (#168): the pointer is on the point nearest it
 * along x, however close the points sit, so each one can be reached.
 * `left` places a point across the plot, in percent.
 */
export function HitLayer<T>({
  points,
  left,
  onNear,
  onLeave,
  onPress,
  className = "vlayer",
}: {
  points: T[];
  left: (p: T) => number;
  onNear: (p: T) => void;
  onLeave?: () => void;
  /** A click: the point it's on. */
  onPress?: (p: T) => void;
  className?: string;
}) {
  /** The point the pointer is on: the nearest along x. */
  const pointed = (e: React.PointerEvent | React.MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return undefined;
    return nearestAlongX(points, left, ((e.clientX - box.left) / box.width) * 100);
  };
  return (
    <div
      aria-hidden="true"
      className={className}
      onPointerMove={(e) => {
        const p = pointed(e);
        if (p !== undefined) onNear(p);
      }}
      onPointerLeave={onLeave}
      onClick={(e) => {
        const p = pointed(e);
        if (p !== undefined) onPress?.(p);
      }}
    />
  );
}

/**
 * Each point as a button that switches it between train and validation
 * (#53), with the pointed-at or focused one's value and what a click does.
 * The pointer reaches them through one hit layer (`HitLayer`); the keyboard
 * through one tab stop, its arrow keys stepping from point to point in x
 * order. `at` places a point on the plot, in percent.
 */
export function PointButtons({
  points,
  at,
  words,
  onSwitch,
  onHover,
  className = "vhit",
}: {
  points: Point[];
  at: (p: Point) => { left: number; top: number };
  words: PointWords;
  onSwitch: (x: number) => void;
  /** The pointer meets a point, or focus lands on it: Dataset detail picks its sweep. */
  onHover?: (p: Point) => void;
  className?: string;
}) {
  const [tip, setTip] = useState<number | null>(null);
  /** The point the pointer is on, drawn as hovered. */
  const [near, setNear] = useState<number | null>(null);
  /** The point Tab lands on: the last one stepped to, pressed or focused. */
  const [stop, setStop] = useState<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const ordered = [...points].sort((a, b) => a.x - b.x);
  const tabStop = ordered.some((p) => p.x === stop) ? stop : (ordered[0]?.x ?? null);
  const shown = points.find((p) => p.x === tip);
  const tipAt = shown === undefined ? null : at(shown);
  const focus = (x: number) => {
    setStop(x);
    buttons.current.get(x)?.focus({ preventScroll: true });
  };
  /** The point a key steps to from the point at `from`, in x order; `undefined` for another key. */
  const step = (from: number, key: string): number | undefined => {
    const k = ordered.findIndex((p) => p.x === from);
    const last = ordered.length - 1;
    const to: Record<string, number> = {
      ArrowRight: Math.min(k + 1, last),
      ArrowDown: Math.min(k + 1, last),
      ArrowLeft: Math.max(k - 1, 0),
      ArrowUp: Math.max(k - 1, 0),
      Home: 0,
      End: last,
    };
    return key in to ? ordered[to[key]].x : undefined;
  };
  return (
    <>
      <HitLayer
        points={points}
        left={(p) => at(p).left}
        className="vlayer switch"
        onNear={(p) => {
          setNear(p.x);
          setTip(p.x);
          onHover?.(p);
        }}
        onLeave={() => {
          setNear(null);
          setTip((t) => (t === near ? null : t));
        }}
        onPress={(p) => {
          // The point keeps focus, as a pressed button does (old ADR-0027).
          focus(p.x);
          onSwitch(p.x);
        }}
      />
      {points.map((p) => {
        const { left, top } = at(p);
        const state = p.validation ? "validation point" : "train point";
        return (
          <button
            key={`h${p.x}`}
            ref={(el) => {
              if (el === null) buttons.current.delete(p.x);
              else buttons.current.set(p.x, el);
            }}
            type="button"
            className={`${className}${p.x === near ? " near" : ""}`}
            style={{ left: pc(left), top: pc(top) }}
            tabIndex={p.x === tabStop ? 0 : -1}
            aria-label={`${xWords(p.x, words.unit)}, ${p.interpolated ? "interpolated, " : ""}${state}`}
            onFocus={() => {
              setStop(p.x);
              setTip(p.x);
              onHover?.(p);
            }}
            onBlur={() => setTip((t) => (t === p.x ? null : t))}
            onKeyDown={(e) => {
              const to = step(p.x, e.key);
              if (to === undefined) return;
              e.preventDefault();
              focus(to);
            }}
            onClick={() => onSwitch(p.x)}
          />
        );
      })}
      {shown !== undefined && tipAt !== null && (
        <div
          className="vtip"
          aria-hidden="true"
          style={{
            ...(tipAt.left > 55
              ? { right: `calc(${pc(100 - tipAt.left)} + 14px)` }
              : { left: `calc(${pc(tipAt.left)} + 14px)` }),
            top: `calc(${pc(tipAt.top)} - 22px)`,
          }}
        >
          <b>
            {xWords(shown.x, words.unit)} · {fixed(shown.value, words.digits)}
            {shown.sd !== null && ` ± ${fixed(shown.sd, words.digits)}`}
          </b>
          <span>
            {shown.interpolated ? "Interpolated, a " : "A "}
            {shown.validation
              ? "validation point. Click to make it a train point."
              : "train point. Click to make it a validation point."}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * A protocol's data on the Protocols step and in the Protocol builder:
 * measured means with SD whiskers (●), interpolated points without (◆),
 * validation points hollow (○ ◇), on round axes. An interpolated point out
 * of its measure's range is ringed red (#52); with `onSwitch` each point is
 * a button that switches it (#53).
 */
export function DataChart({
  points,
  logx,
  label,
  ring,
  outOfRange,
  onSwitch,
  words,
}: {
  points: Point[];
  logx: boolean;
  /** The chart in words, for a screen reader. */
  label: string;
  /** The x of a point to ring: the Protocol builder's highlighted sweep. */
  ring?: number;
  /** The x of each interpolated point out of its measure's range. */
  outOfRange?: ReadonlySet<number>;
  /** Clicking a point switches it between train and validation. */
  onSwitch?: (x: number) => void;
  words?: PointWords;
}) {
  const xs = points.map((p) => p.x);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const ys = points.flatMap((p) => (p.sd === null ? [p.value] : [p.value - p.sd, p.value + p.sd]));
  const [yLo, yHi] = valueRange(ys.length ? ys : [0, 1]);
  const pad = (xHi - xLo) * 0.05 || 1;
  const [x0, x1] = logx ? [xLo / 1.35, xHi * 1.35] : [xLo - pad, xHi + pad];
  const yPad = (yHi - yLo) * 0.06;
  const [y0, y1] = [yLo - yPad, yHi + yPad];
  const lg = (v: number) => (logx ? Math.log10(v) : v);
  const px = (v: number) => ((lg(v) - lg(x0)) / (lg(x1) - lg(x0))) * 100;
  const py = (v: number) => (1 - (v - y0) / (y1 - y0)) * 100;
  const xt = logx ? decades(xLo, xHi) : ticks(xLo, xHi, 4);
  const yt = yHi === 1 && yLo >= -0.1 ? [0, 0.5, 1] : ticks(yLo, yHi, 3);
  const at = (p: Point) => ({ left: px(p.x), top: py(p.value) });
  const switching = onSwitch !== undefined && words !== undefined;
  return (
    <div className="data-chart">
      <div className="plot" role={switching ? "group" : "img"} aria-label={label}>
        {yt.map((v) => (
          <div
            key={`g${v}`}
            aria-hidden="true"
            className="gridline"
            style={{ top: `calc(${pc(py(v))} - 0.5px)` }}
          />
        ))}
        <div aria-hidden="true" className="baseline" />
        {points.map((p) => {
          const x = px(p.x);
          const y = py(p.value);
          return (
            <span key={p.x}>
              {!p.interpolated && p.sd !== null && p.sd > 0 && (
                <span
                  aria-hidden="true"
                  className="whisker"
                  style={{
                    left: `calc(${pc(x)} - 2.5px)`,
                    top: `calc(${pc(py(p.value + p.sd))} - 0.5px)`,
                    height: `calc(${pc(py(p.value - p.sd) - py(p.value + p.sd))} + 1px)`,
                  }}
                />
              )}
              <span
                aria-hidden="true"
                className={`mark${p.interpolated ? " added" : ""}${p.validation ? " held" : ""}${outOfRange?.has(p.x) ? " bad" : ""}`}
                style={{ left: pc(x), top: pc(y) }}
              />
              {outOfRange?.has(p.x) && (
                <span aria-hidden="true" className="bad-ring" style={{ left: pc(x), top: pc(y) }} />
              )}
              {p.x === ring && (
                <span
                  aria-hidden="true"
                  className="ring"
                  style={{ left: `calc(${pc(x)} - 6px)`, top: `calc(${pc(y)} - 6px)` }}
                />
              )}
            </span>
          );
        })}
        {switching && <PointButtons points={points} at={at} words={words} onSwitch={onSwitch} />}
        {xt.map((v) => (
          <span
            key={`x${v}`}
            aria-hidden="true"
            className="ax"
            style={{
              left: `calc(${pc(px(v))} - 24px)`,
              top: "calc(100% + 5px)",
              width: 48,
              textAlign: "center",
            }}
          >
            {short(v)}
          </span>
        ))}
        {yt.map((v) => (
          <span
            key={`y${v}`}
            aria-hidden="true"
            className="ax"
            style={{
              right: "calc(100% + 7px)",
              top: `calc(${pc(py(v))} - 7px)`,
              width: 34,
              textAlign: "right",
            }}
          >
            {short(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** What a data chart's marks mean, counted: measured, interpolated, validation, out of range. */
export function PointsLegend({ points, outOfRange }: { points: Point[]; outOfRange: number }) {
  const added = points.filter((p) => p.interpolated).length;
  const held = points.filter((p) => p.validation).length;
  return (
    <div className="lgs" aria-hidden="true">
      <span className="lg">
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none">
          <path d="M4 1v12M1.5 1h5M1.5 13h5" className="stroke-ink" />
          <circle cx="4" cy="7" r="2.4" className="fill-ink" />
        </svg>
        measured ± SD
      </span>
      {added > 0 && (
        <span className="lg">
          <span className="glyph added" />
          <span>
            <span className="mono">{added}</span> interpolated · no SD
          </span>
        </span>
      )}
      {held > 0 && (
        <span className="lg">
          <span className="glyph held" />
          {added > 0 && <span className="glyph added held" />}
          <span>
            <span className="mono">{held}</span> validation
          </span>
        </span>
      )}
      {outOfRange > 0 && (
        <span className="lg bad">
          <span className="glyph bad-ring" />
          out of range
        </span>
      )}
    </div>
  );
}

/**
 * Every sweep's voltage command on a true time axis: a light family and one
 * dark sweep, its measured step shaded. Durations or voltages that aren't
 * numbers yet draw at their sweep's nearest sense.
 */
export function VoltageCommand({
  holding,
  steps,
  sweeps,
  label,
}: {
  holding: number;
  steps: Step[];
  /** Each point's x: the swept voltage or duration. */
  sweeps: number[];
  label: string;
}) {
  const W = 344;
  const H = 176;
  const L = 40;
  const R = 2;
  const T = 8;
  const B = 8;
  // A few sweeps read better than every one: about six, the ends kept.
  const every = Math.max(1, Math.round(sweeps.length / 6));
  const vals = sweeps.filter((_, i) => i % every === 0);
  if (sweeps.length > 0 && vals[vals.length - 1] !== sweeps[sweeps.length - 1]) {
    vals.push(sweeps[sweeps.length - 1]);
  }
  const voltages = [
    holding,
    ...steps.flatMap((s) => (s.voltage_mV === "swept" ? sweeps : [s.voltage_mV])),
  ];
  const vmin = Math.min(-140, Math.min(...voltages) - 10);
  const vmax = Math.max(60, Math.max(...voltages) + 10);
  const dmax = Math.max(0, ...sweeps);
  const total = steps.reduce((t, s) => t + (s.duration_ms === "swept" ? dmax : s.duration_ms), 0);
  const pre = total * 0.16;
  const tmax = total + 2 * pre || 1;
  const sx = (t: number) => L + (t / tmax) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
  const hi = Math.round((vals.length - 1) * 0.72);
  let family = "";
  let dark = "";
  let measured = "";
  vals.forEach((val, k) => {
    let t = pre;
    let d = `M${sx(0).toFixed(1)} ${sy(holding).toFixed(1)}L${sx(pre).toFixed(1)} ${sy(holding).toFixed(1)}`;
    for (const s of steps) {
      const v = s.voltage_mV === "swept" ? val : s.voltage_mV;
      const dd = s.duration_ms === "swept" ? val : s.duration_ms;
      d += `L${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`;
      if (k === hi && s.measure !== null) {
        measured = `M${sx(t).toFixed(1)} ${T}H${sx(t + dd).toFixed(1)}V${H - B}H${sx(t).toFixed(1)}Z`;
      }
      t += dd;
      d += `L${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`;
    }
    d += `L${sx(t).toFixed(1)} ${sy(holding).toFixed(1)}L${sx(t + pre).toFixed(1)} ${sy(holding).toFixed(1)}`;
    if (k === hi) dark = d;
    else family += d;
  });
  const yt = [50, 0, -50, -100].filter((v) => v >= vmin && v <= vmax);
  return (
    <div className="vcmd" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={measured} className="measured" />
        <path d={yt.map((v) => `M${L} ${sy(v).toFixed(1)}H${W - R}`).join("")} className="grid" />
        <path d={family} className="family" />
        <path d={dark} className="sweep" />
      </svg>
      {yt.map((v) => (
        <span
          key={v}
          aria-hidden="true"
          className="ax"
          style={{
            left: 0,
            top: `calc(${pc((sy(v) / H) * 100)} - 7px)`,
            width: L - 8,
            textAlign: "right",
          }}
        >
          {minus(String(v))}
        </span>
      ))}
      <span aria-hidden="true" className="ax" style={{ left: L, top: "calc(100% + 5px)" }}>
        0
      </span>
      <span aria-hidden="true" className="ax" style={{ right: 0, top: "calc(100% + 5px)" }}>
        {Math.round(total)} ms
      </span>
    </div>
  );
}

/** The decay window drawn on a sketch of an open probability: its two levels, and the time between. */
export function DecaySketch({ from, to }: { from: number; to: number }) {
  const X0 = 46;
  const X1 = 432;
  const Y0 = 8;
  const YB = 66;
  const N = 240;
  const f = (t: number) => (1 - Math.exp(-t / 0.08)) * Math.exp(-t / 0.32);
  const raw = Array.from({ length: N + 1 }, (_, k) => f(k / N));
  const top = Math.max(...raw);
  const peakAt = raw.indexOf(top);
  const ys = raw.map((y) => y / top);
  const sx = (t: number) => X0 + t * (X1 - X0);
  const sy = (y: number) => YB - y * (YB - Y0);
  const trace = ys
    .map((y, k) => `${k ? "L" : "M"}${sx(k / N).toFixed(1)} ${sy(y).toFixed(1)}`)
    .join("");
  const a = from / 100;
  const b = to / 100;
  const ok = a > 0 && b > 0 && a <= 1 && b <= 1 && a !== b;
  if (!ok) {
    return (
      <span className="decay-sketch" role="img" aria-label="Sketch of an open probability">
        <svg width="440" height="98" viewBox="0 0 440 98" fill="none" aria-hidden="true">
          <path d={`M${X0} ${YB}.5H${X1}`} className="base" />
          <path d={trace} className="trace" />
        </svg>
      </span>
    );
  }
  const rise = a < b;
  const cross = (fr: number) => {
    if (fr >= 1) return peakAt;
    if (rise) {
      for (let k = 1; k <= peakAt; k++) {
        if (ys[k] >= fr) return k - 1 + (fr - ys[k - 1]) / (ys[k] - ys[k - 1]);
      }
      return peakAt;
    }
    for (let j = peakAt + 1; j <= N; j++) {
      if (ys[j] <= fr) return j - 1 + (ys[j - 1] - fr) / (ys[j - 1] - ys[j]);
    }
    return N;
  };
  const xa = sx(cross(a) / N);
  const xb = sx(cross(b) / N);
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  let ya = sy(a);
  let yb = sy(b);
  const gap = 13 - Math.abs(ya - yb);
  if (gap > 0) {
    if (ya < yb) [ya, yb] = [ya - gap / 2, yb + gap / 2];
    else [ya, yb] = [ya + gap / 2, yb - gap / 2];
  }
  const mid = Math.max(X0 + 4, Math.min(X1 - 64, (lo + hi) / 2 - 40));
  const what = rise ? "rise" : "decay";
  return (
    <span
      className="decay-sketch"
      role="img"
      aria-label={`Sketch: the ${what} time is timed from ${from} % to ${to} % of the peak`}
    >
      <svg width="440" height="98" viewBox="0 0 440 98" fill="none" aria-hidden="true">
        <path
          d={`M${lo.toFixed(1)} ${Y0}H${hi.toFixed(1)}V${YB}H${lo.toFixed(1)}Z`}
          className="band"
        />
        <path
          d={[a, b].map((fr) => `M${X0} ${sy(fr).toFixed(1)}H${X1}`).join("")}
          className="level"
        />
        <path
          d={[
            [xa, a],
            [xb, b],
          ]
            .map(([x, fr]) => `M${x.toFixed(1)} ${sy(fr).toFixed(1)}V${YB}`)
            .join("")}
          className="drop"
        />
        <path d={`M${X0} ${YB}.5H${X1}`} className="base" />
        <path d={trace} className="trace" />
        <path d={`M${lo.toFixed(1)} ${YB + 6}v6H${hi.toFixed(1)}v-6`} className="bracket" />
      </svg>
      <span
        aria-hidden="true"
        className="ax"
        style={{ left: 0, top: ya - 7, width: X0 - 8, textAlign: "right" }}
      >
        {from} %
      </span>
      <span
        aria-hidden="true"
        className="ax"
        style={{ left: 0, top: yb - 7, width: X0 - 8, textAlign: "right" }}
      >
        {to} %
      </span>
      <span
        aria-hidden="true"
        className="ax ink"
        style={{ left: mid, top: YB + 15, width: 80, textAlign: "center" }}
      >
        {what} time
      </span>
    </span>
  );
}
