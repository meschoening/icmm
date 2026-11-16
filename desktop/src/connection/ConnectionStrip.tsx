/**
 * The strip across the Active platform's card foot (LaptopConnection): the
 * connect's steps, a failure with its fixes and Retry now, a reconnect's
 * reason over its countdown or its try, a host key to trust or forget, or a
 * key to add or choose. A failure is an alert, and a reconnect's reason is
 * announced as each try changes it; the steps and the facts that tick
 * aren't, since the status line above already is. A question's strip takes
 * focus on its heading, so a keyboard or screen reader user lands on the
 * question rather than on a button.
 *
 * A failure reads in three lines (#116): what happened, the next step, and
 * the raw line in small mono. Retry now shows only where retrying can help.
 */
import {
  type FormEvent,
  Fragment,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useReport } from "../report/useReport";
import { useSshKeys } from "../settings/commands";
import { SshKeySelect } from "../settings/SshKeySelect";
import { useBlocker } from "../ui/blocker";
import { grayProps } from "../ui/gray";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { useWorking } from "../ui/working";
import type { ConnectFix, RecordedKey } from "../wire/types.gen";
import { ICMM_KEY } from "./icmmKey";
import { press, usePressed } from "./pressed";
import type { KeyAskView, KeyView, StepView, StripView } from "./view";

export interface StripActions {
  onRetry: () => void;
  onEdit: () => void;
  /** This computer's platform id, which Use this computer instead connects to. */
  thisComputer: string | undefined;
  /** Connects to This computer instead, where the cluster can't be used. */
  onUseThisComputer: () => void;
  /** Ends the connect: a host key's Cancel. */
  onCancel: () => void;
  onTrust: (fingerprint: string) => void;
  /** Forgets the recorded key; rejects with the sentence to show when it can't. */
  onForget: (fingerprint: string) => Promise<void>;
  /** Asks for a key, from a refused one. */
  onSetUpKey: () => void;
  /** Adds ICMM's key with the password; rejects with the sentence to show by the field. */
  onAddKey: (password: string) => Promise<void>;
  /** Saves a key file as the platform's, and connects again; rejects with the sentence to show. */
  onUseKey: (file: string) => Promise<void>;
}

/** What a step's glyph says to a screen reader. */
const SAID: Record<StepView["state"], string> = {
  done: "done",
  current: "under way",
  todo: "not reached",
};

const GLYPH: Record<StepView["state"], string> = {
  done: "g-completed",
  current: "g-busy",
  todo: "g-todo",
};

export function ConnectionStrip({
  view,
  platform,
  ...actions
}: { view: StripView; platform: string } & StripActions) {
  switch (view.kind) {
    case "steps":
      return (
        <div className="strip steps">
          <ol className="hsteps" aria-label={`Connecting to ${platform}`}>
            {view.steps.map((s, i) => (
              <li key={s.name} className="hstep">
                <div className="hstep-top">
                  <span className={`g ${GLYPH[s.state]}`} aria-hidden="true" />
                  <span className={s.state === "todo" ? "todo" : undefined}>{s.name}</span>
                  <span className="sr-only">, {SAID[s.state]}</span>
                  {i < view.steps.length - 1 && <span className="hstep-line" aria-hidden="true" />}
                </div>
                <span className="hstep-d">{s.figure === "" ? " " : s.figure}</span>
                {s.meter !== undefined && (
                  <span
                    className="meter"
                    role="img"
                    aria-label={`${Math.round(s.meter * 100)}% of the engine uploaded`}
                  >
                    <span style={{ width: `${s.meter * 100}%` }} />
                  </span>
                )}
              </li>
            ))}
          </ol>
          {view.uploading && (
            <p className="hint">
              You can close ICMM. The next connect picks up the upload where it stopped.
            </p>
          )}
          {view.handingOver !== undefined && <p className="hint">{view.handingOver}</p>}
        </div>
      );
    case "failure":
      return <FailureStrip view={view} {...actions} />;
    case "host_unknown":
      return <UnknownKey host={view.host} hostKey={view.key} forgot={view.forgot} {...actions} />;
    case "key_question":
      return <AskForKey ask={view.ask} {...actions} />;
    case "host_changed":
      return (
        <ChangedKey
          // A new question starts closed.
          key={view.recorded.fingerprint}
          host={view.host}
          hostKey={view.key}
          recorded={view.recorded}
          {...actions}
        />
      );
    case "reconnecting":
      return (
        <div className="strip">
          <div className="strip-say">
            <div className="strip-say" role="status">
              {/* A new node per attempt, so a try that fails the same way is announced too. */}
              <span key={view.attempt} className="strip-sentence">
                {view.sentence}
              </span>
              {view.hint !== undefined && <span className="hint">{view.hint}</span>}
            </div>
            <span className="strip-facts">
              {view.next !== null ? (
                <>
                  Next try in <span className="n">{view.next}</span> s
                </>
              ) : (
                <>
                  Trying again now
                  {view.step !== null && (
                    <>
                      {" "}
                      · {view.step.name} · <Figures text={view.step.soFar} /> so far
                    </>
                  )}
                </>
              )}{" "}
              · attempt <span className="n">{view.attempt}</span>
            </span>
          </div>
          <div className="strip-actions">
            <RetryNow trying={view.next === null} onRetry={actions.onRetry} />
          </div>
        </div>
      );
  }
}

