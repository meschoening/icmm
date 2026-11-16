/**
 * Dataset detail (LaptopDatasetDetail), the editor (#146): the dataset's
 * facts and Jump to, then each protocol's facts beside its data and its
 * voltage command, then the configs that name it (#213), then the runs fit
 * to it. Runs come with Submit & Runs, so until then the runs list shows its
 * no-runs state, and no sentence counts them. Each change saves on its own: Rename, Edit protocol… and Remove…
 * save a new revision, New protocol… adds one, Duplicate saves a copy and
 * opens it ready to name, and Delete dataset… commits a tombstone. Export
 * saves the displayed revision byte for byte (#147). Change validation
 * points puts the page into a changing mode (#53): each point of the data
 * is a button that switches it, a bar counts the changes, and Save saves
 * one new revision.
 *
 * Each chart reads out its dark point under it (DS06), and the pointer or
 * the keyboard picks another. A revision that can't be read says why, and
 * New config from this dataset says so instead of opening, as it does while
 * the dataset reads and after a read failed. Another computer's delete while
 * the page is open puts a note over the page as it was; Export still saves
 * it, and Save as a new dataset, in Duplicate's place, saves it again as a
 * new dataset and opens that (DS07). The change feed's `datasets`
 * reads the dataset again; not connected, the page keeps its heading and
 * says when the dataset shows, and reconnecting keeps what it showed.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FailureBox } from "../../setup/FailureBox";
import { Reading } from "../../setup/PlatformSetup";
import { inSentence } from "../../setup/form";
import { useReadAgain } from "../../setup/queries";
import { useDatasetConfigs } from "../../configs/queries";
import { useNow } from "../../connection/useNow";
import { getConnection, useConnection } from "../../shell/connection";
import { useAsked } from "../../shell/asked";
import { useBlocker } from "../../ui/blocker";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import { commands } from "../../wire/api.gen";
import { useWorking, type Working } from "../../ui/working";
import type { Export } from "./exportFile";
import { useExport } from "./useExport";
import { clock } from "../../ui/clock";
import { PAGE_HEADING_ATTR } from "../../ui/pageChangeFocus";
import { PageHeading } from "../../ui/PageHeading";
import type {
  DatasetSummary,
  Point,
  Protocol,
  SavedDataset,
  SavedPlatform,
  Template,
  UnreadableError,
  WireError,
} from "../../wire/types.gen";
import { count } from "../format";
import { keepOneTrain, pointWords, unmarked } from "../points";
import { useDatasetIssues } from "../queries";
import { windowWords } from "../words";
import { PointsFacts } from "../PointsFacts";
import { ChangeBar } from "./ChangeValidation";
import { PointsChart, SweepsChart } from "./charts";
import { changesIn, reloadedWanted, switched, wantedOf, withWanted, type Wanted } from "./marks";
import { useLeaveGuard } from "../leaveGuard";
import { ChangeSection } from "./ChangeSection";
import { ConfigsFact, ConfigsFrom } from "./ConfigsFrom";
import { DatasetRuns, RunsFact } from "./DatasetRuns";
import { useDatasetRuns } from "../../runs/queries";
import { datasetKey, useActivePlatform, useDataset, useHeldFailure, useListed } from "./read";
import { Rename } from "./Rename";
import { savedWords } from "../../requestKey";
import { landed, useDatasetWrite, type DatasetWrite } from "./write";
import { ShowOnceConnected } from "./ShowOnceConnected";
import { useOpened } from "../../shell/palette/recents";
import {
  axisTitles,
  logX,
  sweptUnit,
  modifiedWords,
  pointsLabel,
  protocolFacts,
  readoutWords,
  sweepsOf,
  sweepWords,
  templateWords,
} from "./words";

type Platform = Pick<SavedPlatform, "type" | "name">;

export function DatasetPage() {
  const { id } = useParams({ from: "/datasets/$id" });
  const c = useConnection();
  const platform = useActivePlatform();
  const q = useDataset(id);
  const listed = useListed(id, q.data === undefined);
  const error = q.isError ? (q.error as unknown as WireError) : undefined;
  const read = useReadAgain(q.data === undefined ? error : undefined, q.refetch);
  const live = c.status === "connected" || c.status === "reconnecting";

  // The page keeps what it last showed, so its heading stays while it isn't connected.
  const [seen, setSeen] = useState<SavedDataset>();
  if (q.data !== undefined && q.data !== seen) setSeen(q.data);
  // Another dataset's page reuses this one: what it showed is no name for this one.
  const kept = seen?.id === id ? seen : undefined;
  const name = q.data?.content.name ?? kept?.content.name ?? listed?.name;
  useOpened(name === undefined ? undefined : { kind: "dataset", id, name });
  // When another computer's delete was first heard: each later read is `not_found` again.
  const [deleted, setDeleted] = useState<{ id: string; at: number }>();
  if (q.data !== undefined && error?.code === "not_found" && deleted?.id !== id) {
    setDeleted({ id, at: q.errorUpdatedAt });
  }
  const failure = useHeldFailure(read.failure, q.isFetching, id, q.data !== undefined || !live);

  if (platform === undefined || !live || (q.data === undefined && c.status !== "connected")) {
    return (
      <Frame
        name={name}
        blocker="Opens once you’re connected"
        duplicate={<BlockedDuplicate blocker="Duplicates once you’re connected" />}
        exportBlocker="Exports once you’re connected"
      >
        <ShowOnceConnected platform={platform} one={name !== undefined}>
          {name === undefined ? "this dataset" : <span className="mono">{name}</span>}
        </ShowOnceConnected>
      </Frame>
    );
  }
  if (q.data !== undefined) {
    return (
      <Shown
        key={id}
        dataset={q.data}
        platform={platform}
        deletedAt={deleted?.id === id ? deleted.at : undefined}
      />
    );
  }
  if (failure?.code === "not_found") return <NotHere platform={platform} />;
  if (failure?.code === "unreadable") {
    return <Unreadable id={id} platform={platform} error={failure} listed={listed} name={name} />;
  }
  const called = name ?? "this dataset";
  if (failure !== undefined) {
    return (
      <Frame
        name={name}
        blocker={`ICMM couldn’t read ${called}`}
        exportBlocker={`ICMM couldn’t read ${called}`}
        duplicate={<BlockedDuplicate blocker={`ICMM couldn’t read ${called}`} />}
      >
        <FailureBox
          error={failure}
          task="dataset"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      </Frame>
    );
  }
  return (
    // Every action is there in every state, grayed with why, so none pops in (#449's SF07).
    <Frame
      name={name}
      blocker={`Waiting for ${called} to load`}
      exportBlocker={`Waiting for ${called} to load`}
      duplicate={<BlockedDuplicate blocker={`Waiting for ${called} to load`} />}
    >
      <Reading>
        {/* One flex item, so the name sits in the sentence. */}
        <span>
          Reading {name === undefined ? "the dataset" : <span className="mono">{name}</span>} on{" "}
          {inSentence(platform)}…
        </span>
      </Reading>
    </Frame>
  );
}

