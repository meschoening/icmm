/** Export figures…'s outcome under Compare's head (#342, `useExportFigures.tsx`). */
import { useState } from "react";
import { fileAt, revealWords } from "../datasets/detail/exportFile";
import { grayProps } from "../ui/gray";
import { commands } from "../wire/api.gen";
import type { WireError, WrittenFile } from "../wire/types.gen";

export type Outcome =
  | { kind: "written"; path: string; count: number }
  | { kind: "failed"; path: string; problem: WrittenFile["problem"]; detail: string | null }
  | { kind: "error"; path: string; error: Partial<WireError> };

export function Exported({
  path,
  count,
  os,
}: {
  path: string;
  count: number;
  os: string | undefined;
}) {
  const { file, folder } = fileAt(path);
  const [failed, setFailed] = useState<string>();
  return (
    <div className="note-ask cmp-exported" role="status">
      <p>
        Exported <span className="n">{count}</span> {count === 1 ? "figure" : "figures"} to{" "}
        <span className="mono">{file}</span> in {folder}: one SVG per protocol.
        <span className="hint">
          Each protocol’s overlay with its legend and RMSE table, in light colors.
        </span>
        {failed !== undefined && <span className="err">{failed}</span>}
      </p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setFailed(undefined);
          commands
            .reveal_file({ path })
            .catch((e: Partial<WireError>) => setFailed(e.message ?? String(e)));
        }}
      >
        {revealWords(os)}
      </button>
    </div>
  );
}

export function ExportFailed({
  outcome,
  again,
  gray,
}: {
  outcome: Exclude<Outcome, { kind: "written" }>;
  again: () => void;
  gray: boolean;
}) {
  const { file, folder } = fileAt(outcome.path);
  const next =
    outcome.kind === "failed"
      ? outcome.problem === "no_space"
        ? "The disk is full. Free some space, or export to another folder."
        : outcome.problem === "denied"
          ? "This computer didn’t let ICMM write there. Export again and choose another folder."
          : undefined
      : outcome.error.message;
  const raw =
    outcome.kind === "failed"
      ? `${outcome.path} · ${outcome.detail ?? outcome.problem}`
      : `${outcome.path} · ${outcome.error.code ?? "error"}`;
  return (
    <div className="ebox" role="alert">
      <div className="fsay">
        <p className="fwhat">
          ICMM couldn’t save the figures to <span className="mono">{file}</span> in {folder}.
        </p>
        {next !== undefined && <p className="fnext">{next}</p>}
        <span className="term fraw">{raw}</span>
      </div>
      <button type="button" className="btn btn-sm" {...grayProps(gray)} onClick={again}>
        Export again
      </button>
    </div>
  );
}