/**
 * A failed connect: its three lines, its fixes and Retry now. ICMM's own
 * problem's fix is Report a problem…, whose panel opens under the strip
 * (#126).
 */
function FailureStrip({
  view,
  ...actions
}: { view: Extract<StripView, { kind: "failure" }> } & StripActions) {
  const report = useReport({
    failure: { what: view.sentence, next: view.next ?? null, raw: view.details ?? null },
  });
  const buttons = view.fixes.length > 0 || view.retry;
  return (
    <>
      <div className={report.open ? "strip bad open" : "strip bad"} role="alert">
        <div className="strip-say failure">
          <p className="strip-sentence">{view.sentence}</p>
          {view.next !== undefined && <p className="strip-next">{view.next}</p>}
          {view.details !== undefined && <p className="term strip-raw">{view.details}</p>}
          {report.sentence}
        </div>
        {buttons && (
          <div className="strip-actions">
            {view.fixes.map((fix) =>
              fix === "report" ? (
                <Fragment key={fix}>{report.button}</Fragment>
              ) : (
                <FixButton key={fix} fix={fix} {...actions} />
              ),
            )}
            {view.retry && <RetryNow trying={false} onRetry={actions.onRetry} />}
          </div>
        )}
      </div>
      {report.panel}
    </>
  );
}

/** A duration with its numbers set as figures: "1 min 4 s". */
function Figures({ text }: { text: string }) {
  return text.split(/(\d+)/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="n">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Retry now: gray from the press until the connect's next state. While a
 * reconnect's attempt runs it stays put, so it keeps focus, but says why it
 * waits.
 */
function RetryNow({ trying, onRetry }: { trying: boolean; onRetry: () => void }) {
  const b = useBlocker(trying ? "It’s trying now" : undefined);
  const pressed = usePressed({ button: "retry" });
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        {...b.props}
        {...grayProps(pressed)}
        onClick={(e) => {
          b.props.onClick(e);
          if (!trying && !pressed) onRetry();
        }}
      >
        Retry now
      </button>
      {b.bubble}
    </>
  );
}

function FixButton({
  fix,
  onEdit,
  onSetUpKey,
  thisComputer,
  onUseThisComputer,
}: { fix: ConnectFix } & StripActions) {
  switch (fix) {
    case "set_up_key":
      return (
        <button type="button" className="btn btn-sm" onClick={onSetUpKey}>
          Set up a key…
        </button>
      );
    case "add_key_again":
      return (
        <button type="button" className="btn btn-sm" onClick={onSetUpKey}>
          Add the key again…
        </button>
      );
    case "edit_platform":
      return (
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Edit platform
        </button>
      );
    case "use_this_computer":
      return thisComputer === undefined ? null : (
        <UseThisComputer id={thisComputer} onUse={onUseThisComputer} />
      );
    // `FailureStrip` draws Report a problem…, with its panel.
    case "report":
      return null;
  }
}

/** A Connect to This computer: gray from the press until its connect shows. */
function UseThisComputer({ id, onUse }: { id: string; onUse: () => void }) {
  const pressed = usePressed({ button: "connect", platformId: id });
  return (
    <button
      type="button"
      className="btn btn-sm"
      {...grayProps(pressed)}
      onClick={() => {
        if (!pressed) onUse();
      }}
    >
      Use this computer instead
    </button>
  );
}

/**
 * Focuses `heading` once, when the strip appears, unless the user is busy
 * elsewhere on the page: in another field, say.
 */
function useFocusOnArrival(heading: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const now = document.activeElement;
    const card = heading.current?.closest("article");
    if (now === null || now === document.body || card?.contains(now)) heading.current?.focus();
  }, [heading]);
}

