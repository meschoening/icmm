/**
 * The Config builder (#183; LaptopConfigBuilder, new and edit): a config's
 * Name & data, Topology and Optimization, with Work and Data beside them.
 * New config opens from Configs and First launch, and from Dataset detail
 * with that dataset chosen (`/configs/new?dataset=`); Edit opens a saved
 * config (`/configs/$id/edit`), and so does Duplicate's copy, with its name
 * selected.
 *
 * `validate_config`'s issues show under their fields a moment after typing
 * stops, and Save checks again (`save_config` refuses what fails, as
 * `invalid`); notes show but don't stop a save. A new config saves with
 * Save, or Save and submit… to Submit; Edit saves with Save changes. Each
 * goes back to the config on Configs, or on to Submit.
 *
 * Section 1 and 2's patterns: leaving with a change asks first, whichever
 * way out; a save across a reconnect waits, locked, then says it couldn't
 * confirm; another computer's save gets the note with Reload, which keeps
 * the fields you changed, each then marked; another computer's delete of
 * the config says so, and Save as a new config saves the fields as shown
 * (CF04); a delete of its dataset says so; and while disconnected the
 * builder keeps its work.
 */
import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNow } from "../../connection/useNow";
import { useActivePlatform, useHeldFailure } from "../../datasets/detail/read";
import { ShowOnceConnected } from "../../datasets/detail/ShowOnceConnected";
import { modifiedWords } from "../../datasets/detail/words";
import { useLeaveGuard } from "../../datasets/leaveGuard";
import { useDatasets } from "../../datasets/queries";
import { isMac } from "../../platform";
import { savedWords } from "../../requestKey";
import { FailureBox, TryAgain } from "../../setup/FailureBox";
import { Reading } from "../../setup/PlatformSetup";
import { inSentence } from "../../setup/form";
import { useRunsUpTo } from "../../runs/queries";
import { plural } from "../../submit/estimate";
import { useReadAgain } from "../../setup/queries";
import { useConnection } from "../../shell/connection";
import { useBlocker } from "../../ui/blocker";
import { clock } from "../../ui/clock";
import { ReadingFacts } from "../../ui/HeadFacts";
import { PageHeading } from "../../ui/PageHeading";
import { ReportFromHere } from "../../report/ReportFromHere";
import type { Working } from "../../ui/working";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import { commands } from "../../wire/api.gen";
import type {
  DatasetSummary,
  Issue,
  SaveConfigParams,
  SavedConfig,
  SavedPlatform,
  UnreadableError,
  WireError,
} from "../../wire/types.gen";
import { useDelete } from "../useDelete";
import { UnreadableBox } from "../UnreadableBox";
import { GetNewest } from "../../ui/GetNewest";
import { useConfig, useConfigCheck, useConfigs } from "../queries";
import { againName, emptyIdsWords, STATES_WORDS } from "../words";
import { useConfigWrite } from "../write";
import { Data, MAX_RUN_STARTS, Time, Work } from "./Aside";
import { useBuilderTime } from "./time";
import {
  changedFields,
  draftOf,
  elsewhereNotice,
  fieldMarks,
  idEntries,
  idsText,
  issuesOf,
  newDraft,
  reloadDraft,
  statesKey,
  tidied,
  wireOf,
  type ConfigDraft,
  type Field,
  type FieldIssue,
  IN_ADVANCED,
  type Numeric,
} from "./draft";
import { drawnIds, MOST_DRAWN, useIdDrawings } from "./drawings";
import { FromNote } from "./FromNote";
import { fromResultsDraft, parsePicks, useFromResults, type FromResults } from "./fromResults";
import { NameData, Optimization, Topology } from "./Sections";
import { statusOf } from "./status";
import { useOpened } from "../../shell/palette/recents";

type Platform = Pick<SavedPlatform, "type" | "name">;

