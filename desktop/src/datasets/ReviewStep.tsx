/**
 * Review (LaptopWizReview): the protocols in a table, the values templates
 * gave, then Save dataset. A name another computer took meanwhile asks for
 * another here; a save across a reconnect waits for it.
 */
import { useId } from "react";
import { useNow } from "../connection/useNow";
import { clock } from "../ui/clock";
import type { Working } from "../ui/working";
import { defaultsOf, formDirection, type Choice, type ProtocolForm } from "./draft";
import {
  defaultsWords,
  interpolationWords,
  pointCounts,
  sheetsUsedWords,
  templateLabel,
  validationGroups,
} from "./words";
import { PointsFacts } from "./PointsFacts";
import { count } from "./format";
import type { Book } from "./NewDataset";
import { StepHeader } from "./StepHeader";

function measureWords(f: ProtocolForm): string {
  const kind = f.steps.find((s) => s.measure !== null)?.measure;
  const normalized = f.normalized ? ", normalized" : "";
  if (kind === "decay_time" && f.window !== null) {
    const name = formDirection(f) === "rise" ? "Rise time" : "Decay time";
    return `${name} · ${f.window.from.value}\u00a0→\u00a0${f.window.to.value}\u00a0%${normalized}`;
  }
  if (kind === "time_to_peak") return "Time to peak";
  return `Peak${normalized}`;
}

/** A save found the name taken: by which dataset, since when, and the free name ICMM proposed. */
export interface Taken {
  name: string;
  at: string;
  proposed: string;
}

export interface ReviewStepProps {
  platform: string;
  step: number;
  discard: () => void;
  saving: Working;
  book: Book;
  name: string;
  setName: (name: string) => void;
  /** A save found the name taken by another computer's dataset. */
  taken: Taken | null;
  nameTaken: boolean;
  forms: ProtocolForm[];
  choices: Choice[];
  /** A value on Protocols still to fix. */
  blocked: boolean;
  message: string | undefined;
  waiting: boolean;
  save: () => void;
  back: () => void;
  edit: () => void;
}

