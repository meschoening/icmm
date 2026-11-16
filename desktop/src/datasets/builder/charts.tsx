/**
 * The Protocol builder's charts (LaptopProtocolBuilder): every sweep's
 * voltage command on a true time axis, one sweep highlighted, its steps
 * labeled and its measured step shaded; and each template card's glyph, the
 * same drawing at a card's size. Colors come from tokens.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { minus, short } from "../format";

/** A step as drawn: numbers only, the caller's stand-ins where a field isn't one. */
export interface DrawnStep {
  voltage: number;
  duration: number;
  measured: boolean;
}

/** The one swept quantity, if there's one: which step's voltage or duration. */
export interface Swept {
  step: number;
  kind: "voltage" | "duration";
}

interface Segment {
  step: number;
  t0: number;
  t1: number;
  voltage: number;
  measured: boolean;
}

/** Each sweep's corners (time, voltage), and the highlighted sweep's steps as segments. */
function sweepsOf(
  holding: number,
  steps: DrawnStep[],
  swept: Swept | null,
  sweeps: number[],
  hi: number,
  pre: (longest: number) => number,
) {
  const values: (number | null)[] = swept !== null && sweeps.length > 0 ? sweeps : [null];
  const longest = Math.max(
    0,
    ...values.map((val) =>
      steps.reduce(
        (t, s, i) =>
          t + (val !== null && swept?.kind === "duration" && swept.step === i ? val : s.duration),
        0,
      ),
    ),
  );
  const hold = pre(longest);
  const segments: Segment[] = [];
  const lines = values.map((val, k) => {
    let t = hold;
    const pts: [number, number][] = [
      [0, holding],
      [hold, holding],
    ];
    steps.forEach((s, i) => {
      const here = val !== null && swept !== null && swept.step === i ? swept.kind : null;
      const v = here === "voltage" ? val! : s.voltage;
      const d = here === "duration" ? val! : s.duration;
      pts.push([t, v]);
      if (k === hi) segments.push({ step: i, t0: t, t1: t + d, voltage: v, measured: s.measured });
      t += d;
      pts.push([t, v]);
    });
    pts.push([t, holding], [t + hold, holding]);
    return pts;
  });
  return { lines, segments, tmax: longest + 2 * hold || 1, values };
}

/** A round step for about `n` ticks across 0…`span`. */
function niceStep(span: number, n: number): number {
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
}

function path(pts: [number, number][], sx: (t: number) => number, sy: (v: number) => number) {
  return pts.map(([t, v], j) => `${j ? "L" : "M"}${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`).join("");
}

/** The voltage range drawn: −140 to +60 mV, wider where a voltage is outside it. */
function voltageRange(holding: number, steps: DrawnStep[], swept: Swept | null, sweeps: number[]) {
  const vs = [holding, ...steps.map((s) => s.voltage)];
  if (swept?.kind === "voltage") vs.push(...sweeps);
  return [Math.min(-140, Math.min(...vs) - 10), Math.max(60, Math.max(...vs) + 10)];
}

/** The voltage command's width at 1280 and below, and before its column is measured. */
const W0 = 520;
const H = 240;
const L = 40;
const R = 8;
const T = 30;
const B = 26;