/**
 * A key known_hosts hasn't seen: trust it and the connect goes on, or cancel
 * it. After Forget the old key, it's the host's new key.
 */
function UnknownKey({
  host,
  hostKey,
  forgot,
  onCancel,
  onTrust,
}: { host: string; hostKey: KeyView; forgot: boolean } & StripActions) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading);
  /** Gray from the press until the connect goes on. */
  const trusting = usePressed({ button: "trust" });
  return (
    <div
      className="strip ask stacked keyed"
      role="alertdialog"
      aria-labelledby={`${id}-h`}
      aria-describedby={`${id}-b`}
    >
      <div className="strip-row">
        <div className="strip-say">
          <h4 id={`${id}-h`} ref={heading} tabIndex={-1}>
            {forgot ? `Trust the new key for ${host}?` : `First connection to ${host}`}
          </h4>
          <p id={`${id}-b`}>
            {forgot
              ? "ICMM forgot the old key. If your cluster publishes its fingerprint, check that this one matches."
              : "This computer hasn’t seen the host’s key before. If your cluster publishes its fingerprint, check that they match."}{" "}
            Trusting adds it to <span className="mono">~/.ssh/known_hosts</span>.
          </p>
        </div>
        <div className="strip-actions">
          <button type="button" className="btn-text btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            {...grayProps(trusting)}
            onClick={() => {
              if (!trusting) onTrust(hostKey.fingerprint);
            }}
          >
            Trust and connect
          </button>
        </div>
      </div>
      {/* Under the row, across the strip, so a fingerprint reads whole even beside the buttons. */}
      <dl className="fpt">
        <dt>{hostKey.algorithm}</dt>
        <dd className="fp">{hostKey.fingerprint}</dd>
      </dl>
    </div>
  );
}

/**
 * A key that changed: the connect stopped before signing in. Forgetting the
 * old key confirms inline first; then the connect starts over and asks about
 * the new one.
 */
