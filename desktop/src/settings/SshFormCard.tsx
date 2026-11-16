/**
 * The add and edit form for an SSH platform, inline in its card
 * (LaptopPlatformForm). Add has one primary, "Add and connect", and can be
 * filled in from `~/.ssh/config`. A platform filled in from a host that
 * jumps through others keeps that route, which Edit shows under the Login
 * host; changing the Login host or port drops it. Editing counts the
 * unsaved changes, and says when saving reconnects. Remove confirms in a
 * strip that replaces the footer. The desktop checks the fields; each issue
 * shows under its field.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Connection } from "../shell/connection";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import type { SshPlatform } from "../wire/types.gen";
import { failureOf, type Failure, usePlatformCommands, useSshKeys } from "./commands";
import { FillFromSshConfig, Route } from "./FillFromSshConfig";
import { FormStatus } from "./PlatformCard";
import { SshKeySelect } from "./SshKeySelect";
import {
  changedFields,
  type Field,
  fieldsOf,
  filledIn,
  jumpFor,
  ORDER,
  routeFrom,
  routeOf,
  shownKey,
  WIRE,
} from "./sshFields";

export interface SshFormCardProps {
  /** The platform to edit; `undefined` adds one. */
  platform?: SshPlatform;
  /** Its connection when it's the Active platform. */
  connection?: Connection;
  /** The Active platform while it's connected or trying to be, for Add's warning. */
  liveElsewhere?: string;
  /** ICMM connects to it when it opens, which removing it ends. */
  launch?: boolean;
  onDirty: (changes: number) => void;
  onCancel: () => void;
  /** Saved; for Add, the new platform's id. */
  onSaved: (id: string) => void;
  onRemoved: () => void;
  /**
   * "Its runs keep going." after "Saving reconnects."; First launch leaves
   * it out, since setup comes before any run.
   */
  keepGoing?: boolean;
  /**
   * First launch after a failed first connect: Save and connect. It retries
   * after the edit; when the edit already restarted the connect, the retry
   * finds it under way and leaves it.
   */
  connects?: () => Promise<unknown>;
}

