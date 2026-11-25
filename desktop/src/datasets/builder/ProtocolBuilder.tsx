/**
 * The Protocol builder (#144; LaptopProtocolBuilder): a protocol's steps,
 * each voltage and duration fixed or swept and one step measured, started
 * from a template or Blank; its name, hold, weight and time resolution; the
 * data it expects, mapped from its sheet; every sweep's voltage command; and
 * `validate_dataset`'s checks, live (ADR-0003).
 *
 * The wizard opens it for a Custom sheet, and Save protocol hands the
 * protocol back to the wizard unsaved (#143). On a saved dataset (#146),
 * New protocol… and Edit protocol… open it with `saved`: its breadcrumb
 * links the dataset, its revision line and note sit under the facts, Change…
 * reads any workbook, and Save protocol saves a new revision. The engine
 * names its template as its steps change: a card stays pressed while the
 * steps have that template's structure, and none is when they're Custom.
 *
 * Its Interpolate and Validation rows are the wizard's (#145): this
 * computer's engine makes its points as its data or interpolation change,
 * and the as-read chart draws them, each a button that switches it.
 *
 * A template's values read "default" until typed, counted under Save (#164).
 * The Decay time template reads Decay time or Rise time by its window, and
 * Decay or rise time on a card not pressed and a step not timed.
 */
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Chevron } from "../../settings/SshFormCard";
import { useBlocker } from "../../ui/blocker";
import { PAGE_HEADING_ATTR } from "../../ui/pageChangeFocus";
import type { FieldMark } from "../../setup/form";
import type { Working } from "../../ui/working";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import type {
  DatasetContent,
  Issue,
  Measure,
  Point,
  Protocol,
  Template,
} from "../../wire/types.gen";
import { parsed } from "../draft";
import { count, sweepLabels } from "../format";
import { redrawn, useMaking } from "../making";
import { InterpolateRow, ValidationRow } from "../PointRows";
import {
  keepOneTrain,
  pickedOf,
  pointWords,
  switchedAt,
  unmarked,
  type InterpolationForm,
  type Made,
} from "../points";
import { outOfRangeOf, useRangeFix } from "../rangeFix";
import { useDatasetIssues } from "../queries";
import { pointsOf, TEMPLATE_LABELS, type SheetRead } from "../sheets";
import {
  DECAY_OR_RISE,
  defaultsTally,
  measureFact,
  measureWords,
  outOfRangeWords,
  templateLabel,
} from "../words";
import { SweepsChart, TemplateGlyph, type DrawnStep, type Swept } from "./charts";
import { Checks } from "./Checks";
import { DataCard } from "./DataCard";
import { FieldIssue, MarkWords, TextField } from "./Field";
import { keyOf, sweptOf } from "./fields";
import {
  addStep,
  defaultsOf,
  measureDefaults,
  moveStep,
  PRESETS,
  protocolOf,
  removeStep,
  setMeasure,
  typed,
  typedStep,
  withPreset,
  type BuilderDraft,
  type BuilderStep,
  type PresetName,
} from "./model";
import { StepRow } from "./StepRow";
import { ReportFromHere } from "../../report/ReportFromHere";

/** The builder on a saved dataset (#146): what the wizard's builder doesn't have. */
export interface SavedContext {
  datasetId: string;
  /** Edit protocol…: the protocol's name as saved; `null` for New protocol…. */
  editing: string | null;
  /** Its place among the dataset's protocols. */
  index: number;
  /** Its points as saved, which settings back at theirs bring back, marks and all. */
  kept?: Made;
  /** Under the facts: "1 change. Saving makes a new revision of herg-wt." */
  line: React.ReactNode;
  /** Another computer's save or delete, with what to do. */
  note: React.ReactNode;
  /** Each field you or another computer changed, by key (`fieldMarks`, #164). */
  marks: Record<string, FieldMark>;
  /** Why Save protocol waits, beyond its checks. */
  saveBlocked: string | undefined;
  saving: Working;
  /** What the last save said, if it failed. */
  message: string | undefined;
  /** The draft, held by the page so Reload can change it. */
  onDraft: React.Dispatch<React.SetStateAction<BuilderDraft>>;
  /** Change…: another workbook's sheet, opened on the one for the steps' template (#168). */
  change: { gray: boolean; press: (template: Template | undefined) => void };
  sheets: SheetRead[];
  /** Another sheet of the workbook, its V0 and V1 read for the steps' template. */
  onSheet: (sheet: string, template: Template | undefined) => void;
  failure?: { what: string; next: string; raw: string };
}