export function NewConfigPage() {
  const { dataset, states, ids, picks } = useSearch({ from: "/configs/new" });
  const c = useConnection();
  const platform = useActivePlatform();
  const datasets = useDatasets();
  const configs = useConfigs();
  const kept = useKept(datasets.data);
  // From Results' New config from these… (#343): its picks, whose top-ranked's run is read.
  const picked = useMemo(() => {
    const all = picks === undefined ? [] : parsePicks(picks);
    return all.length > 0 && dataset !== undefined && states !== undefined && ids !== undefined
      ? all
      : undefined;
  }, [picks, dataset, states, ids]);
  const read = useFromResults(dataset, picked);
  const key = `new/${dataset ?? ""}/${states ?? ""}/${ids ?? ""}/${picks ?? ""}`;
  // What it opened on, once read, for this search: later reads of the run don't change the builder
  // or its note, and another New config's search opens its own.
  const [openedOn, setOpened] = useState<{ key: string; from: FromResults; start: ConfigDraft }>();
  const opened = openedOn?.key === key ? openedOn : undefined;
  if (
    opened === undefined &&
    picked !== undefined &&
    read.state === "ready" &&
    configs.data !== undefined
  ) {
    const names = configs.data.map((x) => x.name);
    const start = fromResultsDraft(
      read.from,
      { dataset: dataset!, states: states!, ids: ids! },
      names,
    );
    setOpened({ key, from: read.from, start });
  }
  const waits = picked !== undefined && opened === undefined;
  if (platform !== undefined && kept !== undefined && !waits) {
    // From a dataset, that one; else the only one, or none chosen for you (CF13).
    const chosen = kept.find((d) => d.id === dataset) ?? (kept.length === 1 ? kept[0] : undefined);
    return (
      <Builder
        key={key}
        platform={platform}
        datasets={kept}
        editing={null}
        source={opened?.from}
        start={
          opened?.start ?? {
            ...newDraft(chosen?.id ?? ""),
            // From Find custom topology's New config with its id (#222).
            ...(states !== undefined && ids !== undefined ? { states, which: "ids", ids } : {}),
          }
        }
      />
    );
  }
  return (
    <Frame crumb="New config" title="New config">
      {platform === undefined || c.status !== "connected" ? (
        <ShowOnceConnected platform={platform} kind="Configs">
          its datasets
        </ShowOnceConnected>
      ) : datasets.isError ? (
        <FailureBox
          error={datasets.error as unknown as WireError}
          task="datasets"
          platform={platform}
          onRetry={datasets.refetch}
        />
      ) : read.state === "failed" ? (
        <FailureBox
          error={read.error}
          task={{ reading: "the picks’ runs" }}
          platform={platform}
          onRetry={read.retry}
        />
      ) : picked !== undefined && configs.isError ? (
        <FailureBox
          error={configs.error as unknown as WireError}
          task="configs"
          platform={platform}
          onRetry={configs.refetch}
        />
      ) : picked !== undefined ? (
        <Reading>Reading the picks’ runs on {inSentence(platform)}…</Reading>
      ) : (
        <Reading>Reading the datasets on {inSentence(platform)}…</Reading>
      )}
    </Frame>
  );
}

export function EditConfigPage() {
  const { id } = useParams({ from: "/configs/$id/edit" });
  const copyOf = useRouterState({ select: (s) => s.location.state.copyOf });
  const c = useConnection();
  const platform = useActivePlatform();
  const datasets = useDatasets();
  const configs = useConfigs();
  const q = useConfig(id);
  const error = q.isError ? (q.error as unknown as WireError) : undefined;
  const read = useReadAgain(q.data === undefined ? error : undefined, q.refetch);
  const failure = useHeldFailure(read.failure, q.isFetching, id, q.data !== undefined);
  /**
   * The revision it opened on: what its changes are to, until Reload. The route keeps the page
   * from one config's builder to another's (⌘K), so what it holds is this config's only.
   */
  const [openedOn, setOpened] = useState<SavedConfig>();
  const opened = openedOn?.id === id ? openedOn : undefined;
  if (opened === undefined && q.data !== undefined) setOpened(q.data);
  useOpened(opened === undefined ? undefined : { kind: "config", id, name: opened.config.name });
  // A delete after it opened comes back as `not_found`: the builder keeps what it showed.
  const [deletedOn, setDeletedAt] = useState<{ id: string; at: number }>();
  const deletedAt = deletedOn?.id === id ? deletedOn.at : undefined;
  if (opened !== undefined && error?.code === "not_found" && deletedAt === undefined) {
    setDeletedAt({ id, at: q.errorUpdatedAt });
  }

  const kept = useKept(datasets.data);
  // Delete config… from a damaged config's box (#452), kept above the editor and the views a
  // read's answer swaps: the feed can read it gone before the delete answers, which is it landing.
  const navigate = useNavigate();
  const toConfigs = useCallback(() => void navigate({ to: "/configs" }), [navigate]);
  const del = useDelete(
    id,
    opened?.config.name ?? configs.data?.find((x) => x.id === id)?.name ?? "this config",
    platform?.name ?? "",
    toConfigs,
  );
  const landed = del.sent && error?.code === "not_found";
  useEffect(() => {
    if (landed) toConfigs();
  }, [landed, toConfigs]);
  // Held while it's read again, as on Configs: the change feed refetches it, and a delete
  // from its box must keep the box, and the question under it, until it lands (#452).
  const unreadable = (
    error?.code === "unreadable" ? error : failure?.code === "unreadable" ? failure : undefined
  ) as UnreadableError | undefined;
  // An unreadable revision replaces even a cached editor: its changes can no longer save.
  // Unmounting the builder also drops its leave guard; there is no editing to return to.
  if (
    unreadable === undefined &&
    opened !== undefined &&
    platform !== undefined &&
    kept !== undefined
  ) {
    return (
      <Builder
        key={id}
        platform={platform}
        datasets={kept}
        editing={{
          opened,
          latest: q.data,
          deletedAt,
          copyOf,
          retryRead: error === undefined ? undefined : q.refetch,
        }}
        start={draftOf(opened.config)}
      />
    );
  }
  // One it can't read is named as Configs lists it.
  const name = opened?.config.name ?? configs.data?.find((x) => x.id === id)?.name;
  const offline = platform === undefined || (c.status !== "connected" && opened === undefined);
  // The head stays as the builder draws it (#445, SF08): its facts line in the state's own
  // words, Cancel, and Save changes gray with why in the status line.
  const where = platform === undefined ? "" : inSentence(platform);
  // A damaged one keeps it too, with Delete config… in its box (#452), and a newer one (#458).
  const damaged = unreadable?.data.problem === "damaged";
  const newer = unreadable?.data.problem === "newer";
  const gone = unreadable === undefined && failure?.code === "not_found";
  const waits: Waits | undefined =
    platform === undefined || (unreadable !== undefined && !damaged && !newer)
      ? undefined
      : offline
        ? {
            facts: <p className="facts">Not connected to {where}</p>,
            why: `Waits for ${where} to connect`,
          }
        : damaged
          ? {
              facts: <p className="facts">ICMM can’t read this config</p>,
              why: "Waits for the config: ICMM can’t read it",
            }
          : newer
            ? {
                facts: <p className="facts">Saved by a newer ICMM</p>,
                why: "Waits for the config: it needs a newer ICMM",
              }
            : gone
              ? {
                  facts: <p className="facts">Not on {where} any more</p>,
                  why: `Waits for the config: it isn’t on ${where}`,
                }
              : failure !== undefined
                ? {
                    facts: <p className="facts">Couldn’t read the config</p>,
                    why: "Waits for the config: it couldn’t be read",
                  }
                : {
                    facts: <ReadingFacts>Reading the config on {where}…</ReadingFacts>,
                    why: "Waits for the config to be read",
                  };
  return (
    <Frame crumb={name} mono title="Edit config" waits={waits} back={id}>
      {offline ? (
        <ShowOnceConnected platform={platform} kind="Configs" one>
          this config
        </ShowOnceConnected>
      ) : unreadable !== undefined ? (
        damaged ? (
          <Damaged name={name ?? "this config"} error={unreadable} del={del} />
        ) : (
          <UnreadableBox
            name={name ?? "this config"}
            error={unreadable}
            next={
              newer ? (
                <>
                  <GetNewest /> to edit it.
                </>
              ) : undefined
            }
          />
        )
      ) : gone ? null : failure !== undefined ? (
        <FailureBox
          error={failure}
          task="config"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      ) : null}
    </Frame>
  );
}

