/**
 * Platform setup, in the foot of step 1's card (LaptopFirstRun's `setup`,
 * `lookup-failed`, `refused` and `local` views): the Output folder with its
 * free space, then the Job defaults a first run needs, with the rest under
 * Advanced. "Save and continue" writes them for every computer that
 * connects. The scheduler is shown in the sentence, never asked.
 *
 * Focus goes to the heading when setup opens. A failed save puts it in the
 * first field with an issue; a refused folder is that field.
 *
 * Settings opens the same form on the saved settings (`SetupForm`'s `edit`;
 * LaptopSettings's `editing` views): each changed field outlined with what it
 * was, Cancel beside Save, and the two states #82 drew. When another computer
 * saves meanwhile, a note names the fields it changed and offers Reload,
 * which keeps the fields you changed over theirs; then each of theirs says
 * so, and one you both changed says what they saved (#118's U15). A save
 * still on its way when the connection drops locks the form and waits for
 * it, as the desktop sends it again, for up to 3 minutes.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { whole } from "../configs/words";
import { keyFor, unconfirmedWords } from "../requestKey";
import { useRunsOverview } from "../runs/queries";
import { usePlatformCommands } from "../settings/commands";
import { Chevron } from "../settings/SshFormCard";
import { getConnection, useConnection } from "../shell/connection";
import { grayProps, useSystemDialog } from "../ui/gray";
import { useWorking } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { commands } from "../wire/api.gen";
import type {
  SavedPlatform,
  SavedPlatformSettings,
  SchedulerLookup,
  WireError,
} from "../wire/types.gen";
import {
  advancedElsewhere,
  changedFields,
  checkSetup,
  coresLine,
  elsewhereNotice,
  fieldMarks,
  fieldsOf,
  initialFields,
  inSentence,
  issuesOf,
  limitLine,
  menus,
  OUTPUT_SIZE,
  REFUSED_SIZE,
  sameFailure,
  reloaded,
  type SetupField,
  type SetupFields,
  withAccount,
} from "./form";
import { FailureBox } from "./FailureBox";
import { agentKey, useFolderCheck, useReadAgain, useSchedulerLookup } from "./queries";
import { bytes } from "./units";

export interface PlatformSetupProps {
  platform: SavedPlatform;
  /** Saved: the card moves to its summary once the settings are read back. */
  onSaved: () => void;
  /** Another computer saved first: the card shows theirs. */
  onConflict: () => void;
  /** Settings sets up a platform added there: "Save settings", and changed there later. */
  inSettings?: boolean;
  /** Settings tracks initial setup alongside its other forms. */
  tracking?: SetupTracking;
  /** First launch's Connect when ICMM opens row, above Save; not one of the settings. */
  launch?: React.ReactNode;
  /** What was typed before the form last went: First launch's Edit takes the card a while. */
  draft?: SetupDraft;
}

/**
 * Fields typed into Platform setup, kept while the form is away: what the
 * form opened on and what it held, so only the typed fields come back over
 * the next lookup's proposal.
 */
export interface SetupDraft {
  fields: Typed | undefined;
  keep: (typed: Typed | undefined) => void;
}

export interface Typed {
  base: SetupFields;
  fields: SetupFields;
}