export interface ProtocolBuilderProps {
  platform: string;
  /** Whether the platform can be asked for checks now. */
  connected: boolean;
  /** The dataset it goes in, by name. */
  dataset: string;
  /** Its sheet's workbook; `null` for saved points that came from none. */
  workbook: string | null;
  /** The sheet its data comes from; `null` until a new protocol on a saved dataset has one. */
  read: SheetRead | null;
  /** The selected unit of the sheet's duration column, before conversion to ms. */
  seconds: boolean;
  draft: BuilderDraft;
  /** The dataset's other protocols, so a name they have is caught. */
  others: Protocol[];
  onCancel: () => void;
  /** The protocol as built, and the template the engine found its steps to have. */
  onSave: (draft: BuilderDraft, template: Template, protocol: Protocol) => void;
  saved?: SavedContext;
}

/** Each card's words under its name (LaptopProtocolBuilder). */
const CARD_WORDS: Record<PresetName, { name: string; sub: string }> = {
  gv_activation: { name: TEMPLATE_LABELS.gv_activation, sub: "1 step · swept voltage · peak" },
  steady_state_inactivation: {
    name: TEMPLATE_LABELS.steady_state_inactivation,
    sub: "2 steps · swept conditioning · peak",
  },
  recovery: { name: TEMPLATE_LABELS.recovery, sub: "3 steps · swept gap · peak" },
  // Where no window is known yet, the shared type reads as both (#164).
  decay_time: { name: DECAY_OR_RISE, sub: "1 step · swept voltage · decay or rise time" },
  time_to_peak: {
    name: TEMPLATE_LABELS.time_to_peak,
    sub: "1 step · swept voltage · time to peak",
  },
  blank: { name: "Blank", sub: "one fixed step · nothing measured" },
};

/** A card's line, which breaks only after a dot (#50): "1 step ·" / "swept voltage". */
function breakAfterDots(text: string): string {
  return text
    .split(" · ")
    .map((part) => part.replace(/ /g, "\u00a0"))
    .join("\u00a0· ");
}

/** The sweeps a card's glyph draws, by what its template sweeps. */
const GLYPH_VOLTAGES = [-80, -60, -40, -20, 0, 20, 40];
const GLYPH_DURATIONS = [5, 50, 150, 300, 600];

