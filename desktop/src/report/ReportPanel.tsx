/** Report a problem…'s panel (#126): what the report holds and leaves out, and that the page is public. */
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { failureOf } from "../failure";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { commands } from "../wire/api.gen";
import type { SavedReport } from "../wire/types.gen";
import type { ReportAbout } from "./useReport";

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
          start: about.start === undefined ? null : await about.start.read(),
        }),
      )
      .then(onSaved, (e: unknown) => setFailed(failureOf(e).message));
  };
  const failure = about.failure;
  return (
    <div
      className={about.look === undefined ? "rep" : `rep ${about.look}`}
      role="region"
      aria-labelledby={`${id}-h`}
    >
      <div className="rep-say">
        <h4 id={`${id}-h`} ref={heading} tabIndex={-1}>
          Report this on ICMM’s issue page
        </h4>
        <p>
          ICMM saves a report in Downloads and opens its issue page on GitHub, filled in. The page
          is public, and nothing is posted until you submit it there.
        </p>
        <dl className="kv">
          {failure !== undefined && (
            <>
              <dt>The failure</dt>
              <dd>
                {about.start !== undefined
                  ? "This error and the end of its job log"
                  : failure.raw !== null
                    ? "This sentence and its raw line"
                    : "This sentence"}
              </dd>
            </>
          )}
          {about.start !== undefined && (
            <>
              <dt>The start</dt>
              <dd>{about.start.name}, with its run’s config</dd>
            </>
          )}
          <dt>Versions</dt>
          <dd>{preview?.versions ?? "…"}</dd>
          <dt>Platform</dt>
          <dd>{preview?.platform ?? "…"}</dd>
          <dt>Logs</dt>
          <dd>
            Today’s app and agent logs
            {preview !== undefined &&
              ` · ${preview.log_lines.toLocaleString("en-US")} ${preview.log_lines === 1 ? "line" : "lines"}`}
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
