/**
 * The Protocol builder's Data card: what the protocol expects as x, y and
 * SD, the columns of its sheet mapped to them, and the sheet as read: its
 * points as made, interpolated ones ◆ and validation ones hollow, each a
 * button that switches it (#145). On a saved dataset (#146), Change… reads
 * a sheet from any workbook, a menu picks among its sheets, and a new
 * protocol starts with none.
 */
import { Fragment } from "react";
import type { useBlocker } from "../../ui/blocker";
import { grayProps } from "../../ui/gray";
import type { Measure, Point, Template } from "../../wire/types.gen";
import { DataChart } from "../charts";
import type { PointWords } from "../points";
import { count, span } from "../format";
import type { SheetRead } from "../sheets";
import { NORMALIZED_Y } from "../words";
import type { Swept } from "./charts";
import { every } from "./fields";
import type { BuilderDraft, BuilderStep } from "./model";

/** What the y column holds: open probability only, never a current (ADR-0010). */
function yWords(
  measure: Measure | null,
  normalized: boolean,
  template: Template,
  rise: boolean,
  window: string,
): [string, string] {
  if (measure === null) return ["— (measure one step)", ""];
  if (measure.kind === "time_to_peak") return ["Time to peak", "ms"];
  if (measure.kind === "decay_time") {
    const what = `${rise ? "Rise" : "Decay"} time, ${window} of peak`;
    return normalized ? [`${what}, as a fraction of the largest`, "0–1"] : [what, "ms"];
  }
  if (!normalized) return ["Peak open probability", "0–1"];
  const named: Partial<Record<Template, string>> = {
    gv_activation: "Normalized conductance",
    steady_state_inactivation: "Normalized current",
    recovery: "Fraction recovered",
  };
  return named[template] !== undefined
    ? [named[template], NORMALIZED_Y[template]!]
    : ["Peak, as a fraction of the largest", "0–1"];
}

