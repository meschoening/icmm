/**
 * The Protocol builder on a saved dataset (#146; LaptopProtocolBuilder views
 * custom, edit and stale): New protocol… adds one, and Edit protocol…
 * changes one; each Save protocol saves a new revision of the dataset
 * (`save_dataset` over the revision it opened on), and Cancel and Save go
 * back to Dataset detail, at that protocol.
 *
 * Edit protocol… starts from the protocol as saved: its measured points show
 * as a sheet named for its Source, whose columns are x, y and SD, since the
 * workbook isn't kept, and its points keep their interpolated points and
 * marks until its data or interpolation changes. Change…, and a new
 * protocol's Choose…, read a sheet from any workbook; this computer's
 * engine makes its points afresh, interpolated as set, with a proposed
 * split, as the wizard does (#145, ADR-0011).
 *
 * Another computer's save while it's open gets section 1's note with
 * Reload, which keeps the fields you changed, and Save waits for it; a
 * delete gets Dataset detail's note. Leaving with a change asks first. As
 * in Settings (#164), the note names the fields they changed, and after
 * Reload each one says "From another computer · was …"; each field you
 * changed says "Changed · was …".
 */
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useNow } from "../../connection/useNow";
import { FailureBox } from "../../setup/FailureBox";
import { Reading } from "../../setup/PlatformSetup";
import { inSentence } from "../../setup/form";
import { useReadAgain } from "../../setup/queries";
import { getConnection, useConnection } from "../../shell/connection";
import { clock } from "../../ui/clock";
import { useDatasetRuns } from "../../runs/queries";
import { revisionRunsWords } from "../../runs/words";
import { useSystemDialog } from "../../ui/gray";
import { PageHeading } from "../../ui/PageHeading";
import { commands } from "../../wire/api.gen";
import type { Protocol, SavedDataset, Template, WireError } from "../../wire/types.gen";
import { datasetKey, useActivePlatform, useDataset } from "../detail/read";
import { ShowOnceConnected } from "../detail/ShowOnceConnected";
import { landed, useDatasetWrite } from "../detail/write";
import { useLeaveGuard } from "../leaveGuard";
import {
  openingSheet,
  protocolNames,
  readSheet,
  savedSheet,
  unique,
  type SheetRead,
} from "../sheets";
import { failureWords, type ReadFailure } from "../readFailure";
import {
  blankDraft,
  changesOf,
  draftOf,
  elsewhereNotice,
  fieldMarks,
  reloadDraft,
  sharedHolding,
  withVoltages,
  type BuilderDraft,
} from "./model";
import { ProtocolBuilder } from "./ProtocolBuilder";
import { ReportFromHere } from "../../report/ReportFromHere";

export function NewProtocolPage() {
  const { id } = useParams({ from: "/datasets/$id/new-protocol" });
  return <SavedProtocol key={`${id}/new`} id={id} editing={null} />;
}

export function EditProtocolPage() {
  const { id, protocol } = useParams({ from: "/datasets/$id/protocols/$protocol" });
  return <SavedProtocol key={`${id}/${protocol}`} id={id} editing={protocol} />;
}

/** The dataset read, then the builder on it; until then, where the read is. */
function SavedProtocol({ id, editing }: { id: string; editing: string | null }) {
  const c = useConnection();
  const platform = useActivePlatform();
  const q = useDataset(id);
  const error = q.isError ? (q.error as unknown as WireError) : undefined;
  const read = useReadAgain(q.data === undefined ? error : undefined, q.refetch);
  /** The revision it opened on: what its changes are to, until Reload. */
  const [opened, setOpened] = useState<SavedDataset>();
  if (opened === undefined && q.data !== undefined) setOpened(q.data);
  // A delete after it opened comes back as `not_found`: the builder keeps what it showed.
  const [deletedAt, setDeletedAt] = useState<number>();
  if (opened !== undefined && error?.code === "not_found" && deletedAt === undefined) {
    setDeletedAt(q.errorUpdatedAt);
  }

  const title = editing === null ? "New protocol" : "Edit protocol";
  if (opened !== undefined && platform !== undefined) {
    const protocol =
      editing === null ? null : opened.content.protocols.find((p) => p.name === editing);
    if (protocol === undefined) {
      return (
        <Waiting id={id} name={opened.content.name} editing={editing} title={title}>
          <p className="facts">
            {opened.content.name} has no protocol named <span className="mono">{editing}</span>.
          </p>
        </Waiting>
      );
    }
    return (
      <Builder
        opened={opened}
        latest={q.data}
        protocol={protocol}
        platform={platform.name}
        connected={c.status === "connected"}
        deletedAt={deletedAt}
      />
    );
  }
  if (platform === undefined || c.status !== "connected") {
    return (
      <Waiting id={id} editing={editing} title={title}>
        <ShowOnceConnected platform={platform} one>
          this dataset
        </ShowOnceConnected>
      </Waiting>
    );
  }
  if (error !== undefined && error.code !== "not_found") {
    return (
      <Waiting id={id} editing={editing} title={title}>
        <FailureBox
          error={error}
          task="dataset"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      </Waiting>
    );
  }
  if (error?.code === "not_found") {
    return (
      <Waiting id={id} editing={editing} title={title}>
        <p className="facts">This dataset isn’t on {inSentence(platform)} any more.</p>
      </Waiting>
    );
  }
  return (
    <Waiting id={id} editing={editing} title={title}>
      <Reading>
        <span>Reading the dataset on {inSentence(platform)}…</span>
      </Reading>
    </Waiting>
  );
}

