/**
 * A wizard step's head: "Step N of 4", its heading and facts, Discard, Back
 * and its one primary button, the status line under them, and its lede.
 */
import type { ReactNode } from "react";
import { useBlocker } from "../ui/blocker";
import { PAGE_HEADING_ATTR } from "../ui/pageChangeFocus";
import type { Working } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { ReportFromHere } from "../report/ReportFromHere";

export interface StepHeaderProps {
  step: number;
  title: string;
  facts: ReactNode;
  lede: ReactNode;
  /** The status line: what Next waits for, or what's next. */
  status: ReactNode;
  /** How the status line reads: plain, a problem, or a wait. */
  tone?: "plain" | "ink" | "bad" | "wait";
  discard: (() => void) | null;
  back: (() => void) | null;
  primary: string;
  /** Why the primary button can't be used yet; it says so when pressed. */
  blocked?: string;
  onPrimary: () => void;
  /** The primary button's slow action, for Save. */
  working?: Working;
  workingWords?: string;
}

export function StepHeader(p: StepHeaderProps) {
  const block = useBlocker(p.blocked);
  const busy = p.working?.pending ?? false;
  const press = () => {
    if (p.blocked === undefined) p.onPrimary();
  };
  return (
    <>
      <section className="step-head">
        <div className="hdr">
          <div className="hdr-text">
            <div className="label">Step {p.step} of 4</div>
            <h1 id="step-heading" className="title" tabIndex={-1} {...{ [PAGE_HEADING_ATTR]: "" }}>
              {p.title}
            </h1>
            <p className="facts">{p.facts}</p>
          </div>
          <div className="hacts">
            <div className="acts">
              {p.discard !== null && !busy && (
                <button type="button" className="btn-text" onClick={p.discard}>
                  Discard
                </button>
              )}
              {p.back !== null &&
                (p.working ? (
                  <BesideButton type="button" className="btn" working={p.working} onClick={p.back}>
                    Back
                  </BesideButton>
                ) : (
                  <button type="button" className="btn" onClick={p.back}>
                    Back
                  </button>
                ))}
              <>
                {p.working ? (
                  <WorkingButton
                    type="button"
                    className="btn btn-primary"
                    working={p.working}
                    words={p.workingWords ?? "Saving…"}
                    {...block.props}
                    onClick={(e) => {
                      block.props.onClick(e);
                      press();
                    }}
                  >
                    {p.primary}
                  </WorkingButton>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    {...block.props}
                    onClick={(e) => {
                      block.props.onClick(e);
                      press();
                    }}
                  >
                    {p.primary}
                  </button>
                )}
                {block.bubble}
              </>
            </div>
            <span id="step-status" className={`astat ${p.tone ?? "plain"}`} role="status">
              {p.tone === "wait" && <span className="g g-queued" aria-hidden="true" />}
              {p.status}
            </span>
          </div>
        </div>
        <p className="lede">{p.lede}</p>
      </section>
      <ReportFromHere name="New dataset" />
    </>
  );
}