/**
 * The page's head: the breadcrumb, the name with Rename, Export, Duplicate and New
 * config from this dataset, and the facts under the whole row; then the
 * page. Renaming, the name is a field in the heading's place.
 */
function Frame({
  name,
  deleted = false,
  blocker,
  naming,
  rename,
  duplicate,
  exportBlocker,
  exporter,
  landed = false,
  facts,
  children,
}: {
  name: string | undefined;
  deleted?: boolean;
  /** The page lands on another element than its heading: where the builder was opened. */
  landed?: boolean;
  /** Why New config from this dataset can't open, if it can't. */
  blocker?: string;
  /** The name's field, in the heading's place, while it's renamed. */
  naming?: React.ReactNode;
  /** Rename, beside the name. */
  rename?: React.ReactNode;
  /** Duplicate, before New config from this dataset, and what its last try said. */
  duplicate?: React.ReactNode;
  /** Why Export cannot export when the page has no readable revision. */
  exportBlocker?: string;
  exporter?: Export;
  facts?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const b = useBlocker(blocker);
  const { id } = useParams({ from: "/datasets/$id" });
  return (
    <div className="page ds-page">
      <section className="ds-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/datasets" className="link">
            Datasets
          </Link>
          <span aria-hidden="true">/</span>
          {name !== undefined && (
            <span className="mono" aria-current="page">
              {name}
            </span>
          )}
        </nav>
        <div className="ds-title-row">
          <div className="ds-title">
            {naming ?? (
              <div className="ds-name-row">
                <PageHeading landing={!landed}>
                  <span className="title-id">{name ?? "Dataset"}</span>
                  {deleted && <span className="del-word">deleted</span>}
                </PageHeading>
                {rename}
              </div>
            )}
          </div>
          <div className="ds-actions">
            {exporter !== undefined ? (
              exporter.button
            ) : exportBlocker !== undefined ? (
              <BlockedExport blocker={exportBlocker} />
            ) : null}
            {duplicate}
            <Link
              to="/configs/new"
              search={{ dataset: id }}
              className="btn btn-primary"
              {...b.props}
              {...besideProps(exporter?.working)}
            >
              New config from this dataset
            </Link>
            {b.bubble}
          </div>
        </div>
        {facts !== undefined && <p className="facts ds-facts">{facts}</p>}
      </section>
      {children}
    </div>
  );
}

/**
 * Duplicate where there's nothing it can copy yet, saying why: as wide as the live one, which
 * keeps room for "Duplicating…", so Export beside it stays put.
 */
function BlockedDuplicate({ blocker }: { blocker: string }) {
  const b = useBlocker(blocker);
  const idle = useWorking();
  return (
    <>
      <WorkingButton type="button" className="btn" working={idle} words="Duplicating…" {...b.props}>
        Duplicate
      </WorkingButton>
      {b.bubble}
    </>
  );
}

/** Export where there's nothing it can export yet, saying why. */
function BlockedExport({ blocker }: { blocker: string }) {
  return useExport(undefined, blocker).button;
}

/**
 * An action beside Export while it works: from the press it does nothing, and
 * while the working state shows it's grayed, as a `BesideButton` is.
 */
function besideProps(working: Working | undefined): {
  "aria-disabled"?: true;
  onClickCapture?: (e: React.MouseEvent) => void;
} {
  if (working === undefined || !working.pending) return {};
  return {
    ...(working.shown ? { "aria-disabled": true } : {}),
    onClickCapture: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** A dataset this platform doesn't have: deleted, or never saved here. */
function NotHere({ platform }: { platform: Platform }) {
  return (
    <div className="page">
      <PageHeading>Dataset not found</PageHeading>
      <p className="facts">This dataset isn’t on {inSentence(platform)} any more.</p>
      <p>
        <Link to="/datasets" className="link">
          Go to Datasets
        </Link>
      </p>
    </div>
  );
}

/** What the next step is when a revision can't be read, by why. */
const UNREADABLE_NEXT: Record<UnreadableError["data"]["problem"], string | undefined> = {
  missing:
    "ICMM keeps each revision in its Data folder exactly as it was saved. If its folder was moved or deleted outside ICMM, put it back where it was.",
  damaged:
    "ICMM keeps each revision exactly as it was saved, and won’t change it. If its files were edited outside ICMM, put them back as they were.",
  newer: undefined,
};

/** Why New config from this dataset can't use a revision that can't be read. */
function unreadableBlocker(name: string | undefined, e: UnreadableError): string {
  const it = name ?? "this dataset";
  return e.data.problem === "newer"
    ? `Update ICMM on this computer to use ${it}.`
    : `ICMM can’t read ${it}, so a config can’t use it.`;
}

/** Why Export can't save a revision that can't be read. */
function unreadableExport(name: string | undefined, e: UnreadableError): string {
  const it = name ?? "this dataset";
  return e.data.problem === "newer"
    ? `Update ICMM on this computer to export ${it}.`
    : `ICMM can’t read ${it}, so it can’t export it.`;
}

/** Why Duplicate and New protocol… can't use a revision that can't be read. */
function unreadableChange(name: string | undefined, e: UnreadableError, doing: string): string {
  const it = name ?? "this dataset";
  return e.data.problem === "newer"
    ? `Update ICMM on this computer to change ${it}.`
    : `ICMM can’t read ${it}, so it can’t ${doing}.`;
}

/**
 * A dataset whose current revision can't be read: its failure, in the
 * three-line box. It can't be renamed, copied or added to, but it can be
 * deleted.
 */
function Unreadable({
  id,
  platform,
  error,
  listed,
  name,
}: {
  id: string;
  platform: Platform;
  error: UnreadableError;
  listed: DatasetSummary | undefined;
  name: string | undefined;
}) {
  const now = useNow([]);
  const points = listed?.protocols.reduce((n, p) => n + p.points, 0);
  const configs = useDatasetConfigs(id).data;
  return (
    <Frame
      name={name}
      blocker={unreadableBlocker(name, error)}
      exportBlocker={unreadableExport(name, error)}
      duplicate={<BlockedDuplicate blocker={unreadableChange(name, error, "copy it")} />}
      facts={
        listed !== undefined && points !== undefined ? (
          <>
            <span className="n">{listed.protocols.length}</span>{" "}
            {listed.protocols.length === 1 ? "protocol" : "protocols"} ·{" "}
            <span className="n">{points}</span> {points === 1 ? "point" : "points"}
            <ConfigsFact configs={configs} /> · modified {modifiedWords(listed.modified_at, now)}
          </>
        ) : undefined
      }
    >
      <div className="fail-box" role="alert">
        <div className="fail-say">
          <p className="fail-what">{error.message}</p>
          {UNREADABLE_NEXT[error.data.problem] !== undefined && (
            <p className="fail-next">{UNREADABLE_NEXT[error.data.problem]}</p>
          )}
          <p className="term fail-raw">unreadable · {error.data.details}</p>
        </div>
      </div>
      {configs !== undefined && <ConfigsFrom name={name ?? "this dataset"} configs={configs} />}
      <DatasetRuns id={id} name={name} />
      <ChangeSection
        id={id}
        name={name ?? "this dataset"}
        platform={platform.name}
        protocols={listed?.protocols.length ?? 0}
        configs={configs?.map((x) => x.name)}
        addBlocked={unreadableChange(name, error, "add to it")}
        onLeave={() => {}}
      />
    </Frame>
  );
}

/** The dataset as read: its facts, Jump to, each protocol, its runs, and its changes. */
function Shown({
  dataset: latest,
  platform,
  deletedAt,
}: {
  dataset: SavedDataset;
  platform: Platform;
  deletedAt?: number;
}) {
  const deleted = deletedAt !== undefined;
  const now = useNow([]);
  const navigate = useNavigate();
  const queries = useQueryClient();
  const configs = useDatasetConfigs(latest.id).data;
  const dsRuns = useDatasetRuns(latest.id);
  /** A copy's source, or the deleted dataset this one was saved again from, by id. */
  const from = useRouterState({ select: (s) => s.location.state.from });
  const fromConfigs = useDatasetConfigs(from).data?.length;

  /** The revisions this page saved: none of them is another computer's. */
  const [own, setOwn] = useState<ReadonlySet<number>>(() => new Set());
  const saidOwn = (revision: number) => setOwn((was) => new Set(was).add(revision));
  // A copy just duplicated opens with its name in the field.
  const copyOf = useRouterState({ select: (s) => s.location.state.copyOf });
  const [renaming, setRenaming] = useState<{ base: SavedDataset; copyOf?: string } | null>(() =>
    copyOf !== undefined ? { base: latest, copyOf } : null,
  );
  const [typed, setTyped] = useState(latest.content.name);
  /** A rename's save met another computer's: the note stays until Reload. */
  const [conflicted, setConflicted] = useState(false);
  const renameWrite = useDatasetWrite(platform.name);
  /** The protocol Remove… asks about, by name. */
  const [removing, setRemoving] = useState<string | null>(null);
  const removeWrite = useDatasetWrite(platform.name);
  const renameButton = useRef<HTMLButtonElement>(null);
  if (renaming !== null && latest.revision !== renaming.base.revision) {
    if (landed(latest.content, renameWrite.unconfirmed)) {
      // The rename landed and only its answer was lost: it's saved, not another computer's.
      saidOwn(latest.revision);
      setRenaming(null);
      renameWrite.setMessage(undefined);
    } else if (own.has(latest.revision)) {
      // This page's own save since the rename began: the rename goes on from it.
      setRenaming({ ...renaming, base: latest });
    }
  }
  if (removing !== null && landed(latest.content, removeWrite.unconfirmed)) {
    // The remove landed and only its answer was lost.
    setRemoving(null);
    removeWrite.setMessage(undefined);
  }
  // Changing validation points: the marks wanted, over the revision it began from.
  const [changing, setChanging] = useState<{ base: SavedDataset; wanted: Wanted } | null>(null);
  /** A save of the changes met another computer's: the note stays until Reload. */
  const [changeConflicted, setChangeConflicted] = useState(false);
  const [changeReloadIssue, setChangeReloadIssue] = useState<string>();
  const changeWrite = useDatasetWrite(platform.name);
  const changeButton = useRef<HTMLButtonElement>(null);
  if (changing !== null && latest.revision !== changing.base.revision) {
    if (landed(latest.content, changeWrite.unconfirmed)) {
      // The changes landed and only their answer was lost.
      saidOwn(latest.revision);
      setChanging(null);
      changeWrite.setMessage(undefined);
    } else if (own.has(latest.revision)) {
      // This page's own save since the change began, a rename or a remove: it goes on from it.
      const carried = reloadedWanted(changing.base.content, latest.content, changing.wanted);
      if (carried.ok) setChanging({ base: latest, wanted: carried.wanted });
    }
  }
  const naming = renaming !== null && !deleted;
  const stale = naming && (conflicted || latest.revision !== renaming.base.revision);
  const marking = changing !== null && !deleted;
  const changeStale = marking && (changeConflicted || latest.revision !== changing.base.revision);
  // Until Reload, the page shows the revision the rename or the change started from.
  const dataset = stale ? renaming.base : changeStale ? changing.base : latest;
  const { content, templates } = dataset;
  const name = content.name;
  /** What the page draws: the dataset, with the marks wanted while they change. */
  const marked = marking ? withWanted(content, changing.wanted) : content;
  const changes = marking ? changesIn(content, changing.wanted) : 0;
  const all = marked.protocols.flatMap((p) => p.points);
  const counts = {
    points: all.length,
    interpolated: all.filter((p) => p.interpolated).length,
    validation: all.filter((p) => p.validation).length,
  };

  const closeRename = () => {
    setRenaming(null);
    setConflicted(false);
    renameWrite.setMessage(undefined);
    setTimeout(() => renameButton.current?.focus());
  };
  const saved = (next: SavedDataset) => {
    saidOwn(next.revision);
    queries.setQueryData(datasetKey(getConnection(), next.id), next);
    closeRename();
  };
  const reload = () => {
    if (renaming === null) return;
    setRenaming({ ...renaming, base: latest });
    setConflicted(false);
    renameWrite.setMessage(undefined);
  };
  const onTyped = useCallback((t: string) => setTyped(t), []);

  const remove = async (protocol: string) => {
    const at = content.protocols.findIndex((p) => p.name === protocol);
    const next = {
      ...dataset,
      content: { ...content, protocols: content.protocols.filter((_, i) => i !== at) },
      templates: templates.filter((_, i) => i !== at),
    };
    const { id, revision } = dataset;
    const done = await removeWrite.run(
      { id, revision, content: next.content },
      (key) =>
        commands.save_dataset({
          request_key: key,
          id,
          expected_revision: revision,
          content: next.content,
        }),
      { content: next.content },
    );
    if (done.ok) {
      saidOwn(done.value.revision);
      queries.setQueryData(datasetKey(getConnection(), id), {
        ...next,
        revision: done.value.revision,
        modified_at: new Date().toISOString(),
      });
      setRemoving(null);
      // Focus goes to the protocol that takes its place, or the one before it.
      const land = next.content.protocols[Math.min(at, next.content.protocols.length - 1)];
      setTimeout(() =>
        document.getElementById(sectionId(land))?.querySelector<HTMLElement>("h2")?.focus(),
      );
    } else if (done.code === "conflict") {
      removeWrite.setMessage(
        `Another computer saved ${name} as you pressed. It shows here now: Remove ${protocol} again to save it without ${protocol}.`,
      );
    } else if (done.code === "invalid") {
      removeWrite.setMessage(done.issues[0]?.message);
    }
  };

  // Deleted elsewhere, the page's revision can be saved again as a new dataset (DS07).
  const againWrite = useDatasetWrite(platform.name);
  const saveAgain = async () => {
    const { id, revision } = dataset;
    const done = await againWrite.run(
      { id, revision },
      (key) => commands.save_as_new_dataset({ request_key: key, id, revision }),
      {
        words: {
          happened: `${name} saved as a new dataset`,
          again: "Saving",
          safe: "it won’t make a second copy",
        },
      },
    );
    if (done.ok) {
      // The new dataset is what the page shows, under the name it was saved with.
      queries.setQueryData(datasetKey(getConnection(), done.value.id), {
        ...dataset,
        id: done.value.id,
        revision: done.value.revision,
        modified_at: new Date().toISOString(),
        content: { ...content, name: done.value.name },
      } satisfies SavedDataset);
      guard.pass();
      await navigate({
        to: "/datasets/$id",
        params: { id: done.value.id },
        state: { savedAgain: name, from: dataset.id },
      });
    } else if (done.code === "not_found") {
      againWrite.setMessage("This dataset isn’t on this platform any more.");
    }
  };

  const duplicateWrite = useDatasetWrite(platform.name);
  const duplicate = async () => {
    const { id, revision } = dataset;
    const done = await duplicateWrite.run(
      { id, revision },
      (key) => commands.duplicate_dataset({ request_key: key, id, revision }),
      { words: { ...savedWords(`the copy of ${name}`), again: "Duplicating" } },
    );
    if (done.ok) {
      guard.pass();
      await navigate({
        to: "/datasets/$id",
        params: { id: done.value.id },
        state: { copyOf: name, from: id },
      });
    }
  };

  const changed = naming && typed !== renaming.base.content.name;
  const [deleting, setDeleting] = useState(false);
  const waiting =
    (renameWrite.working.pending ||
      removeWrite.working.pending ||
      duplicateWrite.working.pending ||
      againWrite.working.pending ||
      changeWrite.working.pending ||
      deleting) &&
    getConnection().status !== "connected";
  const guard = useLeaveGuard({
    asks: changed || changes > 0 || waiting,
    waiting,
    what:
      changes > 1 && !changed
        ? { one: false, text: `Your ${changes} changes to ${name}’s validation points` }
        : { one: true, text: `Your change to ${name}` },
  });

  const startChange = () => {
    changeWrite.setMessage(undefined);
    setChangeConflicted(false);
    setChangeReloadIssue(undefined);
    setChanging({ base: dataset, wanted: {} });
    // The bar takes focus from the button it replaces.
    setTimeout(() => document.getElementById("vbar-title")?.focus());
  };
  const closeChange = () => {
    setChanging(null);
    setChangeConflicted(false);
    setChangeReloadIssue(undefined);
    changeWrite.setMessage(undefined);
    setTimeout(() => changeButton.current?.focus());
  };
  const reloadChange = () => {
    if (changing === null) return;
    const carried = reloadedWanted(changing.base.content, latest.content, changing.wanted);
    if (!carried.ok) {
      setChangeReloadIssue(
        `ICMM couldn’t match ${carried.protocol}’s points to the new revision with certainty. Your pending marks are still shown on the earlier revision. Cancel discards them so you can start again on the new revision.`,
      );
      return;
    }
    setChanging({ base: latest, wanted: carried.wanted });
    setChangeConflicted(false);
    setChangeReloadIssue(undefined);
    changeWrite.setMessage(undefined);
  };
  const redrawAll = async () => {
    const started = changing;
    changeWrite.setMessage(undefined);
    try {
      const drawn = await Promise.all(
        // Each protocol proposes the share it keeps (#166).
        content.protocols.map((p) => commands.propose_split({ protocol: p })),
      );
      // Edits, Reload, Cancel and a new changing session supersede this draw.
      setChanging((c) => (c === null || c !== started ? c : { ...c, wanted: wantedOf(drawn) }));
    } catch (error) {
      changeWrite.setMessage(
        (error as Partial<WireError>).message ?? "Couldn’t redraw. Try again.",
      );
      throw error;
    }
  };
  const saveChanges = async () => {
    if (changing === null) return;
    const base = changing.base;
    const next = withWanted(base.content, changing.wanted);
    const { id, revision } = base;
    const done = await changeWrite.run(
      { id, revision, content: next },
      (key) =>
        commands.save_dataset({ request_key: key, id, expected_revision: revision, content: next }),
      { content: next },
    );
    if (done.ok) {
      saidOwn(done.value.revision);
      queries.setQueryData(datasetKey(getConnection(), id), {
        ...base,
        revision: done.value.revision,
        modified_at: new Date().toISOString(),
        content: next,
      } satisfies SavedDataset);
      closeChange();
    } else if (done.code === "conflict") {
      setChangeConflicted(true);
    } else if (done.code === "invalid") {
      changeWrite.setMessage(done.issues[0]?.message);
    }
  };
  // Saving keeps one train point in the dataset: the platform's checks say so before Save.
  const checked = useDatasetIssues(
    marking && changes > 0 ? withWanted(changing.base.content, changing.wanted) : null,
    dataset.id,
  );
  const keepOne = keepOneTrain(checked.issues ?? []);
  const gone = deleted ? `Another computer deleted ${name}.` : undefined;
  // A deleted dataset's revisions stay, so Export still saves the one the page shows.
  const exporter = useExport(
    { id: dataset.id, revision: dataset.revision, name, protocols: content.protocols.length },
    undefined,
  );
  // ⌘K's Export <dataset>… opens the page to export it.
  useAsked(
    useSearch({ from: "/datasets/$id" }).start,
    true,
    () => exporter.start(),
    () =>
      void navigate({
        to: "/datasets/$id",
        params: { id: latest.id },
        search: {},
        replace: true,
      }),
  );
  /** Saved again as a new dataset from a deleted one: the deleted one's name. */
  const savedAgain = useRouterState({ select: (s) => s.location.state.savedAgain });
  // Back from the builder, the page lands where it was opened: the protocol, or New protocol….
  const land = useRouterState({ select: (s) => s.location.state.land });
  const landsOn =
    land === "new-protocol" || content.protocols.some((p) => sectionId(p) === land)
      ? land
      : undefined;

  return (
    <Frame
      name={name}
      deleted={deleted}
      blocker={gone}
      exporter={exporter}
      landed={landsOn !== undefined && !naming}
      naming={
        naming ? (
          <Rename
            base={renaming.base}
            platform={platform.name}
            copyOf={renaming.copyOf}
            stale={stale}
            write={renameWrite}
            onCancel={closeRename}
            onSaved={saved}
            onConflict={() => setConflicted(true)}
            onTyped={onTyped}
          />
        ) : undefined
      }
      rename={
        deleted ? undefined : (
          <button
            type="button"
            className="btn btn-sm"
            ref={renameButton}
            {...besideProps(exporter.working)}
            onClick={() => {
              setTyped(name);
              setRenaming({ base: dataset });
            }}
          >
            Rename
          </button>
        )
      }
      duplicate={
        deleted ? (
          <span className="ds-dup">
            <WorkingButton
              type="button"
              className="btn"
              working={againWrite.working}
              words="Saving…"
              {...besideProps(exporter.working)}
              onClick={() => void saveAgain()}
            >
              Save as a new dataset
            </WorkingButton>
            {againWrite.message !== undefined && (
              <span className="err ds-dup-message" role="alert">
                {againWrite.message}
              </span>
            )}
          </span>
        ) : (
          <span className="ds-dup">
            <WorkingButton
              type="button"
              className="btn"
              working={duplicateWrite.working}
              words="Duplicating…"
              {...besideProps(exporter.working)}
              onClick={() => void duplicate()}
            >
              Duplicate
            </WorkingButton>
            {duplicateWrite.message !== undefined && (
              <span className="err ds-dup-message" role="alert">
                {duplicateWrite.message}
              </span>
            )}
          </span>
        )
      }
      facts={
        <>
          <span className="n">{marked.protocols.length}</span>{" "}
          {content.protocols.length === 1 ? "protocol" : "protocols"} ·{" "}
          <PointsFacts counts={counts} />
          <ConfigsFact configs={configs} />
          <RunsFact runs={dsRuns} /> · modified {modifiedWords(dataset.modified_at, now)}
        </>
      }
    >
      {exporter.outcome}
      {marking && (
        <ChangeBar
          name={name}
          runs={dsRuns}
          held={counts.validation}
          points={counts.points}
          changes={changes}
          saving={changeWrite.working}
          saveBlocked={
            changeStale
              ? "Reload first"
              : changes === 0
                ? "No changes yet"
                : keepOne !== undefined && checked.current
                  ? keepOne.message
                  : undefined
          }
          message={changeWrite.message}
          redraw={redrawAll}
          none={() =>
            setChanging({
              ...changing,
              wanted: wantedOf(
                content.protocols.map((p) => ({ name: p.name, points: unmarked(p.points) })),
              ),
            })
          }
          cancel={closeChange}
          save={() => void saveChanges()}
        />
      )}
      {changeStale && (
        <div className="note-ask" role="status">
          <p>
            {own.has(latest.revision) ? "This page saved " : "Another computer saved "}
            {changing.base.content.name} since you started changing its validation points.
            <span className="hint">
              {changeReloadIssue === undefined ? (
                `Reload shows its ${latest.content.name} and keeps the points you switched.`
              ) : (
                <span className="err" role="alert">
                  {changeReloadIssue}
                </span>
              )}
            </span>
          </p>
          <button type="button" className="btn btn-sm" onClick={reloadChange}>
            Reload
          </button>
        </div>
      )}
      {deleted && (
        <div className="note-ask" role="status">
          <p>
            Another computer deleted {name} at {clock(deletedAt, now)}.
            <span className="hint">
              This page shows {name} as it was. Save as a new dataset keeps a copy on{" "}
              {inSentence(platform)}, and Export saves one to a file.
            </span>
          </p>
          <Link to="/datasets" className="btn btn-sm">
            Go to Datasets
          </Link>
        </div>
      )}
      {savedAgain !== undefined && !deleted && (
        <div className="note-ask" role="status">
          <p>
            Saved {savedAgain} again, as a new dataset.
            <span className="hint">It starts with no runs.</span>
          </p>
        </div>
      )}
      {stale && renaming !== null && (
        <div className="note-ask" role="status">
          <p>
            Another computer saved {renaming.base.content.name} since you started renaming it.
            <span className="hint">
              Reload shows its {latest.content.name} and keeps your new name.
            </span>
          </p>
          <button type="button" className="btn btn-sm" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      <nav aria-label="Protocols in this dataset" className="dd-jumps">
        <span className="label">Jump to</span>
        {content.protocols.map((p, i) => (
          <a
            key={p.name}
            href={`#${sectionId(p)}`}
            className="dd-jump"
            onClick={(e) => {
              e.preventDefault();
              const target = document.getElementById(sectionId(p));
              target?.scrollIntoView({ block: "start" });
              target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
            }}
          >
            <span className="mono dd-jump-name">{p.name}</span>
            <span>{templateWords(templates[i], p.steps.length)}</span>
          </a>
        ))}
      </nav>
      <div className="dd-protocols">
        <Legend
          interpolated={counts.interpolated > 0}
          validation={counts.validation > 0}
          change={
            marking || deleted ? undefined : (
              <button
                type="button"
                className="btn btn-sm dd-vchange"
                ref={changeButton}
                {...besideProps(exporter.working)}
                onClick={startChange}
              >
                Change validation points
              </button>
            )
          }
        />
        {marked.protocols.map((p, i) => (
          <ProtocolSection
            key={p.name}
            protocol={p}
            template={templates[i]}
            onSwitch={
              marking
                ? (x) =>
                    setChanging({
                      ...changing,
                      wanted: switched(changing.wanted, marked, p.name, x),
                    })
                : undefined
            }
            landing={landsOn === sectionId(p) && !naming}
            actions={{
              datasetId: dataset.id,
              dataset: name,
              blocked: gone,
              only: content.protocols.length === 1,
              asking: removing === p.name && gone === undefined,
              write: removeWrite,
              onAsk: () => {
                removeWrite.setMessage(undefined);
                setRemoving(p.name);
              },
              onKeep: () => setRemoving(null),
              onRemove: () => void remove(p.name),
            }}
          />
        ))}
      </div>
      {configs !== undefined && (
        <ConfigsFrom
          name={name}
          configs={configs}
          copyOf={
            copyOf !== undefined && fromConfigs !== undefined
              ? { name: copyOf, configs: fromConfigs }
              : undefined
          }
          savedFrom={
            savedAgain !== undefined && fromConfigs !== undefined && !deleted
              ? { name: savedAgain, configs: fromConfigs }
              : undefined
          }
          gone={deleted}
        />
      )}
      <DatasetRuns id={dataset.id} name={name} />
      <ChangeSection
        id={dataset.id}
        name={name}
        platform={platform.name}
        protocols={content.protocols.length}
        configs={configs?.map((x) => x.name)}
        blocked={gone}
        landing={landsOn === "new-protocol" && !naming}
        onPending={setDeleting}
        onLeave={guard.pass}
      />
      {guard.dialog}
    </Frame>
  );
}

const sectionId = (p: Protocol) => `protocol-${p.name}`;

/** A fraction of the peak as the Window menu writes it: 0.37 → 37. */
const percent = (f: number) => Math.round(f * 1000) / 10;

/** What the charts' marks mean, then Change validation points. */
function Legend({
  interpolated,
  validation,
  change,
}: {
  interpolated: boolean;
  validation: boolean;
  change?: React.ReactNode;
}) {
  return (
    <div className="dd-legend">
      <span className="key">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none" aria-hidden="true">
          <path d="M5 1v12M2.5 1h5M2.5 13h5" className="whisker-glyph" />
          <circle cx="5" cy="7" r="2.4" className="dot-glyph" />
        </svg>
        mean ± SD
      </span>
      {interpolated && (
        <span className="key">
          <span aria-hidden="true" className="dd-glyph added" />
          interpolated · no SD
        </span>
      )}
      <span className="key">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" className="ring-glyph" />
          <circle cx="7" cy="7" r="2.2" className="dot-glyph" />
        </svg>
        the point read out under its chart, and drawn dark at right — hover a point to switch
      </span>
      {validation ? (
        <span className="key">
          <span aria-hidden="true" className="dd-glyph held" />
          {interpolated && <span aria-hidden="true" className="dd-glyph added held" />}
          validation
        </span>
      ) : (
        <span className="key">no validation points</span>
      )}
      {change}
    </div>
  );
}

/** What a protocol's name line offers: Edit protocol… and Remove…, and Remove…'s question. */
interface ProtocolActions {
  datasetId: string;
  dataset: string;
  /** Why neither can be used, if they can't: deleted on another computer. */
  blocked?: string;
  /** It's the dataset's only protocol, so Remove… says why it can't. */
  only: boolean;
  /** Remove… asks now, across the protocol's top. */
  asking: boolean;
  write: DatasetWrite;
  onAsk: () => void;
  onKeep: () => void;
  onRemove: () => void;
}

/** A protocol: its facts, then its data and its voltage command. */
function ProtocolSection({
  protocol: p,
  template,
  landing,
  actions: a,
  onSwitch,
}: {
  protocol: Protocol;
  template: Template;
  /** The page lands on its heading. */
  landing: boolean;
  actions: ProtocolActions;
  /** While validation points change, clicking a point switches it. */
  onSwitch?: (x: number) => void;
}) {
  const sweeps = sweepsOf(p);
  const [hi, setHi] = useState(Math.floor(sweeps.length / 2));
  const shape = templateWords(template, p.steps.length);
  const axes = axisTitles(p, template);
  const facts = protocolFacts(p, template);
  const measure = p.steps.find((s) => s.measure !== null)?.measure;
  const dark = sweeps[Math.min(hi, sweeps.length - 1)];
  const words = pointWords(sweptUnit(p) === "ms", measure?.kind, p.normalized);
  // The point drawn dark, read out under its chart (DS06).
  const measured = p.points.filter((q) => !q.interpolated);
  const read = measured[Math.min(hi, measured.length - 1)] as Point | undefined;
  const readout = read === undefined ? undefined : readoutWords(p, template, read, words);
  const edit = useBlocker(a.blocked);
  const remove = useBlocker(a.blocked);
  const removeButton = useRef<HTMLButtonElement>(null);
  const askTitle = useRef<HTMLSpanElement>(null);
  const asked = useRef(a.asking);
  useEffect(() => {
    if (asked.current === a.asking) return;
    asked.current = a.asking;
    // Asking, focus goes to the question; keeping it, back to Remove….
    (a.asking ? askTitle : removeButton).current?.focus();
  }, [a.asking]);
  const id = sectionId(p);
  const onlyWhy = `${p.name} is ${a.dataset}’s only protocol, and a dataset keeps at least one. Add another with New protocol… first, or delete ${a.dataset}.`;
  return (
    <section
      id={id}
      aria-label={`${p.name} — ${shape}`}
      className={`dd-protocol${a.asking ? " asking" : ""}`}
    >
      {a.asking && (
        <div
          className="dd-ask dd-remove"
          role="alertdialog"
          aria-labelledby={`${id}-rm-t`}
          aria-describedby={`${id}-rm-b`}
        >
          <div className="dd-ask-text">
            <span id={`${id}-rm-t`} className="dd-ask-title" tabIndex={-1} ref={askTitle}>
              Remove {p.name} from {a.dataset}?
            </span>
            <span id={`${id}-rm-b`}>
              This saves {a.dataset} without {p.name}, as a new revision. New protocol… can add{" "}
              {p.name} again from its workbook.
            </span>
            {a.write.message !== undefined && (
              <span className="dd-ask-message" role="alert">
                {a.write.message}
              </span>
            )}
          </div>
          <div className="dd-ask-actions">
            <BesideButton
              type="button"
              className="btn btn-sm"
              working={a.write.working}
              onClick={a.onKeep}
            >
              Keep it
            </BesideButton>
            <WorkingButton
              type="button"
              className="btn btn-sm btn-danger"
              working={a.write.working}
              words="Removing…"
              onClick={a.onRemove}
            >
              Remove {p.name}
            </WorkingButton>
          </div>
        </div>
      )}
      <div className="dd-proto-facts">
        <div className="dd-proto-head">
          <h2
            className="mono dd-proto-name"
            tabIndex={-1}
            {...(landing ? { [PAGE_HEADING_ATTR]: "" } : {})}
          >
            {p.name}
          </h2>
          <span className="dd-proto-acts">
            <Link
              to="/datasets/$id/protocols/$protocol"
              params={{ id: a.datasetId, protocol: p.name }}
              className="btn btn-sm"
              {...edit.props}
            >
              Edit protocol…
            </Link>
            {edit.bubble}
            {a.only && a.blocked === undefined ? (
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled="true"
                aria-describedby={`${id}-only`}
              >
                Remove…
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                ref={removeButton}
                {...remove.props}
                onClick={(e) => {
                  remove.props.onClick(e);
                  if (a.blocked === undefined) a.onAsk();
                }}
              >
                Remove…
              </button>
            )}
            {remove.bubble}
          </span>
        </div>
        <div className="dd-proto-body">
          <div className="dd-proto-shape">{shape}</div>
          {a.only && a.blocked === undefined && (
            <p id={`${id}-only`} className="hint dd-proto-why">
              {onlyWhy}
            </p>
          )}
          <dl className="dd-meta">
            {facts.map((f) => (
              <div key={f.k} className="dd-meta-row">
                <dt>{f.k}</dt>
                <dd className={f.wraps ? "wraps" : undefined}>
                  {f.k === "Source" && p.source !== null ? <SourceWords source={p.source} /> : f.v}
                </dd>
              </div>
            ))}
          </dl>
          {measure?.kind === "decay_time" && (
            <p className="dd-proto-note">
              {windowWords(percent(measure.from), percent(measure.to))}
            </p>
          )}
        </div>
      </div>
      <figure className="dd-proto-fig">
        <figcaption>
          <span className="label">Dataset</span>
          <span className="fig-title">{axes.y}</span>
        </figcaption>
        <div className="fig-body">
          <PointsChart
            protocol={p}
            logx={logX(p)}
            hi={hi}
            onPick={setHi}
            label={
              onSwitch === undefined
                ? pointsLabel(p)
                : `${pointsLabel(p)}. Each point switches between train and validation.`
            }
            onSwitch={onSwitch}
            words={words}
            pickName={(q) => sweepWords(p, template, q.x)}
          />
          <div className="fig-foot">
            <span className="grow rdo" aria-live="polite" aria-atomic="true">
              {readout !== undefined && (
                <>
                  <span className="mono ink">{readout.values}</span>
                  {readout.marks}
                </>
              )}
            </span>
            <span>{axes.x}</span>
          </div>
        </div>
      </figure>
      <figure className="dd-proto-fig">
        <figcaption>
          <span className="label">Protocol</span>
          <span className="fig-title">Voltage command (mV)</span>
        </figcaption>
        <div className="fig-body">
          <SweepsChart
            protocol={p}
            sweeps={sweeps}
            hi={hi}
            label={`${p.name} voltage protocol, ${count(sweeps.length, "sweep")}`}
          />
          <div className="fig-foot">
            <span className="grow">
              <span className="mono">{sweeps.length}</span>{" "}
              {sweeps.length === 1 ? "sweep" : "sweeps"}
              {dark !== undefined && (
                <>
                  {" "}
                  · <span className="ink">{sweepWords(p, template, dark)}</span> drawn dark
                </>
              )}
            </span>
            <span>Time (ms)</span>
          </div>
        </div>
      </figure>
    </section>
  );
}

/** A protocol's Source, which breaks only between the workbook and sheet. */
function SourceWords({ source }: { source: NonNullable<Protocol["source"]> }) {
  return (
    <>
      <span className="nw">{source.workbook} ›</span> <span className="nw">{source.sheet}</span>
    </>
  );
}