export function ProtocolBuilder(p: ProtocolBuilderProps) {
  const id = useId();
  const [own, setOwn] = useState(p.draft);
  const sv = p.saved;
  // On a saved dataset the page holds the draft, so Reload can change it.
  const draft = sv === undefined ? own : p.draft;
  const setDraft = sv === undefined ? setOwn : sv.onDraft;
  const [hi, setHi] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const fid = (key: string) => `${id}-${key}`;

  useEffect(() => {
    // The page changed: its heading takes focus (old ADR-0028).
    document.getElementById(fid("h"))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const swept = sweptOf(draft.steps);
  const seconds = p.seconds && swept.one?.kind === "duration";
  const index = sv?.index ?? p.others.length;
  const read = p.read;
  const measuredPoints = useMemo(
    () => (read === null ? [] : pointsOf(read, draft.roles, seconds)),
    [read, draft.roles, seconds],
  );
  const at = ["protocols", String(index)];
  const source =
    read === null || p.workbook === null ? null : { workbook: p.workbook, sheet: read.name };
  const made = useMemo(
    () => protocolOf(draft, measuredPoints, source, at),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, measuredPoints, p.workbook, read?.name, index],
  );
  const points = made.points;
  // Its points are made on this computer's engine as its data or interpolation change.
  const toMake = useMemo(
    () =>
      measuredPoints.length === 0
        ? []
        : [
            {
              id: "draft",
              key: made.key,
              protocol: {
                ...(made.protocol ?? builderProtocol(draft)),
                interpolation: made.read.made,
                validation_share: made.shareRead.made,
                points: measuredPoints,
              },
            },
          ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [made, measuredPoints],
  );
  const onMade = useCallback(
    (_: string, m: Made) => setDraft((d) => ({ ...d, made: m })),
    [setDraft],
  );
  const making = useMaking(p.dataset, toMake, { draft: draft.made }, onMade, {
    draft: sv?.kept,
  });
  const current = draft.made !== undefined && draft.made.key === made.key;
  /** A change by hand to its marks, while its points are current. */
  const remark = (change: (pts: Point[]) => Point[]) => {
    if (current) {
      setDraft({ ...draft, made: { ...draft.made!, points: change(points), picked: true } });
    }
  };
  const picked = current ? pickedOf(draft.made, points) : 0;
  const content: DatasetContent | null = useMemo(
    () =>
      made.protocol === null
        ? null
        : {
            name: p.dataset,
            protocols: [...p.others.slice(0, index), made.protocol, ...p.others.slice(index)],
          },
    [made.protocol, p.dataset, p.others, index],
  );
  const checked = useDatasetIssues(content, sv?.datasetId ?? null);
  const range = outOfRangeOf(checked.issues ?? [], index, points);
  const fix = useRangeFix(p.dataset, range === null ? null : made.protocol, made.read.logOffered);
  const failed = making.failed.get("draft");
  const template: Template | undefined = checked.templates?.[index];
  // Its own issues, and the dataset's one that every point is held out.
  const mine = (issues: Issue[]) =>
    issues.filter(
      (i) =>
        (i.path[0] === "protocols" && i.path[1] === String(index)) || i === keepOneTrain(issues),
    );
  const engineIssues = checked.current ? mine(checked.issues ?? []) : [];
  const shownIssues = [...made.issues, ...(content === null ? [] : mine(checked.issues ?? []))];
  const byKey = new Map<string, string>();
  for (const issue of shownIssues) {
    const key = keyOf(issue.path.slice(2));
    if (!byKey.has(key)) byKey.set(key, issue.message);
  }

  // A time resolution to fix keeps Advanced open.
  const advancedOpen = advanced || byKey.has("resolution");
  const measured = draft.steps.flatMap((s, j) => (s.measure === "none" ? [] : [j]));
  const mStep = measured.length === 1 ? draft.steps[measured[0]] : null;
  const measure: Measure | null =
    mStep === null || mStep.measure === "none"
      ? null
      : mStep.measure === "decay_time"
        ? {
            kind: "decay_time",
            from: (parsed(mStep.from) ?? Number.NaN) / 100,
            to: (parsed(mStep.to) ?? Number.NaN) / 100,
          }
        : { kind: mStep.measure };
  const rise = measure?.kind === "decay_time" && measure.from < measure.to;
  const words = pointWords(swept.one?.kind === "duration", measure?.kind, draft.normalized);
  const xs = [...new Set(points.map((pt) => pt.x))].sort((a, b) => a - b);
  const sweeps = swept.one === null ? [] : xs;
  const hiAt = Math.max(0, Math.min(hi ?? Math.floor((sweeps.length - 1) / 2), sweeps.length - 1));

  const edit = (change: Partial<BuilderDraft>) => setDraft(typed(draft, change));
  const editStep = (j: number, change: Partial<BuilderStep>) =>
    setDraft(typedStep(draft, j, change));
  const defaults = defaultsOf(draft);
  const marks = sv?.marks ?? {};
  /** A card's words: the pressed Decay time card is named by its window. */
  const cardWords = (name: PresetName) =>
    name === "decay_time" && template === "decay_time"
      ? rise
        ? { name: "Rise time", sub: "1 step · swept voltage · rise time" }
        : { name: TEMPLATE_LABELS.decay_time, sub: "1 step · swept voltage · decay time" }
      : CARD_WORDS[name];
  // Its errors' unit, as the Weight hint says it (#164).
  const errorUnit =
    measure === null
      ? null
      : measure.kind === "peak" || (measure.kind === "decay_time" && draft.normalized)
        ? "fractions"
        : "ms";

  // Save waits for the checks: a value to fix, or the platform's answer.
  const failing = made.issues.length + engineIssues.length;
  const blocked =
    sv?.saveBlocked ??
    (failing > 0
      ? `${count(failing, "check")} to fix`
      : !checked.current
        ? p.connected
          ? `Checking with ${p.platform}…`
          : `Checks run once ${p.platform} is connected`
        : making.pending.has("draft")
          ? "Making its points on this computer…"
          : failed !== undefined
            ? "Its points weren’t made"
            : undefined);
  const save = useBlocker(blocked);
  const change = useBlocker(
    sv === undefined ? "In the wizard, a protocol reads only its own sheet." : undefined,
  );

  const nSweeps = swept.one !== null && sweeps.length > 0 ? sweeps.length : 1;
  const facts = measureFact(draft.steps);

  const drawn: DrawnStep[] = draft.steps.map((s) => ({
    voltage: parsed(s.voltage) ?? parsed(draft.holding) ?? -80,
    duration: Math.max(0, parsed(s.duration) ?? 0),
    measured: s.measure !== "none",
  }));

  return (
    <div className="builder">
      <section className="b-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/datasets" className="link">
            Datasets
          </Link>
          <span aria-hidden="true">/</span>
          {sv === undefined ? (
            <span className="mono">{p.dataset}</span>
          ) : (
            <Link to="/datasets/$id" params={{ id: sv.datasetId }} className="link mono">
              {p.dataset}
            </Link>
          )}
          <span aria-hidden="true">/</span>
          {sv?.editing != null ? (
            <span className="mono" aria-current="page">
              {sv.editing}
            </span>
          ) : (
            <span aria-current="page">New protocol</span>
          )}
        </nav>
        <div className="hdr">
          <div className="hdr-text">
            <h1 id={fid("h")} className="title" tabIndex={-1} {...{ [PAGE_HEADING_ATTR]: "" }}>
              {sv?.editing != null ? "Edit protocol" : "New protocol"}
            </h1>
            <p className="facts">
              <span className="mono">{draft.name}</span>
              {template !== undefined && (
                <> · {templateLabel(template, draft.steps.length, rise ? "rise" : "decay")}</>
              )}{" "}
              · <span className="n">{nSweeps}</span> {nSweeps === 1 ? "sweep" : "sweeps"} · {facts}
            </p>
            {sv?.line != null && <p className="hint b-revision">{sv.line}</p>}
            {sv?.message !== undefined && (
              <p className="err" role="alert">
                {sv.message}
              </p>
            )}
          </div>
          <div className="hacts">
            <div className="acts">
              {sv === undefined ? (
                <button type="button" className="btn" onClick={p.onCancel}>
                  Cancel
                </button>
              ) : (
                <BesideButton
                  type="button"
                  className="btn"
                  working={sv.saving}
                  onClick={p.onCancel}
                >
                  Cancel
                </BesideButton>
              )}
              {sv === undefined ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  {...save.props}
                  onClick={(e) => {
                    save.props.onClick(e);
                    if (blocked === undefined && template !== undefined && made.protocol !== null) {
                      p.onSave(draft, template, made.protocol);
                    }
                  }}
                >
                  Save protocol
                </button>
              ) : (
                <WorkingButton
                  type="button"
                  className="btn btn-primary"
                  working={sv.saving}
                  words="Saving…"
                  {...save.props}
                  onClick={(e) => {
                    save.props.onClick(e);
                    if (blocked === undefined && template !== undefined && made.protocol !== null) {
                      p.onSave(draft, template, made.protocol);
                    }
                  }}
                >
                  Save protocol
                </WorkingButton>
              )}
              {save.bubble}
            </div>
            {defaults.length > 0 && (
              <span className="astat">{defaultsTally(defaults.length)}</span>
            )}
          </div>
        </div>
      </section>
      <ReportFromHere
        name={`${sv?.editing != null ? "Edit protocol" : "New protocol"} in ${p.dataset}`}
      />
      {sv?.note}

      <section aria-labelledby={fid("tpl")} className="b-start">
        <div className="b-sechead">
          <h2 id={fid("tpl")} className="label">
            Start from
          </h2>
          <span className="hint">
            Presets of the steps below. A protocol keeps its template while only voltages and
            durations change, and is Custom when its steps match none.
          </span>
        </div>
        <div className="tpls">
          {PRESETS.map(({ name, preset }) => {
            const glyphSwept = sweptOf(
              preset.steps.map((s) => ({
                voltage: "",
                voltageSwept: s.voltage_mV === "swept",
                duration: "",
                durationSwept: s.duration_ms === "swept",
                measure: "none",
                from: "",
                to: "",
              })),
            ).one;
            return (
              <button
                key={name}
                type="button"
                className="tpl"
                aria-pressed={template !== undefined && template === name}
                onClick={() => {
                  setDraft(withPreset(draft, name));
                  setHi(null);
                }}
              >
                <TemplateGlyph
                  holding={preset.holding_mV}
                  steps={preset.steps.map((s) => ({
                    voltage: s.voltage_mV === "swept" ? 0 : s.voltage_mV,
                    duration: s.duration_ms === "swept" ? 0 : s.duration_ms,
                    measured: s.measure !== null,
                  }))}
                  swept={glyphSwept}
                  sweeps={glyphSwept?.kind === "duration" ? GLYPH_DURATIONS : GLYPH_VOLTAGES}
                />
                <span className="tpl-text">
                  <span className="tpl-name">{cardWords(name).name}</span>
                  <span className="tpl-sub">{breakAfterDots(cardWords(name).sub)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="b-grid">
        <div className="b-left">
          <section aria-labelledby={fid("steps")} className="b-steps">
            <div className="b-sechead">
              <h2 id={fid("steps")} className="label">
                Steps
              </h2>
              <span className="hint">
                Run in order after the hold. Sweep exactly one voltage or duration; measure exactly
                one step.
              </span>
            </div>
            {draft.steps.map((s, j) => (
              <StepRow
                key={j}
                j={j}
                step={s}
                steps={draft.steps.length}
                fid={fid}
                issues={byKey}
                sweptRange={
                  points.length === 0
                    ? null
                    : {
                        xs,
                        column: read?.columns[draft.roles.x!]?.name ?? "",
                      }
                }
                normalized={draft.normalized}
                template={template ?? "custom"}
                defaults={{
                  voltage: defaults.includes(`v${j}`),
                  duration: defaults.includes(`d${j}`),
                }}
                marks={{ voltage: marks[`v${j}`], duration: marks[`d${j}`] }}
                onStep={(change) => editStep(j, change)}
                onMeasure={(kind) => setDraft(setMeasure(draft, j, kind))}
                onNormalize={(on) => edit({ normalized: on })}
                onMove={(by) => setDraft(moveStep(draft, j, by))}
                onRemove={() => setDraft(removeStep(draft, j))}
              />
            ))}
            <div className="b-add">
              <button type="button" className="btn btn-sm" onClick={() => setDraft(addStep(draft))}>
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                Add step
              </button>
            </div>
          </section>

          <section aria-labelledby={fid("proto")} className="b-proto">
            <h2 id={fid("proto")} className="label">
              Protocol
            </h2>
            <div className="kv3 bkv">
              <label htmlFor={fid("name")} className="k top">
                Protocol name
              </label>
              <span className="v col">
                <TextField
                  id={fid("name")}
                  value={draft.name}
                  issue={byKey.get("name")}
                  mark={marks.name}
                  hint
                  width="b-pname"
                  onChange={(name) => edit({ name })}
                />
                {/* A renamed protocol's mark is the first line under the field: beside it, a
                    32-character name has no room at 1200 (#572 D10). */}
                <MarkWords id={fid("name")} mark={marks.name} under />
                {/* Any name error takes the hint's place (#561 D9). */}
                {byKey.has("name") ? (
                  <span id={`${fid("name")}-issue`} className="err">
                    {byKey.get("name")}
                  </span>
                ) : (
                  <span id={`${fid("name")}-h`} className="hint">
                    Letters, digits, - and _, up to 32.
                  </span>
                )}
              </span>
              <label htmlFor={fid("holding")} className="k top">
                Holding potential
              </label>
              <span className="v col">
                <span className="ln">
                  <TextField
                    id={fid("holding")}
                    value={draft.holding}
                    issue={byKey.get("holding")}
                    mark={marks.holding}
                    onChange={(holding) => edit({ holding })}
                  />
                  <span className="unit">mV</span>
                  {defaults.includes("holding") ? (
                    <span className="def">default</span>
                  ) : (
                    // Its room stays once it goes, so the hint beside it keeps its lines (#469 R04).
                    marks.holding === undefined && (
                      <span className="def def-room" aria-hidden="true" />
                    )
                  )}
                  <MarkWords id={fid("holding")} mark={marks.holding} />
                  <span className="hint">
                    v0 · the cell rests here before step 1 and between sweeps
                  </span>
                </span>
                <FieldIssue id={fid("holding")} issue={byKey.get("holding")} />
              </span>
              <label htmlFor={fid("weight")} className="k top">
                Weight
              </label>
              <span className="v col">
                <span className="ln">
                  <TextField
                    id={fid("weight")}
                    value={draft.weight}
                    issue={byKey.get("weight")}
                    mark={marks.weight}
                    onChange={(weight) => edit({ weight })}
                  />
                  {marks.weight !== undefined ? (
                    <MarkWords id={fid("weight")} mark={marks.weight} />
                  ) : (
                    <span className="hint">
                      0.5 halves this protocol’s part of the cost.
                      {errorUnit !== null && (
                        <>
                          {" "}
                          Its errors are in {errorUnit}
                          {points.length > 0 && (
                            <>
                              , over <span className="mono">{points.length}</span>{" "}
                              {points.length === 1 ? "point" : "points"}
                            </>
                          )}
                          .
                        </>
                      )}
                    </span>
                  )}
                </span>
                <FieldIssue id={fid("weight")} issue={byKey.get("weight")} />
              </span>
              <InterpolateRow
                name={draft.name}
                fieldId={fid("perGap")}
                interp={draft.interp}
                read={made.read}
                points={points}
                picked={picked}
                issue={byKey.get("interpolation")}
                range={
                  range !== null && fix !== undefined
                    ? outOfRangeWords(
                        range.points.map((pt) => ({ ...pt, unit: words.unit })),
                        range.rule,
                        fix ?? {},
                        draft.name,
                      )
                    : undefined
                }
                onChange={(change: Partial<InterpolationForm>) =>
                  edit({ interp: { ...draft.interp, ...change } })
                }
              />
              <ValidationRow
                name={draft.name}
                fieldId={fid("share")}
                points={points}
                share={draft.share}
                madeShare={made.shareRead.made}
                picked={picked}
                onShare={(share) => edit({ share })}
                shareIssue={byKey.get("validation_share")}
                redraw={async () => {
                  if (!current || toMake.length === 0) return;
                  const next = await redrawn(toMake[0].protocol, { ...draft.made!, points });
                  // Any edit since the press takes precedence over its proposal.
                  setDraft((d) => (d === draft ? { ...d, made: next } : d));
                }}
                none={() => remark(unmarked)}
                issue={
                  failed !== undefined && failed.code !== "invalid"
                    ? `ICMM couldn’t make ${draft.name}’s points on this computer. ${failed.message ?? ""}`
                    : keepOneTrain(engineIssues)?.message
                }
              />
            </div>
            <div className="b-advanced">
              <button
                type="button"
                className="disc"
                aria-expanded={advancedOpen}
                aria-controls={fid("adv")}
                onClick={() => setAdvanced(!advancedOpen)}
              >
                <Chevron open={advancedOpen} />
                Advanced
              </button>
              {advancedOpen && (
                <div id={fid("adv")} className="kv3 bkv">
                  <label htmlFor={fid("resolution")} className="k top">
                    Time resolution
                  </label>
                  <span className="v col">
                    <span className="ln">
                      <TextField
                        id={fid("resolution")}
                        value={draft.resolution}
                        issue={byKey.get("resolution")}
                        mark={marks.resolution}
                        onChange={(resolution) => edit({ resolution })}
                      />
                      <span className="unit">ms</span>
                      <MarkWords id={fid("resolution")} mark={marks.resolution} />
                      <span className="hint">
                        Time between readings of the measured step
                        {measure !== null && (
                          <>
                            {" "}
                            · default{" "}
                            <span className="mono">
                              {measureDefaults(measure.kind).time_resolution_ms}
                            </span>{" "}
                            ms for {measureWords(measure)}
                          </>
                        )}
                      </span>
                    </span>
                    <FieldIssue id={fid("resolution")} issue={byKey.get("resolution")} />
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="b-aside">
          <section aria-labelledby={fid("wave")} className="b-wave">
            <div className="b-wave-head">
              <h2 id={fid("wave")} className="label">
                Voltage command · every sweep, true time axis
              </h2>
              <div className="lgs" aria-hidden="true">
                <span className="lg">
                  <svg width="18" height="8">
                    <path d="M0 4h18" className="lg-hi" />
                  </svg>
                  highlighted sweep
                </span>
                <span className="lg">
                  <svg width="18" height="8">
                    <path d="M0 4h18" className="lg-fam" />
                  </svg>
                  other sweeps
                </span>
                <span className="lg">
                  <svg width="14" height="12">
                    <rect x="0.5" y="0.5" width="13" height="11" className="lg-band" />
                  </svg>
                  measured step
                </span>
              </div>
            </div>
            <div className="b-wave-plot">
              <SweepsChart
                holding={parsed(draft.holding) ?? -80}
                steps={drawn}
                swept={swept.one}
                sweeps={sweeps}
                hi={hiAt}
                label={`Voltage command, ${count(nSweeps, "sweep")}, the measured step shaded`}
              />
              <div className="b-time">Time (ms)</div>
            </div>
            <Sweeps
              sweeps={sweeps}
              data={measuredPoints.map((pt) => pt.x)}
              swept={swept.one}
              hi={hiAt}
              pick={setHi}
              mapped={points.length > 0}
            />
          </section>

          <DataCard
            fid={fid}
            draft={draft}
            read={read}
            workbook={p.workbook}
            points={points}
            seconds={seconds}
            swept={swept.one}
            measure={measure}
            rise={rise}
            mStep={mStep}
            template={template ?? "custom"}
            ring={swept.one !== null ? sweeps[hiAt] : undefined}
            outOfRange={new Set(range?.points.map((pt) => pt.x))}
            onSwitch={(x) => remark((pts) => switchedAt(pts, x))}
            words={words}
            change={{ ...change, onPress: sv && (() => sv.change.press(template)) }}
            changeGray={sv?.change.gray}
            sheets={sv?.sheets}
            onSheet={sv && ((sheet) => sv.onSheet(sheet, template))}
            failure={sv?.failure}
            onRoles={(roles) => edit({ roles })}
          />

          <Checks
            fid={fid}
            platform={p.platform}
            connected={p.connected}
            current={checked.current}
            dataset={p.dataset}
            saved={sv?.editing ?? null}
            draft={draft}
            read={read}
            points={points}
            swept={swept}
            measured={measured}
            measure={measure}
            local={made.issues}
            engine={engineIssues}
          />
        </aside>
      </div>
    </div>
  );
}

/** The highlighted sweep's chips, one per sweep; a long list is a menu. */
function Sweeps({
  sweeps,
  data,
  swept,
  hi,
  pick,
  mapped,
}: {
  sweeps: number[];
  /** The x the sheet's rows hold, whose precision the labels take. */
  data: number[];
  swept: Swept | null;
  hi: number;
  pick: (k: number) => void;
  mapped: boolean;
}) {
  if (swept === null || sweeps.length === 0) {
    return (
      <span className="hint">
        {swept === null || !mapped
          ? "One sweep — nothing is swept"
          : "One sweep until a column is mapped to x"}
      </span>
    );
  }
  const unit = swept.kind === "voltage" ? "mV" : "ms";
  const labels = sweepLabels(sweeps, data);
  return (
    <div className="b-chips">
      <span className="hint">Highlighted sweep ({unit})</span>
      {sweeps.length > 40 ? (
        <select
          className="input input-sm mono b-sweep-menu"
          aria-label="Highlighted sweep"
          value={String(hi)}
          onChange={(e) => pick(Number(e.target.value))}
        >
          {sweeps.map((v, k) => (
            <option key={v} value={String(k)}>
              {labels[k]}
            </option>
          ))}
        </select>
      ) : (
        <div role="group" aria-label="Highlighted sweep" className="chips">
          {sweeps.map((v, k) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={k === hi}
              onClick={() => pick(k)}
            >
              {labels[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The draft as a protocol the engine can read while a value isn't a number: its points are what it makes. */
function builderProtocol(draft: BuilderDraft): Protocol {
  return {
    name: draft.name,
    source: null,
    holding_mV: -80,
    steps: [],
    normalized: draft.normalized,
    weight: 1,
    time_resolution_ms: 0.1,
    interpolation: { enabled: false, points_per_gap: 1, log_x: false },
    validation_share: 0.2,
    points: [],
  };
}