function ChangedKey({
  host,
  hostKey,
  recorded,
  onForget,
  onCancel,
}: { host: string; hostKey: KeyView; recorded: RecordedKey } & StripActions) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string>();
  /** Set while a forget is on its way: a second click forgets nothing more. */
  const forgetting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLSpanElement>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  useFocusOnArrival(heading);

  const ask = () => {
    setConfirming(true);
    setTimeout(() => confirmHeading.current?.focus());
  };
  const keep = () => {
    setConfirming(false);
    setFailed(undefined);
    setTimeout(() => forgetButton.current?.focus());
  };
  const forget = () => {
    if (forgetting.current) return;
    forgetting.current = true;
    setFailed(undefined);
    onForget(recorded.fingerprint)
      .catch((e: unknown) => setFailed(String(e)))
      .finally(() => (forgetting.current = false));
  };

  return (
    <div className="strip bad stacked keyed" role="alert" aria-labelledby={`${id}-h`}>
      <div className="strip-row">
        <div className="strip-say">
          <h4 id={`${id}-h`} ref={heading} tabIndex={-1}>
            {host} has a different host key
          </h4>
          <p>
            This happens when a cluster is reinstalled, or when someone intercepts the connection.
            ICMM stopped before signing in. If you didn’t expect it, ask your cluster’s admins
            before you go on.
          </p>
        </div>
        {!confirming && (
          <div className="strip-actions">
            <button type="button" className="btn-text btn-sm" onClick={onCancel}>
              Not now
            </button>
            <button type="button" className="btn btn-sm" ref={forgetButton} onClick={ask}>
              Forget the old key…
            </button>
          </div>
        )}
      </div>
      {/* Under the row, across the strip: fingerprints read whole, one above the other. */}
      <div className="fpk">
        <dl className="fpt">
          <dt>Recorded</dt>
          <dd className="fp">{recorded.fingerprint}</dd>
          <dt>Now</dt>
          <dd className="fp">{hostKey.fingerprint}</dd>
        </dl>
        <p className="hint">
          {recorded.algorithm === hostKey.algorithm
            ? `Both ${recorded.algorithm}`
            : `${recorded.algorithm} recorded, ${hostKey.algorithm} now`}{" "}
          · the recorded one is line <span className="n">{recorded.line}</span> of{" "}
          <span className="mono">{recorded.file}</span>
        </p>
      </div>
      {confirming && (
        <div
          className="strip-confirm"
          role="alertdialog"
          aria-labelledby={`${id}-fh`}
          aria-describedby={`${id}-fb`}
        >
          <div className="strip-say">
            <span id={`${id}-fh`} className="confirm-title" ref={confirmHeading} tabIndex={-1}>
              Forget the old key?
            </span>
            <span id={`${id}-fb`} className="ink-2">
              ICMM removes line <span className="n">{recorded.line}</span> from{" "}
              <span className="mono">{recorded.file}</span>. Then it shows you the key the host has
              now, to trust or not.
            </span>
            {failed !== undefined && (
              <span className="field-issue" role="alert">
                {failed}
              </span>
            )}
          </div>
          <div className="strip-actions">
            <button type="button" className="btn btn-sm" onClick={keep}>
              Keep it
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={forget}>
              Forget the old key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * No key got through: add ICMM's key with the password, used once, or choose
 * a key the cluster accepts. A wrong password empties the field and takes
 * focus there, saying why; a cluster that takes no password gets ICMM's
 * public line to add by hand instead.
 */
function AskForKey({ ask, onCancel, onAddKey, onUseKey }: { ask: KeyAskView } & StripActions) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useFocusOnArrival(heading);
  const working = useWorking();
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState<string>();
  /** Counts wrong passwords: each one moves focus to the field. */
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (tries > 0) field.current?.focus();
  }, [tries]);
  const keys = useSshKeys().data?.keys;
  const [chosen, setChosen] = useState<string>();
  // Not one the host just refused, nor ICMM's, which Retry now and the
  // password are for.
  const fresh = keys?.find((k) => k !== ICMM_KEY && !ask.tried.includes(k));
  const key = chosen ?? fresh ?? "";
  const noKey = useBlocker(key === "" ? "Choose a key file first" : undefined);
  /** Why the key the user chose, or ICMM's, can't be used. */
  const [keyIssue, setKeyIssue] = useState<{ on: "own" | "icmm"; says: string }>();
  const pub = useRef<HTMLElement>(null);

  /** Each connects again, gray until its steps show. */
  const retrying = usePressed({ button: "retry" });
  const using = usePressed({ button: "use_key" });
  const use = (on: "own" | "icmm", file: string) => {
    setKeyIssue(undefined);
    press({ button: on === "icmm" ? "retry" : "use_key" }, () => onUseKey(file)).catch(
      (says: unknown) => setKeyIssue({ on, says: String(says) }),
    );
  };

  /** For 2 s after each copy, Copy says ✓ Copied; another press starts the 2 s again. */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const showCopied = () => {
    clearTimeout(copiedTimer.current);
    setCopied(true);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  };
  const copy = () => {
    // Where the clipboard can't be written, the line is selected to copy by hand.
    const select = () => {
      if (pub.current !== null) window.getSelection()?.selectAllChildren(pub.current);
    };
    const written = navigator.clipboard?.writeText(ask.publicKey ?? "");
    if (written === undefined) select();
    else written.then(showCopied, select);
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (working.busy()) return;
    // An empty one would only count against the host's wrong tries.
    if (password === "") {
      setWrong("Enter your password.");
      setTries((n) => n + 1);
      return;
    }
    setWrong(undefined);
    working
      .run(() => onAddKey(password))
      .catch((message: unknown) => {
        setPassword("");
        setWrong(String(message));
        setTries((n) => n + 1);
      });
  };

  return (
    <div
      className="strip ask kform"
      role="alertdialog"
      aria-labelledby={`${id}-h`}
      aria-describedby={`${id}-b`}
    >
      <div className="ktop">
        <div>
          <h4 id={`${id}-h`} ref={heading} tabIndex={-1}>
            {ask.title}
          </h4>
          <p id={`${id}-b`}>{ask.body}</p>
        </div>
        <BesideButton
          working={working}
          type="button"
          className="btn-text btn-sm"
          onClick={onCancel}
        >
          Cancel
        </BesideButton>
      </div>
      <div className="paths">
        {ask.password ? (
          <form className="path" aria-labelledby={`${id}-mk`} onSubmit={add} noValidate>
            <h5 id={`${id}-mk`}>
              {ask.offer.title} <span className="hint">· recommended</span>
            </h5>
            <p className="hint">{ask.offer.body}</p>
            <div className="field">
              <label htmlFor={`${id}-pw`} className="flabel">
                Password for <span className="mono">{ask.user}</span>
              </label>
              <input
                id={`${id}-pw`}
                ref={field}
                className="input"
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                value={password}
                // Read-only rather than disabled, so a press of Enter here keeps focus.
                readOnly={working.shown}
                aria-disabled={working.shown || undefined}
                aria-invalid={wrong !== undefined || undefined}
                aria-describedby={wrong !== undefined ? `${id}-pw-issue` : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
              {wrong !== undefined && (
                <p id={`${id}-pw-issue`} className="field-issue">
                  {wrong}
                </p>
              )}
            </div>
            <div className="path-foot">
              <WorkingButton
                working={working}
                words="Adding key…"
                type="submit"
                className="btn btn-primary"
              >
                {ask.offer.button}
              </WorkingButton>
            </div>
          </form>
        ) : (
          <div className="path" role="group" aria-labelledby={`${id}-mk`}>
            <h5 id={`${id}-mk`}>
              {ask.offer.title} <span className="hint">· recommended</span>
            </h5>
            <p className="hint">
              {ask.host} doesn’t take passwords, so ICMM can’t add the key itself. It made one here:
              add this line to <span className="mono">~/.ssh/authorized_keys</span> there, or email
              it to your cluster’s admins. It’s the public half of the key, so it’s safe to share.
              Then retry.
            </p>
            {ask.publicKey !== null && (
              <div className="pub">
                <code ref={pub}>{ask.publicKey}</code>
                <button type="button" className="btn btn-sm" onClick={copy}>
                  {copied ? <CopiedIcon /> : <CopyIcon />}
                  <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
            )}
            {keyIssue?.on === "icmm" && (
              <p className="field-issue" role="alert">
                {keyIssue.says}
              </p>
            )}
            <div className="path-foot">
              <button
                type="button"
                className="btn btn-primary"
                {...grayProps(retrying)}
                onClick={() => use("icmm", ICMM_KEY)}
              >
                Retry now
              </button>
            </div>
          </div>
        )}
        <div className="path" role="group" aria-labelledby={`${id}-own`}>
          <h5 id={`${id}-own`}>Use a key I have</h5>
          <p className="hint">
            A key file the cluster already accepts. One with a passphrase works once it’s in{" "}
            <span className="mono">ssh-agent</span>.
          </p>
          <div className="field">
            <label htmlFor={`${id}-key`} className="flabel">
              SSH key
            </label>
            <SshKeySelect
              id={`${id}-key`}
              className="input mono"
              value={key}
              onChange={(k) => {
                setChosen(k);
                setKeyIssue(undefined);
              }}
              aria-invalid={keyIssue?.on === "own" || undefined}
              aria-describedby={keyIssue?.on === "own" ? `${id}-key-issue` : undefined}
            />
            {keyIssue?.on === "own" && (
              <p id={`${id}-key-issue`} className="field-issue">
                {keyIssue.says}
              </p>
            )}
          </div>
          <div className="path-foot">
            <BesideButton
              working={working}
              type="button"
              className="btn"
              {...noKey.props}
              {...grayProps(using)}
              onClick={(e) => {
                noKey.props.onClick(e);
                if (key !== "") use("own", key);
              }}
            >
              Connect with this key
            </BesideButton>
            {noKey.bubble}
          </div>
        </div>
      </div>
    </div>
  );
}

/** How long Copy says Copied. */
export const COPIED_FOR_MS = 2000;

function CopiedIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.2 6.4 4.8 9 9.8 3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 10V3.5a1 1 0 0 1 1-1H10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