type Deleting = Pick<ReturnType<typeof useDelete>, "ask" | "open" | "more">;

/**
 * A damaged config's box, with Delete config… where a read failure's Try again goes, and the
 * Configs page's own confirm under it (LaptopConfigBuilder's `edit-damaged-delete`, #452).
 */
function Damaged({ name, error, del }: { name: string; error: UnreadableError; del: Deleting }) {
  const { ask, open, more } = del;
  return (
    <>
      <UnreadableBox name={name} error={error}>
        <button type="button" className="btn btn-sm" ref={more} onClick={open}>
          Delete config…
        </button>
      </UnreadableBox>
      {ask}
    </>
  );
}

/**
 * The platform's datasets as last read: a connection that ends forgets its
 * reads, and an open builder keeps its work, its dataset menu with it.
 */
function useKept<T>(data: T | undefined): T | undefined {
  const [kept, setKept] = useState(data);
  if (data !== undefined && data !== kept) setKept(data);
  return data ?? kept;
}

/** Edit config's head before its config is read: the facts line, and why Save changes waits. */
interface Waits {
  facts: React.ReactNode;
  why: string;
}

/**
 * The builder's place while what it builds on isn't there yet. With `waits`, Edit config's
 * head as the builder draws it: Cancel back to the config on Configs, and Save changes gray.
 */
function Frame({
  crumb,
  mono = false,
  title,
  waits,
  back,
  children,
}: {
  crumb: string | undefined;
  mono?: boolean;
  title: string;
  waits?: Waits;
  /** The config Cancel goes back to. */
  back?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="page cb-page">
      <section className="cb-head">
        <div className="cb-head-text">
          <Crumbs crumb={crumb} mono={mono} />
          <PageHeading>{title}</PageHeading>
          {waits?.facts}
        </div>
        {waits !== undefined && <WaitingActs why={waits.why} back={back} />}
      </section>
      <ReportFromHere name={crumb ?? title} mono={mono && crumb !== undefined} />
      {children}
    </div>
  );
}

function WaitingActs({ why, back }: { why: string; back: string | undefined }) {
  const navigate = useNavigate();
  const save = useBlocker(why);
  return (
    <div className="hacts">
      <div className="acts">
        <button
          type="button"
          className="btn-text"
          onClick={() =>
            void navigate({ to: "/configs", search: back === undefined ? {} : { id: back } })
          }
        >
          Cancel
        </button>
        <button type="button" className="btn btn-primary" {...save.props}>
          Save changes <span className="kbd kbd-inv">{isMac() ? "⌘↵" : "Ctrl ↵"}</span>
        </button>
        {save.bubble}
      </div>
      <span className="astat plain" role="status">
        {why}
      </span>
    </div>
  );
}

function Crumbs({ crumb, mono }: { crumb: string | undefined; mono: boolean }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/configs" className="link">
        Configs
      </Link>
      {crumb !== undefined && (
        <>
          <span aria-hidden="true">/</span>
          <span className={mono ? "mono" : undefined} aria-current="page">
            {crumb}
          </span>
        </>
      )}
    </nav>
  );
}

