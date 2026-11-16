/** An export's note and its red box (#344, `useSave.tsx`). */
import { useState } from "react";
import { fileAt, revealWords } from "../datasets/detail/exportFile";
import { grayProps } from "../ui/gray";
import { commands } from "../wire/api.gen";
import type { WireError } from "../wire/types.gen";
import type { Outcome, Said } from "./outcome";

/** Where it went, with Show in Finder: the file it chose, or the folder of figures. */
export function Exported({ path, said, os }: { path: string; said: Said; os: string | undefined }) {
  const [failed, setFailed] = useState<string>();
  return (
    <div className="note-ask ex-note" role="status">
      <p>
        {said.lead}
        <span className="hint">{said.hint}</span>
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
    <div className="ebox ex-failed" role="alert">
      <div className="fsay">
        <p className="fwhat">
          ICMM couldn’t save {outcome.what} to <span className="mono">{file}</span> in {folder}.
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

/** "herg-wt-leaderboard.csv in Documents": the file's name, in mono, and its folder's. */
export function FileIn({ path }: { path: string }) {
  const { file, folder } = fileAt(path);
  return (
    <>
      <span className="mono">{file}</span> in {folder}
    </>
  );
}
