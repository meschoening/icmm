/**
 * Source (LaptopDatasetWizard): choose or drop the workbook, read on this
 * computer, and name the dataset, checked against the Active platform's.
 */
import { useId } from "react";
import { useSystemDialog, grayProps } from "../ui/gray";
import type { Working } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { DatasetSummary, Issue } from "../wire/types.gen";
import { count, size } from "./format";
import { failureWords, type ReadFailure } from "./readFailure";
import type { Book } from "./NewDataset";
import { unique } from "./sheets";
import { StepHeader } from "./StepHeader";

export type { ReadFailure } from "./readFailure";

function WorkbookIcon({ size: px }: { size: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 28 28" fill="none" aria-hidden="true" className="wb">
      <rect
        x="4.5"
        y="4.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M4.5 10.5h19M4.5 16.5h19M11.5 4.5v19" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export interface SourceStepProps {
  platform: string;
  step: number;
  discard: () => void;
  saving: Working;
  book: Book | null;
  reading: string | null;
  failure: ReadFailure | null;
  /** The file being dragged over the window, by name ("" without one); `null` when none is. */
  dragging: string | null;
  read: (path: string) => Promise<void>;
  name: string;
  /** The file's own name, when it was taken and ICMM proposed another. */
  proposed: string | null;
  /** The user typed the name. */
  typed: boolean;
  setName: (name: string) => void;
  datasets: DatasetSummary[] | undefined;
  /** Where the name check is: waiting for a connection, asking, or answered. */
  nameCheck: "offline" | "checking" | "ready" | "unknown";
  nameTaken: boolean;
  /** `validate_dataset`'s word on the name, if it has one. */
  nameIssue: Issue | undefined;
  next: () => void;
}

export function SourceStep(p: SourceStepProps) {
  const id = useId();
  const dialog = useSystemDialog();
  const choose = async () => {
    const chosen = await dialog.open(() =>
      commands.choose_file({ title: "Choose a workbook", folder: null }),
    );
    if (chosen.path !== null) await p.read(chosen.path);
  };

  const wb = p.book?.workbook;
  const free =
    p.datasets === undefined
      ? null
      : unique(p.name, 64, new Set(p.datasets.map((d) => d.name.toLowerCase())));
  // The agent's sentence for a name it won't take, beyond one that's taken.
  const ruleIssue =
    p.nameIssue !== undefined &&
    !p.nameTaken &&
    p.nameIssue.message !== "Another dataset already has this name."
      ? p.nameIssue.message
      : undefined;
  const bad = p.nameTaken || ruleIssue !== undefined;

  let blocked: string | undefined;
  let status: string;
  if (p.reading !== null) [blocked, status] = ["Reading the workbook…", "Reading the workbook…"];
  else if (wb === undefined)
    [blocked, status] = ["Choose a workbook first", "Choose a workbook first"];
  else if (bad) [blocked, status] = ["Choose a free name", "Choose a free name"];
  else {
    blocked = undefined;
    status = `${count(wb.sheets.length, "sheet")} to check next`;
  }

  const failure = p.failure === null ? null : failureWords(p.failure);
  const dropWords =
    p.dragging !== null
      ? p.dragging === ""
        ? "Drop to read the workbook"
        : `Drop to read ${p.dragging}`
      : failure !== null
        ? "Drop another .xlsx workbook here"
        : "Drop an .xlsx workbook here";

  return (
    <>
      <StepHeader
        step={p.step}
        title="Source"
        facts={
          wb !== undefined ? (
            <>
              <span className="mono-name">{wb.name}</span> · {count(wb.sheets.length, "sheet")} ·{" "}
              {size(wb.bytes ?? 0)}
            </>
          ) : (
            "One Excel workbook, one sheet per protocol"
          )
        }
        lede={`Choose the workbook with your summary data: a sheet per protocol, its values in columns under a header row. ICMM reads it on this computer; only the dataset it makes is saved to ${p.platform}.`}
        status={status}
        discard={p.discard}
        back={null}
        primary="Next: Sheets"
        blocked={blocked}
        onPrimary={p.next}
      />
      <section className="sec" aria-labelledby={`${id}-wb`}>
        <h2 id={`${id}-wb`} className="label">
          Workbook
        </h2>
        {wb === undefined || p.reading !== null ? (
          <div className={`drop${p.dragging !== null ? " over" : ""}`}>
            <WorkbookIcon size={28} />
            {p.reading !== null ? (
              <span className="drop-t" role="status">
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  Reading <span className="mono">{p.reading}</span>…
                </span>
              </span>
            ) : (
              <>
                <span className="drop-t">{dropWords}</span>
                <span className="drop-s">or</span>
                <button
                  type="button"
                  className="btn"
                  {...grayProps(dialog.gray)}
                  onClick={() => void choose()}
                >
                  Choose workbook…
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={`file${p.dragging !== null ? " over" : ""}`}>
            <WorkbookIcon size={24} />
            <div className="file-t">
              <span className="mono file-name">{wb.name}</span>
              <span className="file-sheets">
                <span className="mono n">{wb.sheets.length}</span>{" "}
                {wb.sheets.length === 1 ? "sheet" : "sheets"}:{" "}
                <span className="mono sheet-names">{wb.sheets.map((s) => s.name).join(" · ")}</span>
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              {...grayProps(dialog.gray)}
              onClick={() => void choose()}
            >
              Choose another…
            </button>
          </div>
        )}
        {failure !== null && p.reading === null && (
          <div className="ebox" role="alert">
            <div className="fsay">
              <p className="fwhat">{failure.what}</p>
              <p className="fnext">{failure.next}</p>
              {failure.raw !== "" && <span className="term fraw">{failure.raw}</span>}
            </div>
          </div>
        )}
        <span className="hint">
          {wb !== undefined
            ? "Drop another workbook on this page to start over from it."
            : "Up to 50 MB. Sheet and column names suggest each protocol’s template; you’ll check them next."}
        </span>
      </section>
      {wb !== undefined && (
        <section className="sec name-sec" aria-labelledby={`${id}-ds`}>
          <h2 id={`${id}-ds`} className="label">
            Dataset
          </h2>
          <label htmlFor={`${id}-name`} className="flabel">
            Name
          </label>
          <div className="name-row">
            <input
              id={`${id}-name`}
              className={`input mono name-input${bad ? " bad" : ""}`}
              value={p.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => p.setName(e.target.value)}
              aria-invalid={bad || undefined}
              aria-describedby={`${id}-name-h`}
            />
            <NameCheck state={p.nameCheck} taken={bad} platform={p.platform} />
          </div>
          {p.nameTaken && free !== null && (
            <div className="taken">
              <p className="err">
                {p.platform} already has a dataset named <span className="mono">{p.name}</span>.
                Names are unique ignoring case.
              </p>
              <div className="taken-free">
                <span>
                  <span className="mono">{free}</span> is free.
                </span>
                <button type="button" className="btn btn-sm" onClick={() => p.setName(free)}>
                  Use {free}
                </button>
              </div>
            </div>
          )}
          {ruleIssue !== undefined && <p className="err">{ruleIssue}</p>}
          <span id={`${id}-name-h`} className="hint">
            {p.proposed !== null
              ? `From the file name; ${p.proposed} is taken, so ICMM added ${p.name.slice(p.proposed.length)}. Letters, digits, ., - and _, up to 64.`
              : p.typed
                ? "Letters, digits, ., - and _, up to 64."
                : "From the file name. Letters, digits, ., - and _, up to 64."}
          </span>
        </section>
      )}
    </>
  );
}

/** Beside the name: free, checking, or checked once connected; nothing when the list failed, and Save checks. */
function NameCheck({
  state,
  taken,
  platform,
}: {
  state: "offline" | "checking" | "ready" | "unknown";
  taken: boolean;
  platform: string;
}) {
  return (
    <span className="ok" role="status">
      {state === "offline" ? (
        <>
          <span className="g g-off" aria-hidden="true" />
          Checked once {platform} is connected
        </>
      ) : state === "checking" ? (
        <>
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Checking {platform}…
        </>
      ) : taken || state === "unknown" ? null : (
        <>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2.5 7.4 5.6 10.4 11.5 3.8" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Free on {platform}
        </>
      )}
    </span>
  );
}