/** The builder's place while its dataset isn't there to build on. */
function Waiting({
  id,
  name,
  editing,
  title,
  children,
}: {
  id: string;
  name?: string;
  editing: string | null;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="page ds-page">
      <section className="ds-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/datasets" className="link">
            Datasets
          </Link>
          <span aria-hidden="true">/</span>
          <Link to="/datasets/$id" params={{ id }} className="link mono">
            {name ?? "Dataset"}
          </Link>
          <span aria-hidden="true">/</span>
          <span className={editing === null ? undefined : "mono"} aria-current="page">
            {editing ?? "New protocol"}
          </span>
        </nav>
        <PageHeading>{title}</PageHeading>
      </section>
      <ReportFromHere name={`${title} in ${name ?? "a dataset"}`} />
      {children}
    </div>
  );
}

/** The workbook Change… or Choose… read, and the sheet of it the protocol's data comes from. */
interface Book {
  workbook: string;
  sheets: SheetRead[];
  sheet: string;
}

/** A sheet's columns for x, y and SD: as its template names them, else its first three. */
function rolesOf(read: SheetRead): BuilderDraft["roles"] {
  const { x, y, sd } = read.roles;
  if (x !== undefined && y !== undefined) return { x, y, ...(sd !== undefined ? { sd } : {}) };
  const n = read.columns.length;
  return {
    x: n > 0 ? 0 : undefined,
    y: n > 1 ? 1 : undefined,
    ...(n > 2 ? { sd: 2 } : {}),
  };
}

