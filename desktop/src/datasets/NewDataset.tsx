/**
 * The Dataset wizard (#143): a new dataset from one `.xlsx` workbook, read
 * on this computer (old ADR-0006), in four steps: Source, Sheets, Protocols
 * and Review (LaptopDatasetWizard, LaptopWizSheets, LaptopWizProtocols,
 * LaptopWizReview). Checks are `validate_dataset`'s, shown beside their
 * fields; Save is `save_dataset` with a request key (ADR-0009).
 *
 * Section 1's patterns hold: leaving with a workbook read asks first, a save
 * across a reconnect waits for it, and a name another computer took
 * meanwhile asks for another.
 *
 * A Custom sheet's steps come from the Protocol builder (#144), which opens
 * in the wizard's place and hands the protocol back unsaved.
 *
 * Each protocol's points are made on this computer's engine as its sheet's
 * points or Interpolate change (#145, ADR-0011, ADR-0013): interpolated as
 * set, with a proposed split, which Redraw, None and a click on a point
 * change. What's made is saved as the dataset's points and marks.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inApp } from "../ipc";
import { keyFor, savedWords, unconfirmedWords } from "../requestKey";
import { usePlatforms } from "../settings/commands";
import { agentKey } from "../setup/queries";
import { getConnection, useConnection } from "../shell/connection";
import { leavingWords } from "../shell/leaving";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useWorking } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { Issue, Point, Protocol, Template, WireError, Workbook } from "../wire/types.gen";
import { blankDraft, withEdits, type BuilderDraft } from "./builder/model";
import { ProtocolBuilder } from "./builder/ProtocolBuilder";
import {
  choicesOf,
  contentOf,
  formsOf,
  sheetsStatus,
  type Choice,
  type Edits,
  type ProtocolForm,
} from "./draft";
import { redrawn, useMaking, type ToMake } from "./making";
import { switchedAt, unmarked, type Made } from "./points";
import { allDatasets, named, useDatasetIssues, useDatasets } from "./queries";
import { datasetName, readSheet, unique, type SheetRead } from "./sheets";
import { ProtocolsStep, type PointControls } from "./ProtocolsStep";
import { ReviewStep, type Taken } from "./ReviewStep";
import { SheetsStep } from "./SheetsStep";
import { SourceStep, type ReadFailure } from "./SourceStep";
import { StepRail } from "./StepRail";
import { STEPS, protocolsStatus, type StepId } from "./words";

/** Where `tauri://drag-drop` tells of files dropped on the window, with their paths. */
const DROP = "tauri://drag-drop";
const DRAG_ENTER = "tauri://drag-enter";
const DRAG_LEAVE = "tauri://drag-leave";

/** A workbook read, its sheets as the wizard reads them. */
export interface Book {
  path: string;
  workbook: Workbook;
  reads: SheetRead[];
}