export function SshFormCard({
  platform,
  connection,
  liveElsewhere,
  launch = false,
  onDirty,
  onCancel,
  onSaved,
  onRemoved,
  keepGoing = true,
  connects,
}: SshFormCardProps) {
  const adding = platform === undefined;
  const idp = useId();
  const commands = usePlatformCommands();
  const keys = useSshKeys();
  const [was] = useState(() => fieldsOf(platform));
  const [f, setF] = useState(was);
  const [route, setRoute] = useState(() => routeOf(platform));
  const [filledFrom, setFilledFrom] = useState<string>();
  const [advanced, setAdvanced] = useState(false);
  const [failure, setFailure] = useState<Failure>({
    fields: {},
    message: undefined,
  });
  const saving = useWorking();
  const removal = useWorking();
  const [removing, setRemoving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const removeHeading = useRef<HTMLSpanElement>(null);

  useEffect(() => first.current?.focus(), []);

  const found = keys.data?.keys;
  /** The key to show and send. */
  const key = shownKey(f.key, found);

  const jump = jumpFor(f, route);
  // Edit changes the route only by changing the host or port, which count already.
  const changes = changedFields(f, was);
  /** The changes an edit marks; Add has nothing to compare with. */
  const changed = adding ? [] : changes;
  useEffect(() => onDirty(changes.length), [onDirty, changes.length]);

  const live = connection !== undefined && connection.status !== "not_connected";
  const reconnects = live && changed.some((c) => c !== "name");

  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((now) => ({ ...now, [field]: e.target.value }));

  const save = async () => {
    const form = {
      type: "ssh" as const,
      name: f.name,
      host: f.host,
      port: f.port,
      user: f.user,
      identity_file: key === "" ? null : key,
      data_folder: f.data,
      jump,
    };
    try {
      if (adding) {
        onSaved((await saving.run(() => commands.add(form))).id);
      } else {
        const id = platform.id;
        await saving.run(async () => {
          await commands.edit(id, form);
          // An edit that restarted the connect leaves the retry nothing to do.
          if (connects !== undefined) await connects();
        });
        onSaved(id);
      }
    } catch (error) {
      const failed = failureOf(error);
      setFailure(failed);
      if (failed.fields[WIRE.data] !== undefined) setAdvanced(true);
      const at = ORDER.find((field) => failed.fields[WIRE[field]] !== undefined);
      if (at !== undefined) {
        // After the Advanced section opens.
        setTimeout(() => document.getElementById(`${idp}-${at}`)?.focus());
      }
    }
  };

  const remove = async () => {
    if (platform === undefined) return;
    const id = platform.id;
    try {
      await removal.run(() => commands.remove(id));
      onRemoved();
    } catch (error) {
      setFailure(failureOf(error));
      keepIt();
    }
  };

  const startRemoving = () => {
    setRemoving(true);
    setTimeout(() => removeHeading.current?.focus());
  };
  const keepIt = () => {
    setRemoving(false);
    setTimeout(() => removeButton.current?.focus());
  };

  /** A field's props: its id, its issue and whether it changed. */
  const field = (name: Field, className: string) => {
    const issue = failure.fields[WIRE[name]];
    return {
      id: `${idp}-${name}`,
      className: [className, changed.includes(name) ? "dirty" : ""].filter(Boolean).join(" "),
      "aria-invalid": issue !== undefined ? true : undefined,
      "aria-describedby": issue !== undefined ? `${idp}-${name}-issue` : undefined,
    };
  };
  const issue = (name: Field) => {
    const text = failure.fields[WIRE[name]];
    return text === undefined ? null : (
      <span className="field-issue" id={`${idp}-${name}-issue`}>
        {text}
      </span>
    );
  };

  const title = adding ? "New compute platform" : `Edit ${platform.name}`;

  return (
    <article className="surface-card editing" aria-labelledby={`${idp}-h`}>
      <div className={adding ? "form-head" : "form-head row"}>
        <h3 id={`${idp}-h`} tabIndex={-1}>
          {title}
        </h3>
        {adding ? (
          <p className="hint">Any cluster or workstation you can reach over SSH.</p>
        ) : connection !== undefined ? (
          <FormStatus connection={connection} kind="ssh" />
        ) : null}
      </div>
      <form
        className="platform-form"
        aria-labelledby={`${idp}-h`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {adding && (
          <FillFromSshConfig
            id={`${idp}-cfg`}
            filledFrom={filledFrom}
            jump={jump}
            layout="beside"
            onFill={(alias, host) => {
              setF((now) => filledIn(now, alias, host));
              setRoute(routeFrom(host));
              setFilledFrom(alias);
            }}
          />
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${idp}-name`} className="flabel">
              Name
            </label>
            <input
              ref={first}
              {...field("name", "input")}
              type="text"
              placeholder="Lab cluster"
              value={f.name}
              onChange={set("name")}
            />
            {issue("name")}
          </div>
          <div className="field">
            <label htmlFor={`${idp}-host`} className="flabel">
              Login host
            </label>
            <input
              {...field("host", "input mono")}
              type="text"
              placeholder="login.cluster.example.edu"
              spellCheck={false}
              autoCapitalize="off"
              value={f.host}
              onChange={set("host")}
            />
            {issue("host")}
            {!adding && jump.length > 0 && (
              <span className="hint">
                It connects through <Route jump={jump} /> first.
              </span>
            )}
            {failure.fields.jump !== undefined && (
              <span className="field-issue">{failure.fields.jump}</span>
            )}
          </div>
          <div className="field port">
            <label htmlFor={`${idp}-port`} className="flabel">
              Port
            </label>
            <input
              {...field("port", "input mono")}
              type="text"
              inputMode="numeric"
              value={f.port}
              onChange={set("port")}
            />
            {issue("port")}
          </div>
          <div className="field">
            <label htmlFor={`${idp}-user`} className="flabel">
              Username
            </label>
            <input
              {...field("user", "input mono")}
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              value={f.user}
              onChange={set("user")}
            />
            {issue("user")}
          </div>
          <div className="field span-2">
            <label htmlFor={`${idp}-key`} className="flabel">
              SSH key
            </label>
            <SshKeySelect
              {...field("key", "input mono")}
              value={key}
              onChange={(k) => setF((now) => ({ ...now, key: k }))}
            />
            {issue("key")}
          </div>
          <p className="hint key-hint">
            Keys in <span className="mono nowrap">ssh-agent</span> are tried first, then this one.
            If none works, ICMM can make one.
          </p>
        </div>
        <div className="advanced">
          <div className="advanced-row">
            <button
              type="button"
              className="disc"
              aria-expanded={advanced}
              aria-controls={`${idp}-adv`}
              onClick={() => setAdvanced((a) => !a)}
            >
              <Chevron open={advanced} />
              Advanced
            </button>
            {!advanced && (
              <span className="hint">
                Data folder <span className="mono ink-2">{f.data}</span>
              </span>
            )}
          </div>
          {advanced && (
            <div id={`${idp}-adv`} className="advanced-grid">
              <div className="field">
                <label htmlFor={`${idp}-data`} className="flabel">
                  Data folder
                </label>
                <input
                  {...field("data", "input mono")}
                  type="text"
                  spellCheck={false}
                  value={f.data}
                  onChange={set("data")}
                />
                {issue("data")}
              </div>
              <p className="hint beside-field">
                {!adding && changed.includes("data") ? (
                  <>
                    <span className="ink">Changed</span> · was{" "}
                    <span className="mono">{was.data}</span>. You’ll see the datasets, configs and
                    runs in the new folder. Nothing is moved, and{" "}
                    <span className="mono">{was.data}</span> stays as it is.
                  </>
                ) : adding ? (
                  "Where the platform keeps its datasets, configs, Platform settings and runs. A folder another computer already set up connects straight in."
                ) : (
                  "Where the platform keeps its datasets, configs, Platform settings and runs."
                )}
              </p>
            </div>
          )}
        </div>
        {/* Enter in a field submits. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
      {removing && platform ? (
        <div
          className="cfoot confirm"
          role="alertdialog"
          aria-labelledby={`${idp}-rm-h`}
          aria-describedby={`${idp}-rm-b`}
        >
          <div className="confirm-text">
            <span id={`${idp}-rm-h`} ref={removeHeading} tabIndex={-1} className="confirm-title">
              Remove {platform.name}?
            </span>
            <span id={`${idp}-rm-b`}>
              {live
                ? "ICMM forgets how to reach it from this computer, and disconnects first. "
                : "ICMM forgets how to reach it from this computer. "}
              Nothing on {platform.name} is deleted: its datasets, configs and runs stay in{" "}
              <span className="mono">{platform.data_folder}</span>
              {live ? ", and runs in progress keep going." : "."}
              {launch && " ICMM won’t connect when it opens until you choose another platform."}
            </span>
          </div>
          <div className="confirm-actions">
            <BesideButton type="button" className="btn btn-sm" working={removal} onClick={keepIt}>
              Keep it
            </BesideButton>
            <WorkingButton
              type="button"
              className="btn btn-sm btn-danger"
              working={removal}
              words="Removing…"
              onClick={() => void remove()}
            >
              Remove platform
            </WorkingButton>
          </div>
        </div>
      ) : (
        <div className="cfoot">
          {!adding && (
            <BesideButton
              type="button"
              className="btn btn-sm"
              ref={removeButton}
              working={saving}
              onClick={startRemoving}
            >
              Remove platform…
            </BesideButton>
          )}
          <span className={adding ? "cfoot-note" : "cfoot-note end"}>
            {failure.message !== undefined ? (
              <span className="field-issue" role="alert">
                {failure.message}
              </span>
            ) : adding ? (
              liveElsewhere !== undefined &&
              `Connecting disconnects ${liveElsewhere}. Its runs keep going.`
            ) : (
              <Unsaved
                count={changed.length}
                after={
                  connects !== undefined
                    ? "Saving connects."
                    : reconnects
                      ? keepGoing
                        ? "Saving reconnects. Its runs keep going."
                        : "Saving reconnects."
                      : undefined
                }
              />
            )}
          </span>
          <BesideButton
            type="button"
            className="btn-text btn-sm"
            working={saving}
            onClick={onCancel}
          >
            Cancel
          </BesideButton>
          <WorkingButton
            type="button"
            className="btn btn-sm btn-primary"
            working={saving}
            words={adding ? "Adding…" : "Saving…"}
            onClick={() => void save()}
          >
            {adding
              ? "Add and connect"
              : connects !== undefined
                ? "Save and connect"
                : reconnects
                  ? "Save and reconnect"
                  : "Save"}
          </WorkingButton>
        </div>
      )}
    </article>
  );
}

/** The unsaved count, and what saving them does. */
export function Unsaved({ count, after }: { count: number; after: string | undefined }) {
  if (count === 0) return null;
  return (
    <>
      <span className="unsaved">
        <span className="g g-unsaved" aria-hidden="true" />
        {count} unsaved {count === 1 ? "change" : "changes"}
      </span>
      {after !== undefined && <span> · {after}</span>}
    </>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d={open ? "M1.5 3.5 5 7l3.5-3.5" : "M3.5 1.5 7 5l-3.5 3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