/** A saved config the builder edits: as it opened, as it is now, and whether it's gone. */
interface Editing {
  opened: SavedConfig;
  latest: SavedConfig | undefined;
  /** A newer revision's read failed: retry it without losing the draft or clearing a conflict. */
  retryRead: (() => Promise<unknown>) | undefined;
  /** When another computer's delete was first heard. */
  deletedAt: number | undefined;
  /** Duplicate's copy, by the name it was copied from: it opens with its name selected. */
  copyOf: string | undefined;
}

/**
 * How many runs used the config, as LaptopConfigBuilder's edit says it: " · used by 1 run", or
 * " · no runs yet"; nothing until every run of it is read (KF16).
 */
function RunsUsed({ id }: { id: string }) {
  const { runs, done } = useRunsUpTo(Number.POSITIVE_INFINITY, null, id);
  if (!done) return null;
  return (
    <> · {runs.length === 0 ? "no runs yet" : `used by ${plural(runs.length, "run", "runs")}`}</>
  );
}

/** A button beside the working one, while it isn't the one pressed. */
const IDLE: Working = {
  busy: () => false,
  pending: false,
  shown: false,
  run: (work) => work(),
};

/** "just now" within a minute, else as Datasets' Modified column says it. */
function savedWhen(at: string, now: number): string {
  return now - Date.parse(at) < 60_000 ? "just now" : modifiedWords(at, now);
}

