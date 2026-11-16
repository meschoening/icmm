/**
 * A finished start's fit inspector (#346, LaptopStart's finished views):
 * the chosen protocol's fit overlay beside every sweep's simulated open
 * probability over its voltage command, on one time axis, Absolute or Each
 * sweep's peak = 1. `FitOverlay` and `SweepsFigure` draw any start's; their
 * geometry is `charts.ts`', beside Compare's overlay (#342).
 */
import { useState } from "react";
import { axisTitles, sweepWords, sweepsOf as measuredOf } from "../../datasets/detail/words";
import type { ModelAlong } from "../../simulation/queries";
import type { Protocol, SimulatedPoint, Template } from "../../wire/types.gen";
import { fitOf, INSPECTOR, INSPECTOR_R, RESPONSE, sweepsOf, VOLTAGE, type Label } from "./charts";

/** Labels laid over a drawing, each at its place. */
export function Labels({ labels }: { labels: Label[] }) {
  return (
    <>
      {labels.map((l, i) => (
        <span
          key={i}
          className={`sp-lab${l.align ? ` ${l.align}` : ""}${l.kind ? ` ${l.kind}` : ""}`}
          style={{ left: l.left, top: l.top }}
          aria-hidden="true"
        >
          {l.t}
        </span>
      ))}
    </>
  );
}

/**
 * A protocol's points with a start's line over them, large, its axes titled
 * as Dataset detail titles them.
 */
export function FitOverlay({
  protocol,
  template,
  line,
  validation,
  label,
}: {
  protocol: Protocol;
  template: Template;
  /** The start's model along the protocol's x, as its line is drawn. */
  line: ModelAlong | undefined;
  validation: boolean;
  label: string;
}) {
  const fit = fitOf(protocol.points, line ?? [], protocol.interpolation.log_x, {
    box: INSPECTOR,
    r: INSPECTOR_R,
    validation,
    titles: axisTitles(protocol, template),
  });
  return (
    <span className="sp-plot sp-overlay">
      <svg
        className="fluid"
        width="100%"
        height={INSPECTOR.height}
        viewBox={`0 0 ${INSPECTOR.width} ${INSPECTOR.height}`}
        preserveAspectRatio="none"
        fill="none"
        role="img"
        aria-label={label}
      >
        <path className="sp-grid" d={fit.grid} />
        <path className="sp-base" d={fit.base} />
        <path className="sp-whisk" d={fit.whiskers} />
        <path className="sp-model" d={fit.model} />
        <path className="sp-k-dot" d={fit.dots} />
        <path className="sp-k-ring" d={fit.rings} />
        <path className="sp-k-dot" d={fit.diamonds} />
        <path className="sp-k-ring" d={fit.hollow} />
      </svg>
      <Labels labels={fit.labels} />
    </span>
  );
}

/**
 * Every measured sweep's simulated open probability over its voltage
 * command, on one time axis, the sweep `hi` highlighted and named.
 */
export function SweepsFigure({
  protocol,
  simulated,
  hi,
  name,
  peak,
}: {
  protocol: Protocol;
  simulated: readonly SimulatedPoint[];
  /** The highlighted sweep, by its place among the measured sweeps. */
  hi: number;
  /** What it's called: "−20 mV". */
  name: string;
  peak: boolean;
}) {
  const s = sweepsOf(protocol, simulated, { hi, label: name, peak });
  return (
    <>
      <span className="sp-plot sp-response">
        <svg
          className="fluid"
          width="100%"
          height={RESPONSE.height}
          viewBox={`0 0 ${RESPONSE.width} ${RESPONSE.height}`}
          preserveAspectRatio="none"
          fill="none"
          role="img"
          aria-label={s.response.aria}
        >
          <path className="sp-vgrid" d={s.response.vgrid} />
          <path className="sp-grid" d={s.response.grid} />
          <path className="sp-base" d={s.response.base} />
          {s.response.curves.map((k, i) => (
            <path key={i} className={k.hi ? "sp-sweep hi" : "sp-sweep"} d={k.d} />
          ))}
        </svg>
        <Labels labels={s.response.labels} />
      </span>
      <span className="sp-plot sp-voltage">
        <svg
          className="fluid"
          width="100%"
          height={VOLTAGE.height}
          viewBox={`0 0 ${VOLTAGE.width} ${VOLTAGE.height}`}
          preserveAspectRatio="none"
          fill="none"
          role="img"
          aria-label={s.voltage.aria}
        >
          <path className="sp-vgrid" d={s.voltage.vgrid} />
          <path className="sp-grid" d={s.voltage.grid} />
          {s.voltage.curves.map((k, i) => (
            <path key={i} className={k.hi ? "sp-command hi" : "sp-command"} d={k.d} />
          ))}
        </svg>
        <Labels labels={s.voltage.labels} />
      </span>
    </>
  );
}

/**
 * The chosen protocol inspected: its name, the highlighted sweep (the
 * middle measured one, as Dataset detail darkens it), the scale, then its
 * fit overlay beside its sweeps. Without its sweeps yet, it says it's
 * drawing them.
 */
export function FitInspector({
  protocol,
  template,
  label,
  line,
  simulated,
  validation,
  start,
}: {
  protocol: Protocol;
  template: Template;
  /** The protocol's template in words: "G/V activation". */
  label: string;
  line: ModelAlong | undefined;
  simulated: readonly SimulatedPoint[] | undefined;
  validation: boolean;
  start: number;
}) {
  const [peak, setPeak] = useState(false);
  const sweeps = measuredOf(protocol);
  const hi = Math.floor(sweeps.length / 2);
  const name = sweeps.length === 0 ? "" : sweepWords(protocol, template, sweeps[hi]);
  return (
    <div className="sp-insp">
      <div className="sp-insphead">
        <h3>
          <span className="mono">{protocol.name}</span> · {label}
        </h3>
        <span className="sp-hi">
          Highlighted sweep: <span className="mono">{name}</span>
        </span>
        <span className="sp-scale">Open probability</span>
        <div className="seg" role="group" aria-label="Open probability scale">
          <button type="button" aria-pressed={!peak} onClick={() => setPeak(false)}>
            Absolute
          </button>
          <button type="button" aria-pressed={peak} onClick={() => setPeak(true)}>
            Each sweep’s peak = 1
          </button>
        </div>
      </div>
      <div className="sp-inspgrid">
        <div className="sp-inspcol">
          <span className="sp-insplabel">Fit overlay</span>
          <FitOverlay
            protocol={protocol}
            template={template}
            line={line}
            validation={validation}
            label={`Fit overlay for ${protocol.name}: start ${start}’s simulated curve over the measured points`}
          />
        </div>
        <div className="sp-inspcol">
          <span className="sp-insplabel">
            Simulated response and voltage protocol · shared time axis
          </span>
          {simulated === undefined ? (
            <p className="sp-reading">Drawing its sweeps on this computer…</p>
          ) : (
            <SweepsFigure
              protocol={protocol}
              simulated={simulated}
              hi={hi}
              name={name}
              peak={peak}
            />
          )}
        </div>
      </div>
    </div>
  );
}
