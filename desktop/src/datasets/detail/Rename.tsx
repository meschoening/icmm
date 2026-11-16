/**
 * Rename on Dataset detail (#146; LaptopDatasetDetail views rename, taken,
 * stale and copy): the name becomes a field with Cancel and Save. Under it,
 * whether the name is free (the platform's names, ignoring case), the
 * agent's sentence for one it won't take, and the rules. Save saves a new
 * revision under the new name, and stays grayed while the name is taken or
 * another computer's save waits for Reload.
 *
 * A copy just duplicated opens here, its name selected, and Cancel keeps it.
 */
import { useEffect, useRef, useState } from "react";
import { useDatasetRuns } from "../../runs/queries";
import { renameRunsWords } from "../../runs/words";
import { useBlocker } from "../../ui/blocker";
import { PAGE_HEADING_ATTR } from "../../ui/pageChangeFocus";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import { commands } from "../../wire/api.gen";
import type { SavedDataset } from "../../wire/types.gen";
import { named, useDatasetIssues, useDatasets } from "../queries";
import type { DatasetWrite } from "./write";

/** The rules for a name, as the field's hint says them. */
export const NAME_RULES = "Letters, digits, ., - and _, up to 64.";

/** The agent's sentence for a name another dataset has, which the platform's list already says. */
const TAKEN = "Another dataset already has this name.";

export function Rename({
  base,
  platform,
  copyOf,
  stale,
  write,
  onCancel,
  onSaved,
  onConflict,
  onTyped,
}: {
  /** The revision the rename started from, or was reloaded to. */
  base: SavedDataset;
  platform: string;
  /** The dataset this one is a copy of, by name, when it was just duplicated. */
  copyOf: string | undefined;
  /** Another computer saved since `base`: Save waits for Reload. */
  stale: boolean;
  write: DatasetWrite;
  onCancel: () => void;
  onSaved: (saved: SavedDataset) => void;
  /** A save met another computer's. */
  onConflict: () => void;
  /** The name as typed, for the leave question. */
  onTyped: (name: string) => void;
}) {
  const [typed, setTyped] = useState(base.content.name);
  const field = useRef<HTMLInputElement>(null);
  const datasets = useDatasets();
  const changed = typed !== base.content.name;
  const content = { ...base.content, name: typed };
  const checked = useDatasetIssues(changed ? content : null, base.id);
  const clash = datasets.data === undefined ? undefined : named(datasets.data, typed);
  const taken = changed && clash !== undefined && clash.id !== base.id ? clash : undefined;
  const nameIssue = checked.current
    ? checked.issues?.find((i) => i.path.length === 1 && i.path[0] === "name")
    : undefined;
  const ruleIssue =
    changed && taken === undefined && nameIssue !== undefined && nameIssue.message !== TAKEN
      ? nameIssue.message
      : undefined;
  const free =
    changed && taken === undefined && ruleIssue === undefined && datasets.data !== undefined;
  const save = useBlocker(
    taken !== undefined || ruleIssue !== undefined
      ? "Choose a free name"
      : stale
        ? "Reload first"
        : undefined,
  );

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  useEffect(() => onTyped(typed), [typed, onTyped]);

  const submit = async () => {
    if (!changed) {
      onCancel();
      return;
    }
    const done = await write.run(
      { id: base.id, revision: base.revision, content },
      (key) =>
        commands.save_dataset({
          request_key: key,
          id: base.id,
          expected_revision: base.revision,
          content,
        }),
      { content },
    );
    if (done.ok) {
      onSaved({
        ...base,
        revision: done.value.revision,
        modified_at: new Date().toISOString(),
        content,
      });
    } else if (done.code === "conflict") {
      onConflict();
    } else if (done.code === "invalid") {
      write.setMessage(done.issues[0]?.message);
    }
  };

  const runs = useDatasetRuns(base.id);
  const hint =
    copyOf !== undefined
      ? `A copy of ${copyOf}, saved as ${base.content.name}. Name it now, or Cancel to keep this name. ${NAME_RULES}`
      : `${NAME_RULES}${renameRunsWords(runs)}`;
  const bad = taken !== undefined || ruleIssue !== undefined;
  return (
    <div className="ds-rename">
      <h1 className="sr-only">{base.content.name}</h1>
      <div className="ds-rename-row">
        <label htmlFor="ds-rename" className="sr-only">
          New name for {base.content.name}
        </label>
        <input
          id="ds-rename"
          ref={field}
          className={`input ds-rename-input${bad ? " bad" : ""}`}
          value={typed}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={bad || undefined}
          aria-describedby="ds-rename-h"
          // A copy opens here on a page change, which focuses the page's heading: this field.
          {...(copyOf !== undefined ? { [PAGE_HEADING_ATTR]: "" } : {})}
          onFocus={(e) => {
            if (copyOf !== undefined && !changed) e.currentTarget.select();
          }}
          onChange={(e) => {
            if (!write.working.busy()) setTyped(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (save.props["aria-disabled"] === undefined) void submit();
            } else if (e.key === "Escape" && !write.working.busy()) {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <span className="ds-rename-acts">
          <BesideButton
            type="button"
            className="btn btn-sm"
            working={write.working}
            onClick={onCancel}
          >
            Cancel
          </BesideButton>
          <WorkingButton
            type="button"
            className="btn btn-sm btn-primary"
            working={write.working}
            words="Saving…"
            {...save.props}
            onClick={(e) => {
              save.props.onClick(e);
              if (save.props["aria-disabled"] === undefined) void submit();
            }}
          >
            Save
          </WorkingButton>
          {save.bubble}
        </span>
      </div>
      {free && (
        <span className="ok" role="status">
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1.5 5.2 4 7.5l4.5-5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span>
            <span className="mono ink">{typed}</span> is free.
          </span>
        </span>
      )}
      {taken !== undefined && (
        <p className="err" role="alert">
          {platform} already has a dataset named <span className="mono">{taken.name}</span>. Names
          are unique ignoring case.
        </p>
      )}
      {ruleIssue !== undefined && (
        <p className="err" role="alert">
          {ruleIssue}
        </p>
      )}
      {write.message !== undefined && (
        <p className="err" role="alert">
          {write.message}
        </p>
      )}
      <span id="ds-rename-h" className="hint">
        {hint}
      </span>
    </div>
  );
}
