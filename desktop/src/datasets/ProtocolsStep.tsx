/**
 * Protocols (LaptopWizProtocols): one protocol at a time, its data beside
 * its voltage command, then its steps, a decay time's window, Normalize,
 * Weight and Time resolution. A value its template gave reads "default"
 * until edited; a value that fails its check shows `validate_dataset`'s
 * sentence under it, or for a value in the step table, on a line under the
 * table that names its row and field (#191), and the status line counts them.
 *
 * A protocol the Protocol builder made (#144) shows here like the others,
 * its steps as built. Interpolate and Validation, between Normalize and
 * Weight, are the builder's rows too (#145): the data chart previews the
 * points interpolation adds (◆) and the proposed validation points
 * (hollow), each a button that switches it, as this computer's engine
 * makes them (ADR-0011, ADR-0013). A decay time whose window runs upward
 * reads as a rise wherever it's named (#164).
 */
import { useId } from "react";
import { flushSync } from "react-dom";
import { KeptHint } from "../ui/KeptHint";
import type { Working } from "../ui/working";
import type { DatasetContent, Issue, Step } from "../wire/types.gen";
import { measureDefaults } from "./builder/model";
import { DataChart, PointsLegend, VoltageCommand } from "./charts";
import { Checking } from "./Checking";
import { WindowControl } from "./DecayWindow";
import {
  defaultsOf,
  fieldAt,
  formDirection,
  interpEdits,
  parsed,
  type Edits,
  type Field,
  type ProtocolForm,
} from "./draft";
import { count, span } from "./format";
import type { Making } from "./making";
import { InterpolateRow, ValidationRow } from "./PointRows";
import { keepOneTrain, pointWords } from "./points";
import { PointsFacts } from "./PointsFacts";
import { outOfRangeOf, useRangeFix } from "./rangeFix";
import { StepHeader } from "./StepHeader";
import {
  interpolationLine,
  NORMALIZED_Y,
  normalizeHint,
  outOfRange,
  outOfRangeWords,
  pointCounts,
  protocolsStatus,
  templateLabel,
  windowValid,
  type ProtocolsStatus,
} from "./words";

/** The issues with each protocol's fields, by protocol index and field key. */
function issuesByField(issues: Issue[]): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>();
  for (const issue of issues) {
    const at = fieldAt(issue.path);
    if (at.protocol === null) continue;
    const mine = out.get(at.protocol) ?? new Map<string, string>();
    if (!mine.has(at.key)) mine.set(at.key, issue.message);
    out.set(at.protocol, mine);
  }
  return out;
}