function Builder({
  opened,
  latest,
  protocol,
  platform,
  connected,
  deletedAt,
}: {
  opened: SavedDataset;
  latest: SavedDataset | undefined;
  /** The protocol it edits, as saved when it opened; `null` for a new one. */
  protocol: Protocol | null;
  platform: string;
  connected: boolean;
  deletedAt: number | undefined;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const now = useNow([]);
  const editing = protocol?.name ?? null;
  /** The revision its changes are to: the one it opened on, or the one Reload showed. */
  const [base, setBase] = useState(opened);
  const openedAt =
    editing === null ? -1 : opened.content.protocols.findIndex((p) => p.name === editing);
  /** Where it is in `base`; `-1` when Reload showed a revision without it, which it goes back into. */
  const found = editing === null ? -1 : base.content.protocols.findIndex((p) => p.name === editing);
  const index =
    found >= 0
      ? found
      : editing === null
        ? base.content.protocols.length
        : Math.min(openedAt, base.content.protocols.length);
  const atBase = found >= 0 ? base.content.protocols[found] : protocol;
  /** What it started from, as a draft: the protocol as saved, or Blank at the dataset's hold. */
  const start = (p: Protocol | null): BuilderDraft =>
    p === null
      ? blankDraft("protocol", {}, sharedHolding(base.content.protocols))
      : draftOf(p, rolesOf(savedSheet(p)));
  const [from, setFrom] = useState(() => start(atBase));
  /** What it opened on, which Reload's marks say each of their fields was. */
  const [first] = useState(from);
  const [draft, setDraft] = useState(from);
  const [book, setBook] = useState<Book | null>(null);
  /** The name a new protocol was given from its sheet, which it keeps following until typed. */
  const [proposed, setProposed] = useState<string>();
  const [failure, setFailure] = useState<ReadFailure>();
  const [conflicted, setConflicted] = useState(false);
  const write = useDatasetWrite(platform);
  const dialog = useSystemDialog();

  const name = base.content.name;
  const runs = useDatasetRuns(base.id);
  const sheet = book?.sheets.find((s) => s.name === book.sheet) ?? null;
  const read = sheet ?? (atBase === null ? null : savedSheet(atBase));
  const others = base.content.protocols.filter((_, i) => i !== found);
  const changes = editing === null ? 0 : changesOf(from, draft, book !== null);
  const deleted = deletedAt !== undefined;
  // A save whose answer was lost, but which landed: it's saved, so it goes back as one does.
  const [goneBack, setGoneBack] = useState(false);
  if (!goneBack && latest !== undefined && landed(latest.content, write.unconfirmed)) {
    setGoneBack(true);
    setTimeout(() => back(`protocol-${draft.name}`));
  }
  const stale =
    !deleted && (conflicted || (latest !== undefined && latest.revision !== base.revision));

  const waiting = write.working.pending && getConnection().status !== "connected";
  const guard = useLeaveGuard({
    asks:
      (editing === null ? changesOf(start(null), draft, book !== null) > 0 : changes > 0) ||
      waiting,
    waiting,
    what:
      editing === null
        ? { one: true, text: `Your new protocol in ${name}` }
        : {
            one: changes <= 1,
            text:
              changes <= 1 ? `Your change to ${editing}` : `Your ${changes} changes to ${editing}`,
          },
  });

  /**
   * Back to Dataset detail, landing on `land`'s element. A protocol's section scrolls to the
   * top, as Jump to has it: focus alone doesn't move the page when the heading is already in
   * view, low on the screen (#560). New protocol… stays where it was.
   */
  const back = (land: string) => {
    guard.pass();
    void navigate({
      to: "/datasets/$id",
      params: { id: base.id },
      state: { land },
      ...(land === "new-protocol" ? {} : { hash: land, hashScrollIntoView: { block: "start" } }),
    });
  };

  /** The template the steps had at the press, else the protocol's as saved. */
  const templateOr = (template: Template | undefined) =>
    template ?? (found >= 0 ? base.templates[found] : undefined);

  const choose = async (template: Template | undefined) => {
    const chosen = await dialog.open(() =>
      commands.choose_workbook({ title: "Choose a workbook", folder: null }),
    );
    if (chosen.path === null) return;
    setFailure(undefined);
    const file = chosen.path.split(/[/\\]/).pop() ?? chosen.path;
    try {
      const workbook = await commands.read_workbook({ path: chosen.path });
      if (workbook.problem !== null) {
        setFailure({ workbook });
        return;
      }
      const sheets = workbook.sheets.map(readSheet).filter((s) => !s.skipped);
      if (sheets.length === 0) {
        setFailure({ workbook, noNumbers: true });
        return;
      }
      // The protocol's Source sheet, else its template's, else the first (#168).
      const opening = openingSheet(
        sheets,
        book?.sheet ?? atBase?.source?.sheet,
        templateOr(template),
      );
      setBook({ workbook: workbook.name, sheets, sheet: opening.name });
      setDraft(withSheet(opening, template));
    } catch (error) {
      setFailure({
        workbook: {
          name: file,
          bytes: null,
          problem: "unreadable",
          detail: (error as Partial<WireError>)?.message ?? String(error),
          sheets: [],
        },
      });
    }
  };
  const pickSheet = (s: string, template: Template | undefined) => {
    const next = book?.sheets.find((x) => x.name === s);
    if (book === null || next === undefined) return;
    setBook({ ...book, sheet: s });
    setDraft(withSheet(next, template));
  };
  /**
   * The draft on another sheet: its columns mapped, its V0 and V1 read into
   * its voltages, and a new protocol named for it until typed.
   */
  const withSheet = (s: SheetRead, template: Template | undefined): BuilderDraft => {
    // A new protocol's name follows its sheet until it's typed.
    const named = editing === null && (draft.name === from.name || draft.name === proposed);
    const taken = new Set(others.map((p) => p.name.toLowerCase()));
    const name = named ? unique(protocolNames([s.name])[0], 32, taken) : draft.name;
    if (named) setProposed(name);
    return withVoltages({ ...draft, roles: rolesOf(s), name }, s, templateOr(template));
  };

  const reload = () => {
    if (latest === undefined) return;
    const theirs =
      editing === null ? null : latest.content.protocols.find((p) => p.name === editing);
    if (theirs != null) {
      const next = start(theirs);
      setDraft(reloadDraft(from, draft, next));
      setFrom(next);
    }
    setBase(latest);
    setConflicted(false);
    write.setMessage(undefined);
  };

  const save = async (template: Template, made: Protocol) => {
    const protocols = [...others.slice(0, index), made, ...others.slice(index)];
    const content = { ...base.content, protocols };
    const { id, revision } = base;
    const done = await write.run(
      { id, revision, content },
      (key) =>
        commands.save_dataset({ request_key: key, id, expected_revision: revision, content }),
      { content },
    );
    if (done.ok) {
      // Dataset detail shows it at once, landing on the protocol; the feed confirms it.
      const templates = base.templates.filter((_, i) => i !== found);
      queries.setQueryData(datasetKey(getConnection(), id), {
        id,
        revision: done.value.revision,
        modified_at: new Date().toISOString(),
        content,
        templates: [...templates.slice(0, index), template, ...templates.slice(index)],
        copied_from: base.copied_from,
      } satisfies SavedDataset);
      back(`protocol-${made.name}`);
    } else if (done.code === "conflict") {
      setConflicted(true);
    } else if (done.code === "invalid") {
      write.setMessage(done.issues[0]?.message);
    }
  };

  /** Their protocol, as a draft, once another computer saved one under its name. */
  const theirs =
    !stale || editing === null || latest === undefined
      ? undefined
      : latest.content.protocols.find((p) => p.name === editing);
  const notice = theirs === undefined ? undefined : elsewhereNotice(from, start(theirs), draft);
  const marks = editing === null ? {} : fieldMarks(first, from, draft);

  const line =
    editing === null ? null : (
      <>
        {changes === 0 ? "No changes yet." : changes === 1 ? "1 change." : `${changes} changes.`}{" "}
        Saving makes a new revision of {name}
        {revisionRunsWords(runs)}.
      </>
    );
  const note = deleted ? (
    <div className="note-ask b-note" role="status">
      <p>
        Another computer deleted {name} at {clock(deletedAt, now)}.
        <span className="hint">
          This page shows {name} as it was. Nothing on it can change now.
        </span>
      </p>
      <Link to="/datasets" className="btn btn-sm">
        Go to Datasets
      </Link>
    </div>
  ) : stale && notice?.fields !== undefined ? (
    <div className="note-ask b-note" role="status">
      <p>
        Another computer changed {editing}’s {notice.fields} since you opened it.
        <span className="hint">{notice.reload}</span>
      </p>
      <button type="button" className="btn btn-sm" onClick={reload}>
        Reload
      </button>
    </div>
  ) : stale ? (
    <div className="note-ask b-note" role="status">
      <p>
        Another computer saved {name} since you opened {editing ?? "New protocol"}.
        <span className="hint">
          {editing === null
            ? `Reload shows its ${latest?.content.name ?? name} and keeps your new protocol.`
            : changes === 0
              ? `Reload shows its ${editing}.`
              : `Reload shows its ${editing} and keeps ${changes === 1 ? "the field" : `the ${changes} fields`} you changed.`}
        </span>
      </p>
      <button type="button" className="btn btn-sm" onClick={reload}>
        Reload
      </button>
    </div>
  ) : null;

  return (
    <>
      <ProtocolBuilder
        platform={platform}
        connected={connected}
        dataset={name}
        workbook={book?.workbook ?? atBase?.source?.workbook ?? null}
        read={read}
        seconds={sheet?.seconds ?? false}
        draft={draft}
        others={others}
        onCancel={() => back(editing === null ? "new-protocol" : `protocol-${editing}`)}
        onSave={(_, template, made) => void save(template, made)}
        saved={{
          datasetId: base.id,
          editing,
          index,
          kept: from.made,
          line,
          note,
          marks,
          saveBlocked: deleted
            ? `Another computer deleted ${name}.`
            : stale
              ? "Reload first"
              : editing !== null && changes === 0
                ? "No changes yet"
                : undefined,
          saving: write.working,
          message: write.message,
          onDraft: setDraft,
          change: { gray: dialog.gray, press: (template) => void choose(template) },
          sheets: book?.sheets ?? [],
          onSheet: pickSheet,
          failure: failure === undefined ? undefined : failureWords(failure),
        }}
      />
      {guard.dialog}
    </>
  );
}
