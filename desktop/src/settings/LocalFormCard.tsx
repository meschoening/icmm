/**
 * This computer's form: built in, so only its Data folder changes. Choose…
 * opens the OS's folder dialog, gray until it opens.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Connection } from "../shell/connection";
import { grayProps, useSystemDialog } from "../ui/gray";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import type { LocalPlatform } from "../wire/types.gen";
import { failureOf, type Failure, usePlatformCommands } from "./commands";
import { FormStatus } from "./PlatformCard";

export interface LocalFormCardProps {
  platform: LocalPlatform;
  connection?: Connection;
  onDirty: (changes: number) => void;
  onCancel: () => void;
  onSaved: (id: string) => void;
  /** First launch after a failed first connect: Save and connect, as `SshFormCard` has it. */
  connects?: () => Promise<unknown>;
}

export function LocalFormCard({
  platform,
  connection,
  onDirty,
  onCancel,
  onSaved,
  connects,
}: LocalFormCardProps) {
  const idp = useId();
  const commands = usePlatformCommands();
  const [data, setData] = useState(platform.data_folder);
  const [failure, setFailure] = useState<Failure>({
    fields: {},
    message: undefined,
  });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const changed = data.trim() !== platform.data_folder;
  useEffect(() => onDirty(changed ? 1 : 0), [onDirty, changed]);
  const live = connection !== undefined && connection.status !== "not_connected";
  const reconnects = live && changed;
  const issue = failure.fields.data_folder;

  const dialog = useSystemDialog();
  const choose = async () => {
    const chosen = await dialog.open(() =>
      commands.chooseFolder({
        title: "Choose the data folder",
        folder: data,
      }),
    );
    if (chosen.path !== null) setData(chosen.path);
  };

  const saving = useWorking();
  const save = async () => {
    try {
      await saving.run(async () => {
        await commands.edit(platform.id, { type: "local", data_folder: data });
        // An edit that restarted the connect leaves the retry nothing to do.
        if (connects !== undefined) await connects();
      });
      onSaved(platform.id);
    } catch (error) {
      setFailure(failureOf(error));
      input.current?.focus();
    }
  };

  return (
    <article className="surface-card editing" aria-labelledby={`${idp}-h`}>
      <div className="form-head row">
        <h3 id={`${idp}-h`} tabIndex={-1}>
          Edit This computer
        </h3>
        {connection !== undefined && <FormStatus connection={connection} kind="local" />}
        <p className="hint">Built in, so it’s always here. Only its data folder can change.</p>
      </div>
      <form
        className="local-form"
        aria-labelledby={`${idp}-h`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label htmlFor={`${idp}-data`} className="flabel">
            Data folder
          </label>
          <div className="with-button">
            <input
              ref={input}
              id={`${idp}-data`}
              className={`input mono${changed ? " dirty" : ""}`}
              type="text"
              spellCheck={false}
              value={data}
              aria-invalid={issue !== undefined ? true : undefined}
              aria-describedby={issue !== undefined ? `${idp}-issue` : undefined}
              onChange={(e) => setData(e.target.value)}
            />
            <BesideButton
              type="button"
              className="btn"
              working={saving}
              {...grayProps(dialog.gray)}
              onClick={() => void choose()}
            >
              Choose…
            </BesideButton>
          </div>
          {issue !== undefined && (
            <span className="field-issue" id={`${idp}-issue`}>
              {issue}
            </span>
          )}
        </div>
        <p className="hint beside-field">
          Where this computer keeps its datasets, configs, Platform settings and runs. Changing it
          switches which data you see. Nothing is moved.
        </p>
      </form>
      <div className="cfoot">
        <span className="cfoot-note end">
          {failure.message !== undefined ? (
            <span className="field-issue" role="alert">
              {failure.message}
            </span>
          ) : (
            changed &&
            (connects !== undefined ? "Saving connects." : reconnects && "Saving reconnects.")
          )}
        </span>
        <BesideButton type="button" className="btn-text btn-sm" working={saving} onClick={onCancel}>
          Cancel
        </BesideButton>
        <WorkingButton
          type="button"
          className="btn btn-sm btn-primary"
          working={saving}
          words="Saving…"
          onClick={() => void save()}
        >
          {connects !== undefined ? "Save and connect" : reconnects ? "Save and reconnect" : "Save"}
        </WorkingButton>
      </div>
    </article>
  );
}
