/**
 * One step in the Protocol builder (LaptopProtocolBuilder): its voltage and
 * duration, each fixed or swept, a template's value tagged "default" until
 * typed, and a changed one marked (#164); its measure, a decay time's
 * window, and Normalize on the measured step; moved, or removed.
 */
import type { FieldMark } from "../../setup/form";
import { KeptHint } from "../../ui/KeptHint";
import type { Template } from "../../wire/types.gen";
import { WindowControl } from "../DecayWindow";
import { parsed } from "../draft";
import { count, minus, span } from "../format";
import { DECAY_OR_RISE, MEASURE_HINTS, normalizeHint } from "../words";
import { every } from "./fields";
import { FieldIssue, MarkWords } from "./Field";
import type { BuilderStep, MeasureKind } from "./model";

const MEASURE_MENU: { value: MeasureKind | "none"; label: string }[] = [
  { value: "none", label: "Nothing" },
  { value: "peak", label: "Peak" },
  { value: "decay_time", label: DECAY_OR_RISE },
  { value: "time_to_peak", label: "Time to peak" },
];

export function StepRow({
  j,
  step: s,
  steps,
  fid,
  issues,
  sweptRange,
  normalized,
  template,
  defaults,
  marks,
  onStep,
  onMeasure,
  onNormalize,
  onMove,
  onRemove,
}: {
  j: number;
  step: BuilderStep;
  steps: number;
  fid: (key: string) => string;
  issues: Map<string, string>;
  sweptRange: { xs: number[]; column: string } | null;
  normalized: boolean;
  template: Template;
  /** Its values a template filled, still as filled (#164). */
  defaults: { voltage: boolean; duration: boolean };
  /** Its values you or another computer changed (#164). */
  marks: { voltage?: FieldMark; duration?: FieldMark };
  onStep: (change: Partial<BuilderStep>) => void;
  onMeasure: (kind: MeasureKind | "none") => void;
  onNormalize: (on: boolean) => void;
  onMove: (by: 1 | -1) => void;
  onRemove: () => void;
}) {
  const n = j + 1;
  const a = parsed(s.from) ?? Number.NaN;
  const b = parsed(s.to) ?? Number.NaN;
  // A timed step's window is known: the shared type reads by it (#164).
  const timed = s.measure === "decay_time" ? (a < b ? "Rise time" : "Decay time") : DECAY_OR_RISE;
  const quantity = (kind: "voltage" | "duration") => {
    const isV = kind === "voltage";
    const swept = isV ? s.voltageSwept : s.durationSwept;
    const key = `${isV ? "v" : "d"}${j}`;
    const unit = isV ? "mV" : "ms";
    const issue = issues.get(key);
    const mark = isV ? marks.voltage : marks.duration;
    const tagged = isV ? defaults.voltage : defaults.duration;
    return (
      <>
        <span className="k">{isV ? "Voltage" : "Duration"}</span>
        <div className="seg seg-sm" role="group" aria-label={`Step ${n} ${kind}`}>
          <button
            type="button"
            aria-pressed={!swept}
            onClick={() => onStep(isV ? { voltageSwept: false } : { durationSwept: false })}
          >
            Fixed
          </button>
          <button
            type="button"
            aria-pressed={swept}
            onClick={() => onStep(isV ? { voltageSwept: true } : { durationSwept: true })}
          >
            Swept
          </button>
        </div>
        <div className="b-q">
          {swept ? (
            <span className="from">
              <span>from data</span>
              {sweptRange === null ? (
                <span className="dim">map a column to x under Data</span>
              ) : (
                <>
                  <span className="mono">{span(sweptRange.xs, unit, isV)}</span>
                  <span className="dim">
                    {[
                      count(sweptRange.xs.length, "value"),
                      every(sweptRange.xs) && `${every(sweptRange.xs)} ${unit}`,
                      `column ${sweptRange.column}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              )}
            </span>
          ) : (
            <span className="ln">
              <input
                id={fid(key)}
                className={`input input-sm mono b-num${issue ? " bad" : ""}${mark && mark.kind !== "theirs" ? " dirty" : ""}`}
                value={isV ? minus(s.voltage) : s.duration}
                aria-label={`Step ${n} ${kind} in ${unit}`}
                aria-invalid={issue ? true : undefined}
                aria-describedby={
                  [mark ? `${fid(key)}-was` : null, issue ? `${fid(key)}-issue` : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                spellCheck={false}
                autoComplete="off"
                onChange={(e) =>
                  onStep(isV ? { voltage: e.target.value } : { duration: e.target.value })
                }
              />
              <span className="unit">{unit}</span>
              {tagged && <span className="def">default</span>}
              <MarkWords id={fid(key)} mark={mark} />
            </span>
          )}
          <FieldIssue id={fid(key)} issue={swept ? undefined : issue} />
        </div>
      </>
    );
  };
  const decay = s.measure === "decay_time";
  const measure = s.measure;
  // Normalize's hint, on or off: it keeps the room of the longer (#469 R04).
  const normalizeWords = (on: boolean) =>
    measure === "none" ? "" : normalizeHint(measure, on, template, decay && a < b);
  const windowIssue = issues.get(`from${j}`) ?? issues.get(`to${j}`);
  const percent = (end: "from" | "to") => (
    <input
      className={`input input-sm mono pct${issues.has(`${end}${j}`) ? " bad" : ""}`}
      value={s[end]}
      aria-label={`Window ${end}, % of peak`}
      aria-invalid={issues.has(`${end}${j}`) || undefined}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onStep({ [end]: e.target.value })}
    />
  );
  return (
    <div className="bstep" role="group" aria-label={`Step ${n}`}>
      <span className={`badge${s.measure === "none" ? "" : " badge-m"}`} aria-hidden="true">
        {n}
      </span>
      <div className="sg">
        {quantity("voltage")}
        {quantity("duration")}
        <label htmlFor={fid(`m${j}`)} className="k top">
          Measure
        </label>
        <div className="mcol">
          <select
            id={fid(`m${j}`)}
            className="input input-sm measure-menu"
            value={s.measure}
            onChange={(e) => onMeasure(e.target.value as MeasureKind | "none")}
          >
            {MEASURE_MENU.map((m) => (
              <option key={m.value} value={m.value}>
                {m.value === "decay_time" ? timed : m.label}
              </option>
            ))}
          </select>
          {s.measure !== "none" && MEASURE_HINTS[s.measure] && (
            <span className="hint">{MEASURE_HINTS[s.measure]}</span>
          )}
        </div>
        {decay && (
          <>
            <label htmlFor={fid(`w${j}`)} className="k top">
              Window
            </label>
            <div className="mcol">
              <WindowControl
                from={s.from}
                to={s.to}
                menuId={fid(`w${j}`)}
                onPreset={(w) => onStep(w)}
                issue={windowIssue}
              >
                <span className="ln window-other">
                  {percent("from")}
                  <span className="unit" aria-hidden="true">
                    →
                  </span>
                  {percent("to")}
                  <span className="unit">% of peak</span>
                </span>
              </WindowControl>
            </div>
          </>
        )}
        {s.measure !== "none" && (
          <>
            <span className="k top20">Normalize</span>
            <div className="nrow">
              {s.measure !== "time_to_peak" && (
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={normalized}
                    aria-label="Normalize"
                    onChange={(e) => onNormalize(e.target.checked)}
                  />
                  <span className="trk" aria-hidden="true" />
                </label>
              )}
              <KeptHint says={normalizeWords(normalized)} may={[true, false].map(normalizeWords)} />
            </div>
          </>
        )}
        {issues.has(`m${j}`) && <span className="err sg-wide">{issues.get(`m${j}`)}</span>}
      </div>
      <div className="mv">
        <button
          type="button"
          className="icon-btn btn-sm"
          aria-label={`Move step ${n} up`}
          disabled={j === 0}
          onClick={() => onMove(-1)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn btn-sm"
          aria-label={`Move step ${n} down`}
          disabled={j === steps - 1}
          onClick={() => onMove(1)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn btn-sm"
          aria-label={`Remove step ${n}`}
          disabled={steps === 1}
          onClick={onRemove}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
