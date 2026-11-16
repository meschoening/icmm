/**
 * Dataset detail's two charts for each protocol (LaptopDatasetDetail): its
 * data, and every sweep's voltage command, side by side. One sweep is drawn
 * dark on the right and ringed on the left; the pointer picks the measured
 * point nearest it along x, and the keyboard steps through them (DS06), a
 * gray halo on the one pointed at or focused. Each chart has its summary in
 * words; colors come from tokens. While validation points change (#53),
 * each point of the data is a button that switches it.
 */
import { useRef, useState } from "react";
import type { Point, Protocol } from "../../wire/types.gen";
import { decades, valueRange, wideTicks } from "../axes";
import { HitLayer, PointButtons } from "../charts";
import type { PointWords } from "../points";
import { minus, short } from "../format";

const pc = (v: number) => `${v.toFixed(2)}%`;

/** A tick label: x below the plot, or y left of it. */
function Tick({ at, axis, children }: { at: number; axis: "x" | "y"; children: string }) {
  const style =
    axis === "x"
      ? { left: `calc(${pc(at)} - 24px)`, top: "calc(100% + 5px)", width: 48, textAlign: "center" }
      : { right: "calc(100% + 7px)", top: `calc(${pc(at)} - 7px)`, width: 33, textAlign: "right" };
  return (
    <span aria-hidden="true" className="ax" style={style as React.CSSProperties}>
      {children}
    </span>
  );
}

/**
 * A protocol's points: measured means with SD whiskers (●), interpolated
 * points without (◆), validation points hollow (○ ◇), on round axes. The
 * measured point `hi` is ringed; the pointer picks the measured point
 * nearest it along x, and each measured point is a radio, one tab stop
 * whose arrow keys pick the next. With `onSwitch`, each point is a button
 * on a faint cobalt disc instead.
 */
export function PointsChart({
  protocol,
  logx,
  hi,
  onPick,
  label,
  onSwitch,
  words,
  pickName = (p) => `${minus(String(p.x))}`,
}: {
  protocol: Protocol;
  logx: boolean;
  /** The chart in words, for a screen reader. */
  label: string;
  /** The ringed point, as an index into the measured points. */
  hi: number;
  onPick: (measured: number) => void;
  /** Clicking a point switches it between train and validation. */
  onSwitch?: (x: number) => void;
  words?: PointWords;
  /** How a measured point's radio is named: its sweep, "−20 mV". */
  pickName?: (p: Point) => string;
}) {
  const points = protocol.points;
  const xs = points.map((p) => p.x);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const ys = points.flatMap((p) => (p.sd === null ? [p.value] : [p.value - p.sd, p.value + p.sd]));
  const [yLo, yHi] = valueRange(ys.length ? ys : [0, 1]);
  const pad = (xHi - xLo) * 0.05 || 1;
  const [x0, x1] = logx ? [xLo / 1.35, xHi * 1.35] : [xLo - pad, xHi + pad];
  const yPad = (yHi - yLo) * 0.05;
  const [y0, y1] = [yLo - yPad, yHi + yPad];
  const lg = (v: number) => (logx ? Math.log10(v) : v);
  const px = (v: number) => ((lg(v) - lg(x0)) / (lg(x1) - lg(x0))) * 100;
  const py = (v: number) => (1 - (v - y0) / (y1 - y0)) * 100;
  const xt = logx ? decades(xLo, xHi) : wideTicks(xLo, xHi);
  const yt = yHi === 1 && yLo >= -0.1 ? [0, 0.25, 0.5, 0.75, 1] : wideTicks(yLo, yHi, 4);
  const measured = points.filter((p) => !p.interpolated);
  const ringed = measured[Math.min(hi, measured.length - 1)] as Point | undefined;
  const at = (p: Point) => ({ left: pc(px(p.x)), top: pc(py(p.value)) });
  const switching = onSwitch !== undefined && words !== undefined;
  return (
    <div className="pts-chart">
      <div className="plot" role={switching ? "group" : "radiogroup"} aria-label={label}>
        {yt.map((v) => (
          <div
            key={`g${v}`}
            aria-hidden="true"
            className="gridline"
            style={{ top: `calc(${pc(py(v))} - 0.5px)` }}
          />
        ))}
        <div aria-hidden="true" className="baseline" />
        {points.map((p) => (
          <span key={p.x}>
            {!p.interpolated && p.sd !== null && p.sd > 0 && (
              <span
                aria-hidden="true"
                className="whisker"
                style={{
                  left: `calc(${pc(px(p.x))} - 2.5px)`,
                  top: `calc(${pc(py(p.value + p.sd))} - 0.5px)`,
                  height: `calc(${pc(py(p.value - p.sd) - py(p.value + p.sd))} + 1px)`,
                }}
              />
            )}
            <span
              aria-hidden="true"
              className={`mark${p.interpolated ? " added" : ""}${p.validation ? " held" : ""}`}
              style={at(p)}
            />
          </span>
        ))}
        {ringed !== undefined && <span aria-hidden="true" className="ring" style={at(ringed)} />}
        {switching ? (
          <PointButtons
            points={points}
            at={(p) => ({ left: px(p.x), top: py(p.value) })}
            words={words}
            onSwitch={onSwitch}
            onHover={(p) => {
              const i = measured.indexOf(p);
              if (i >= 0) onPick(i);
            }}
            className="vhit edit"
          />
        ) : (
          <PointPicks
            points={measured}
            at={(p) => ({ left: px(p.x), top: py(p.value) })}
            hi={Math.min(hi, measured.length - 1)}
            onPick={onPick}
            name={pickName}
          />
        )}
        {xt.map((v) => (
          <Tick key={`x${v}`} axis="x" at={px(v)}>
            {short(v)}
          </Tick>
        ))}
        {yt.map((v) => (
          <Tick key={`y${v}`} axis="y" at={py(v)}>
            {short(v)}
          </Tick>
        ))}
      </div>
    </div>
  );
}

