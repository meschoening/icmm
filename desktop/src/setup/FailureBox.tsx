/**
 * A failed read or save of Platform setup's parts, in a red box (#117's
 * U01): #116's three lines across its width (what happened, whose move it
 * is, the raw line), then its buttons at the bottom right, so no line has to
 * center on a button. A retry that failed the same way says when.
 *
 * ICMM's own errors get Report a problem…, whose panel opens under the box
 * (#126).
 */
import { useReport } from "../report/useReport";
import { clock } from "../ui/clock";
import type { SavedPlatform } from "../wire/types.gen";
import { useWorking } from "../ui/working";
import { WorkingButton } from "../ui/WorkingButton";
import { failureBox, type FailureBox as FailureBoxWords, type SetupTask } from "./form";

export interface FailureBoxProps {
  error: unknown;
  task: SetupTask;
  platform: Pick<SavedPlatform, "type" | "name">;
  /** Reads again; a save's box has none, since Save is its retry. */
  onRetry?: () => Promise<unknown>;
  /** When a retry last failed the same way. */
  again?: number;
}

export function FailureBox({ error, task, platform, onRetry, again }: FailureBoxProps) {
  return <SaidBox said={failureBox(error, task, platform)} onRetry={onRetry} again={again} />;
}

/**
 * A box already worded, as Submit run words a refused submit (`refusedBox`):
 * the same three lines and buttons as `FailureBox` gives a failed read.
 */
export function SaidBox({
  said,
  onRetry,
  again,
}: {
  said: FailureBoxWords;
  onRetry?: () => Promise<unknown>;
  again?: number;
}) {
  const raw = said.logRef === undefined ? said.raw : `internal error · log ${said.logRef}`;
  const report = useReport({
    failure: { what: said.what, next: said.next ?? null, raw },
    look: "alone",
  });
  const retry = said.retry && onRetry !== undefined;
  const box = (
    <div className={report.open ? "fail-box open" : "fail-box"} role="alert">
      <div className="fail-say">
        <p className="fail-what">{said.what}</p>
        {said.next !== undefined && <p className="fail-next">{said.next}</p>}
        <p className="term fail-raw">
          {said.logRef === undefined ? (
            said.raw
          ) : (
            <>
              internal error · log <span className="ink-2">{said.logRef}</span>
            </>
          )}
        </p>
        {again !== undefined && (
          <p className="hint">Tried again at {clock(again, again)} · same error</p>
        )}
        {said.report && report.sentence}
      </div>
      {((said.report && report.button !== null) || retry) && (
        <div className="fail-actions">
          {said.report && report.button}
          {retry && <TryAgain onRetry={onRetry} />}
        </div>
      )}
    </div>
  );
  // Box and panel as one, so the page's gap doesn't part them.
  return report.open ? (
    <div className="rep-under">
      {box}
      {report.panel}
    </div>
  ) : (
    box
  );
}

/** Try again after a read failed: "Reading…" while it reads again. */
export function TryAgain({ onRetry }: { onRetry: () => Promise<unknown> }) {
  const reading = useWorking();
  return (
    <WorkingButton
      type="button"
      className="btn btn-sm"
      working={reading}
      words="Reading…"
      onClick={() => void reading.run(onRetry)}
    >
      Try again
    </WorkingButton>
  );
}
