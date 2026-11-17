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
 *
 * From the page (#470, LaptopStart's `best-report` and `best-reported`,
 * LaptopRunDetail's `report`): a page's ··· or ⌘K opens the panel with no
 * failure (`look: "page"`), a box of its own under the page head with a row
 * naming the page; saved, its sentence takes the panel's place with Show in
 * Finder and ×. It has no button: `start` opens it, and Cancel and × put
 * focus back where it was.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { revealWords } from "../datasets/detail/exportFile";
import { failureOf } from "../failure";
import { webviewInfo } from "../ipc";
import { commands } from "../wire/api.gen";
import type { ReportFailure, ReportPage, SavedReport } from "../wire/types.gen";
import { ReportPanel } from "./ReportPanel";

export interface ReportAbout {
  /** The failure as the page shows it; none for Settings' Diagnostic logs. */
  failure?: ReportFailure;
  /** The page it's from: a failed start's, or any page's from its ··· or ⌘K. */
  page?: AboutPage;
  /**
   * Under a box of its own (`alone`), below a row of buttons (`boxed`), not in a card, or under
   * the page head, from the page's ··· or ⌘K (`page`).
   */
  look?: "alone" | "boxed" | "page";
  /** What the report is about, where its words can change under it; its failure's words otherwise. */
  key?: string;
}

/** The page a report is from, as its panel's row names it. */
export interface AboutPage {
  kind: ReportPage["kind"];
  /** The row's words: "start 23 of #214/T12.3, with its run’s config and the end of its job log". */
  row: ReactNode;
  /** Read as the report is saved, so a start's job log is the newest. */
  read: () => Promise<ReportPage>;
}

/** The panel's row for each kind of page. */
export const PAGE_TERM: Record<ReportPage["kind"], string> = {
  start: "The start",
  topology: "The topology",
  run: "The run",
  page: "The page",
};

export interface Report {
  /** Report a problem…, or once saved Show in Finder; nothing while the panel is open. */
  button: ReactNode;
  /** What was saved and opened, once it was. */
  sentence: ReactNode;
  /** The panel, while it's open. */
  panel: ReactNode;
  /** Whether the panel is open, for the box above it to square its foot. */
  open: boolean;
  /** Opens the panel, as Report a problem… does; from the page's ··· or ⌘K. */
  start: () => void;
}

type Step = { at: "closed" } | { at: "review" } | { at: "saved"; saved: SavedReport };

export function useReport(about: ReportAbout): Report {
  // A new failure starts closed.
  const key = about.key ?? JSON.stringify(about.failure ?? null);
  const [step, setStep] = useState<Step & { key: string }>({ at: "closed", key });
  const now: Step = step.key === key ? step : { at: "closed" };
  /** Where focus goes once the step it's for has drawn. */
  const focus = useRef<"report" | "heading" | "reveal" | "back">(undefined);
  const reportButton = useRef<HTMLButtonElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // From the page, where focus was as it opened: the ··· button, or what ⌘K gave it back to.
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focus.current === undefined) return;
    if (focus.current === "back") {
      const to = back.current;
      (to?.isConnected ? to : document.querySelector<HTMLElement>("[data-page-heading]"))?.focus();
    } else {
      ({ report: reportButton, heading, reveal: revealButton })[focus.current].current?.focus();
    }
    focus.current = undefined;
  });
  const go = (next: Step, then: NonNullable<typeof focus.current>) => {
    focus.current = then;
    setStep({ ...next, key });
  };

  const os = useQuery({ queryKey: ["webview_info"], queryFn: webviewInfo, staleTime: Infinity })
    .data?.os;
  const [revealFailed, setRevealFailed] = useState<string>();

  const page = about.look === "page";
  const start = () => {
    const at = document.activeElement;
    back.current = at instanceof HTMLElement && at !== document.body ? at : null;
    go({ at: "review" }, "heading");
  };
  // Cancel and × put focus back where it was as the panel opened, else on the page heading.
  const close = () => go({ at: "closed" }, page ? "back" : "report");

  const reveal =
    now.at === "saved"
      ? () => {
          setRevealFailed(undefined);
          commands
            .reveal_file({ path: now.saved.path })
            .catch((e: unknown) => setRevealFailed(failureOf(e).message));
        }
      : undefined;

  const button = page ? null : now.at === "closed" ? (
    <button ref={reportButton} type="button" className="btn btn-sm" onClick={start}>
      Report a problem…
    </button>
  ) : now.at === "saved" ? (
    <button ref={revealButton} type="button" className="btn btn-sm" onClick={reveal}>
      {revealWords(os)}
    </button>
  ) : null;

  const sentence =
    !page && now.at === "saved" ? (
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
        onCancel={close}
        onSaved={(saved) => go({ at: "saved", saved }, "reveal")}
      />
    ) : page && now.at === "saved" ? (
      <div className="rep rep-page done">
        <p className="rsent" role="status">
          <span className="g g-completed" aria-hidden="true" />
          <span>
            Saved <span className="mono rsent-file">{now.saved.file}</span> in Downloads and opened
            ICMM’s issue page in your browser. Drag the file onto the page, say what went wrong,
            then submit.
            {revealFailed !== undefined && <span className="field-issue">{revealFailed}</span>}
          </span>
        </p>
        <div className="rep-actions">
          <button ref={revealButton} type="button" className="btn btn-sm" onClick={reveal}>
            {revealWords(os)}
          </button>
          <button type="button" className="rep-x" aria-label="Dismiss" onClick={close}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
      </div>
    ) : null;

  return { button, sentence, panel, open: now.at === "review", start };
}
