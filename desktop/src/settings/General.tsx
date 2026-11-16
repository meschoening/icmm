/**
 * Settings' General section (LaptopSettings): Theme, Notifications, Mark
 * still-improving starts (#234) and the logs folder, each applying at once.
 * The logs row shows where the folder is, as text to copy (#118's U22), and
 * Report a problem… for a problem no failure shows (#126).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { chooseTheme } from "../theme";
import { useReport } from "../report/useReport";
import { useBlocker } from "../ui/blocker";
import { commands } from "../wire/api.gen";
import type { Preferences, Theme } from "../wire/types.gen";
import { failureOf } from "./commands";
import { usePreferences, useSetPreferences } from "./preferences";

const THEMES: [Theme, string][] = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
];

export function General() {
  const id = useId();
  const preferences = usePreferences().data;
  const setPreferences = useSetPreferences();
  const [failure, setFailure] = useState<string | undefined>();
  /** Whether a test was sent since notifications were last turned on. */
  const [sent, setSent] = useState(false);
  const run = (action: () => Promise<unknown>) => {
    setFailure(undefined);
    action().catch((error: unknown) => setFailure(failureOf(error).message));
  };
  const change = (next: Partial<Preferences>) => {
    if (preferences === undefined) return;
    run(() => setPreferences({ ...preferences, ...next }));
  };
  // The page shows the saved theme: a choice shows at once, and one that
  // can't be saved goes back once the preferences are read again.
  const theme = preferences?.theme;
  useEffect(() => {
    if (theme !== undefined) chooseTheme(theme);
  }, [theme]);
  const logs = useQuery({
    queryKey: ["logs_folder"],
    queryFn: commands.logs_folder,
    staleTime: Infinity,
  }).data?.path;
  const report = useReport({});
  const on = preferences?.notifications ?? true;
  const test = useBlocker(on ? undefined : "Turn notifications on to send a test");
  return (
    <section id="general" className="general" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="label">
        General
      </h2>
      <div className="surface-card">
        <div className="general-row">
          <div className="general-text">
            <span id={`${id}-theme`} className="general-title">
              Theme
            </span>
            <span className="general-hint">System follows your OS setting.</span>
          </div>
          <div className="seg" role="group" aria-labelledby={`${id}-theme`}>
            {THEMES.map(([theme, label]) => (
              <button
                key={theme}
                type="button"
                aria-pressed={preferences?.theme === theme}
                disabled={preferences === undefined}
                onClick={() => change({ theme })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="general-row">
          <div className="general-text">
            <label htmlFor={`${id}-n`} className="general-title">
              Notifications
            </label>
            <span id={`${id}-nd`} className="general-hint">
              A notification from your computer when a run completes or fails. Send a test to check
              that they show.
            </span>
            {sent && on && (
              <span role="status" className="general-hint general-said">
                Test sent. If none appeared, allow notifications for ICMM in your computer’s
                settings.
              </span>
            )}
          </div>
          <div className="general-controls">
            <button
              type="button"
              className="btn btn-sm"
              {...test.props}
              onClick={(e) => {
                test.props.onClick(e);
                if (!on) return;
                run(async () => {
                  await commands.send_test_notification();
                  setSent(true);
                });
              }}
            >
              Send a test
            </button>
            {test.bubble}
            <label className="switch">
              <input
                id={`${id}-n`}
                type="checkbox"
                role="switch"
                checked={on}
                disabled={preferences === undefined}
                onChange={(e) => {
                  setSent(false);
                  change({ notifications: e.target.checked });
                }}
                aria-describedby={`${id}-nd`}
              />
              <span className="trk" aria-hidden="true" />
            </label>
          </div>
        </div>
        <div className="general-row">
          <div className="general-text">
            <label htmlFor={`${id}-si`} className="general-title">
              Mark still-improving starts
            </label>
            <span id={`${id}-sid`} className="general-hint">
              Mark starts whose Train RMSE was still falling when their evaluations ran out.
            </span>
          </div>
          <label className="switch">
            <input
              id={`${id}-si`}
              type="checkbox"
              role="switch"
              checked={preferences?.mark_still_improving ?? false}
              disabled={preferences === undefined}
              onChange={(e) => change({ mark_still_improving: e.target.checked })}
              aria-describedby={`${id}-sid`}
            />
            <span className="trk" aria-hidden="true" />
          </label>
        </div>
        <div className="general-row">
          <div className="general-text">
            <span className="general-title">Diagnostic logs</span>
            <span className="general-hint">
              App and agent logs from the last seven days. A report holds the newest, with your
              versions.
            </span>
            {logs !== undefined && logs !== "" && <span className="mono general-path">{logs}</span>}
            {report.sentence}
          </div>
          <div className="general-controls general-logs">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => run(() => commands.open_logs_folder())}
            >
              Open logs folder
            </button>
            {report.button}
          </div>
        </div>
        {report.panel}
      </div>
      {failure !== undefined && (
        <p className="field-issue" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