export function PlatformSetup({
  platform,
  onSaved,
  onConflict,
  inSettings = false,
  tracking,
  launch,
  draft,
}: PlatformSetupProps) {
  const idp = useId();
  const lookup = useSchedulerLookup(true);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus goes to the heading when setup opens, unless the user is working elsewhere.
  useEffect(() => {
    const at = document.activeElement;
    const idle =
      at === null ||
      at === document.body ||
      at.matches("[data-page-heading]") ||
      at.closest(".fl-one") !== null;
    if (idle) heading.current?.focus();
  }, []);
  const local = platform.type === "local";
  const data = <span className="mono">{platform.data_folder}</span>;
  // An SSH host's lead says what the lookup found there, so it waits for the lookup (#281).
  const found = local ? undefined : lookup.data?.scheduler;

  return (
    <div className="setup">
      <div className="setup-head">
        <h4 id={`${idp}-h`} ref={heading} tabIndex={-1}>
          Set up {inSentence(platform)}
        </h4>
        {local ? (
          <p>
            Runs start here as local processes, and {data} isn’t set up yet.{" "}
            {inSettings ? "You can change these here later." : "Settings can change these later."}
          </p>
        ) : found === "slurm" ? (
          <p>
            {inSettings ? (
              <>
                ICMM found SLURM here, and {data} isn’t set up yet. Every computer that connects
                shares these, and you can change them here later.
              </>
            ) : (
              // One line, so the hints #117 added still leave Save above the fold.
              <>
                ICMM found SLURM here. Every computer that connects to {data} shares these settings.
              </>
            )}
          </p>
        ) : found === "local" ? (
          <p>
            {inSettings ? (
              <>
                ICMM found no SLURM on {platform.name}, so starts run there as processes, and {data}{" "}
                isn’t set up yet. Every computer that connects shares these, and you can change them
                here later.
              </>
            ) : (
              <>
                ICMM found no SLURM on {platform.name}, so starts run there as processes. Every
                computer that connects to {data} shares these settings.
              </>
            )}
          </p>
        ) : null}
      </div>
      {lookup.data !== undefined ? (
        <SetupForm
          headingId={`${idp}-h`}
          lookup={lookup.data}
          platform={platform}
          saveLabel={inSettings ? "Save settings" : "Save and continue"}
          onSaved={onSaved}
          onConflict={onConflict}
          tracking={tracking}
          beforeSave={launch}
          draft={draft}
        />
      ) : (
        <LookupState lookup={lookup} platform={platform} />
      )}
    </div>
  );
}

/**
 * While the lookup is read, a line saying so; if it fails, the box in the
 * form's place, with Try again. Settings' Change settings puts Cancel under
 * it, since the form it would close never opened.
 */
