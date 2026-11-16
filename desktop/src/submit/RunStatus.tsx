/**
 * A config's newest run as a status (LaptopSubmitRun): the glyph carries the
 * state of one in flight, beside its number; an ended run, or none yet, is
 * plain words. Shared by the config card and its picker.
 */
import type { ConfigRun } from "../wire/types.gen";
import { runStatus } from "./words";

export function RunStatus({ run, now }: { run: ConfigRun | null; now: number }) {
  const status = runStatus(run, now);
  if (status.glyph === undefined && status.run === undefined) {
    return <span className="sub-quiet">{status.word}</span>;
  }
  return (
    <span className={`st${run?.state === "held" ? " st-quiet" : ""}`}>
      {status.glyph !== undefined && <span className={status.glyph} aria-hidden="true" />}
      {status.run !== undefined && <span className="mono">{status.run}</span>} {status.word}
    </span>
  );
}
