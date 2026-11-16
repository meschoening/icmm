/**
 * The Dataset wizard's steps down its left side: each done step a link back
 * with what it chose, the current one in bold, the rest in gray.
 */
import type { SheetsStatus } from "./draft";
import { STEPS, type StepId } from "./words";
import { count } from "./format";

export interface StepRailProps {
  step: StepId;
  go: (to: StepId) => void;
  file: string | null;
  name: string;
  nameFree: boolean;
  sheets: number;
  status: SheetsStatus;
  protocols: number;
  platform: string;
  /** A save is under way: no going back. */
  locked: boolean;
}

export function StepRail(p: StepRailProps) {
  const at = STEPS.findIndex((s) => s.id === p.step);
  const needs = p.status.needs.length;
  const templates = p.status.needs.filter((n) => n.needs === "template").length;
  const needWord = templates === needs ? "a template" : templates === 0 ? "steps" : "attention";
  const sub: Record<StepId, React.ReactNode> = {
    source:
      at > 0 && p.file !== null ? (
        <>
          <span className="mono rail-file">{p.file}</span>
          <span className="rail-sub">
            → <span className="mono rail-name">{p.name}</span>
            {/* The dot keeps to the name, so a wrapped line starts with words. */}
            {p.nameFree && "\u00a0· name is free"}
          </span>
        </>
      ) : (
        <span className="rail-sub">Workbook and name</span>
      ),
    sheets: (
      <span className="rail-sub">
        {at > 1
          ? `${count(p.protocols, "protocol")} · ${p.status.leftOut === 0 ? "none left out" : `${count(p.status.leftOut, "sheet")} left out`}`
          : at === 1
            ? `${count(p.sheets, "sheet")} · ${needs === 0 ? "all set" : `${needs} ${needs === 1 ? "needs" : "need"} ${needWord}`}`
            : "Templates and names"}
      </span>
    ),
    protocols: <span className="rail-sub">Voltages, timing, weights</span>,
    review: <span className="rail-sub">Save to {p.platform}</span>,
  };
  return (
    <nav aria-label="New dataset steps" className="rail">
      <div className="label">New dataset</div>
      <ol>
        {STEPS.map((s, i) => {
          const done = i < at;
          const current = i === at;
          const mark = done ? (
            <span className="rail-mark done" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                <path d="M1.5 5.2 4 7.5l4.5-5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
          ) : (
            <span className={`rail-mark mono${current ? " current" : ""}`} aria-hidden="true">
              {i + 1}
            </span>
          );
          const words = (
            <span className="rail-words">
              <span className="rail-title">
                {s.title}
                {done && <span className="sr-only"> (done)</span>}
              </span>
              {sub[s.id]}
            </span>
          );
          return (
            <li
              key={s.id}
              aria-current={current ? "step" : undefined}
              className={current ? "current" : done ? "done" : "later"}
            >
              {done && !p.locked ? (
                <button type="button" className="rail-step" onClick={() => p.go(s.id)}>
                  {mark}
                  {words}
                </button>
              ) : (
                <div className="rail-step">
                  {mark}
                  {words}
                </div>
              )}
              {i < STEPS.length - 1 && <span aria-hidden="true" className="rail-line" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
