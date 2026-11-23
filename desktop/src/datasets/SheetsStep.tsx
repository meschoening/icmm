/**
 * Sheets (LaptopWizSheets): each sheet's template, with a line on what it
 * measures (#164), the ranges its columns give, units included, and its
 * protocol name. A sheet no template matches offers its closest, its columns
 * suggested by name; one with no numbers is skipped. The Decay time
 * template reads Decay time or Rise time by its window, and Decay or rise
 * time where none is known: another sheet's menu and the closest template.
 */
import { useId, useState } from "react";
import type { TemplateName } from "../wire/templates.gen";
import type { Issue } from "../wire/types.gen";
import { SheetPreview } from "./charts";
import { sweptOf } from "./builder/fields";
import { fieldAt, parsed, type Choice, type ProtocolForm, type SheetsStatus } from "./draft";
import { count, decimalsFor, fixed, joinAnd, span } from "./format";
import type { Book } from "./NewDataset";
import {
  pointsOf,
  ROLES,
  rolesByName,
  TEMPLATE_LABELS,
  type Role,
  type RoleSpec,
  type SheetRead,
} from "./sheets";
import { StepHeader } from "./StepHeader";
import {
  DECAY_OR_RISE,
  directionOf,
  measureFact,
  templateLabel,
  templateLine,
  templateName,
} from "./words";
import type { Working } from "../ui/working";

const TEMPLATE_OPTIONS = Object.entries(TEMPLATE_LABELS) as [TemplateName, string][];

export interface SheetsStepProps {
  platform: string;
  step: number;
  discard: () => void;
  saving: Working;
  book: Book;
  choices: Choice[];
  setChoices: (choices: Choice[]) => void;
  status: SheetsStatus;
  forms: ProtocolForm[];
  issues: Issue[];
  back: () => void;
  next: () => void;
  /** Opens the Protocol builder for a Custom sheet. */
  openBuilder: (sheet: string) => void;
}

export function SheetsStep(p: SheetsStepProps) {
  const { reads } = p.book;
  const set = (i: number, change: Partial<Choice>) =>
    p.setChoices(p.choices.map((c, j) => (j === i ? { ...c, ...change } : c)));

  // A protocol's name issue, by its sheet.
  const nameIssues = new Map<string, string>();
  for (const issue of p.issues) {
    const at = fieldAt(issue.path);
    if (at.protocol !== null && at.key === "name") {
      const sheet = p.forms[at.protocol]?.sheet;
      if (sheet !== undefined && !nameIssues.has(sheet)) nameIssues.set(sheet, issue.message);
    }
  }

  const needs = p.status.needs;
  const nNone = needs.filter((n) => n.needs === "template").length;
  const what = nNone === needs.length ? "a template" : nNone === 0 ? "its steps" : "attention";
  let blocked: string | undefined;
  let status: React.ReactNode;
  if (needs.length > 0) {
    blocked = `${needs.length} ${needs.length === 1 ? "sheet needs" : "sheets need"} ${what} — ${needs[0].sheet}`;
    status = (
      <a
        href={`#sheet-${needs[0].sheet}`}
        className="link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(`template-${needs[0].sheet}`)?.focus();
        }}
      >
        {blocked}
      </a>
    );
  } else if (nameIssues.size > 0) {
    // A sheet's bad or empty name holds Next, as a missing template does (#561 D4).
    const [sheet] = nameIssues.keys();
    const n = nameIssues.size;
    blocked = `${n} ${n === 1 ? "sheet needs" : "sheets need"} a valid name — ${sheet}`;
    status = (
      <a
        href={`#sheet-${sheet}`}
        className="link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(`name-${sheet}`)?.focus();
        }}
      >
        {blocked}
      </a>
    );
  } else if (p.forms.length === 0) {
    blocked = "Use at least one sheet";
    status = blocked;
  } else {
    status = `${count(p.status.matched, "sheet")} ready · ${p.status.leftOut} left out`;
  }

  const needWord = nNone === needs.length ? "a template" : nNone === 0 ? "steps" : "attention";
  return (
    <>
      <StepHeader
        step={p.step}
        title="Sheets"
        facts={
          <>
            <span className="mono">{p.book.workbook.name}</span> ·{" "}
            <span className="n">{reads.length}</span> sheets ·{" "}
            <span className="n">{p.status.matched}</span> matched
            {needs.length > 0 && (
              <>
                {" "}
                · <span className="n">{needs.length}</span> {needs.length === 1 ? "needs" : "need"}{" "}
                {needWord}
              </>
            )}
            {needs.length === 0 && nameIssues.size > 0 && (
              <>
                {" "}
                · <span className="n">{nameIssues.size}</span>{" "}
                {nameIssues.size === 1 ? "needs" : "need"} a valid name
              </>
            )}
            {p.status.leftOut > 0 && (
              <>
                {" "}
                · <span className="n">{p.status.leftOut}</span> skipped
              </>
            )}
          </>
        }
        lede="Each sheet you use becomes a protocol. Check its template and the ranges we read, units included. A protocol's name labels it on charts and in results: up to 32 letters, digits, - and _."
        status={status}
        tone={needs.length > 0 || nameIssues.size > 0 ? "ink" : "plain"}
        discard={p.discard}
        back={p.back}
        primary="Next: Protocols"
        blocked={blocked}
        onPrimary={p.next}
      />
      <section aria-label="Sheets" className="sheets">
        <div className="sheets-head" aria-hidden="true">
          <span className="th">Use</span>
          <span className="th">Preview</span>
          <span className="th">Sheet · what we read</span>
          <span className="th">Template · protocol name</span>
        </div>
        {reads.map((read, i) => (
          <SheetRow
            key={read.name}
            read={read}
            choice={p.choices[i]}
            set={(change) => set(i, change)}
            nameIssue={nameIssues.get(read.name)}
            form={p.forms.find((f) => f.sheet === read.name)}
            openBuilder={() => p.openBuilder(read.name)}
          />
        ))}
      </section>
    </>
  );
}

