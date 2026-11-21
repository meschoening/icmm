/**
 * Report a problem…'s panel (#126): what the report holds and leaves out, and that the page is
 * public. From the page's ··· or ⌘K (#470), with no failure, it's headed for the page.
 */
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { failureOf } from "../failure";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { commands } from "../wire/api.gen";
import type { SavedReport } from "../wire/types.gen";
import { PAGE_TERM, type ReportAbout } from "./useReport";

/** `2026-11-12-0914`, on this computer's clock: the report's file name ends with it. */
function stamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

export function ReportPanel({
  about,
  heading,
  onCancel,
  onSaved,
}: {
  about: ReportAbout;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onCancel: () => void;
  onSaved: (saved: SavedReport) => void;
}) {
  const id = useId();
  const preview = useQuery({
    queryKey: ["report_preview"],
    queryFn: commands.report_preview,
    // The logs grow: each opening counts them again.
    staleTime: 0,
    gcTime: 0,
  }).data;
  const saving = useWorking();
  const [failed, setFailed] = useState<string>();
  const save = () => {
    setFailed(undefined);
    saving
      .run(async () =>
        commands.save_report({
          stamp: stamp(new Date()),
          failure: about.failure ?? null,
          page: about.page === undefined ? null : await about.page.read(),
        }),
      )
      .then(onSaved, (e: unknown) => setFailed(failureOf(e).message));
  };
  const failure = about.failure;
  const page = about.page;
  // From the page, with no failure: a box of its own under the page head, so a level-2 heading.
  const fromPage = about.look === "page";
  const Heading = fromPage ? "h2" : "h4";
  return (
    <div
      // `rep-page`, since `.page` is the page's own frame.
      className={
        about.look === undefined
          ? "rep"
          : about.look === "page"
            ? "rep rep-page"
            : `rep ${about.look}`
      }
      role="region"
      aria-labelledby={`${id}-h`}
    >
      <div className="rep-say">
        <Heading id={`${id}-h`} ref={heading} tabIndex={-1}>
          {fromPage ? "Report a problem on ICMM’s issue page" : "Report this on ICMM’s issue page"}
        </Heading>
        <p>
          ICMM opens a new issue on GitHub with the report filled in. There, signed in to GitHub,{" "}
          {fromPage ? "say what went wrong" : "read it over"}. The page is public, and nothing is
          posted until you submit it.
        </p>
        <dl className="kv">
          {failure !== undefined && (
            <>
              <dt>The failure</dt>
              <dd>
                {page?.kind === "start"
                  ? "This error and the end of its job log"
                  : failure.raw !== null
                    ? "This sentence and its raw line"
                    : "This sentence"}
              </dd>
            </>
          )}
          {page !== undefined && (
            <>
              <dt>{PAGE_TERM[page.kind]}</dt>
              <dd>{page.row}</dd>
            </>
          )}
          <dt>Versions</dt>
          <dd>{preview?.versions ?? "…"}</dd>
          <dt>Platform</dt>
          <dd>{preview?.platform ?? "…"}</dd>
          <dt>Logs</dt>
          <dd>The newest warnings and errors</dd>
          <dt>Whole report</dt>
          <dd>
            Copied to your clipboard and saved in Downloads, with today’s app and agent logs
            {/* No-break spaces, so the line breaks only after the dot. */}
            {preview !== undefined &&
              `\u00a0· ${preview.log_lines.toLocaleString("en-US")}\u00a0${preview.log_lines === 1 ? "line" : "lines"}`}
            . Paste it into the issue if you like.
          </dd>
          <dt>Left out</dt>
          <dd>
            Keys, passwords and dataset contents; user names become{" "}
            <span className="mono">user</span>.
          </dd>
        </dl>
        {failed !== undefined && (
          <p className="field-issue" role="alert">
            {failed}
          </p>
        )}
      </div>
      <div className="rep-actions">
        <BesideButton working={saving} type="button" className="btn-text btn-sm" onClick={onCancel}>
          Cancel
        </BesideButton>
        <WorkingButton
          working={saving}
          words="Saving…"
          type="button"
          className="btn btn-sm btn-primary"
          onClick={save}
        >
          Save and open issue page
        </WorkingButton>
      </div>
    </div>
  );
}
