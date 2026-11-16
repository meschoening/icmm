/** Export's outcome under Dataset detail's header (#147, `useExport.tsx`). */
import { useState } from "react";
import { grayProps } from "../../ui/gray";
import { commands } from "../../wire/api.gen";
import type { WireError } from "../../wire/types.gen";
import { fileAt, revealWords, type Outcome, type Shown } from "./exportFile";

export function Exported({
  shown,
  path,
  os,
}: {
  shown: Shown;
  path: string;
  os: string | undefined;
}) {
  const { file, folder } = fileAt(path);
  const [failed, setFailed] = useState<string>();
  return (
    <div className="note-ask dd-exported" role="status">
      <p>
        Exported {shown.name} to <span className="mono">{file}</span> in {folder}.
        <span className="hint">
          It holds this revision: <span className="n">{shown.protocols}</span>{" "}
          {shown.protocols === 1 ? "protocol" : "protocols"}, with their validation points,
          interpolation and weights. Import on Datasets reads it, on any platform.
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
          ICMM couldn’t save <span className="mono">{file}</span> in {folder}.
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