/** A role's words: a decay time's y column is named for its window, as its template is. */
function labeled(spec: RoleSpec, template: TemplateName, name: string): RoleSpec {
  return template === "decay_time" && spec.role === "y" ? { ...spec, label: name } : spec;
}

/** Each column the sheet's template takes, in its order, or every column unmatched. */
function shownColumns(
  read: SheetRead,
  choice: Choice,
  name: string,
): { spec: RoleSpec | null; column: number }[] {
  const template =
    choice.template === "none" || choice.template === "custom" ? null : choice.template;
  const built = choice.template === "custom" ? choice.built : undefined;
  if (built !== undefined) {
    // The columns the Protocol builder mapped, as its Data card names them.
    const { roles } = built.draft;
    return (["x", "y", "sd"] as const).flatMap((role) => {
      const column = roles[role];
      if (column === undefined) return [];
      const label = role === "sd" ? "SD" : role;
      return [{ spec: { role, label, token: read.columns[column].name, unit: null }, column }];
    });
  }
  if (template === null) return read.columns.map((_, column) => ({ spec: null, column }));
  return ROLES[template].flatMap((spec) => {
    const column = choice.roles[spec.role];
    return column === undefined ? [] : [{ spec: labeled(spec, template, name), column }];
  });
}

function SheetRow({
  read,
  choice,
  set,
  nameIssue,
  form,
  openBuilder,
}: {
  read: SheetRead;
  choice: Choice;
  set: (change: Partial<Choice>) => void;
  nameIssue: string | undefined;
  /** Its protocol, once it is one: a decay time's window, as the Protocols step has it. */
  form: ProtocolForm | undefined;
  openBuilder: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const used = choice.use && !read.skipped;
  const none = choice.template === "none";
  const custom = choice.template === "custom";
  const built = custom ? choice.built : undefined;
  /** A Custom sheet's steps aren't built yet. */
  const unbuilt = custom && built === undefined;
  const flagged = used && (none || unbuilt);
  const template = none || custom ? null : (choice.template as TemplateName);
  // A decay time's window is known: as the Protocols step has it, else its template's or a rise's.
  const from = form?.window ? parsed(form.window.from.value) : null;
  const to = form?.window ? parsed(form.window.to.value) : null;
  const direction =
    from !== null && to !== null ? directionOf(from, to) : choice.rise ? "rise" : "decay";
  const named = template === null ? "" : templateName(template, direction);

  let reason: string;
  if (none) reason = "No template matches these columns";
  else if (custom) reason = "Set to Custom by you";
  else if (choice.mapped)
    reason = `Matched ${named}: mapped ${mapping(read, template!, choice.roles)}`;
  else if (read.matched && read.template === template) reason = `Matched ${named}`;
  else {
    // A template chosen by hand takes columns by name: say which, where they aren't its own.
    const renamed = ROLES[template!].some((spec) => {
      const at = choice.roles[spec.role];
      return at !== undefined && read.columns[at].name !== spec.token;
    });
    reason = `Set to ${named} by you${renamed ? `: mapped ${mapping(read, template!, choice.roles)}` : ""}`;
  }
  // The window's fractions, so a half-decay sheet says 50 %: the Protocols step's, else the guess.
  const window =
    from !== null && to !== null
      ? { from, to }
      : choice.rise
        ? { from: 10, to: 90 }
        : choice.half
          ? { from: 100, to: 50 }
          : undefined;
  const line = none ? null : templateLine(custom ? "custom" : template!, direction, window);

  const columns = shownColumns(read, choice, named);
  const recoveryX = (spec: RoleSpec | null) => spec?.unit === "s|ms";
  // As the sheet has them: a recovery's gaps in its own unit.
  const points = template === null ? [] : pointsOf(read, choice.roles, false);
  const xSpec = template === null ? null : ROLES[template].find((s) => s.role === "x")!;
  const builtSwept = built === undefined ? null : sweptOf(built.draft.steps).one;
  const previewPoints =
    built !== undefined
      ? pointsOf(read, built.draft.roles, choice.seconds && builtSwept?.kind === "duration")
      : template === null && read.columns.length >= 2
        ? pointsOf(read, { x: 0, y: 1, sd: read.columns.length > 2 ? 2 : undefined }, false)
        : points;

  const onTemplate = (value: string) => {
    if (value === "none" || value === "custom") {
      set({ template: value, mapped: false });
      return;
    }
    const t = value as TemplateName;
    set({
      template: t,
      roles: rolesByName(t, read.columns),
      seconds: t === "recovery" && read.largestX !== null && read.largestX <= 10,
      mapped: false,
      rise: read.rise,
      half: read.half,
    });
  };

  return (
    <div
      role="group"
      aria-label={`Sheet ${read.name}`}
      id={`sheet-${read.name}`}
      className={`sheet-row${flagged ? " flag" : ""}${used ? "" : " off"}`}
    >
      <div className="sr-use">
        <input
          id={`${id}-use`}
          type="checkbox"
          checked={used}
          disabled={read.skipped}
          aria-label={`Use sheet ${read.name}`}
          onChange={(e) => set({ use: e.target.checked })}
        />
      </div>
      {!read.skipped && (
        <div className="sr-preview dim">
          <SheetPreview
            points={previewPoints}
            xUnit={
              builtSwept !== null
                ? builtSwept.kind === "duration"
                  ? "ms"
                  : "mV"
                : xSpec?.unit === "s|ms"
                  ? choice.seconds
                    ? "s"
                    : "ms"
                  : (xSpec?.unit ?? "")
            }
            signed={builtSwept !== null ? builtSwept.kind === "voltage" : xSpec?.unit === "mV"}
            logx={
              (built?.template ?? template) === "recovery" && previewPoints.every((pt) => pt.x > 0)
            }
          />
        </div>
      )}
      <div className="sr-sheet dim">
        <div className="sr-title">
          <span className="sr-name">{read.name}</span>
          <span className="sr-rows">
            {read.skipped ? "Skipped: no numeric columns" : count(read.rows, "row")}
          </span>
          {flagged && (
            <span className="sr-flag">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6.2" className="fill-ink" />
                <path d="M7 3.6v4.2" className="stroke-bg" strokeWidth="1.6" />
                <circle cx="7" cy="10.2" r="0.95" className="fill-bg" />
              </svg>
              {unbuilt ? "Needs its steps" : "Needs a template"}
            </span>
          )}
        </div>
        {!read.skipped && <span className="sr-reason">{reason}</span>}
        {!read.skipped && line !== null && <span className="sr-line">{line}</span>}
      </div>
      <div className="sr-template dim">
        <select
          id={`template-${read.name}`}
          className={`input${flagged ? " flagged" : ""}`}
          aria-label={`Template for sheet ${read.name}`}
          value={choice.template}
          disabled={!used}
          onChange={(e) => onTemplate(e.target.value)}
        >
          <option value="none">No template — choose…</option>
          {TEMPLATE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {value !== "decay_time" ? label : value === template ? named : DECAY_OR_RISE}
            </option>
          ))}
          <option value="custom">Custom protocol…</option>
        </select>
        <input
          id={`name-${read.name}`}
          className={`input mono${nameIssue ? " bad" : ""}`}
          aria-label={`Protocol name for sheet ${read.name}`}
          value={!used || none || unbuilt ? "" : choice.name}
          placeholder={used && (none || unbuilt) ? "template first" : ""}
          disabled={!used || none || unbuilt}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={nameIssue ? true : undefined}
          aria-describedby={nameIssue ? `${id}-name-issue` : undefined}
          onChange={(e) => set({ name: e.target.value })}
        />
        {nameIssue && (
          <span id={`${id}-name-issue`} className="err">
            {nameIssue}
          </span>
        )}
      </div>
      {!read.skipped && (
        <div className="sr-values dim">
          <div
            id={`${id}-pv`}
            className={`pv${open ? " open" : ""}`}
            role="table"
            aria-label={`Parsed values, sheet ${read.name}`}
            style={{ gridTemplateColumns: `repeat(${columns.length}, max-content)` }}
          >
            <div role="row" className="pv-row">
              {columns.map(({ spec, column }) => {
                const values = read.columns[column].numbers.filter((x): x is number => x !== null);
                const unit = spec?.unit === "s|ms" ? null : (spec?.unit ?? null);
                const signed = spec?.unit === "mV";
                return (
                  <div role="columnheader" className="pv-h" key={column}>
                    <span className="pv-k">
                      <span>{spec?.label ?? "Unmatched"}</span>
                      <span className="tok">{spec?.token ?? read.columns[column].name}</span>
                      {recoveryX(spec) && (
                        <select
                          className="input input-sm mono unit-select"
                          aria-label={`Unit of column ${read.columns[column].name}`}
                          value={choice.seconds ? "s" : "ms"}
                          onChange={(e) => set({ seconds: e.target.value === "s" })}
                        >
                          <option value="s">s</option>
                          <option value="ms">ms</option>
                        </select>
                      )}
                    </span>
                    <span className="pv-r">
                      {spec?.role === "holding" || spec?.role === "pulse"
                        ? span([values.find((x) => x !== undefined) ?? 0], unit, signed)
                        : span(values, unit, signed)}
                    </span>
                  </div>
                );
              })}
            </div>
            {open && <ParsedRows read={read} columns={columns.map((c) => c.column)} />}
          </div>
          {used && template === "recovery" && (choice.seconds || read.seconds) && (
            <span className="unit-note">
              {choice.seconds
                ? `Read as seconds (${read.largestX} → ${Number(((read.largestX ?? 0) * 1000).toPrecision(12))} ms) because the largest value is ${read.largestX}. Switch to ms if that’s wrong.`
                : `Read as milliseconds (${smallest(read, choice.roles)} → ${read.largestX} ms). The largest value is ${read.largestX} — check this is right.`}
            </span>
          )}
          <button
            type="button"
            className="btn-text btn-sm pv-toggle"
            aria-expanded={open}
            aria-controls={`${id}-pv`}
            onClick={() => setOpen(!open)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              className={open ? "up" : ""}
            >
              <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            {open ? "Hide parsed values" : `Show parsed values · ${count(read.rows, "row")}`}
          </button>
        </div>
      )}
      {used && none && read.template !== null && (
        <Mapper read={read} template={read.template} choice={choice} set={set} />
      )}
      {used && custom && (
        <div className="sr-panel">
          <div className="sr-panel-text">
            <span className="sr-panel-title">
              {built === undefined
                ? "Custom protocol: its steps aren’t defined yet"
                : `Custom protocol: ${templateLabel(built.template, built.draft.steps.length)} · ${measureFact(built.draft.steps)}`}
            </span>
            <span className="hint">
              {built === undefined
                ? `Set the hold, each step’s voltage and duration, which one is swept and which one is measured. Columns ${joinAnd(read.columns.map((c) => c.name))} are offered for mapping there.`
                : "Its steps, and the columns it reads, are set in the protocol builder."}
            </span>
          </div>
          <button
            id={`builder-${read.name}`}
            type="button"
            className="btn btn-sm"
            onClick={openBuilder}
          >
            Open protocol builder
          </button>
        </div>
      )}
    </div>
  );
}