/**
 * The width of the element `ref` is on, in whole px, `fallback` until it's
 * measured or where there's no ResizeObserver.
 */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const e = ref.current;
    if (e === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(e);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Every sweep's voltage command, `hi` highlighted (LaptopProtocolBuilder,
 * 240 px tall): 520 px wide at 1280, across its column above (#451).
 */
export function SweepsChart({
  holding,
  steps,
  swept,
  sweeps,
  hi,
  label,
}: {
  holding: number;
  steps: DrawnStep[];
  swept: Swept | null;
  /** The swept quantity's value in each sweep; none draws one sweep as typed. */
  sweeps: number[];
  hi: number;
  label: string;
}) {
  const [ref, W] = useWidth(W0);
  const { lines, segments, tmax } = sweepsOf(holding, steps, swept, sweeps, hi, (longest) =>
    Math.max(longest * 0.04, 0.1),
  );
  const [vmin, vmax] = voltageRange(holding, steps, swept, sweeps);
  const sx = (t: number) => L + (t / tmax) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
  const top = T;
  const bottom = H - B;
  const family = lines
    .filter((_, k) => k !== hi)
    .map((pts) => path(pts, sx, sy))
    .join("");
  const dark = lines[Math.min(hi, lines.length - 1)];
  let band = "";
  let edges = "";
  let seps = "";
  segments.forEach((s, i) => {
    const x0 = sx(s.t0);
    const x1 = sx(s.t1);
    if (i > 0) seps += `M${x0.toFixed(1)} ${top - 22}V${bottom}`;
    if (s.measured) {
      band += `M${x0.toFixed(1)} ${top}H${x1.toFixed(1)}V${bottom}H${x0.toFixed(1)}Z`;
      edges += `M${x0.toFixed(1)} ${top}V${bottom}M${x1.toFixed(1)} ${top}V${bottom}`;
    }
  });
  if (segments.length > 0) {
    seps += `M${sx(segments[0].t0).toFixed(1)} ${top - 22}V${bottom}`;
    seps += `M${sx(segments[segments.length - 1].t1).toFixed(1)} ${top - 22}V${bottom}`;
  }
  const yt = [-100, -50, 0, 50].filter((v) => v > vmin && v < vmax);
  const step = niceStep(tmax, 6);
  const xt: number[] = [];
  for (let t = 0; t <= tmax + step * 1e-9; t += step) xt.push(Number(t.toPrecision(12)));
  const first = segments.length > 0 ? sx(segments[0].t0) : W - R;
  return (
    <div ref={ref} className="sweeps" role="img" aria-label={label}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden="true">
        <path d={band} className="band" />
        <path d={edges} className="band-edge" />
        <path d={yt.map((v) => `M${L} ${sy(v).toFixed(1)}H${W - R}`).join("")} className="grid" />
        <path d={`M${L} ${bottom + 0.5}H${W - R}`} className="base" />
        <path d={seps} className="sep" />
        <path d={family} className="family" />
        {dark && <path d={path(dark, sx, sy)} className="sweep" />}
      </svg>
      <span
        aria-hidden="true"
        className="sw-label"
        style={
          first - L < 34
            ? { left: first - 35, top: top - 22, width: 32, textAlign: "right" }
            : { left: L + 4, top: top - 22 }
        }
      >
        hold
      </span>
      {segments.map((s) => {
        const x0 = sx(s.t0);
        const w = sx(s.t1) - x0;
        const here = swept !== null && swept.step === s.step ? swept.kind : null;
        let text = String(s.step + 1);
        if (w > 150) {
          text += here === "voltage" ? " · swept voltage" : ` · ${signed(s.voltage)} mV`;
          if (here === "duration") text += " · swept duration";
          if (s.measured) text += " · measured";
        } else if (w > 60 && s.measured) {
          text += " · measured";
        }
        return (
          <span
            key={s.step}
            aria-hidden="true"
            className={`sw-label${s.measured ? " on" : ""}`}
            style={{ left: x0 + 6, top: top - 22, maxWidth: Math.max(12, w - 10) }}
          >
            {text}
          </span>
        );
      })}
      {xt.map((t) => (
        <span
          key={`x${t}`}
          aria-hidden="true"
          className="ax"
          style={{ left: sx(t) - 30, top: bottom + 6, width: 60, textAlign: "center" }}
        >
          {short(t)}
        </span>
      ))}
      {yt.map((v) => (
        <span
          key={`y${v}`}
          aria-hidden="true"
          className="ax"
          style={{ left: 0, top: sy(v) - 7, width: L - 8, textAlign: "right" }}
        >
          {minus(String(v))}
        </span>
      ))}
      <span aria-hidden="true" className="sw-unit">
        mV
      </span>
    </div>
  );
}

/** A voltage with its sign: "+40", "−80", "0". */
function signed(v: number): string {
  return v > 0 ? `+${short(v)}` : short(v);
}

/** A template card's glyph: its sweeps at a card's size, the middle one dark. */
export function TemplateGlyph({
  holding,
  steps,
  swept,
  sweeps,
}: {
  holding: number;
  steps: DrawnStep[];
  swept: Swept | null;
  sweeps: number[];
}) {
  const w = 96;
  const h = 34;
  const middle = Math.floor(sweeps.length / 2);
  const { lines, tmax } = sweepsOf(holding, steps, swept, sweeps, middle, () => 12);
  const hi = Math.min(middle, lines.length - 1);
  const [vmin, vmax] = voltageRange(holding, steps, swept, sweeps);
  const sx = (t: number) => 1 + (t / tmax) * (w - 2);
  const sy = (v: number) => 2 + (1 - (v - vmin) / (vmax - vmin)) * (h - 4);
  const family = lines
    .filter((_, k) => k !== hi)
    .map((pts) => path(pts, sx, sy))
    .join("");
  return (
    <svg
      className="tpl-glyph"
      width="100%"
      height="28"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true"
    >
      <path d={family} className="family" />
      <path d={path(lines[hi], sx, sy)} className="sweep" />
    </svg>
  );
}
