/**
 * The Protocol builder's Checks card: `validate_dataset`'s issues, live,
 * in the board's order beside what passes (ADR-0003). While a check is out,
 * the last answer's rows stay, gray, and its heading says it's checking, so
 * the card keeps its height and nothing under it moves (#509, F07).
 */
import { useState } from "react";
import type { Issue, Measure, Point } from "../../wire/types.gen";
import { count, span } from "../format";
import type { SheetRead } from "../sheets";
import { measureWords, WINDOW_RULE } from "../words";
import type { Swept } from "./charts";
import { fieldWords, keyOf, rankOf } from "./fields";
import type { BuilderDraft } from "./model";

export function Checks({
  fid,
  platform,
  connected,
  current,
  dataset,
  saved,
  draft,
  read,
  points,
  swept,
  measured,
  measure,
  local,
  engine,
}: {
  fid: (key: string) => string;
  platform: string;
  connected: boolean;
  current: boolean;
  dataset: string;
  /** Edit protocol…: the protocol's name as saved; `null` for a new protocol. */
  saved: string | null;
  draft: BuilderDraft;
  /** The sheet its data comes from; `null` until one is chosen. */
  read: SheetRead | null;
  points: Point[];
  swept: { all: Swept[]; one: Swept | null };
  measured: number[];
  measure: Measure | null;
  local: Issue[];
  engine: Issue[];
}) {
  // In the board's order: the sweep, the measure, the window, the fields, the data, the name.
  const rows: Row[] = [];
  if (swept.one !== null) {
    rows.push({
      rank: rankOf("sweep"),
      ok: true,
      text: `One swept quantity: step ${swept.one.step + 1} ${swept.one.kind}.`,
    });
  }
  if (measured.length === 1 && measure !== null) {
    rows.push({
      rank: rankOf("measure"),
      ok: true,
      text: `Exactly one step is measured: step ${measured[0] + 1}, ${measureWords(measure)}.`,
    });
  }
  for (const issue of local) {
    const key = keyOf(issue.path.slice(2));
    rows.push({ rank: rankOf(key), ok: false, text: `${fieldWords(key)}: ${issue.message}` });
  }
  // What the check answered: the engine's issues, the data and the name.
  const answered: Row[] = [];
  // The engine's issues, those about points grouped by sentence.
  const pointGroups = new Map<string, number>();
  for (const issue of engine) {
    const rest = issue.path.slice(2);
    const key = keyOf(rest);
    if (key === "points" && rest.length > 1) {
      pointGroups.set(issue.message, (pointGroups.get(issue.message) ?? 0) + 1);
    } else if (/^[vd]\d+$/.test(key)) {
      const text = `${fieldWords(key)}: ${issue.message}`;
      answered.push({ rank: rankOf(key), ok: false, text });
    } else if (/^(from|to)\d+$/.test(key)) {
      // In %, as the window is typed, and once for its two fractions (#168).
      const text = `${fieldWords(key)}: ${WINDOW_RULE}`;
      if (!answered.some((r) => r.text === text)) {
        answered.push({ rank: rankOf(key), ok: false, text });
      }
    } else {
      answered.push({ rank: rankOf(key), ok: false, text: issue.message });
    }
  }
  for (const [message, n] of pointGroups) {
    const text = `${count(n, "point")}: ${message}`;
    answered.push({ rank: rankOf("points"), ok: false, text });
  }
  const pointIssues = engine.some((i) => i.path[2] === "points");
  const nameIssue = engine.some((i) => i.path.length === 3 && i.path[2] === "name");
  // Saved points keep their interpolated ones, which no row of the sheet holds.
  const rowsMeasured = points.filter((pt) => !pt.interpolated);
  const added = points.length - rowsMeasured.length;
  if (current && read !== null && swept.one !== null && rowsMeasured.length > 0 && !pointIssues) {
    const xs = rowsMeasured.map((pt) => pt.x);
    const column = read.columns[draft.roles.x!].name;
    const range = span(
      xs,
      swept.one.kind === "voltage" ? "mV" : "ms",
      swept.one.kind === "voltage",
    );
    const rowsOf = `${count(rowsMeasured.length, "row")} of ${read.name}`;
    answered.push({
      rank: rankOf("points"),
      ok: true,
      // The facts count every sweep: the rows, then what interpolation adds (#168).
      text:
        added > 0
          ? `${rowsOf}, plus ${added} interpolated (${column} ${range}).`
          : `${count(rowsMeasured.length, "sweep")} match the ${rowsOf} (${column} ${range}).`,
    });
  }
  // The protocol's own saved name isn't news, so only another name is said to be free (#560).
  if (
    current &&
    draft.name !== saved &&
    !nameIssue &&
    local.every((i) => i.path[2] !== "name")
  ) {
    answered.push({
      rank: rankOf("name"),
      ok: true,
      text: `The name ${draft.name} is free in ${dataset}.`,
    });
  }
  // The last answer, kept while the next is out (a state from an earlier render, as React has it).
  const [held, setHeld] = useState<Row[]>([]);
  if (current && !same(answered, held)) setHeld(answered);
  const kept = !current && held.length > 0;
  // A kept row says no more than what's typed since: a field's own check replaces its row.
  const typed = new Set(rows.map((r) => r.rank));
  const stale = held.filter((r) => !typed.has(r.rank)).map((r) => ({ ...r, stale: true }));
  rows.push(...(current ? answered : stale));
  rows.sort((a, b) => a.rank - b.rank);
  const waiting = connected
    ? `Checking with ${platform}…`
    : `Checks run on ${platform} once it’s connected.`;
  return (
    <section aria-labelledby={fid("ck")} className="card b-checks">
      <div className="ck-head">
        <h2 id={fid("ck")} className="label">
          Checks
        </h2>
        {/* Mounted throughout, so a screen reader hears it as it comes. */}
        <span className="ck-waiting" role="status">
          {kept && (
            <>
              <span className="g g-queued" aria-hidden="true" />
              {waiting}
            </>
          )}
        </span>
      </div>
      <ul className="ck-list">
        {rows.map((r, k) => (
          <li key={k} className={`ck${r.ok ? "" : " bad"}${r.stale ? " stale" : ""}`}>
            {r.ok ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-label="passes">
                <path d="M2.5 7.4 5.6 10.3 11.5 3.8" className="ck-ok" strokeWidth="1.6" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-label="fails">
                <path d="M3 3l8 8M11 3l-8 8" className="ck-bad" strokeWidth="1.6" />
              </svg>
            )}
            <span>{r.text}</span>
          </li>
        ))}
        {!current && !kept && (
          <li className="ck wait">
            <span className="g g-queued" aria-hidden="true" />
            <span>{waiting}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

interface Row {
  ok: boolean;
  text: string;
  rank: number;
  /** From the last answer, kept while the next check is out. */
  stale?: boolean;
}

const same = (a: Row[], b: Row[]) =>
  a.length === b.length &&
  a.every((r, i) => r.rank === b[i].rank && r.ok === b[i].ok && r.text === b[i].text);