function Builder({
  platform,
  datasets,
  editing,
  source,
  start,
}: {
  platform: Platform;
  datasets: DatasetSummary[];
  editing: Editing | null;
  /** Results' New config from these…: where its settings came from, which its note says. */
  source?: FromResults;
  /** What it opens on: a new config's fields, or the saved config's. */
  start: ConfigDraft;
}) {
  const c = useConnection();
  const connected = c.status === "connected";
  const navigate = useNavigate();
  const now = useNow([]);
  const configs = useConfigs();
  const write = useConfigWrite(platform.name);
  /** A retry keeps its generated name and full input even when the config list refreshes. */
  const pendingSave = useRef<{
    body: string;
    input: Omit<SaveConfigParams, "request_key">;
  } | null>(null);
  const at = inSentence(platform);

  /** The revision its changes are to: the one it opened on, or the one Reload showed. */
  const [base, setBase] = useState(editing?.opened ?? null);
  const [from, setFrom] = useState(start);
  const [first] = useState(start);
  const [draft, setDraft] = useState(start);
  /** Specific IDs as typed at each number of states, while the builder is open. */
  const idsAt = useRef<Record<string, string>>({});
  const [held, setHeld] = useState<{ ids: string; notes: FieldIssue[] } | null>(null);
  const [rewrite, setRewrite] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [takenOnSave, setTakenOnSave] = useState<string>();
  const [refused, setRefused] = useState<{ body: string; issues: Issue[] } | null>(null);
  const [pressed, setPressed] = useState<"save" | "continue">("save");
  /** A gray Save was pressed while the config had needs: each is a check from then on (CF10). */
  const [tried, setTried] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [openedFor, setOpenedFor] = useState("");
  const note = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  /** Every dataset's name it has seen, so one deleted while it's open keeps its name. */
  const [names, setNames] = useState<Record<string, string>>({});
  // A saved config's dataset, or the picks' run's, may be deleted: it's named as they last had it.
  const savedDataset = editing?.latest?.dataset ?? editing?.opened.dataset ?? source?.run?.dataset;
  const seen = [
    ...datasets.map((d) => [d.id, d.name] as const),
    ...(savedDataset?.name != null ? [[savedDataset.id, savedDataset.name] as const] : []),
  ];
  if (seen.some(([id, name]) => names[id] !== name)) {
    setNames({ ...names, ...Object.fromEntries(seen) });
  }
  const datasetName = (id: string) => names[id] ?? Object.fromEntries(seen)[id] ?? id;

  const wire = useMemo(() => wireOf(draft), [draft]);
  const { answered, body, current } = useConfigCheck(wire.config);
  const deleted = editing?.deletedAt !== undefined;
  const latest = editing?.latest;
  const newer = latest !== undefined && base !== null && latest.revision > base.revision;
  const stale =
    !deleted &&
    base !== null &&
    (conflicted || (latest !== undefined && latest.revision !== base.revision));

  // A save whose answer was lost, but which landed: it's saved, so it goes back as one does.
  const [goneBack, setGoneBack] = useState(false);
  const landed =
    !goneBack &&
    write.unconfirmed !== null &&
    latest !== undefined &&
    base !== null &&
    latest.revision !== base.revision &&
    changedFields(draftOf(latest.config), draft).length === 0;

  const set = (change: Partial<ConfigDraft>) => {
    if (write.working.pending) return;
    setRefused(null);
    setTakenOnSave(undefined);
    const next = { ...draft, ...change };
    // Specific IDs belong to their number of states: they empty, and come back with it.
    if (change.states !== undefined && statesKey(change.states) !== statesKey(draft.states)) {
      idsAt.current[statesKey(draft.states)] = draft.ids;
      next.ids = idsAt.current[statesKey(change.states)] ?? "";
    }
    if (next.ids !== draft.ids) setRewrite(null);
    setDraft(next);
  };

  // Find custom topology's Add (#222): its id in the ids, at its number of states. Ids at another
  // number of states stay with it, as a change of the number of states keeps them.
  const found = (change: { ids: string; states?: string }) => {
    if (write.working.pending) return;
    setRefused(null);
    setTakenOnSave(undefined);
    setRewrite(null);
    const states = change.states ?? draft.states;
    if (statesKey(states) !== statesKey(draft.states)) {
      idsAt.current[statesKey(draft.states)] = draft.ids;
    }
    setDraft({ ...draft, states, ids: change.ids });
  };

  // A number field, once left, shows as a saved one does (CF18); the config it makes is the same.
  const done = (field: Numeric) => {
    if (write.working.pending) return;
    const shown = tidied(field, draft[field]);
    if (shown !== draft[field]) setDraft({ ...draft, [field]: shown });
  };

  // What a save still needs, each with its check once a gray Save is pressed (CF10); the
  // engine's issues, but for a field a save still needs, and a save's refusal for these fields.
  const noIds = draft.which === "ids" && idEntries(draft.ids).length === 0;
  const wanted: Need[] = [];
  if (draft.name === "") wanted.push({ field: "name", words: "a name", check: "Write a name." });
  if (draft.dataset === "") {
    wanted.push({ field: "dataset", words: "a dataset", check: "Choose a dataset." });
  }
  if (draft.states.trim() === "") {
    wanted.push({ field: "states", words: "a number of states", check: STATES_WORDS });
  }
  if (noIds) {
    const check = emptyIdsWords(wire.config.topology.num_states);
    wanted.push({ field: "ids", words: "ids", check });
  }
  const needs = tried ? [] : wanted.map((n) => n.words);
  const needChecks: FieldIssue[] = tried
    ? wanted.map((n) => ({ field: n.field, message: n.check, severity: "error" }))
    : [];
  // A check made while no dataset was chosen says so until the next answers: that's the need's.
  const noDataset = draft.dataset === "" || answered?.check.config.dataset_id === "";
  const engine = [
    ...(answered?.check.issues ?? []),
    ...(refused !== null && refused.body === body ? refused.issues : []),
  ].filter(
    (i) =>
      !(draft.name === "" && i.path[0] === "name") &&
      !(noDataset && i.path[0] === "dataset_id") &&
      !(draft.states.trim() === "" && i.path[0] === "topology" && i.path[1] === "num_states") &&
      !(noIds && i.path.length === 3 && i.path[0] === "topology" && i.path[2] === "ids"),
  );
  const shown = [...needChecks, ...issuesOf(wire, dedupe(engine))];
  const idNotes = shown.filter((i) => i.field === "ids" && i.severity === "note");
  const heldNotes =
    held !== null && held.ids === draft.ids && draft.which === "ids" && idNotes.length === 0
      ? held.notes
      : [];
  const byField = new Map<Field, FieldIssue[]>();
  for (const i of shown) byField.set(i.field, [...(byField.get(i.field) ?? []), i]);

  // Deleted elsewhere, its own name saves as it, or as the next free one if taken since (CF04).
  const again = deleted && draft.name === from.name;
  // The name's live check: the platform's configs, ignoring case, but for this one.
  const clash = again
    ? undefined
    : configs.data?.find(
        (x) => x.id !== base?.id && x.name.toLowerCase() === draft.name.toLowerCase(),
      );
  const taken = draft.name === "" ? undefined : (clash?.name ?? takenOnSave);
  const changedName = editing === null || draft.name !== from.name;
  const nameIssue = byField.has("name");
  const free =
    draft.name !== "" &&
    changedName &&
    taken === undefined &&
    !nameIssue &&
    current &&
    configs.data !== undefined;
  const gone =
    draft.dataset !== "" && !datasets.some((d) => d.id === draft.dataset)
      ? datasetName(draft.dataset)
      : undefined;

  const errors: FieldIssue[] = [
    ...(taken !== undefined
      ? [{ field: "name" as const, message: "", severity: "error" as const }]
      : []),
    ...(gone !== undefined
      ? [{ field: "dataset" as const, message: "", severity: "error" as const }]
      : []),
    ...shown.filter((i) => i.severity === "error"),
  ];
  const notes = shown.filter((i) => i.severity === "note").length + heldNotes.length;
  const changes = changedFields(from, draft);
  const waiting = write.working.pending && c.status !== "connected";
  const name = base?.config.name ?? draft.name;

  const status = statusOf({
    errors,
    notes,
    needs,
    editing: editing !== null,
    deleted,
    changes: changes.length,
    // A check stale while connected comes again; not connected, only a current one counts.
    checked: answered !== undefined && (connected || current),
    platform: platform.name,
    connected,
    waiting,
    saving: write.working.shown,
    message: write.message,
    blocked: stale ? "Reload first" : undefined,
  });

  // The status line's notes count goes to the first note's field, opening Advanced for one it
  // holds once closed again (#509, F17).
  const toFirstNote = () => {
    const first = () => form.current?.querySelector<HTMLElement>(".fnote") ?? null;
    if (first() === null) flushSync(() => setAdvanced(true));
    const found = first();
    if (found === null) return;
    const field = found.closest<HTMLElement>(".cb-field, .cb-sub, fieldset") ?? found;
    const control =
      field.querySelector<HTMLElement>("input:not([type=radio]), select, textarea") ??
      field.querySelector<HTMLElement>("input:checked");
    control?.focus({ preventScroll: true });
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    field.scrollIntoView({ block: "center", behavior: still ? "instant" : "smooth" });
  };

  // Advanced opens by itself when a field inside it has a check or a note.
  const inside = shown
    .filter((i) => IN_ADVANCED.includes(i.field))
    .map((i) => `${i.field}:${i.message}`)
    .join("|");
  if (inside !== openedFor) {
    setOpenedFor(inside);
    if (inside !== "") setAdvanced(true);
  }

  // Specific IDs, once done with, show as a save keeps them, and keep the notes that say why.
  const answeredIds =
    answered?.check.config.topology.which.kind === "ids"
      ? answered.check.config.topology.which.ids
      : null;
  const idsClean =
    wire.said.every((s) => s.field !== "ids") &&
    !shown.some((i) => i.field === "ids" && i.severity === "error");
  if (rewrite !== null && rewrite === draft.ids && current && answeredIds !== null && idsClean) {
    setRewrite(null);
    const normalized = idsText(answeredIds);
    if (normalized !== draft.ids && idEntries(draft.ids).length > 0) {
      setHeld({ ids: normalized, notes: idNotes });
      setDraft({ ...draft, ids: normalized });
    }
  }

  const leaving = editing === null ? changedFields(newDraft(start.dataset), draft) : changes;
  const guard = useLeaveGuard({
    asks: leaving.length > 0 || waiting,
    waiting,
    what:
      editing === null
        ? { one: true, text: "Your new config" }
        : {
            one: changes.length <= 1,
            text:
              changes.length <= 1
                ? `Your change to ${name}`
                : `Your ${changes.length} changes to ${name}`,
          },
  });

  const toConfigs = useCallback(
    (id: string | undefined) => {
      guard.pass();
      void navigate({ to: "/configs", search: id === undefined ? {} : { id } });
    },
    [guard, navigate],
  );
  if (landed) {
    setGoneBack(true);
    setTimeout(() => toConfigs(base?.id));
  }

  const save = async (then: "configs" | "submit") => {
    if (write.working.busy()) return;
    setPressed(then === "submit" || editing !== null ? "continue" : "save");
    // Deleted elsewhere, it saves as a new config.
    const id = deleted ? null : (base?.id ?? null);
    const expected_revision = deleted ? null : (base?.revision ?? null);
    const sourceBody = JSON.stringify({ id, expected_revision, config: wire.config });
    if (pendingSave.current?.body !== sourceBody) {
      // Another config's names: this one's row may still be listed while the list catches up.
      const others = (configs.data ?? []).filter((x) => x.id !== base?.id).map((x) => x.name);
      const config = again ? { ...wire.config, name: againName(draft.name, others) } : wire.config;
      pendingSave.current = { body: sourceBody, input: { id, expected_revision, config } };
    }
    const { input } = pendingSave.current;
    const { config } = input;
    const done = await write.run(
      input,
      (key) => commands.save_config({ request_key: key, ...input }),
      savedWords(config.name),
      config,
    );
    // Only an uncertain outcome needs this input held; a refusal permits a fresh name.
    if (done.ok || done.code !== "other") pendingSave.current = null;
    if (done.ok) {
      guard.pass();
      if (then === "submit") {
        void navigate({ to: "/runs/submit", search: { config: done.value.id } });
      } else {
        toConfigs(done.value.id);
      }
    } else if (done.code === "conflict" && done.reason === "stale_revision") {
      setConflicted(true);
      setTimeout(() => note.current?.focus());
    } else if (done.code === "conflict") {
      setTakenOnSave(config.name);
      nameField.current?.focus();
    } else if (done.code === "invalid") {
      setRefused({ body, issues: done.issues });
    }
  };

  // A gray Save pressed with needs turns each into a check under its field (CF10).
  const press = () => {
    if (wanted.length > 0) setTried(true);
  };

  const reload = () => {
    if (!newer) return;
    const theirs = draftOf(latest.config);
    setDraft(reloadDraft(from, draft, theirs));
    setFrom(theirs);
    setBase(latest);
    setConflicted(false);
    write.setMessage(undefined);
  };

  // ⌘↵ (Ctrl ↵ elsewhere) presses the primary button, from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(isMac() ? e.metaKey : e.ctrlKey)) return;
      // Not while the leave question is asked, or a dialog such as Find custom topology is open.
      if (document.querySelector("[role=alertdialog], [role=dialog][aria-modal=true]")) return;
      e.preventDefault();
      primary.current?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Duplicate's copy opens with its name selected: the page lands on its field.
  const copy = editing?.copyOf !== undefined && base?.revision === editing.opened.revision;
  useEffect(() => {
    if (editing?.copyOf === undefined) return;
    nameField.current?.focus();
    nameField.current?.select();
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const marked =
    stale || (base !== null && editing !== null && base.revision !== editing.opened.revision);
  const marks = marked ? fieldMarks(first, from, draft, datasetName) : {};
  const edited = new Set(editing === null ? [] : changes);
  const fields = { draft, set, done, issues: byField, marks, edited, locked: waiting };

  const theirs = stale && latest !== undefined ? draftOf(latest.config) : undefined;
  const notice = theirs === undefined ? undefined : elsewhereNotice(from, theirs, draft);
  const kbd = isMac() ? "⌘↵" : "Ctrl ↵";
  const save_ = useBlocker(status.blocked);
  const reload_ = useBlocker(newer ? undefined : "Reload waits until the newer config is read.");
  const facts =
    editing === null ? (
      <>On {at} · nothing runs until you submit</>
    ) : (
      <>
        Saved {savedWhen(base!.modified_at, now)}
        {editing.copyOf !== undefined && (
          <>
            {" "}
            · a copy of <span className="mono">{editing.copyOf}</span>
          </>
        )}
        <RunsUsed id={editing.opened.id} />
      </>
    );
  // Counts for fields as they were stay only while a check for them can come.
  const counted = current || connected;
  const check = wire.said.some((s) => s.field === "ids") || !counted ? undefined : answered?.check;
  const work = check?.work;
  const counts =
    answered !== undefined &&
    answered.check.config.topology.num_states === wire.config.topology.num_states
      ? answered.check.counts
      : null;
  const fits =
    draft.which === "ids" && answeredIds !== null && work?.topologies != null && idsClean
      ? { ids: answeredIds, perId: work.per_id, topologies: work.topologies }
      : null;
  // Each id drawn, with or without the read-back's line (#212): a bad one is only in its check.
  const drawingIds =
    draft.which === "ids" && counted && counts !== null ? drawnIds(answered!.check) : null;
  const drawingsLimited = drawingIds !== null && drawingIds.length > MOST_DRAWN;
  const drawn = useIdDrawings(
    counts === null ? null : wire.config.topology.num_states,
    drawingsLimited ? null : drawingIds,
  );

  // Time (#471): what it waits for, else the run's time on the platform, as Submit run says it.
  const evaluations = counted ? (answered?.check.work.evaluations_per_start ?? null) : null;
  const needs_ = [
    ...(draft.dataset === "" || gone !== undefined ? ["a dataset"] : []),
    ...(draft.states.trim() === "" || byField.get("states")?.some((i) => i.severity === "error")
      ? ["a number of states"]
      : []),
  ];
  const timed = counted ? answered?.check.config : undefined;
  const time = useBuilderTime({
    need: needs_.length === 0 ? undefined : needs_.join(" and "),
    // The check for these fields' dataset and states: its box is the one that's timed.
    checked:
      timed !== undefined &&
      timed.dataset_id === draft.dataset &&
      timed.topology.num_states !== null &&
      timed.topology.num_states === wire.config.topology.num_states
        ? {
            datasetId: timed.dataset_id,
            numStates: timed.topology.num_states,
            bounds: timed.bounds,
            population: timed.search.population,
          }
        : undefined,
    work:
      work?.starts != null && work.topologies != null && check !== undefined
        ? {
            starts: work.starts,
            topologies: work.topologies,
            startsPerTopology: check.config.search.starts_per_topology,
          }
        : undefined,
    evaluations,
    uncounted: noIds ? "ids" : (work?.starts ?? 0) > MAX_RUN_STARTS ? "over" : undefined,
  });

  return (
    <div className="page cb-page" data-config={base?.id} data-dataset={draft.dataset}>
      <section className="cb-head">
        <div className="cb-head-text">
          <Crumbs crumb={editing === null ? "New config" : name} mono={editing !== null} />
          <PageHeading landing={!copy}>
            {editing === null ? "New config" : "Edit config"}
          </PageHeading>
          <p className="facts">{facts}</p>
        </div>
        <div className="hacts">
          <div className="acts">
            {!waiting && (
              <BesideButton
                type="button"
                className="btn-text"
                working={write.working}
                onClick={() => {
                  // Back to the config on Configs; one deleted meanwhile isn't there to show.
                  const back = base === null || deleted ? {} : { id: base.id };
                  void navigate({ to: "/configs", search: back });
                }}
              >
                Cancel
              </BesideButton>
            )}
            {editing === null ? (
              <>
                <WorkingButton
                  type="button"
                  className="btn"
                  working={pressed === "save" ? write.working : IDLE}
                  words="Saving…"
                  disabled={pressed !== "save" && write.working.shown}
                  {...save_.props}
                  onClick={(e) => {
                    save_.props.onClick(e);
                    if (status.blocked === undefined) void save("configs");
                    else press();
                  }}
                >
                  Save
                </WorkingButton>
                <WorkingButton
                  ref={primary}
                  type="button"
                  className="btn btn-primary"
                  working={pressed === "continue" ? write.working : IDLE}
                  words="Saving…"
                  disabled={pressed !== "continue" && write.working.shown}
                  {...save_.props}
                  onClick={(e) => {
                    save_.props.onClick(e);
                    if (status.blocked === undefined) void save("submit");
                    else press();
                  }}
                >
                  Save and submit… <span className="kbd kbd-inv">{kbd}</span>
                </WorkingButton>
              </>
            ) : (
              <WorkingButton
                ref={primary}
                type="button"
                className="btn btn-primary"
                working={write.working}
                words="Saving…"
                {...save_.props}
                onClick={(e) => {
                  save_.props.onClick(e);
                  if (status.blocked === undefined) void save("configs");
                  else press();
                }}
              >
                {deleted ? "Save as a new config" : "Save changes"}{" "}
                <span className="kbd kbd-inv">{kbd}</span>
              </WorkingButton>
            )}
            {save_.bubble}
          </div>
          <span className={`astat ${status.tone}`} role="status">
            {status.tone === "wait" && <span className="g g-queued" aria-hidden="true" />}
            {status.mark === "ok" && <OkIcon />}
            {status.mark === "bad" && <BadIcon />}
            {status.notes === undefined ? (
              status.text
            ) : (
              <NotesLine {...status.notes} onNotes={toFirstNote} />
            )}
          </span>
        </div>
      </section>
      <ReportFromHere name={editing === null ? "New config" : name} mono={editing !== null} />
      {source !== undefined && <FromNote from={source} dataset={first.dataset} />}
      {deleted ? (
        // No button of its own: Cancel goes to Configs.
        <div className="note-ask cb-note" role="status">
          <p>
            Another computer deleted <span className="mono">{name}</span> at{" "}
            {clock(editing!.deletedAt!, now)}.
            <span className="hint">Save as a new config keeps your changes.</span>
          </p>
        </div>
      ) : stale ? (
        <div className="note-ask cb-note" role="status" tabIndex={-1} ref={note}>
          <p>
            {notice?.fields !== undefined
              ? `Another computer changed ${name}’s ${notice.fields} since you opened it.`
              : `Another computer saved ${name} since you opened it.`}
            <span className="hint">
              {!newer && editing?.retryRead !== undefined
                ? "Couldn’t read the newer config. Try again."
                : notice?.fields !== undefined
                  ? notice.reload
                  : changes.length === 0
                    ? `Reload shows its ${name}.`
                    : `Reload shows its ${name} and keeps ${changes.length === 1 ? "the field" : `the ${changes.length} fields`} you changed.`}
            </span>
          </p>
          {!newer && editing?.retryRead !== undefined && <TryAgain onRetry={editing.retryRead} />}
          <button
            type="button"
            className="btn btn-sm"
            {...reload_.props}
            onClick={(e) => {
              reload_.props.onClick(e);
              reload();
            }}
          >
            Reload
          </button>
          {reload_.bubble}
        </div>
      ) : null}
      <div className="cb-body">
        <form
          ref={form}
          aria-label={editing === null ? "New config" : "Edit config"}
          className="cb-form"
          onSubmit={(e) => e.preventDefault()}
        >
          <NameData
            {...fields}
            platform={platform.name}
            free={free}
            taken={taken}
            datasets={datasets}
            gone={gone}
            nameRef={nameField}
            landing={copy}
            now={now}
          />
          <Topology
            {...fields}
            counts={counts}
            fits={fits}
            heldNotes={heldNotes}
            drawn={drawn}
            drawingsLimited={drawingsLimited}
            onIdsDone={() => setRewrite(draft.ids)}
            onFound={found}
          />
          <Optimization {...fields} advanced={advanced} onAdvanced={setAdvanced} />
        </form>
        <aside aria-label="Summary" className="cb-aside">
          <Work
            work={work}
            perTopology={check?.config.search.starts_per_topology ?? null}
            uncounted={
              draft.states.trim() === ""
                ? "Counted once you choose a number of states."
                : noIds
                  ? "Counted once you write ids."
                  : !counted
                    ? `Counted once ${platform.name} is connected.`
                    : "Counted once the checks are fixed."
            }
          />
          <Time time={time} evaluations={evaluations} />
          <Data id={draft.dataset} name={datasetName(draft.dataset)} live={gone === undefined} />
        </aside>
      </div>
      {guard.dialog}
    </div>
  );
}

/** What a save still needs, as "Needs …" says it, and the check a gray Save's press makes of it. */
interface Need {
  field: Field;
  words: string;
  check: string;
}

/** Each issue once: a save's refusal can repeat the check's. */
function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.path.join(".")}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function OkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.3 4.8 9 10 3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function BadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3.2v3.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="8.6" r=".8" fill="currentColor" />
    </svg>
  );
}

/** The status line with its notes count a link to the first note (#509, F17). */
function NotesLine({
  before,
  count,
  after,
  onNotes,
}: {
  before: string;
  count: string;
  after: string;
  onNotes: () => void;
}) {
  return (
    <span>
      {before}
      <button type="button" className="link" onClick={onNotes}>
        {count}
      </button>
      {after}
    </span>
  );
}