/** The fields whose shown issue is the last answer's, by protocol index: each is checked again. */
function staleByField(issues: Issue[], stale: ReadonlySet<Issue>): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const seen = new Set<string>();
  for (const issue of issues) {
    const at = fieldAt(issue.path);
    if (at.protocol === null) continue;
    // The field shows its first issue: it's stale only if that one is.
    const key = `${at.protocol} ${at.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!stale.has(issue)) continue;
    const mine = out.get(at.protocol) ?? new Set<string>();
    mine.add(at.key);
    out.set(at.protocol, mine);
  }
  return out;
}

/** The measure a protocol's measured step takes. */
const measureOf = (f: ProtocolForm) => f.steps.find((s) => s.measure !== null)?.measure ?? "peak";

/** A measure in words: a decay time whose window runs upward is a rise time. */
const measureWord = (f: ProtocolForm, measure: keyof typeof MEASURE_WORDS) =>
  measure === "decay_time" && formDirection(f) === "rise" ? "rise time" : MEASURE_WORDS[measure];

/** The unit a protocol's errors are in. */
function errorUnit(f: ProtocolForm): "fractions" | "ms" {
  const measure = measureOf(f);
  if (measure === "time_to_peak") return "ms";
  if (measure === "decay_time") return f.normalized ? "fractions" : "ms";
  return "fractions";
}

const MEASURE_WORDS = {
  peak: "peak",
  decay_time: "decay time",
  time_to_peak: "time to peak",
} as const;

/** The data chart's caption: what's plotted by what. */
function caption(f: ProtocolForm, logx: boolean): string {
  const measure = measureOf(f);
  const y =
    measure === "decay_time"
      ? f.normalized
        ? `${measureWord(f, measure)}, a fraction of the largest`
        : `${measureWord(f, measure)} (ms)`
      : measure === "time_to_peak"
        ? "time to peak (ms)"
        : f.normalized
          ? (NORMALIZED_Y[f.template] ?? "peak, a fraction of the largest")
          : "open probability";
  const swept = f.steps.findIndex((s) => s.voltage === null || s.duration === null);
  const sweptDuration = swept >= 0 && f.steps[swept].duration === null;
  const scale = logx ? ", log scale" : "";
  const x =
    f.template === "steady_state_inactivation"
      ? "conditioning step (mV)"
      : f.template === "recovery"
        ? `gap (ms${scale})`
        : f.template === "custom"
          ? `step ${swept + 1} ${sweptDuration ? `duration (ms${scale})` : `voltage (mV${scale})`}`
          : "test step (mV)";
  return `${y} by ${x}`;
}

/** What switches, redraws and makes each protocol's points (`NewDataset`). */
export interface PointControls {
  making: Making;
  switchAt: (sheet: string, x: number) => void;
  none: (sheet: string) => void;
  redraw: (sheet: string) => Promise<void>;
}

/** A field's number for drawing, or its template's while it isn't one. */
const numberOr = (field: Field | null, fallback: number | "swept"): number | "swept" =>
  field === null ? "swept" : (parsed(field.value) ?? fallback);

export interface ProtocolsStepProps {
  platform: string;
  step: number;
  discard: () => void;
  saving: Working;
  name: string;
  forms: ProtocolForm[];
  issues: Issue[];
  /** The issues of the checks' last answer, while the next is on its way. */
  stale: ReadonlySet<Issue>;
  /** The dataset the forms make, while every value is a number. */
  content: DatasetContent | null;
  points: PointControls;
  edits: Record<string, Edits>;
  setEdits: (edits: Record<string, Edits>) => void;
  selected: number;
  select: (i: number) => void;
  back: () => void;
  next: () => void;
}

export function ProtocolsStep(p: ProtocolsStepProps) {
  const id = useId();
  const byField = issuesByField(p.issues);
  const staleFields = staleByField(p.issues, p.stale);
  const st = makingStatus(p.forms, p.points.making) ?? protocolsStatus(p.forms, p.issues, p.stale);
  const making = p.forms.find((f) => p.points.making.pending.has(f.sheet));
  const blocked = st.blocked
    ? st.text
    : making !== undefined
      ? `Making ${making.name}’s points on this computer…`
      : undefined;
  const f = p.forms[p.selected];
  const edit = (key: string, value: string | boolean) =>
    p.setEdits({ ...p.edits, [f.sheet]: { ...p.edits[f.sheet], [key]: value } });
  const editMany = (changes: Edits) =>
    p.setEdits({ ...p.edits, [f.sheet]: { ...p.edits[f.sheet], ...changes } });
  /** A field's id, as its protocol's section gives it. */
  const fieldIdOf = (protocol: number, key: string) => `${id}-${protocol}-${key}`;
  // The note names what holds Next: it's a link to it, as Sheets' is, until its answer is stale
  // (#424 KF19, KF21).
  const at = st.checking ? undefined : st.at;
  const status =
    at === undefined ? (
      st.checking ? (
        `${st.text} · checking…`
      ) : (
        st.text
      )
    ) : (
      <a
        href={`#${fieldIdOf(at.protocol, at.key)}`}
        className="link"
        onClick={(e) => {
          e.preventDefault();
          // Its protocol shows first, so the field is there to focus.
          flushSync(() => p.select(at.protocol));
          document.getElementById(fieldIdOf(at.protocol, at.key))?.focus();
        }}
      >
        {st.text}
      </a>
    );

  return (
    <>
      <StepHeader
        step={p.step}
        title="Protocols"
        facts={
          <>
            <span className="mono">{p.name}</span> · <span className="n">{p.forms.length}</span>{" "}
            {p.forms.length === 1 ? "protocol" : "protocols"} ·{" "}
            <PointsFacts counts={pointCounts(p.forms)} />
          </>
        }
        lede="Set the voltage command each protocol was recorded with, and how much each counts in a fit. Values marked default came from the template, not from your workbook: check them against your recordings."
        status={status}
        tone={st.blocked && !st.checking ? "ink" : "plain"}
        discard={p.discard}
        back={p.back}
        primary="Next: Review"
        blocked={blocked}
        onPrimary={p.next}
      />
      <div className="protocols">
        <nav aria-label="Protocols" className="plist">
          {p.forms.map((form, i) => {
            const n = defaultsOf(form).length;
            // Interpolated points out of range are counted by the status line, not as values.
            const counted = p.issues.filter(
              (issue) => fieldAt(issue.path).protocol === i && !outOfRange(issue, p.forms),
            );
            const bad = new Set(counted.map((issue) => fieldAt(issue.path).key)).size;
            const checking = counted.some((issue) => p.stale.has(issue));
            return (
              <button
                key={form.sheet}
                type="button"
                className="pitem"
                aria-current={i === p.selected ? "true" : undefined}
                onClick={() => p.select(i)}
              >
                <span className="pn">{form.name}</span>
                <span className="ps">
                  {templateLabel(form.template, form.steps.length, formDirection(form))}
                </span>
                <span className="pmeta">
                  weight <span className="mono">{form.weight.value}</span> ·{" "}
                  <span className="mono">{n}</span> {n === 1 ? "default" : "defaults"}
                  {bad > 0 && (
                    <span className={checking ? "pbad chk" : "pbad"}>
                      {" "}
                      · {count(bad, "value")} to fix
                    </span>
                  )}
                </span>
                {interpolationLine(form) !== null && (
                  <span className="pmeta">{interpolationLine(form)}</span>
                )}
              </button>
            );
          })}
        </nav>
        {f !== undefined && (
          <Protocol
            key={f.sheet}
            idp={id}
            dataset={p.name}
            form={f}
            forms={p.forms}
            index={p.selected}
            issues={byField.get(p.selected) ?? new Map<string, string>()}
            stale={staleFields.get(p.selected) ?? new Set<string>()}
            all={p.issues}
            content={p.content}
            points={p.points}
            edit={edit}
            editMany={editMany}
            select={p.select}
          />
        )}
      </div>
    </>
  );
}