/** "Vm → V, TTP → T, err → SD": each role's column by its header. */
function mapping(
  read: SheetRead,
  template: TemplateName,
  roles: Partial<Record<Role, number>>,
): string {
  return ROLES[template]
    .filter((s) => roles[s.role] !== undefined)
    .map((s) => `${read.columns[roles[s.role]!].name} → ${s.token}`)
    .join(", ");
}

/** The x column's smallest value, as the sheet has it. */
function smallest(read: SheetRead, roles: Partial<Record<Role, number>>): string {
  const x =
    roles.x === undefined
      ? []
      : read.columns[roles.x].numbers.filter((v): v is number => v !== null);
  return x.length ? String(Math.min(...x)) : "";
}

function ParsedRows({ read, columns }: { read: SheetRead; columns: number[] }) {
  const dps = columns.map((c) =>
    decimalsFor(read.columns[c].numbers.filter((x): x is number => x !== null)),
  );
  return (
    <>
      {Array.from({ length: read.rows }, (_, r) => (
        <div role="row" className="pv-row" key={r}>
          {columns.map((c, k) => {
            const x = read.columns[c].numbers[r];
            return (
              <div role="cell" className="pv-c" key={c}>
                {x === null ? "" : fixed(x, dps[k])}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** The closest template's columns, suggested by name and chosen by hand, then Use it. */
function Mapper({
  read,
  template,
  choice,
  set,
}: {
  read: SheetRead;
  template: TemplateName;
  choice: Choice;
  set: (change: Partial<Choice>) => void;
}) {
  const id = useId();
  // No window is known yet, so the shared type reads as both (#164).
  const label = template === "decay_time" ? DECAY_OR_RISE : TEMPLATE_LABELS[template];
  const specs = ROLES[template]
    .filter((s) => s.role !== "pulse" || choice.roles.pulse !== undefined)
    .map((s) => labeled(s, template, label));
  const setRole = (role: Role, column: string) => {
    const roles = { ...choice.roles };
    if (column === "") delete roles[role];
    else roles[role] = Number(column);
    set({ roles });
  };
  const ready = choice.roles.x !== undefined && choice.roles.y !== undefined;
  return (
    <div className="sr-panel mapper">
      <div className="mapper-head">
        <span className="sr-panel-title">Closest template: {label}</span>
        <span className="hint">
          needs{" "}
          {ROLES[template]
            .filter((s) => s.role !== "pulse")
            .map((s) => s.token)
            .join(", ")}{" "}
          · columns suggested by name
        </span>
        <span className="hint mapper-line">{templateLine(template, null)}</span>
      </div>
      <div className="mapper-grid">
        {specs.map((spec) => {
          const at = choice.roles[spec.role];
          const values =
            at === undefined ? [] : read.columns[at].numbers.filter((x): x is number => x !== null);
          return (
            <MapperRow key={spec.role}>
              <label htmlFor={`${id}-${spec.role}`} className="mapper-k">
                {spec.label} <span className="mono">{spec.token}</span>
              </label>
              {spec.role === "holding" && at === undefined ? (
                <>
                  <span className="hint">not in sheet</span>
                  <span className="hint">Set it on the Protocols step.</span>
                </>
              ) : (
                <>
                  <select
                    id={`${id}-${spec.role}`}
                    className="input input-sm mono"
                    value={at === undefined ? "" : String(at)}
                    onChange={(e) => setRole(spec.role, e.target.value)}
                  >
                    {at === undefined && <option value="">choose…</option>}
                    {read.columns.map((c, k) => (
                      <option key={k} value={String(k)}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <span className="mono mapper-r">
                    {values.length
                      ? span(values, spec.unit === "s|ms" ? null : spec.unit, spec.unit === "mV")
                      : ""}
                  </span>
                </>
              )}
            </MapperRow>
          );
        })}
      </div>
      <div className="mapper-use">
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={ready ? undefined : true}
          onClick={() => {
            if (ready) set({ template, mapped: true });
          }}
        >
          Use {label}
        </button>
        <span className="hint">
          Or pick another template, choose Custom protocol… to define the steps yourself, or untick
          Use to leave this sheet out.
        </span>
      </div>
    </div>
  );
}

function MapperRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