/**
 * The measured points as radios (DS06): the pointer picks the one nearest it
 * along x through one hit layer, and the keyboard reaches them as one tab
 * stop, the checked one, whose arrow keys, Home and End pick the next in x
 * order. The point pointed at or focused gets a gray halo.
 */
function PointPicks({
  points,
  at,
  hi,
  onPick,
  name,
}: {
  points: Point[];
  at: (p: Point) => { left: number; top: number };
  hi: number;
  onPick: (measured: number) => void;
  name: (p: Point) => string;
}) {
  /** The point the pointer is on, and the one focused, by index. */
  const [near, setNear] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const radios = useRef(new Map<number, HTMLButtonElement>());
  const haloed = near ?? focused;
  const go = (i: number) => {
    onPick(i);
    radios.current.get(i)?.focus({ preventScroll: true });
  };
  const keyTo = (from: number, key: string): number | undefined => {
    const last = points.length - 1;
    const to: Record<string, number> = {
      ArrowRight: Math.min(from + 1, last),
      ArrowDown: Math.min(from + 1, last),
      ArrowLeft: Math.max(from - 1, 0),
      ArrowUp: Math.max(from - 1, 0),
      Home: 0,
      End: last,
    };
    return to[key];
  };
  return (
    <>
      <HitLayer
        points={points}
        left={(p) => at(p).left}
        onNear={(p) => {
          const i = points.indexOf(p);
          setNear(i);
          onPick(i);
        }}
        onLeave={() => setNear(null)}
      />
      {points.map((p, i) => {
        const { left, top } = at(p);
        return (
          <button
            key={`r${p.x}`}
            ref={(el) => {
              if (el === null) radios.current.delete(i);
              else radios.current.set(i, el);
            }}
            type="button"
            role="radio"
            aria-checked={i === hi}
            aria-label={name(p)}
            tabIndex={i === hi ? 0 : -1}
            className={`vhit${i === haloed ? " near" : ""}`}
            style={{ left: pc(left), top: pc(top) }}
            onFocus={() => {
              setFocused(i);
              onPick(i);
            }}
            onBlur={() => setFocused((f) => (f === i ? null : f))}
            onKeyDown={(e) => {
              const to = keyTo(i, e.key);
              if (to === undefined) return;
              e.preventDefault();
              go(to);
            }}
          />
        );
      })}
    </>
  );
}

/**
 * Every measured sweep's voltage command on a true time axis: a light
 * family and the sweep `hi` dark. Each sweep starts and ends at the holding
 * potential; a swept duration ends its sweep early, and it holds until the
 * longest one ends.
 */
export function SweepsChart({
  protocol,
  sweeps,
  hi,
  label,
}: {
  protocol: Protocol;
  /** Each sweep's x: the swept voltage or duration. */
  sweeps: number[];
  hi: number;
  label: string;
}) {
  const { holding_mV: holding, steps } = protocol;
  const voltages = [
    holding,
    ...steps.flatMap((s) => (s.voltage_mV === "swept" ? sweeps : [s.voltage_mV])),
  ];
  const vmin = Math.min(-130, Math.min(...voltages) - 10);
  const vmax = Math.max(55, Math.max(...voltages) + 10);
  const dmax = Math.max(0, ...sweeps);
  const total = steps.reduce((t, s) => t + (s.duration_ms === "swept" ? dmax : s.duration_ms), 0);
  const pre = total * 0.1;
  const tmax = total + 2 * pre || 1;
  const ux = (t: number) => (t / tmax) * 1000;
  const uy = (v: number) => (1 - (v - vmin) / (vmax - vmin)) * 1000;
  const pt = (t: number, v: number) => `${ux(t).toFixed(1)} ${uy(v).toFixed(1)}`;
  let family = "";
  let dark = "";
  const darkIndex = Math.min(hi, sweeps.length - 1);
  sweeps.forEach((x, k) => {
    let t = pre;
    let d = `M${pt(0, holding)}L${pt(pre, holding)}`;
    for (const s of steps) {
      const v = s.voltage_mV === "swept" ? x : s.voltage_mV;
      d += `L${pt(t, v)}`;
      t += s.duration_ms === "swept" ? x : s.duration_ms;
      d += `L${pt(t, v)}`;
    }
    d += `L${pt(t, holding)}L${pt(tmax, holding)}`;
    if (k === darkIndex) dark = d;
    else family += d;
  });
  const yt = [50, 0, -50, -100].filter((v) => v >= vmin && v <= vmax);
  const xt = wideTicks(0, tmax, 4);
  return (
    <div className="pts-chart">
      <div className="plot" role="img" aria-label={label}>
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <path d={yt.map((v) => `M0 ${uy(v).toFixed(1)}H1000`).join("")} className="grid" />
          <path d={family} className="family" />
          <path d={dark} className="sweep" />
        </svg>
        {xt.map((t) => (
          <Tick key={`x${t}`} axis="x" at={ux(t) / 10}>
            {short(t)}
          </Tick>
        ))}
        {yt.map((v) => (
          <Tick key={`y${v}`} axis="y" at={uy(v) / 10}>
            {minus(String(v))}
          </Tick>
        ))}
      </div>
    </div>
  );
}
