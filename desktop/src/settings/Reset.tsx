/**
 * Reset ICMM (LaptopSettings), alone below a rule at the end of Settings.
 * Reset ICMM… turns its row into a red-soft panel that asks, listing what
 * Reset forgets and keeps; the question takes focus, not an answer, the
 * panel scrolls into view as far as its buttons, and Escape cancels. When
 * this computer has ICMM's key, Keeps names it and who it still signs in as,
 * and Also delete ICMM's SSH key, off by default, moves it into Forgets
 * (#118's U08). A Reset that fails says what's left in the same place,
 * naming the logs another app holds open. One that finishes opens Home,
 * which is First launch again, with the theme following the system.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ICMM_KEY, usesIcmmKey } from "../connection/icmmKey";
import { useConnection } from "../shell/connection";
import { chooseTheme } from "../theme";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { useWorking } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { SavedPlatform } from "../wire/types.gen";
import { failureOf, useSshKeys } from "./commands";

type At = { kind: "rest" } | { kind: "ask" } | { kind: "failed"; message: string };

export interface ResetProps {
  platforms: SavedPlatform[];
  /** Runs `then` once any open form's unsaved changes may go. */
  guard: (then: () => void) => void;
}

export function Reset({ platforms, guard }: ResetProps) {
  const id = useId();
  const [at, setAt] = useState<At>({ kind: "rest" });
  /** Also delete ICMM's SSH key: off each time the panel opens. */
  const [deleteKey, setDeleteKey] = useState(false);
  const keys = useSshKeys();
  const working = useWorking();
  const connection = useConnection();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const start = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const tryAgain = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the panel changes. */
  const focusTo = useRef<"start" | "question" | "retry" | null>(null);
  useEffect(() => {
    const to = focusTo.current;
    focusTo.current = null;
    if (to === "start") start.current?.focus();
    else if (to === "question") {
      // The row sits at the end of a long page, so the panel may open below the fold.
      question.current?.focus({ preventScroll: true });
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.current?.scrollIntoView({ block: "nearest", behavior: still ? "instant" : "smooth" });
    } else if (to === "retry") tryAgain.current?.focus();
  });

  const go = (next: At, focus: typeof focusTo.current) => {
    focusTo.current = focus;
    setAt(next);
  };
  const cancel = () => {
    if (!working.busy()) go({ kind: "rest" }, "start");
  };
  const hasKey = keys.data?.keys.includes(ICMM_KEY) ?? false;
  const reset = () =>
    void working
      .run(() => commands.reset_app({ delete_icmm_key: hasKey && deleteKey }))
      .then(
        () => {
          chooseTheme("system");
          void queries.resetQueries();
          void navigate({ to: "/" });
        },
        (error: unknown) => {
          // Steps before the one that failed are done: read again what they changed.
          void queries.invalidateQueries();
          go({ kind: "failed", message: failureOf(error).message ?? String(error) }, "retry");
        },
      );
  const openLogs = () => void commands.open_logs_folder().catch(() => {});
  const escapeCancels = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    cancel();
  };

  const live =
    connection.status === "connected" ||
    connection.status === "connecting" ||
    connection.status === "reconnecting";
  const then =
    "opens at First launch, as if just installed. Add a platform again and ICMM finds its data as you left it.";
  const lead = live ? `ICMM disconnects from ${connection.platform}, then ${then}` : `ICMM ${then}`;

  return (
    <section className="reset" aria-labelledby={`${id}-h`}>
      {at.kind === "rest" && (
        <div className="reset-rest">
          <div className="general-text">
            <h2 id={`${id}-h`} className="general-title">
              Reset to factory settings
            </h2>
            <span className="general-hint">
              Forgets your saved platforms, preferences and logs on this computer. Your data, runs
              and SSH keys stay.
            </span>
          </div>
          <button
            ref={start}
            type="button"
            className="btn btn-sm"
            onClick={() =>
              guard(() => {
                setDeleteKey(false);
                // What's in `~/.ssh` now: ICMM's key may have been made since.
                void keys.refetch();
                go({ kind: "ask" }, "question");
              })
            }
          >
            Reset ICMM…
          </button>
        </div>
      )}
      {at.kind === "ask" && (
        <div
          ref={panel}
          className="reset-panel"
          role="alertdialog"
          aria-labelledby={`${id}-h`}
          aria-describedby={`${id}-d`}
          onKeyDown={escapeCancels}
        >
          <div className="reset-say">
            <h3 id={`${id}-h`} ref={question} tabIndex={-1}>
              Reset ICMM on this computer?
            </h3>
            <p id={`${id}-d`}>{lead}</p>
          </div>
          <div className="reset-lists">
            <div className="reset-list">
              <h4 id={`${id}-f`} className="label">
                Forgets
              </h4>
              <ul aria-labelledby={`${id}-f`}>
                <li>{forgetsPlatforms(platforms)}</li>
                <li>Your theme, notification and still-improving choices</li>
                <li>The window’s size and place</li>
                <li>Logs from the last seven days</li>
                {hasKey && deleteKey && (
                  <li className="reset-key">
                    ICMM’s SSH key, <span className="mono">{ICMM_KEY}</span>, so no one here can
                    sign in {signIn(platforms)}
                  </li>
                )}
              </ul>
            </div>
            <div className="reset-list">
              <h4 id={`${id}-k`} className="label">
                Keeps
              </h4>
              <ul aria-labelledby={`${id}-k`}>
                <li>Each platform’s Data folder: its datasets, configs, runs and engine</li>
                <li>Runs in progress, which keep going</li>
                <li>
                  {hasKey ? "Your own SSH keys" : "Your SSH keys"} and known hosts in{" "}
                  <span className="mono">~/.ssh</span>
                </li>
                {hasKey && !deleteKey && (
                  <li className="reset-key">
                    ICMM’s SSH key, <span className="mono">{ICMM_KEY}</span>. Anyone using this
                    account on this computer can still sign in {signIn(platforms)}.
                  </li>
                )}
              </ul>
            </div>
          </div>
          {hasKey && (
            <div className="reset-also">
              <label className="check">
                <input
                  type="checkbox"
                  checked={deleteKey}
                  disabled={working.shown}
                  onChange={(e) => setDeleteKey(e.target.checked)}
                  aria-describedby={`${id}-kd`}
                />
                <span className="flabel">Also delete ICMM’s SSH key</span>
              </label>
              <span id={`${id}-kd`} className="hint">
                Before you hand this computer to someone else. Your own keys stay, and connecting
                again makes a new key with your password.
              </span>
            </div>
          )}
          <div className="reset-actions">
            <BesideButton type="button" className="btn btn-sm" working={working} onClick={cancel}>
              Cancel
            </BesideButton>
            <WorkingButton
              type="button"
              className="btn btn-sm btn-danger"
              working={working}
              words="Resetting…"
              onClick={reset}
            >
              Reset ICMM
            </WorkingButton>
          </div>
        </div>
      )}
      {at.kind === "failed" && (
        <div className="reset-panel" role="alert" onKeyDown={escapeCancels}>
          <div className="reset-say">
            <h3 id={`${id}-h`}>
              <span className="g g-failed" aria-hidden="true" />
              Reset didn’t finish
            </h3>
            <p>{withFiles(at.message)}</p>
          </div>
          <div className="reset-actions">
            <BesideButton type="button" className="btn btn-sm" working={working} onClick={openLogs}>
              Open logs folder
            </BesideButton>
            <span className="grow" />
            <BesideButton type="button" className="btn btn-sm" working={working} onClick={cancel}>
              Cancel
            </BesideButton>
            <WorkingButton
              ref={tryAgain}
              type="button"
              className="btn btn-sm btn-danger"
              working={working}
              words="Resetting…"
              onClick={reset}
            >
              Try again
            </WorkingButton>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Who ICMM's key still signs in as you to: the saved platforms that name it,
 * or wherever ICMM added it.
 */
function signIn(platforms: SavedPlatform[]): string {
  const names = platforms.filter(usesIcmmKey).map((p) => p.name);
  return names.length === 0 ? "as you wherever ICMM added it" : `to ${listed(names)} as you`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The logs a failed Reset names, as files: `app.2026-10-03.log`. */
const LOG_FILE = /((?:app|agent)\.\d{4}-\d{2}-\d{2}\.log)/;

function withFiles(message: string): React.ReactNode {
  return message.split(LOG_FILE).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="mono reset-file">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** Where This computer keeps its data until the user chooses another folder. */
const LOCAL_DATA_FOLDER = "~/icmm";

/**
 * The first of Reset's list: the saved platforms by name, and how to reach
 * them. This computer is built in, so it's named only when Reset changes how
 * it's reached: its Data folder goes back to `~/icmm`.
 */
function forgetsPlatforms(platforms: SavedPlatform[]): string {
  const names = platforms
    .filter((p) => p.type === "ssh" || p.data_folder !== LOCAL_DATA_FOLDER)
    .map((p) => p.name);
  if (names.length === 0) return "Your saved platforms and how to reach them";
  if (names.length === 1) return `${names[0]} and how to reach it`;
  return `${listed(names)}, and how to reach them`;
}