export function ReviewStep(p: ReviewStepProps) {
  const id = useId();
  const now = useNow([]);
  const counts = pointCounts(p.forms);
  const groups = validationGroups(p.forms);
  const defaults = p.forms.reduce((n, f) => n + defaultsOf(f).length, 0);
  const sheets = p.book.workbook.sheets.length;
  const used = new Set(p.forms.map((f) => f.sheet));
  const leftOut = p.book.workbook.sheets.map((s) => s.name).filter((s) => !used.has(s));

  let status: string;
  let tone: "plain" | "bad" | "wait" = "plain";
  if (p.waiting) {
    status = `Waiting for ${p.platform} to reconnect, then this saves.`;
    tone = "wait";
  } else if (p.saving.pending) {
    status = `Saving to ${p.platform}…`;
  } else if (p.message !== undefined) {
    status = p.message;
    tone = "bad";
  } else if (p.taken !== null) {
    status = `Saves as ${p.name}`;
  } else {
    status = `Saves to ${p.platform}`;
  }
  const blocked = p.blocked
    ? "Fix the values on Protocols first"
    : p.nameTaken
      ? "Choose a free name"
      : undefined;

  return (
    <>
      <StepHeader
        step={p.step}
        title="Review"
        facts={
          <>
            <span className="mono">{p.name}</span> · <span className="n">{p.forms.length}</span>{" "}
            protocols · <PointsFacts counts={counts} />
          </>
        }
        lede={`Saving makes the dataset on ${p.platform}, ready for a config. To change it later, open it from Datasets: each change saves a new revision, and runs keep the data they were fit to.`}
        status={status}
        tone={tone}
        discard={p.discard}
        back={p.back}
        primary="Save dataset"
        blocked={blocked}
        onPrimary={p.save}
        working={p.saving}
        workingWords="Saving…"
      />
      {p.taken !== null && (
        <section className="sec name-sec" aria-labelledby={`${id}-ds`}>
          <h2 id={`${id}-ds`} className="label">
            Dataset
          </h2>
          <p className="taken-say">
            Another computer saved a dataset named <span className="mono">{p.taken.name}</span> on{" "}
            {p.platform} at {clock(Date.parse(p.taken.at), now)}. Save this one under another name.
          </p>
          <label htmlFor={`${id}-name`} className="flabel">
            Name
          </label>
          <div className="name-row">
            <input
              id={`${id}-name`}
              className={`input mono name-input${p.nameTaken ? " bad" : ""}`}
              value={p.name}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={p.nameTaken || undefined}
              aria-describedby={`${id}-name-h`}
              onChange={(e) => p.setName(e.target.value)}
            />
            {!p.nameTaken && (
              <span className="ok" role="status">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2.5 7.4 5.6 10.4 11.5 3.8" stroke="currentColor" strokeWidth="1.6" />
                </svg>
                Free on {p.platform}
              </span>
            )}
          </div>
          {p.nameTaken && (
            <p className="err">
              {p.platform} already has a dataset named <span className="mono">{p.name}</span>. Names
              are unique ignoring case.
            </p>
          )}
          <span id={`${id}-name-h`} className="hint">
            {p.name === p.taken.proposed && p.name.startsWith(p.taken.name)
              ? `ICMM added ${p.name.slice(p.taken.name.length)}. Letters, digits, ., - and _, up to 64.`
              : "Letters, digits, ., - and _, up to 64."}
          </span>
        </section>
      )}
      {p.taken === null && defaults > 0 && (
        <div className="note">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
            className="note-i"
          >
            <circle cx="9" cy="9" r="7.4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 5v5" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="9" cy="12.6" r="0.9" fill="currentColor" />
          </svg>
          <p>
            <b>
              {count(defaults, "value")}{" "}
              {defaults === 1 ? "is a template default" : "are template defaults"}
            </b>
            , not from your workbook: {defaultsWords(p.forms)}. If you recorded with others, change
            them in{" "}
            <button type="button" className="link" onClick={p.edit}>
              Protocols
            </button>
            .
          </p>
        </div>
      )}
      <section className="sec" aria-labelledby={`${id}-p`}>
        <h2 id={`${id}-p`} className="label">
          Protocols
        </h2>
        <div className="rtable" role="table" aria-labelledby={`${id}-p`}>
          <div role="row" className="rrow">
            {[
              "Protocol",
              "Template",
              "Sheet",
              "Points",
              "Interpolation",
              "Hold",
              "Measure",
              "Weight",
            ].map((h, i) => (
              <span
                key={h}
                role="columnheader"
                className={`th${i === 3 || i === 5 || i === 7 ? " rt-num" : ""}`}
              >
                {h}
              </span>
            ))}
          </div>
          {p.forms.map((f) => {
            return (
              <div role="row" className="rrow" key={f.sheet}>
                <span role="cell" className="pn">
                  {f.name}
                </span>
                <span role="cell">
                  {templateLabel(f.template, f.steps.length, formDirection(f))}
                </span>
                <span role="cell" className="mono dim">
                  {f.sheet}
                </span>
                <span role="cell" className="mono rt-num">
                  {f.points.length}
                </span>
                <span role="cell" className={f.read.made.enabled ? undefined : "dim"}>
                  {interpolationWords(f)}
                </span>
                <span role="cell" className="mono rt-num">
                  {f.holding.value} mV
                </span>
                <span role="cell">{measureWords(f)}</span>
                <span role="cell" className="mono rt-num">
                  {f.weight.value}
                </span>
              </div>
            );
          })}
        </div>
        <span className="hint">
          From <span className="mono">{p.book.workbook.name}</span>:{" "}
          {sheetsUsedWords(p.forms.length, sheets, leftOut)}
        </span>
      </section>
      <section className="sec" aria-labelledby={`${id}-v`}>
        <h2 id={`${id}-v`} className="label">
          Validation points
        </h2>
        {groups.length > 0 ? (
          <>
            <p className="vnone">
              <span className="n">{counts.validation}</span> of{" "}
              <span className="n">{counts.points}</span> points:{" "}
              {groups.map((g, i) => (
                <span key={g.count}>
                  {i === 0 ? "" : i === groups.length - 1 ? " and " : ", "}
                  <span className="n">{g.count}</span> {g.names.length > 1 ? "each in" : "in"}{" "}
                  {g.names.map((name, j) => (
                    <span key={name}>
                      {j === 0 ? "" : j === g.names.length - 1 ? " and " : ", "}
                      <span className="mono">{name}</span>
                    </span>
                  ))}
                </span>
              ))}
              .
            </p>
            <span className="hint">
              Fits leave them out, and Val RMSE scores how well a fit predicts them. To change them,
              go back to{" "}
              <button type="button" className="link" onClick={p.edit}>
                Protocols
              </button>
              .
            </span>
          </>
        ) : (
          <p className="vnone">
            None. Every point is a train point, so runs on <span className="mono">{p.name}</span>{" "}
            rank by Train RMSE.
          </p>
        )}
      </section>
    </>
  );
}
