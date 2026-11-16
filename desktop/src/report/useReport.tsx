/**
 * Report a problem… (#126, LaptopConnection's and LaptopSettings'
 * report-review and reported): on every failure that's ICMM's to fix, on
 * Settings' Diagnostic logs and on a failed start.
 *
 * The press opens a panel in place, under its failure, with no dialog: what
 * the report holds, what it leaves out and that the page is public. Report a
 * problem… hides while it's open, so focus goes to the panel's heading, and
 * back to Report a problem… on Cancel. Save and open issue page saves the
 * report in Downloads and opens ICMM's issue page filled in; then the failure
 * says so, and Show in Finder takes the button's place, with focus.
 *
 * `useReport` gives the three parts each place puts where its own layout has
 * them: the button among its actions, the sentence under its words and the
 * panel under the whole of it.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { revealWords } from "../datasets/detail/exportFile";
import { failureOf } from "../failure";
import { webviewInfo } from "../ipc";
import { commands } from "../wire/api.gen";
import type { ReportFailure, ReportStart, SavedReport } from "../wire/types.gen";
import { ReportPanel } from "./ReportPanel";

export interface ReportAbout {
  /** The failure as the page shows it; none for Settings' Diagnostic logs. */
  failure?: ReportFailure;
  /** A failed start's: read as the report is saved, so its job log is the newest. */
  start?: { name: string; read: () => Promise<ReportStart> };
  /** Under a box of its own (`alone`) or below a row of buttons (`boxed`), not in a card. */
  look?: "alone" | "boxed";
  /** What the report is about, where its words can change under it; its failure's words otherwise. */
  key?: string;
}

export interface Report {
  /** Report a problem…, or once saved Show in Finder; nothing while the panel is open. */
  button: ReactNode;
  /** What was saved and opened, once it was. */
  sentence: ReactNode;
  /** The panel, while it's open. */
  panel: ReactNode;
  /** Whether the panel is open, for the box above it to square its foot. */
  open: boolean;
}

type Step = { at: "closed" } | { at: "review" } | { at: "saved"; saved: SavedReport };

export function useReport(about: ReportAbout): Report {
  // A new failure starts closed.
  const key = about.key ?? JSON.stringify(about.failure ?? null);
  const [step, setStep] = useState<Step & { key: string }>({ at: "closed", key });
  const now: Step = step.key === key ? step : { at: "closed" };
  /** Where focus goes once the step it's for has drawn. */
  const focus = useRef<"report" | "heading" | "reveal">(undefined);
  const reportButton = useRef<HTMLButtonElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus.current === undefined) return;
    ({ report: reportButton, heading, reveal: revealButton })[focus.current].current?.focus();
    focus.current = undefined;
  });
  const go = (next: Step, then: NonNullable<typeof focus.current>) => {
    focus.current = then;
    setStep({ ...next, key });
  };

  const os = useQuery({ queryKey: ["webview_info"], queryFn: webviewInfo, staleTime: Infinity })
    .data?.os;
  const [revealFailed, setRevealFailed] = useState<string>();

  const button =
    now.at === "closed" ? (
      <button
        ref={reportButton}
        type="button"
        className="btn btn-sm"
        onClick={() => go({ at: "review" }, "heading")}
      >
        Report a problem…
      </button>
    ) : now.at === "saved" ? (
      <button
        ref={revealButton}
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setRevealFailed(undefined);
          commands
            .reveal_file({ path: now.saved.path })
            .catch((e: unknown) => setRevealFailed(failureOf(e).message));
        }}
      >
        {revealWords(os)}
      </button>
    ) : null;

  const sentence =
    now.at === "saved" ? (
      <p className="rsent" role="status">
        <span className="g g-completed" aria-hidden="true" />
        <span>
          Saved <span className="mono rsent-file">{now.saved.file}</span> in Downloads and opened
          ICMM’s issue page in your browser. Drag the file onto the page, read it over, then submit.
          {revealFailed !== undefined && <span className="field-issue">{revealFailed}</span>}
        </span>
      </p>
    ) : null;

  const panel =
    now.at === "review" ? (
      <ReportPanel
        about={about}
        heading={heading}
        onCancel={() => go({ at: "closed" }, "report")}
        onSaved={(saved) => go({ at: "saved", saved }, "reveal")}
      />
    ) : null;

  return { button, sentence, panel, open: now.at === "review" };
}
