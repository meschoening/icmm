/**
 * First launch's step 1 before a connection (LaptopFirstRun's `form`): an SSH
 * platform's Connection details, which `~/.ssh/config` can fill in, Connect,
 * and "Use this computer instead".
 *
 * Connect adds the platform, which connects it; it's gray from the press
 * until the card showing the connect replaces the form. After Cancel or Edit
 * the form holds the SSH platform's details (the Active one, or the one saved
 * before This computer took its place), and Connect saves them over it and
 * connects it rather than adding another.
 */
import { useEffect, useId, useRef, useState } from "react";
import { failureOf, type Failure, usePlatformCommands, useSshKeys } from "../settings/commands";
import { Chevron } from "../settings/SshFormCard";
import { FillFromSshConfig } from "../settings/FillFromSshConfig";
import { SshKeySelect } from "../settings/SshKeySelect";
import {
  changedFields,
  type Field,
  fieldsOf,
  filledIn,
  jumpFor,
  ORDER,
  routeFrom,
  routeOf,
  sameRoute,
  shownKey,
  WIRE,
} from "../settings/sshFields";
import { getConnection } from "../shell/connection";
import { grayProps } from "../ui/gray";
import type { SshPlatform } from "../wire/types.gen";

export interface ConnectFormProps {
  /** The SSH platform whose details to edit; `undefined` adds a platform. */
  platform: SshPlatform | undefined;
  /** After Cancel: its disconnect, which lands before Connect does anything. */
  leaving?: Promise<unknown>;
  /** This computer's id, for "Use this computer instead". */
  localId: string;
  /** Puts focus in Name, when the form replaces the card the user was on. */
  focusFirst: boolean;
  /** The connect to platform `id` started: the card takes the form's place. */
  onConnecting: (id: string) => void;
  /** What opens the card: why the saved platforms couldn't be read. */
  note?: React.ReactNode;
}

export function ConnectForm({
  platform,
  leaving,
  localId,
  focusFirst,
  onConnecting,
  note,
}: ConnectFormProps) {
  const idp = useId();
  const commands = usePlatformCommands();
  const keys = useSshKeys();
  const [f, setF] = useState(() => fieldsOf(platform));
  const [route, setRoute] = useState(() => routeOf(platform));
  const [filledFrom, setFilledFrom] = useState<string>();
  const [advanced, setAdvanced] = useState(false);
  const [failure, setFailure] = useState<Failure>({ fields: {}, message: undefined });
  /** Set from an action's press: its progress shows in the card that replaces the form. */
  const saving = useRef(false);
  /** Connect is gray from its press until that card shows, or the action fails. */
  const [connecting, setConnecting] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusFirst) first.current?.focus();
  }, [focusFirst]);

  const found = keys.data?.keys;
  const key = shownKey(f.key, found);

  const jump = jumpFor(f, route);

  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((now) => ({ ...now, [field]: e.target.value }));

  /**
   * Runs one action at a time, and shows what it said if it failed. One that
   * worked leaves the form taking no more, until the card replaces it.
   */
  const act = async (action: () => Promise<string>, pressed?: (on: boolean) => void) => {
    if (saving.current) return;
    saving.current = true;
    pressed?.(true);
    setFailure({ fields: {}, message: undefined });
    try {
      onConnecting(await action());
    } catch (error) {
      saving.current = false;
      pressed?.(false);
      const failed = failureOf(error);
      setFailure(failed);
      if (failed.fields[WIRE.data] !== undefined) setAdvanced(true);
      const at = ORDER.find((field) => failed.fields[WIRE[field]] !== undefined);
      if (at !== undefined) setTimeout(() => document.getElementById(`${idp}-${at}`)?.focus());
    }
  };

  const connect = () =>
    act(async () => {
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
      if (platform === undefined) {
        return (await commands.add(form)).id;
      }
      await leaving;
      const c = getConnection();
      const active = c.status !== "none" && c.platformId === platform.id;
      const moved =
        changedFields(f, fieldsOf(platform)).some((x) => x !== "name") ||
        !sameRoute(jump, platform.jump);
      await commands.edit(platform.id, form);
      // A connection the desktop holds (a failed one too) restarts when how
      // it's reached changed. Otherwise connect it, or retry a failed one.
      if (leaving !== undefined || !active || c.status === "not_connected") {
        await commands.connect(platform.id);
      } else if (c.status === "failed" && !moved) {
        await commands.retry();
      }
      return platform.id;
    }, setConnecting);
  const thisComputer = () =>
    act(async () => {
      await leaving;
      await commands.connect(localId);
      return localId;
    });

  const field = (name: Field, className: string) => {
    const issue = failure.fields[WIRE[name]];
    return {
      id: `${idp}-${name}`,
      className,
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

  return (
    <div className="step-box connect">
      {note}
      <p className="ink-2">
        Any cluster you can reach over SSH, or this computer if you’d rather keep it local.
      </p>
      <form
        className="connect-form"
        aria-label="Connect over SSH"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <div className="connect-grid">
          <div className="span-all fill-block">
            <FillFromSshConfig
              id={`${idp}-cfg`}
              filledFrom={filledFrom}
              jump={jump}
              layout="under"
              onFill={(alias, host) => {
                setF((now) => filledIn(now, alias, host));
                setRoute(routeFrom(host));
                setFilledFrom(alias);
              }}
            />
          </div>
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
              autoComplete="username"
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
          <p className="hint span-all">
            Keys in <span className="mono nowrap">ssh-agent</span> are tried first, then this one.
            If none works, ICMM can make one.
          </p>
          <div className="advanced span-all">
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
                  Data folder on the cluster <span className="mono ink-2">{f.data}</span>
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
                  Where ICMM keeps this platform’s datasets, configs, Platform settings and runs, on
                  the cluster. A folder another computer already set up connects straight in.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="connect-buttons">
          <button type="submit" className="btn btn-primary" {...grayProps(connecting)}>
            Connect
          </button>
          <button type="button" className="btn" onClick={() => void thisComputer()}>
            Use this computer instead
          </button>
        </div>
        {failure.message !== undefined && (
          <p className="field-issue" role="alert">
            {failure.message}
          </p>
        )}
      </form>
      <dl className="then">
        <dt>Then</dt>
        <dd>
          ICMM installs its engine on the cluster the first time, starts and checks its scheduler
          (SLURM). Then it asks where to keep results, and for your job settings: account,
          partition, CPUs and memory per start.
        </dd>
      </dl>
    </div>
  );
}