export function DataCard({
  fid,
  draft,
  read,
  workbook,
  points,
  seconds,
  swept,
  measure,
  rise,
  mStep,
  template,
  ring,
  outOfRange,
  onSwitch,
  words,
  change,
  changeGray = false,
  sheets = [],
  onSheet,
  failure,
  onRoles,
}: {
  fid: (key: string) => string;
  draft: BuilderDraft;
  /** The sheet its data comes from; `null` until one is chosen. */
  read: SheetRead | null;
  /** Its workbook's name; `null` for points that came from none. */
  workbook: string | null;
  points: Point[];
  /** The source x column is in seconds; `points` are already in ms. */
  seconds: boolean;
  swept: Swept | null;
  measure: Measure | null;
  rise: boolean;
  mStep: BuilderStep | null;
  template: Template;
  ring: number | undefined;
  /** The x of each interpolated point out of its measure's range. */
  outOfRange: ReadonlySet<number>;
  /** Clicking a point switches it between train and validation. */
  onSwitch: (x: number) => void;
  words: PointWords;
  /** Change…: blocked in the wizard; on a saved dataset, its press reads another workbook. */
  change: ReturnType<typeof useBlocker> & { onPress?: () => void };
  /** Change… waits for the OS's dialog to open (`gray.ts`). */
  changeGray?: boolean;
  /** The workbook's sheets with numbers, for a menu when there's more than one. */
  sheets?: SheetRead[];
  onSheet?: (sheet: string) => void;
  /** Why the workbook chosen can't be read, in the wizard's words. */
  failure?: { what: string; next: string; raw: string };
  onRoles: (roles: BuilderDraft["roles"]) => void;
}) {
  const x: [string, string] =
    swept === null
      ? ["— (sweep one quantity)", ""]
      : [
          `Step ${swept.step + 1} ${swept.kind} · one row per sweep`,
          swept.kind === "voltage" ? "mV" : "ms",
        ];
  const [yName, yUnit] = yWords(
    measure,
    draft.normalized,
    template,
    rise,
    mStep === null ? "" : `${mStep.from} → ${mStep.to} %`,
  );
  const added = points.filter((p) => p.interpolated).length;
  const held = points.filter((p) => p.validation).length;
  const column = (i: number | undefined) =>
    i === undefined || read === null
      ? []
      : read.columns[i].numbers.filter((v): v is number => v !== null);
  const changeButton = (
    <button
      type="button"
      className="btn btn-sm"
      {...change.props}
      {...grayProps(changeGray)}
      onClick={(e) => {
        change.props.onClick(e);
        if (!changeGray) change.onPress?.();
      }}
    >
      {read === null ? "Choose…" : "Change…"}
    </button>
  );
  const roles = [
    { role: "x" as const, optional: false },
    { role: "y" as const, optional: false },
    { role: "sd" as const, optional: true },
  ];
  return (
    <section aria-labelledby={fid("data")} className="card b-data">
      <h2 id={fid("data")} className="label">
        Data this protocol expects
      </h2>
      <div className="b-expect">
        <span className="mono k">x</span>
        <span>{x[0]}</span>
        <span className="mono k">{x[1]}</span>
        <span className="mono k">y</span>
        <span>{yName}</span>
        <span className="mono k">{yUnit}</span>
        <span className="mono k">SD</span>
        <span>Standard deviation of y</span>
        <span className="mono k">{yUnit}</span>
      </div>
      <div className="b-map">
        {read === null ? (
          <div className="b-from">
            <span className="dim">No workbook yet</span>
            {changeButton}
            {change.bubble}
          </div>
        ) : (
          <div className="b-from">
            {workbook === null ? (
              <span className="dim">From saved points</span>
            ) : (
              <>
                <span className="dim">From</span>
                <span className="mono b-from-src">
                  {workbook} ›{" "}
                  {sheets.length > 1 ? (
                    <select
                      className="input input-sm mono b-sheet-menu"
                      aria-label="Sheet"
                      value={read.name}
                      onChange={(e) => onSheet?.(e.target.value)}
                    >
                      {sheets.map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    read.name
                  )}
                </span>
              </>
            )}
            <span className="dim">
              · <span className="n">{read.rows}</span> rows
            </span>
            {changeButton}
            {change.bubble}
          </div>
        )}
        {failure !== undefined && (
          <div className="ebox" role="alert">
            <div className="fsay">
              <p className="fwhat">{failure.what}</p>
              <p className="fnext">{failure.next}</p>
              {failure.raw !== "" && <span className="term fraw">{failure.raw}</span>}
            </div>
          </div>
        )}
        {read === null ? (
          <span className="hint">Choose… reads a sheet from any workbook.</span>
        ) : (
          <>
            <div className="b-roles">
              {roles.map(({ role, optional }) => {
                const at = draft.roles[role];
                const values = column(at);
                return (
                  <Fragment key={role}>
                    <label htmlFor={fid(`map-${role}`)} className="mono k">
                      {role === "sd" ? "SD" : role}
                    </label>
                    <select
                      id={fid(`map-${role}`)}
                      className="input input-sm mono"
                      value={at === undefined ? "" : String(at)}
                      onChange={(e) => {
                        const next = { ...draft.roles };
                        if (e.target.value === "") delete next[role];
                        else next[role] = Number(e.target.value);
                        onRoles(next);
                      }}
                    >
                      {(optional || at === undefined) && (
                        <option value="">{optional ? "—" : "choose…"}</option>
                      )}
                      {read.columns.map((c, k) => (
                        <option key={k} value={String(k)}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <span className="mono">
                      {values.length > 0 &&
                        span(values, role === "x" && seconds ? "s" : null, false)}
                      {role === "x" && every(values) && (
                        <span className="dim"> {every(values)}</span>
                      )}
                    </span>
                  </Fragment>
                );
              })}
            </div>
            <figure className="b-asread">
              <figcaption className="hint">
                {read.name} as read{seconds ? " · x in ms" : ""}
                {added > 0 && (
                  <>
                    {" · "}
                    <span className="glyph added" aria-hidden="true" /> {added} interpolated
                  </>
                )}
                {held > 0 && ` · ${held} validation, hollow`}
                {outOfRange.size > 0 && (
                  <span className="bad"> · {count(outOfRange.size, "point")} out of range</span>
                )}
                {ring !== undefined ? " · ring = highlighted sweep" : ""}
              </figcaption>
              {points.length > 0 ? (
                <DataChart
                  points={points}
                  logx={false}
                  ring={ring}
                  outOfRange={outOfRange}
                  onSwitch={onSwitch}
                  words={words}
                  label={`${read.name}: ${count(points.length, "point")}, ${
                    draft.roles.y === undefined ? "" : read.columns[draft.roles.y].name
                  } against ${draft.roles.x === undefined ? "" : read.columns[draft.roles.x].name}${
                    added > 0 ? `, ${added} of them interpolated` : ""
                  }${held > 0 ? `, ${held} of them validation points, drawn hollow` : ""}. Each point switches between train and validation.`}
                />
              ) : (
                <span className="hint">Map x and y to see the sheet’s points.</span>
              )}
            </figure>
          </>
        )}
      </div>
    </section>
  );
}