export function NewDatasetPage() {
  const connection = useConnection();
  const platform = connection.status === "none" ? "the platform" : connection.platform;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const platforms = usePlatforms();

  const [step, setStep] = useState<StepId>("source");
  const [reading, setReading] = useState<string | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  /** The file being dragged over the window, by name; `null` when none is. */
  const [dragging, setDragging] = useState<string | null>(null);
  /** The name as typed; `null` while it's the one ICMM proposes. */
  const [typed, setTyped] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  /** Each sheet's points as this computer's engine made them, with their marks. */
  const [made, setMade] = useState<Record<string, Made>>({});
  const [selected, setSelected] = useState(0);
  /** The Custom sheet the Protocol builder is open for, and where it started. */
  const [building, setBuilding] = useState<{ sheet: string; draft: BuilderDraft } | null>(null);
  /** A save found the name taken: by which dataset, since when, and the free one proposed. */
  const [taken, setTaken] = useState<Taken | null>(null);
  /** Another computer has `name`, since `at`: Review asks for another, a free one proposed. */
  const takenBy = (name: string, at: string, names: Set<string>) => {
    const free = unique(name, 64, names);
    setTaken({ name, at, proposed: free });
    setTyped(free);
  };
  const [saveMessage, setSaveMessage] = useState<string | undefined>();

  const datasetsQ = useDatasets();
  // What the platform has, while it can say: names kept from a connection that went aren't
  // checked against, since another computer may have saved one since.
  const live = connection.status === "connected" || connection.status === "reconnecting";
  const datasets = { data: live ? datasetsQ.data : undefined, isError: datasetsQ.isError };
  const names = useMemo(
    () => new Set((datasets.data ?? []).map((d) => d.name.toLowerCase())),
    [datasets.data],
  );
  const base = book === null ? "" : datasetName(book.workbook.name);
  const proposed = datasets.data === undefined ? base : unique(base, 64, names);
  const name = typed ?? proposed;
  const nameTaken = datasets.data !== undefined && named(datasets.data, name) !== undefined;

  const reads = useMemo(() => book?.reads ?? [], [book]);
  const forms = useMemo(() => formsOf(reads, choices, edits, made), [reads, choices, edits, made]);
  const draft = useMemo(
    () => (book === null ? null : contentOf(name, book.workbook.name, forms)),
    [book, name, forms],
  );
  const checked = useDatasetIssues(draft?.content ?? null);
  const issues: Issue[] = useMemo(
    () => [...(draft?.issues ?? []), ...(draft?.content ? (checked.issues ?? []) : [])],
    [draft, checked.issues],
  );
  /** The checks' issues while they're asked again: the last answer's, kept until the next (#424 KF21). */
  const stale = useMemo(
    (): ReadonlySet<Issue> =>
      new Set(checked.checking && draft?.content ? (checked.issues ?? []) : []),
    [checked.checking, checked.issues, draft],
  );

  // Each protocol's points, made again whenever its sheet's points or Interpolate change.
  const toMake = useMemo(
    (): ToMake[] =>
      book === null
        ? []
        : forms.map((f) => ({
            id: f.sheet,
            key: f.key,
            protocol: engineProtocol(f, contentOf(name, book.workbook.name, [f]).content),
          })),
    [book, forms, name],
  );
  const onMade = useCallback(
    (sheet: string, m: Made) => setMade((was) => ({ ...was, [sheet]: m })),
    [],
  );
  const making = useMaking(name, toMake, made, onMade);
  const redrawInputs = useRef(new Map<string, string>());
  useEffect(() => {
    redrawInputs.current = new Map(toMake.map((w) => [w.id, JSON.stringify(w)]));
  }, [toMake]);
  /** A change by hand to a sheet's made points and marks, while they're current. */
  const remark = (sheet: string, change: (points: Point[]) => Point[]) => {
    const f = forms.find((x) => x.sheet === sheet);
    const m = made[sheet];
    if (f === undefined || m === undefined || m.key !== f.key) return;
    setMade({ ...made, [sheet]: { ...m, points: change(f.points), picked: true } });
  };
  const pointControls: PointControls = {
    making,
    switchAt: (sheet, x) => remark(sheet, (points) => switchedAt(points, x)),
    none: (sheet) => remark(sheet, unmarked),
    redraw: async (sheet) => {
      const f = forms.find((x) => x.sheet === sheet);
      const m = made[sheet];
      const w = toMake.find((x) => x.id === sheet);
      if (f === undefined || m === undefined || w === undefined || m.key !== f.key) return;
      const next = await redrawn(w.protocol, { ...m, points: f.points });
      // A newer mark or a change to the input supersedes this proposal.
      setMade((was) =>
        was[sheet] === m && redrawInputs.current.get(sheet) === JSON.stringify(w)
          ? { ...was, [sheet]: next }
          : was,
      );
    },
  };

  // Leaving with a workbook read asks first: the header, links, Discard, the window.
  const started = book !== null;
  const asking = useRef(started);
  const [quitting, setQuitting] = useState(false);
  const showing = useRef(false);
  const leaving = useRef(false);
  const initiator = useRef<HTMLElement | null>(null);
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => {
      if (leaving.current || next.pathname === "/datasets/new") return false;
      initiator.current = document.activeElement as HTMLElement | null;
      return true;
    },
    disabled: !started,
    enableBeforeUnload: false,
    withResolver: true,
  });
  useEffect(() => {
    asking.current = started;
    showing.current = quitting || blocker.status === "blocked";
  }, [started, quitting, blocker.status]);
  useEffect(() => {
    if (!inApp()) return;
    const stop = listen("quit_requested", () => {
      // Acknowledge immediately, before the native unanswered timeout.
      const guarded = asking.current && !leaving.current;
      void commands.guard_quit({ guarded }).catch(() => {});
      if (!guarded) {
        void commands.quit_app().catch(() => {});
        return;
      }
      if (showing.current) return;
      initiator.current = document.activeElement as HTMLElement | null;
      showing.current = true;
      setQuitting(true);
    });
    return () => {
      void commands.guard_quit({ guarded: false }).catch(() => {});
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (inApp()) void commands.guard_quit({ guarded: started }).catch(() => {});
  }, [started]);

  const readGeneration = useRef(0);
  useEffect(
    () => () => {
      readGeneration.current += 1;
    },
    [],
  );
  const read = useCallback(async (path: string) => {
    const generation = ++readGeneration.current;
    const file = path.split(/[/\\]/).pop() ?? path;
    setReading(file);
    setFailure(null);
    try {
      const workbook = await commands.read_workbook({ path });
      if (generation !== readGeneration.current) return;
      if (workbook.problem !== null) {
        setBook(null);
        setFailure({ workbook });
        return;
      }
      const sheets = workbook.sheets.map(readSheet);
      if (sheets.every((s) => s.skipped)) {
        setBook(null);
        setFailure({ workbook, noNumbers: true });
        return;
      }
      // Another workbook starts over from it.
      setBook({ path, workbook, reads: sheets });
      setChoices(choicesOf(sheets));
      setEdits({});
      setMade({});
      setSelected(0);
      setBuilding(null);
      setTyped(null);
      setTaken(null);
    } catch (error) {
      if (generation !== readGeneration.current) return;
      setBook(null);
      setFailure({
        workbook: {
          name: file,
          bytes: null,
          problem: "unreadable",
          detail: (error as Partial<WireError>)?.message ?? String(error),
          sheets: [],
        },
      });
    } finally {
      if (generation === readGeneration.current) setReading(null);
    }
  }, []);

  // A workbook dropped on the window is read on Source, the only step that takes one.
  const onSource = step === "source";
  useEffect(() => {
    if (!onSource) return;
    const stops = [
      listen<{ paths: string[] }>(DROP, (e) => {
        setDragging(null);
        const path = e.payload.paths[0];
        if (path !== undefined) void read(path);
      }),
      listen<{ paths: string[] }>(DRAG_ENTER, (e) => {
        const path = e.payload.paths?.[0];
        setDragging(path === undefined ? "" : (path.split(/[/\\]/).pop() ?? path));
      }),
      listen(DRAG_LEAVE, () => setDragging(null)),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [onSource, read]);

  const index = STEPS.findIndex((s) => s.id === step);
  const go = (to: StepId) => {
    setStep(to);
    // The new step's heading takes focus, as a page change does (old ADR-0028).
    setTimeout(() => document.getElementById("step-heading")?.focus());
  };

  const status = sheetsStatus(reads, choices);
  const saving = useWorking();

  // On Review, a dataset another computer saved under this name asks for
  // another, with a free one proposed beside it.
  const clash = datasets.data === undefined ? undefined : named(datasets.data, name);
  if (step === "review" && clash !== undefined && taken === null && !saving.pending) {
    takenBy(name, clash.modified_at, names);
  }
  const request = useRef<{ key: string; body: string } | null>(null);

  const save = async () => {
    const content = draft?.content;
    if (content == null || saving.busy()) return;
    setSaveMessage(undefined);
    request.current = keyFor(request.current, content);
    const key = request.current.key;
    try {
      await saving.run(() =>
        commands.save_dataset({ request_key: key, id: null, expected_revision: null, content }),
      );
      void queries.invalidateQueries({ queryKey: agentKey(platformId(), "datasets") });
      leaving.current = true;
      await navigate({ to: "/datasets" });
    } catch (error) {
      const e = error as Partial<WireError> & { data?: unknown };
      const code = e.code as string | undefined;
      if (code === "invalid") {
        const found = (e.data as { issues?: Issue[] } | undefined)?.issues ?? [];
        const nameIssue = found.find((i) => i.path.length === 1 && i.path[0] === "name");
        if (nameIssue !== undefined) {
          // A name issue can also mean malformed or empty: confirm a collision.
          const fresh = await allDatasets().catch(() => datasets.data ?? []);
          queries.setQueryData(agentKey(platformId(), "datasets", "all"), fresh);
          const clash = named(fresh, content.name);
          if (clash !== undefined) {
            const all = new Set(fresh.map((d) => d.name.toLowerCase()));
            takenBy(content.name, clash.modified_at, all);
          } else {
            setSaveMessage(
              `Name: ${nameIssue.message}${taken === null ? " Go back to Source to change it." : ""}`,
            );
          }
          return;
        }
        setSaveMessage(
          `${platform} found ${found.length === 1 ? "a value" : `${found.length} values`} to fix. Go back to Protocols.`,
        );
        return;
      }
      if (code === "not_connected" || code === "timeout") {
        // The retry reuses its key, so it can't make a second dataset (#168).
        const offline = getConnection().status === "connected" ? undefined : platform;
        setSaveMessage(unconfirmedWords(savedWords(content.name), offline));
        return;
      }
      setSaveMessage(e.message ?? "Couldn’t save. Try again.");
    }
  };
  const platformId = () => {
    const c = getConnection();
    return c.status === "none" ? "" : c.platformId;
  };

  const discard = () => void navigate({ to: "/datasets" });
  const question = quitting || blocker.status === "blocked";
  const answer = (leave: boolean) => {
    if (quitting) {
      if (leave) void commands.quit_app().catch(() => {});
      else {
        setQuitting(false);
        initiator.current?.focus();
      }
      return;
    }
    if (leave) {
      blocker.proceed?.();
    } else {
      blocker.reset?.();
      initiator.current?.focus();
    }
  };
  const doing = quitting
    ? "Quitting"
    : blocker.status === "blocked"
      ? leavingWords(blocker.next, platforms.data?.platforms)
      : "";

  const leaveQuestion = () =>
    question && (
      <ConfirmDialog
        title={
          quitting ? "Discard the new dataset and quit ICMM?" : "Discard the new dataset and leave?"
        }
        keep="Keep editing"
        confirm={quitting ? "Discard and quit" : "Discard and leave"}
        onKeep={() => answer(false)}
        onConfirm={() => answer(true)}
      >
        <span className="mono">{name}</span> isn’t saved yet. {doing} discards it and what you set
        here. Your workbook stays as it is.
      </ConfirmDialog>
    );

  const waiting = saving.pending && connection.status !== "connected";

  // The builder starts from what the sheet has: its built protocol with the
  // Protocols step's edits and the Sheets step's name over it, or Blank, its
  // first columns as x, y and SD.
  const openBuilder = (sheet: string) => {
    const i = choices.findIndex((c) => c.sheet === sheet);
    const c = choices[i];
    const columns = reads[i].columns.length;
    const draft =
      c.built !== undefined
        ? { ...withEdits(c.built.draft, edits[sheet] ?? {}), name: c.name, made: made[sheet] }
        : blankDraft(c.name, {
            x: columns > 0 ? 0 : undefined,
            y: columns > 1 ? 1 : undefined,
            sd: columns > 2 ? 2 : undefined,
          });
    setBuilding({ sheet, draft });
  };
  const closeBuilder = (sheet: string) => {
    setBuilding(null);
    // Back on Sheets, the button that opened it keeps focus (old ADR-0029).
    setTimeout(() => document.getElementById(`builder-${sheet}`)?.focus());
  };
  const built = (sheet: string, draft: BuilderDraft, template: Template) => {
    setChoices(
      choices.map((c) =>
        c.sheet === sheet
          ? {
              ...c,
              name: draft.name,
              roles: { x: draft.roles.x, y: draft.roles.y, sd: draft.roles.sd },
              built: { draft, template },
            }
          : c,
      ),
    );
    // Its values are the builder's now: the Protocols step's edits went into it.
    setEdits(Object.fromEntries(Object.entries(edits).filter(([key]) => key !== sheet)));
    // So are its points and marks.
    const drafted = draft.made;
    setMade((was) => {
      const rest = Object.fromEntries(Object.entries(was).filter(([key]) => key !== sheet));
      return drafted === undefined ? rest : { ...rest, [sheet]: drafted };
    });
    closeBuilder(sheet);
  };
  /** The dataset's other protocols as they are, so the builder catches a name they have. */
  const others = useMemo((): Protocol[] => {
    if (building === null || book === null) return [];
    return forms
      .filter((f) => f.sheet !== building.sheet)
      .flatMap((f) => contentOf(name, book.workbook.name, [f]).content?.protocols ?? []);
  }, [building, book, forms, name]);

  if (building !== null && book !== null) {
    const i = choices.findIndex((c) => c.sheet === building.sheet);
    return (
      <>
        <ProtocolBuilder
          key={building.sheet}
          platform={platform}
          connected={connection.status === "connected"}
          dataset={name}
          workbook={book.workbook.name}
          read={reads[i]}
          seconds={choices[i].seconds}
          draft={building.draft}
          others={others}
          onCancel={() => closeBuilder(building.sheet)}
          onSave={(draft, template) => built(building.sheet, draft, template)}
        />
        {leaveQuestion()}
      </>
    );
  }
  const shared = { platform, step: index + 1, discard, saving };
  const protocolNames = forms.map((f) => f.name);

  return (
    <div className="wizard">
      <StepRail
        step={step}
        go={go}
        file={book?.workbook.name ?? null}
        name={name}
        nameFree={book !== null && datasets.data !== undefined && !nameTaken}
        sheets={reads.length}
        status={status}
        protocols={protocolNames.length}
        platform={platform}
        locked={saving.pending}
      />
      <main className="wizard-main">
        {step === "source" && (
          <SourceStep
            {...shared}
            book={book}
            reading={reading}
            failure={failure}
            dragging={dragging}
            read={read}
            name={name}
            proposed={typed === null && proposed !== base ? base : null}
            typed={typed !== null}
            setName={setTyped}
            datasets={datasets.data}
            nameCheck={
              datasets.data !== undefined
                ? "ready"
                : datasets.isError
                  ? "unknown"
                  : connection.status === "connected"
                    ? "checking"
                    : "offline"
            }
            nameTaken={nameTaken}
            nameIssue={issues.find((i) => i.path.length === 1 && i.path[0] === "name")}
            next={() => {
              // The name goes on as typed or proposed; a clash later asks about it.
              setTyped(name);
              go("sheets");
            }}
          />
        )}
        {step === "sheets" && book !== null && (
          <SheetsStep
            {...shared}
            book={book}
            choices={choices}
            setChoices={setChoices}
            status={status}
            forms={forms}
            issues={issues}
            back={() => go("source")}
            next={() => go("protocols")}
            openBuilder={openBuilder}
          />
        )}
        {step === "protocols" && book !== null && (
          <ProtocolsStep
            {...shared}
            name={name}
            forms={forms}
            issues={issues}
            stale={stale}
            content={draft?.content ?? null}
            points={pointControls}
            edits={edits}
            setEdits={setEdits}
            selected={Math.min(selected, Math.max(0, forms.length - 1))}
            select={setSelected}
            back={() => go("sheets")}
            next={() => go("review")}
          />
        )}
        {step === "review" && book !== null && draft !== null && (
          <ReviewStep
            {...shared}
            book={book}
            name={name}
            setName={setTyped}
            taken={taken}
            nameTaken={nameTaken}
            forms={forms}
            choices={choices}
            blocked={protocolsStatus(forms, issues).blocked || draft.content === null}
            message={saveMessage}
            waiting={waiting}
            save={save}
            back={() => go("protocols")}
            edit={() => go("protocols")}
          />
        )}
      </main>
      {leaveQuestion()}
    </div>
  );
}

/**
 * What this computer's engine makes a form's points from: its measured
 * points, Interpolate's settings and its validation share, in its protocol
 * as the draft has it, or as its template drew it while a value isn't a
 * number. The engine reads only its points, interpolation, share and
 * Normalize.
 */
function engineProtocol(f: ProtocolForm, content: { protocols: Protocol[] } | null): Protocol {
  const drawn = content?.protocols[0] ?? {
    name: f.name,
    source: null,
    holding_mV: f.base.holding_mV,
    steps: f.base.steps,
    normalized: f.normalized,
    weight: f.base.weight,
    time_resolution_ms: f.base.time_resolution_ms,
    interpolation: f.read.made,
    validation_share: f.shareRead.made,
    points: [],
  };
  return {
    ...drawn,
    interpolation: f.read.made,
    validation_share: f.shareRead.made,
    points: f.measured,
  };
}
