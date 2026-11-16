/**
 * A modal question with two answers: keep what you have, or go on and lose
 * it. Focus goes to its heading, not a button, so Enter can't answer by
 * accident; Escape keeps. Tab stays inside it. Whoever opened it returns
 * focus when it closes. A slow answer works in place (`working`, with its
 * words), and what went wrong shows above the buttons.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BesideButton, WorkingButton } from "./WorkingButton";
import type { Working } from "./working";

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  keep: string;
  confirm: string;
  onKeep: () => void;
  onConfirm: () => void;
  /** What shows under the question, such as a path. */
  after?: ReactNode;
  /** The confirm's working state, and its words ("Deleting…"). */
  working?: { working: Working; words: string };
  /** What the last answer's failure says. */
  message?: string;
}

export function ConfirmDialog({
  title,
  children,
  keep,
  confirm,
  onKeep,
  onConfirm,
  after,
  working,
  message,
}: ConfirmDialogProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!working?.working.busy()) onKeep();
      return;
    }
    if (e.key !== "Tab") return;
    const buttons = [...(box.current?.querySelectorAll("button") ?? [])];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) return;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === heading.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="scrim">
      <div
        ref={box}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        aria-describedby={`${id}-b`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <p id={`${id}-b`}>{children}</p>
        {after}
        {message !== undefined && (
          <p className="dialog-message" role="alert">
            {message}
          </p>
        )}
        <div className="dialog-actions">
          {working === undefined ? (
            <>
              <button type="button" className="btn" onClick={onKeep}>
                {keep}
              </button>
              <button type="button" className="btn btn-danger" onClick={onConfirm}>
                {confirm}
              </button>
            </>
          ) : (
            <>
              <BesideButton
                type="button"
                className="btn"
                working={working.working}
                onClick={onKeep}
              >
                {keep}
              </BesideButton>
              <WorkingButton
                type="button"
                className="btn btn-danger"
                working={working.working}
                words={working.words}
                onClick={onConfirm}
              >
                {confirm}
              </WorkingButton>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