/** The status line while a protocol's points couldn't be made. */
function makingStatus(forms: ProtocolForm[], making: Making): ProtocolsStatus | null {
  const failed = forms.find((f) => making.failed.has(f.sheet));
  const error = failed && making.failed.get(failed.sheet);
  // An invalid answer's issues are the checks' too, and show where they do.
  if (failed === undefined || error?.code === "invalid") return null;
  return { blocked: true, text: `Points not made · ${failed.name}` };
}

function Protocol({
  idp,
  dataset,
  form: f,
  forms,
  index,
  issues,
  stale,
  all,
  content,
  points: controls,
  edit,
  editMany,
  select,
}: {
  idp: string;
  dataset: string;
  form: ProtocolForm;
  forms: ProtocolForm[];
  index: number;
  issues: Map<string, string>;
  /** The fields whose issue is being checked again: it shows gray, "checking…" (#424 KF21). */
  stale: Set<string>;
  /** Every issue the checks found, at its path. */
  all: Issue[];
  content: DatasetContent | null;
  points: PointControls;
  edit: (key: string, value: string | boolean) => void;
  editMany: (changes: Edits) => void;
  select: (i: number) => void;
}) {
  const preset = f.base;
  const xs = f.measured.map((pt) => pt.x);
  const logx = f.read.made.log_x;
  const added = f.points.length - f.measured.length;
  const held = f.points.filter((pt) => pt.validation).length;
  const range = outOfRangeOf(all, index, f.points);
  const fix = useRangeFix(
    dataset,
    range === null ? null : (content?.protocols[index] ?? null),
    f.read.logOffered,
  );
  const failed = controls.making.failed.get(f.sheet);
  const words = pointWords(
    f.steps.some((s) => s.duration === null),
    f.steps.find((s) => s.measure !== null)?.measure ?? undefined,
    f.normalized,
  );
  const keepOne = keepOneTrain(all);
  const measured = f.steps.find((s) => s.measure !== null)?.measure ?? "peak";
  const steps: Step[] = f.steps.map((s, j) => ({
    voltage_mV: numberOr(s.voltage, preset.steps[j].voltage_mV),
    duration_ms: numberOr(s.duration, preset.steps[j].duration_ms),
    measure: s.measure === null ? null : ({ kind: s.measure } as Step["measure"]),
  }));
  const holding = parsed(f.holding.value) ?? preset.holding_mV;
  // By index, not sheet: a sheet's name can hold a space, which splits an `aria-describedby`.
  const fieldId = (key: string) => `${idp}-${index}-${key}`;
  const issueId = (key: string) => `${fieldId(key)}-issue`;

  /**
   * A number field with its unit and "default" while the template gave it; its issue shows
   * elsewhere. In the step table its tag's room stays once it goes, so no column moves (#469 R04).
   */
  const number = (
    field: Field,
    label: string,
    unit: string | null,
    width = "vin",
    keepRoom = false,
  ) => {
    const issue = issues.get(field.key);
    return (
      <span className="ln">
        <input
          id={fieldId(field.key)}
          className={`input input-sm mono ${width}${issue ? (stale.has(field.key) ? " chk" : " bad") : ""}`}
          value={field.value}
          aria-label={`${label}, ${f.name}`}
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? issueId(field.key) : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => edit(field.key, e.target.value)}
        />
        {unit !== null && <span className="unit">{unit}</span>}
        {field.default ? (
          <span className="def">default</span>
        ) : (
          keepRoom && <span className="def def-room" aria-hidden="true" />
        )}
      </span>
    );
  };

  /** A number field with its issue under it. */
  const input = (field: Field, label: string, unit: string | null, width = "vin") => {
    const issue = issues.get(field.key);
    return (
      <span className="cell">
        {number(field, label, unit, width)}
        {issue && (
          <span id={issueId(field.key)} className={stale.has(field.key) ? "err chk" : "err"}>
            {issue}
            {stale.has(field.key) && <Checking />}
          </span>
        )}
      </span>
    );
  };

  // The step table's issues, a line each under it in its rows' order: a row's fields share its
  // line, so an issue under its field would widen its column (#191).
  const tableIssues = [
    { field: f.holding, row: "Hold" },
    ...f.steps.flatMap((s, j) => [
      ...(s.voltage === null ? [] : [{ field: s.voltage, row: `Step ${j + 1} voltage` }]),
      ...(s.duration === null ? [] : [{ field: s.duration, row: `Step ${j + 1} duration` }]),
    ]),
  ].flatMap(({ field, row }) => {
    const issue = issues.get(field.key);
    return issue === undefined ? [] : [{ key: field.key, row, issue }];
  });

  const swept = (unit: "mV" | "ms") => (
    <span className="ln swept">
      swept · <span className="mono">{span(xs, null, unit === "mV")}</span> {unit}
    </span>
  );

  const others = forms.filter((g, i) => i !== index && errorUnit(g) !== errorUnit(f));
  const otherUnit = errorUnit(f) === "ms" ? "fractions" : "ms";
  const resolution = parsed(f.resolution.value);
  const defaultResolution = measureDefaults(measured).time_resolution_ms;
  // Issues the fields don't show: the points, the steps as a whole, Normalize.
  const shown = new Set([
    "holding",
    "from",
    "to",
    "weight",
    "resolution",
    "interp",
    "perGap",
    "share",
    ...f.steps.flatMap((_, j) => [`v${j}`, `d${j}`]),
    ...f.points.flatMap((pt, k) => (pt.interpolated ? [`point${k}`] : [])),
  ]);
  const rest = [...issues.entries()].filter(([key]) => !shown.has(key));

  return (
    <section aria-labelledby={`${idp}-h`} className="protocol">
      <header className="protocol-head">
        <h2 id={`${idp}-h`} className="pn">
          {f.name}
        </h2>
        <span className="ps">
          {templateLabel(f.template, f.steps.length, formDirection(f))} · from{" "}
          <span className="mono">{f.sheet}</span> ·{" "}
          <span className="mono">{f.measured.length}</span>{" "}
          {f.measured.length === 1 ? "point" : "points"}
          {added > 0 && (
            <>
              {" "}
              · <span className="mono">{added}</span> interpolated
            </>
          )}
        </span>
      </header>
      <div className="charts">
        <figure className="chart-fig">
          <figcaption>
            <span className="label ink">Data</span>
            <span className="hint">{caption(f, logx)}</span>
          </figcaption>
          <DataChart
            points={f.points}
            logx={logx}
            outOfRange={new Set(range?.points.map((pt) => pt.x))}
            onSwitch={(x) => controls.switchAt(f.sheet, x)}
            words={words}
            label={[
              `${f.name}: ${f.measured.length} measured points with SD`,
              added > 0 ? ` and ${added} interpolated` : "",
              range !== null ? `, ${range.points.length} out of range` : "",
              held > 0 ? `, ${held} of them validation points, drawn hollow` : "",
              `, ${caption(f, logx)}. Each point switches between train and validation.`,
            ].join("")}
          />
          <PointsLegend points={f.points} outOfRange={range?.points.length ?? 0} />
        </figure>
        <figure className="chart-fig">
          <figcaption>
            <span className="label ink">Voltage command</span>
            <span className="hint">every sweep, mV</span>
          </figcaption>
          <VoltageCommand
            holding={holding}
            steps={steps}
            sweeps={xs}
            label={`Voltage command of ${f.name}, every sweep, the measured step shaded`}
          />
        </figure>
      </div>
      {failed !== undefined && failed.code !== "invalid" && (
        <div className="note bad" role="alert">
          <p>
            <span className="note-line">
              ICMM couldn’t make {f.name}’s points on this computer.
            </span>
            <span className="note-line hint">{failed.message}</span>
          </p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => controls.making.retry(f.sheet)}
          >
            Try again
          </button>
        </div>
      )}
      {rest.length > 0 && (
        <div className="note bad" role="alert">
          <p>
            {rest.map(([key, message]) => (
              <span key={key} className="note-line">
                {key === "points" || key.startsWith("point")
                  ? "Points: "
                  : key === "normalized"
                    ? "Normalize: "
                    : ""}
                {message}
              </span>
            ))}
          </p>
        </div>
      )}
      <div className="sgrid" role="table" aria-label={`Voltage command, ${f.name}`}>
        <div role="row" className="sg-row">
          <span className="th" role="columnheader">
            Step
          </span>
          <span className="th" role="columnheader">
            Voltage
          </span>
          <span className="th" role="columnheader">
            Duration
          </span>
          <span className="th" role="columnheader" />
        </div>
        <div role="row" className="sg-row">
          <span className="c k" role="cell">
            Hold
          </span>
          <span className="c" role="cell">
            {number(f.holding, "Holding potential", "mV", "vin", true)}
          </span>
          <span className="c k" role="cell">
            between sweeps
          </span>
          <span className="c" role="cell" />
        </div>
        {f.steps.map((s, j) => (
          <div role="row" className="sg-row" key={j}>
            <span className="c mono k" role="cell">
              {j + 1}
            </span>
            <span className="c" role="cell">
              {s.voltage === null
                ? swept("mV")
                : number(s.voltage, `Step ${j + 1} voltage`, "mV", "vin", true)}
            </span>
            <span className="c" role="cell">
              {s.duration === null
                ? swept("ms")
                : number(s.duration, `Step ${j + 1} duration`, "ms", "vin", true)}
            </span>
            <span className="c" role="cell">
              {s.measure !== null && (
                <span className="mtag">
                  {/* One span, so the flex gap never falls between its words. */}
                  <span>measures {measureWord(f, s.measure)}</span>
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      {tableIssues.length > 0 && (
        <div className="serrs" role="alert">
          {tableIssues.map(({ key, row, issue }) => (
            <p key={key} id={issueId(key)} className={stale.has(key) ? "err chk" : "err"}>
              <span className="who">{row}</span> · {issue}
              {stale.has(key) && <Checking />}
            </p>
          ))}
        </div>
      )}
      <div className="kv3">
        {f.window !== null && (
          <DecayWindow
            rise={formDirection(f) === "rise"}
            name={f.name}
            from={f.window.from}
            to={f.window.to}
            issues={issues}
            stale={stale}
            fieldId={fieldId}
            edit={edit}
            editMany={editMany}
          />
        )}
        <span className="k">Normalize</span>
        <span className="v">
          {measured === "time_to_peak" ? (
            <span className="hint">{normalizeHint(measured, false, f.template)}</span>
          ) : (
            <>
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={f.normalized}
                  aria-label={`Normalize ${f.name}`}
                  onChange={(e) => edit("normalized", e.target.checked)}
                />
                <span className="trk" aria-hidden="true" />
              </label>
              <KeptHint
                says={normalizeHint(
                  measured,
                  f.normalized,
                  f.template,
                  formDirection(f) === "rise",
                )}
                may={[true, false].map((on) =>
                  normalizeHint(measured, on, f.template, formDirection(f) === "rise"),
                )}
              />
            </>
          )}
        </span>
        <InterpolateRow
          name={f.name}
          fieldId={fieldId("perGap")}
          interp={f.interp}
          read={f.read}
          points={f.points}
          picked={f.picked}
          issue={issues.get("perGap") ?? issues.get("interp")}
          checking={issues.has("perGap") ? stale.has("perGap") : stale.has("interp")}
          range={
            range !== null && fix !== undefined
              ? outOfRangeWords(
                  range.points.map((pt) => ({ ...pt, unit: words.unit })),
                  range.rule,
                  fix ?? {},
                  f.name,
                )
              : undefined
          }
          onChange={(change) => editMany(interpEdits(change))}
        />
        <ValidationRow
          name={f.name}
          fieldId={fieldId("share")}
          points={f.points}
          share={f.share}
          madeShare={f.shareRead.made}
          picked={f.picked}
          onShare={(share) => edit("share", share)}
          shareIssue={issues.get("share")}
          checking={stale.has("share")}
          redraw={() => controls.redraw(f.sheet)}
          none={() => controls.none(f.sheet)}
          issue={keepOne?.message}
        />
        <span className="k">Weight</span>
        <span className="v">
          {input(f.weight, "Weight", null, "win")}
          <span className="hint">
            0.5 halves this protocol’s part of the cost. Its errors are in {errorUnit(f)}, over{" "}
            <span className="mono">{f.points.length}</span>{" "}
            {f.points.length === 1 ? "point" : "points"}
            {others.length > 0 && (
              <>
                ;{" "}
                {others.map((g, i) => (
                  <span key={g.sheet}>
                    {i === 0 ? "" : i === others.length - 1 ? " and " : ", "}
                    <span className="mono">{g.name}</span>
                  </span>
                ))}{" "}
                {others.length === 1 ? "is" : "are"} in {otherUnit}
              </>
            )}
            .
          </span>
        </span>
        <span className="k">Time resolution</span>
        <span className="v">
          {input(f.resolution, "Time resolution", "ms", "win")}
          <span className="hint">
            Time between readings of the measured step ·{" "}
            {resolution === defaultResolution ? (
              `the default for ${measureWord(f, measured)}`
            ) : (
              <>
                default <span className="mono">{defaultResolution}</span> ms for{" "}
                {measureWord(f, measured)}
              </>
            )}
          </span>
        </span>
      </div>
      <div className="protocol-foot">
        <span className="hint">
          <span className="mono">{index + 1}</span> of <span className="mono">{forms.length}</span>
        </span>
        {forms.length > 1 && (
          <button type="button" className="btn" onClick={() => select((index + 1) % forms.length)}>
            Next protocol: <span className="mono">{forms[(index + 1) % forms.length].name}</span>
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The decay window: the Window menu, its sketch and its sentence (#50),
 * shared with the builder. Running upward, it's the Rise window (#164).
 */
export function DecayWindow({
  rise,
  name,
  from,
  to,
  issues,
  stale,
  fieldId,
  edit,
  editMany,
}: {
  rise: boolean;
  name: string;
  from: Field;
  to: Field;
  issues: Map<string, string>;
  /** The fields whose issue is being checked again. */
  stale: Set<string>;
  fieldId: (key: string) => string;
  edit: (key: string, value: string) => void;
  editMany: (changes: Edits) => void;
}) {
  // A window refused as typed says its own rule, which isn't the last answer's: it stays red.
  const typedValid = windowValid(parsed(from.value) ?? Number.NaN, parsed(to.value) ?? Number.NaN);
  const percent = (field: Field, label: string) => (
    <input
      id={fieldId(field.key)}
      className={`input input-sm mono win${issues.has(field.key) ? (stale.has(field.key) && typedValid ? " chk" : " bad") : ""}`}
      value={field.value}
      aria-label={`${label}, ${name}`}
      aria-invalid={issues.has(field.key) || undefined}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => edit(field.key, e.target.value)}
    />
  );
  const label = rise ? "Rise window" : "Decay window";
  return (
    <>
      <span className="k top">{label}</span>
      <span className="v col">
        <WindowControl
          from={from.value}
          to={to.value}
          menuLabel={`${label}, ${name}`}
          onPreset={(w) => editMany(w)}
          issue={issues.get("from") ?? issues.get("to")}
          checking={issues.has("from") ? stale.has("from") : stale.has("to")}
        >
          <span className="ln window-other">
            {percent(from, `${label} from`)}
            <span className="unit">% →</span>
            {percent(to, `${label} to`)}
            <span className="unit">%</span>
          </span>
        </WindowControl>
      </span>
    </>
  );
}