export function LookupState({
  lookup,
  platform,
  onCancel,
}: {
  lookup: ReturnType<typeof useSchedulerLookup>;
  platform: SavedPlatform;
  onCancel?: () => void;
}) {
  const read = useReadAgain(lookup.isError ? lookup.error : undefined, lookup.refetch);
  if (read.failure !== undefined) {
    return (
      <>
        <FailureBox
          error={read.failure}
          task="lookup"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
        {onCancel !== undefined && (
          <div className="lookup-cancel">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </>
    );
  }
  return (
    <Reading>
      {platform.type === "local"
        ? "Reading this computer’s cores…"
        : "Reading your accounts and partitions from SLURM…"}
    </Reading>
  );
}

/** A status line holding a part's place while it's read. */
export function Reading({ children }: { children: React.ReactNode }) {
  return (
    <p className="reading" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {children}
    </p>
  );
}

/** What `was` says in words rather than as a value. */
const WORDS = ["none", "the cluster’s default"];

const ORDER: SetupField[] = [
  "output",
  "account",
  "partition",
  "cpus",
  "memory",
  "time",
  "running",
  "excluded",
  "coordinator",
  "checkEvery",
  "image",
];
const IN_ADVANCED: SetupField[] = ["excluded", "coordinator", "checkEvery", "image"];

/** A menu's options with its value among them, so it shows what Save sends. */
const withValue = (options: string[], value: string) =>
  value === "" || options.includes(value) ? options : [...options, value];

/** Settings tracks either an initial setup or an edit of saved settings. */
export interface SetupTracking {
  /** How many fields differ from what the form opened on. */
  onDirty: (changes: number) => void;
  /** Whether a save is waiting for the connection to come back. */
  onWaiting: (waiting: boolean) => void;
}

/** Settings' edit of saved settings, rather than setup's first save. */
export interface SetupEdit extends SetupTracking {
  /** The settings the form opened on. */
  saved: SavedPlatformSettings;
  /** The settings as the Data folder has them now: newer once another computer saves. */
  latest: SavedPlatformSettings | undefined;
  onCancel: () => void;
}

export interface SetupFormProps {
  headingId: string;
  lookup: SchedulerLookup;
  platform: SavedPlatform;
  saveLabel: string;
  onSaved: () => void;
  /** Platform setup's: another computer saved first. */
  onConflict?: () => void;
  edit?: SetupEdit;
  tracking?: SetupTracking;
  /** What the form opens with: Settings' heading and its hint. */
  head?: React.ReactNode;
  /** A row above Advanced and Save, which takes their rule. */
  beforeSave?: React.ReactNode;
  /** Platform setup's typed fields, kept while the form is away; saving forgets them. */
  draft?: SetupDraft;
}

export function SetupForm({
  headingId,
  lookup,
  platform,
  saveLabel,
  onSaved,
  onConflict,
  edit,
  tracking,
  head,
  beforeSave,
  draft,
}: SetupFormProps) {
  const idp = useId();
  const queries = useQueryClient();
  const desktop = usePlatformCommands();
  const connection = useConnection();
  /** What the edit compares with: the settings it opened on, or reloaded. */
  const [base, setBase] = useState(() =>
    edit === undefined
      ? null
      : { revision: edit.saved.revision, fields: fieldsOf(edit.saved.settings) },
  );
  /** What the edit opened on, before any Reload: what another computer's changes were. */
  const [opened] = useState(() => base?.fields);
  const [initial] = useState(() => initialFields(lookup));
  const [f, setFields] = useState<SetupFields>(() => {
    if (base !== null) return base.fields;
    const typed = draft?.fields;
    return typed === undefined ? initial : reloaded(typed.base, typed.fields, initial);
  });
  const keep = useRef(draft?.keep);
  keep.current = draft?.keep;
  useEffect(() => {
    keep.current?.(changedFields(initial, f).length > 0 ? { base: initial, fields: f } : undefined);
  }, [f, initial]);
  /** The Output folder as last checked: on load, on leaving the field, and on Choose…. */
  const [checked, setChecked] = useState(() => f.output.trim());
  const folder = useFolderCheck(checked);
  const [issues, setIssues] = useState<Partial<Record<SetupField, string>>>({});
  const [message, setMessage] = useState<string | undefined>();
  /** An engine error saving: its box, and when a save last failed the same way. */
  const [saveFailure, setSaveFailure] = useState<{ error: unknown; again?: number }>();
  /** Advanced and Save, kept in view when the box above them pushes them down. */
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (saveFailure === undefined) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    end.current?.scrollIntoView({ block: "nearest", behavior: still ? "instant" : "smooth" });
  }, [saveFailure]);
  const [advanced, setAdvanced] = useState(false);
  /** The runs that keep their Output folder when it changes: only an edit has any (#82). */
  const overview = useRunsOverview(edit !== undefined);
  const earlier = overview.data?.counts;
  const runs =
    earlier === undefined ? 0 : earlier.running + earlier.queued + earlier.held + earlier.ended;
  const saving = useWorking();
  /** The form locks once the save's working state shows. */
  const busy = saving.shown;
  /** From Save's press until its answer, the fields hold what it sends. */
  const setF: typeof setFields = (next) => {
    if (!saving.busy()) setFields(next);
  };
  const request = useRef<{ key: string; body: string } | null>(null);
  /** A save met another computer's: the note stays until Reload. */
  const [stale, setStale] = useState(false);
  const note = useRef<HTMLDivElement>(null);
  const save_ = useRef<HTMLButtonElement>(null);

  const changed = base === null ? [] : changedFields(base.fields, f);
  const marks = base === null || opened === undefined ? {} : fieldMarks(opened, base.fields, f);
  const callbacks = edit ?? tracking;
  const dirtyCount = base === null ? changedFields(initial, f).length : changed.length;
  const waiting = callbacks !== undefined && saving.pending && connection.status !== "connected";
  const waitingShown = waiting && busy;
  const newer =
    edit?.latest !== undefined && base !== null && edit.latest.revision !== base.revision;
  const elsewhere = edit !== undefined && !busy && (stale || newer);
  const told = useRef(callbacks);
  told.current = callbacks;
  useEffect(() => told.current?.onDirty(dirtyCount), [dirtyCount]);
  useEffect(() => told.current?.onWaiting(waiting), [waiting]);
  /** A save's late outcome is the page's business only while the form is open. */
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  /** What a save that couldn't be confirmed sent: it may yet show up as saved. */
  const unconfirmed = useRef<SetupFields | null>(null);
  const latest = edit?.latest;
  useEffect(() => {
    const sent = unconfirmed.current;
    if (sent === null || latest === undefined || base === null) return;
    if (latest.revision === base.revision) return;
    if (changedFields(fieldsOf(latest.settings), sent).length > 0) return;
    // The save landed and only its answer was lost: it's saved, not another computer's.
    unconfirmed.current = null;
    onSaved();
  }, [latest, base, onSaved]);
  // Settings' Change settings puts focus in the first field.
  const editing = useRef(edit !== undefined);
  useEffect(() => {
    if (editing.current) document.getElementById(`${idp}-output`)?.focus();
  }, [idp]);

  const local = lookup.scheduler === "local";
  const shown = menus(lookup, f);
  const current =
    folder.data !== undefined && checked === f.output.trim() ? folder.data : undefined;
  const refusal = current?.output_folder.refusal ?? undefined;
  const free = current?.output_folder.free_bytes;
  /** Beside the Output folder's label: its free space once checked, and why it's gone till then. */
  const typed = f.output.trim();
  let folderNote: string | undefined;
  if (typed !== checked) folderNote = typed === "" ? undefined : "checked when you leave the field";
  else if (current === undefined && folder.isFetching) folderNote = "checking…";
  else if (free != null && refusal === undefined) folderNote = `${bytes(free)} free`;
  const issueOf = (field: SetupField) =>
    field === "output" ? (issues.output ?? refusal) : issues[field];

  /** A changed field's issue goes; the next Save checks it again. */
  const settle = (...fields: SetupField[]) =>
    setIssues((now) => {
      if (!fields.some((x) => now[x] !== undefined)) return now;
      const next = { ...now };
      for (const x of fields) delete next[x];
      return next;
    });
  const set = (field: SetupField, value: string | boolean) => {
    setF((now) => ({ ...now, [field]: value }));
    settle(field);
  };
  const text = (field: SetupField) => ({
    value: f[field] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      set(field, e.target.value),
  });
  const props = (field: SetupField, ...described: string[]) => {
    const issue = issueOf(field);
    const ids = [
      issue !== undefined ? `${idp}-${field}-issue` : undefined,
      field === "output" && issue === undefined ? `${idp}-output-size` : undefined,
      marks[field] !== undefined ? `${idp}-${field}-was` : undefined,
      marks[field]?.kind === "both" ? `${idp}-${field}-saved` : undefined,
      ...described,
    ].filter((x) => x !== undefined);
    return {
      id: `${idp}-${field}`,
      "aria-invalid": issue !== undefined ? true : undefined,
      "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
      disabled: busy || undefined,
    };
  };
  /** A field's control class, outlined once it's changed; a select's prompt is in the text face. */
  const cls = (field: SetupField, more = "") =>
    `input${more.includes("placeholder") ? "" : " mono"}${more}${changed.includes(field) ? " dirty" : ""}`;
  /**
   * Under a changed field: what it was, and for the Output folder, what that
   * means. A field another computer changed says so; one you both changed
   * keeps yours and says what they saved.
   */
  const wasLine = (field: SetupField) => {
    const mark = marks[field];
    if (mark === undefined) return null;
    // A value stays whole, so "1-12:00:00" doesn't break at its hyphen; a path may wrap.
    const value = (said: string) =>
      field === "container" || WORDS.includes(said) ? (
        said
      ) : (
        <span className={field === "output" ? "mono" : "mono whole"}>{said}</span>
      );
    return (
      <>
        <span
          className={field === "container" ? "hint check-hint" : "hint"}
          id={`${idp}-${field}-was`}
        >
          <span className="chg">
            {mark.kind === "theirs" ? "From another computer" : "Changed"}
          </span>{" "}
          · was {value(mark.was)}
          {field === "output" &&
            (runs === 0 ? (
              ". Runs you submit next write here."
            ) : (
              <>
                . Runs you submit next write here; your <span className="n">{whole(runs)}</span>{" "}
                earlier {runs === 1 ? "run keeps its" : "runs keep theirs"}.
              </>
            ))}
        </span>
        {mark.kind === "both" && (
          <span className="hint" id={`${idp}-${field}-saved`}>
            Another computer saved {value(mark.saved)}
          </span>
        )}
      </>
    );
  };
  const issue = (field: SetupField) => {
    let said = issueOf(field);
    // A refused folder says how little a run writes, where it sends you to your home folder.
    if (field === "output" && said !== undefined && said === refusal) {
      said = `${said} ${REFUSED_SIZE}`;
    }
    return said === undefined ? null : (
      <span className="field-issue" id={`${idp}-${field}-issue`}>
        {said}
      </span>
    );
  };
  const label = (field: SetupField, words: string, hint?: string) => (
    <div className="lrow">
      <label htmlFor={`${idp}-${field}`} className="flabel">
        {words}
      </label>
      {hint !== undefined && <span className="hint">{hint}</span>}
    </div>
  );

  /** Another computer's settings, with each field you changed kept over theirs. */
  const reload = () => {
    const theirs = edit?.latest;
    if (theirs === undefined || base === null) return;
    const fields = fieldsOf(theirs.settings);
    setF((now) => reloaded(base.fields, now, fields));
    setBase({ revision: theirs.revision, fields });
    setStale(false);
    setMessage(undefined);
    save_.current?.focus();
  };

  const focusFirst = (found: Partial<Record<SetupField, string>>) => {
    const at = ORDER.find((field) => found[field] !== undefined);
    if (at === undefined) return;
    if (IN_ADVANCED.includes(at)) setAdvanced(true);
    setTimeout(() => document.getElementById(`${idp}-${at}`)?.focus());
  };

  const save = async () => {
    if (saving.busy()) return;
    const result = checkSetup(lookup, f, platform.name);
    if ("issues" in result) {
      // Only an engine error again keeps the box; any other outcome says its own.
      setSaveFailure(undefined);
      setIssues(result.issues);
      setMessage(undefined);
      focusFirst(result.issues);
      return;
    }
    setIssues({});
    setMessage(undefined);
    const failedBefore = saveFailure?.error;
    const expected_revision = base?.revision ?? null;
    // A save over a newer revision, after Reload, is a new request.
    request.current = keyFor(request.current, { expected_revision, settings: result.settings });
    const settingsKey = agentKey(platform.id, "platform_settings");
    unconfirmed.current = null;
    const sent = f;
    try {
      const key = request.current.key;
      const saved = await saving.run(() =>
        commands.save_platform_settings({
          request_key: key,
          expected_revision,
          settings: result.settings,
        }),
      );
      if (edit !== undefined) {
        // The summary shows what was saved at once; the feed confirms it.
        queries.setQueryData(settingsKey, {
          saved: { revision: saved.revision, settings: result.settings },
        });
      }
      keep.current?.(undefined);
      setSaveFailure(undefined);
      if (open.current) onSaved();
      await queries.invalidateQueries({ queryKey: settingsKey });
    } catch (error) {
      const code = (error as Partial<WireError>)?.code as string | undefined;
      if (code !== "internal") setSaveFailure(undefined);
      if (code === "conflict") {
        await queries.invalidateQueries({ queryKey: settingsKey });
        if (!open.current) return;
        if (edit === undefined) {
          onConflict?.();
          return;
        }
        setStale(true);
        setTimeout(() => note.current?.focus());
        return;
      }
      if (!open.current) return;
      if (edit !== undefined && (code === "not_connected" || code === "timeout")) {
        unconfirmed.current = sent;
        // The retry reuses its key, so it saves them once (#168).
        const offline = getConnection().status === "connected" ? undefined : platform.name;
        const words = {
          happened: "the settings saved",
          again: "Saving",
          safe: "it won’t save them twice",
        };
        setMessage(unconfirmedWords(words, offline));
        return;
      }
      if (code === "internal") {
        // ICMM's own error: its box, with the log; Save is the retry, so focus stays on it.
        setSaveFailure({
          error,
          again: sameFailure(failedBefore, error) ? Date.now() : undefined,
        });
        return;
      }
      const failed = issuesOf(error);
      setIssues(failed.fields);
      setMessage(failed.message);
      focusFirst(failed.fields);
    }
  };

  const dialog = useSystemDialog();
  const choose = async () => {
    const chosen = await dialog.open(() =>
      desktop.chooseFolder({
        title: "Choose the Output folder",
        folder: f.output,
      }),
    );
    if (chosen.path !== null) {
      set("output", chosen.path);
      setChecked(chosen.path.trim());
    }
  };

  const hints = edit === undefined;
  const changes = changed.length;
  const notice =
    edit?.latest !== undefined && base !== null && newer
      ? elsewhereNotice(base.fields, fieldsOf(edit.latest.settings), f)
      : undefined;
  const theirsInAdvanced = advancedElsewhere(marks, f);

  return (
    <form
      className="setup-form"
      aria-labelledby={headingId}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {head}
      <div className="field">
        {label("output", "Output folder", folderNote)}
        <div className="with-button">
          <input
            {...props("output")}
            className={cls("output")}
            type="text"
            spellCheck={false}
            {...text("output")}
            onBlur={() => setChecked(f.output.trim())}
          />
          {platform.type === "local" && (
            // Its dialog browses this computer's disk, so an SSH host's folder is typed.
            <BesideButton
              type="button"
              className="btn"
              working={saving}
              {...grayProps(dialog.gray)}
              onClick={() => void choose()}
            >
              Choose…
            </BesideButton>
          )}
        </div>
        {issue("output") ?? (
          <span className="hint" id={`${idp}-output-size`}>
            {OUTPUT_SIZE}
          </span>
        )}
        {wasLine("output")}
      </div>

      {!local && shown.kind === "menus" && (
        <div className="setup-two">
          <div className="field">
            {label("account", "Account", hints ? shown.accountHint : undefined)}
            <select
              {...props("account")}
              className={cls("account", f.account === "" ? " placeholder" : "")}
              value={f.account}
              onChange={(e) => {
                const account = e.target.value;
                setF((now) => withAccount(lookup, now, account));
                settle("account", "partition");
              }}
            >
              {f.account === "" && (
                <option value="" disabled>
                  Choose an account…
                </option>
              )}
              {withValue(shown.accounts, f.account).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            {issue("account")}
            {wasLine("account")}
          </div>
          <div className="field">
            {label("partition", "Partition", hints ? shown.partitionHint : undefined)}
            <select
              {...props("partition")}
              className={cls("partition", f.partition === "" ? " placeholder" : "")}
              {...text("partition")}
            >
              {f.partition === "" && (
                <option value="" disabled>
                  Choose a partition…
                </option>
              )}
              {withValue(shown.partitions, f.partition).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {issue("partition")}
            {wasLine("partition")}
          </div>
        </div>
      )}
      {!local && shown.kind === "text" && (
        <div className="setup-two">
          <div className="field">
            {label("account", "Account")}
            <input
              {...props("account", `${idp}-unread`)}
              className={cls("account")}
              type="text"
              spellCheck={false}
              placeholder="the cluster’s default"
              {...text("account")}
            />
            {issue("account")}
            {wasLine("account")}
          </div>
          <div className="field">
            {label("partition", "Partition")}
            <input
              {...props("partition", `${idp}-unread`)}
              className={cls("partition")}
              type="text"
              spellCheck={false}
              placeholder="the cluster’s default"
              {...text("partition")}
            />
            {issue("partition")}
            {wasLine("partition")}
          </div>
          <p id={`${idp}-unread`} className="hint span-all">
            ICMM couldn’t read these from SLURM. Type yours, or leave them blank for its defaults.
          </p>
        </div>
      )}

      <div className="setup-jobs">
        <div className={local ? "setup-two" : "setup-four"}>
          <div className="field">
            {label("cpus", "CPUs per start")}
            <input
              {...props("cpus")}
              className={cls("cpus")}
              type="text"
              inputMode="numeric"
              {...text("cpus")}
            />
            {issue("cpus")}
            {wasLine("cpus")}
          </div>
          {!local && (
            <div className="field">
              {label("memory", "Memory per start")}
              <input
                {...props("memory")}
                className={cls("memory")}
                type="text"
                spellCheck={false}
                {...text("memory")}
              />
              {issue("memory")}
              {wasLine("memory")}
            </div>
          )}
          {!local && (
            <div className="field">
              {label("time", "Time limit per start")}
              <input
                {...props("time")}
                className={cls("time")}
                type="text"
                spellCheck={false}
                {...text("time")}
              />
              {issue("time")}
              {wasLine("time")}
            </div>
          )}
          <div className="field">
            {label("running", "Max running starts")}
            <div className="with-unit">
              <input
                {...props("running")}
                className={cls("running")}
                type="text"
                inputMode="numeric"
                {...text("running")}
              />
              <span className="unit" aria-hidden="true">
                {local ? "all runs" : "per run"}
              </span>
            </div>
            {issue("running")}
            {wasLine("running")}
          </div>
        </div>
        <p className="hint">
          {local
            ? coresLine(platform, lookup.local?.cores, f.cpus, f.running)
            : limitLine(lookup, f)}
        </p>
      </div>

      {elsewhere && (
        <div className="note-ask" role="status" tabIndex={-1} ref={note}>
          <p>
            {notice?.fields ??
              `Another computer changed ${platform.name}’s Platform settings since you opened them.`}
            <span className="hint">
              {notice?.reload ??
                (changes === 0
                  ? "Reload shows theirs."
                  : `Reload shows theirs and keeps ${changes === 1 ? "the field" : `the ${changes} fields`} you changed.`)}
            </span>
          </p>
          <button type="button" className="btn btn-sm" onClick={reload}>
            Reload
          </button>
        </div>
      )}

      {saveFailure !== undefined && !busy && (
        <FailureBox
          error={saveFailure.error}
          task="save"
          platform={platform}
          again={saveFailure.again}
        />
      )}
      {beforeSave}
      <div className={`setup-end${advanced ? " open" : ""}`} ref={end}>
        {!local && (
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
        )}
        {!local && !advanced && (
          <span className="hint setup-end-hint">
            Excluded nodes, coordinating job, container
            {theirsInAdvanced > 0 && (
              <>
                {" · "}
                <span className="elsewhere">{theirsInAdvanced} changed on another computer</span>
              </>
            )}
            {issues.coordinator !== undefined && (
              <>
                {" · "}
                <span className="field-issue">
                  coordinating job: {issues.coordinator.replace(/\.$/, "")}
                </span>
              </>
            )}
          </span>
        )}
        {!local && advanced && (
          <div id={`${idp}-adv`} className="setup-advanced">
            <div className="field">
              {label("excluded", "Excluded nodes")}
              <input
                {...props("excluded", `${idp}-excluded-hint`)}
                className={cls("excluded")}
                type="text"
                spellCheck={false}
                placeholder="none"
                {...text("excluded")}
              />
              {issue("excluded")}
              {wasLine("excluded")}
              <span className="hint" id={`${idp}-excluded-hint`}>
                Your starts never run on these nodes: name one that keeps failing them. Separate
                them with commas, such as{" "}
                <span className="mono">int36-1802, amd128-[2201-2204]</span>.
              </span>
            </div>
            <div className="setup-two">
              <div className="field">
                {label("coordinator", "Coordinating job’s time limit")}
                <input
                  {...props("coordinator", `${idp}-coordinator-hint`)}
                  className={cls("coordinator")}
                  type="text"
                  spellCheck={false}
                  {...text("coordinator")}
                />
                {issue("coordinator")}
                {wasLine("coordinator")}
                <span className="hint" id={`${idp}-coordinator-hint`}>
                  Each run has a small job that sends out its starts and collects their results. It
                  renews itself automatically.
                </span>
              </div>
              <div className="field">
                {label("checkEvery", "Look for finished starts every")}
                <div className="with-unit">
                  <input
                    {...props("checkEvery", `${idp}-checkEvery-hint`)}
                    className={cls("checkEvery")}
                    type="text"
                    inputMode="numeric"
                    {...text("checkEvery")}
                  />
                  <span className="unit mono" aria-hidden="true">
                    s
                  </span>
                </div>
                {issue("checkEvery")}
                {wasLine("checkEvery")}
                <span className="hint" id={`${idp}-checkEvery-hint`}>
                  How often each run checks on its starts. Shorter shows progress sooner and asks
                  SLURM more often.
                </span>
              </div>
            </div>
            <div className="field">
              <label className="check">
                <input
                  {...props("container", `${idp}-container-hint`)}
                  type="checkbox"
                  checked={f.container}
                  onChange={(e) => set("container", e.target.checked)}
                />
                <span className="flabel">Run starts in a container</span>
              </label>
              <span className="hint check-hint" id={`${idp}-container-hint`}>
                Only if your cluster’s admins ask for one, or its compute nodes can’t run ICMM’s
                engine. Off, starts run on ICMM’s engine.
              </span>
              {wasLine("container")}
            </div>
            {f.container && (
              <div className="setup-container">
                <div className="field">
                  {label("runtime", "Runtime")}
                  <select {...props("runtime")} className={cls("runtime")} {...text("runtime")}>
                    <option value="apptainer">apptainer</option>
                    <option value="docker">docker</option>
                  </select>
                  {wasLine("runtime")}
                </div>
                <div className="field">
                  {label("image", "Image path")}
                  <input
                    {...props("image", `${idp}-image-hint`)}
                    className={cls("image")}
                    type="text"
                    spellCheck={false}
                    {...text("image")}
                  />
                  {issue("image")}
                  {wasLine("image")}
                  <span className="hint" id={`${idp}-image-hint`}>
                    An image with ICMM’s engine in it, on {platform.name}.
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {message !== undefined && (
          <span className="field-issue setup-message" role="alert">
            {message}
          </span>
        )}
        {waitingShown && (
          <span className="setup-message waiting" role="status">
            <span className="g g-queued" aria-hidden="true" />
            Waiting for {platform.name} to reconnect, then this saves.
          </span>
        )}
        <div className="setup-save">
          {edit !== undefined && !waitingShown && (
            <BesideButton type="button" className="btn" working={saving} onClick={edit.onCancel}>
              Cancel
            </BesideButton>
          )}
          <WorkingButton
            type="submit"
            ref={save_}
            className="btn btn-primary"
            working={saving}
            words="Saving…"
          >
            {saveLabel}
          </WorkingButton>
        </div>
      </div>
    </form>
  );
}
