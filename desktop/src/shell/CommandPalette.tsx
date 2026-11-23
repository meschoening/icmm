/**
 * ⌘K (LaptopCommandPalette): a query over the Active platform's runs,
 * results, datasets and configs (#410), and what ICMM can do, each match a
 * row under its group, ↑↓ to move, ↵ to open it. A group shows 4 rows, then
 * "N more", which opens the rest in place; a topology or start typed whole
 * (`#214/T12.3`, `214/12.3/37`) is one row, read once. Each group reads on
 * its own: "Reading runs…" while it's read, its failure with Try again. While
 * the connection is down it searches what was read, a strip under the query
 * saying as of when. Its empty query shows Recently opened (#411): the last 5
 * pages opened on the platform, worded as they are now, one deleted since
 * left out. Do (#412, `palette/do.tsx`) is what ICMM can do from the page it
 * opened over; while the platform isn't connected, the rows that need it are
 * gray.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePressed } from "../connection/pressed";
import { useMinute } from "../runs/queries";
import type { RunSummary } from "../wire/types.gen";
import { rmse } from "../runs/words";
import { isMac } from "../platform";
import { useSelection } from "../selection/selection";
import { usePlatforms } from "../settings/commands";
import { reportHere } from "../report/fromHere";
import { failureBox, inSentence } from "../setup/form";
import { clock } from "../ui/clock";
import { heardAtOf, useConnection } from "./connection";
import { SearchIcon } from "./icons";
import {
  doCommands,
  wordsText,
  type Command,
  type DoIcon,
  type DoActions,
  type PageContext,
  type Words,
} from "./palette/do";
import {
  CompareIcon,
  ConnectIcon,
  ExportIcon,
  ImportIcon,
  PlusIcon,
  ProtocolIcon,
  ReportIcon,
  SettingsIcon,
  SwitchIcon,
  TopologyIcon,
} from "./palette/icons";
import { usePaletteIndex, useTypedReads, type ReadState } from "./palette/reads";
import { recordOpened, useRecentlyOpened, useRecentReads } from "./palette/recents";
import {
  deletedRecent,
  GROUP_KINDS,
  GROUP_LABEL,
  GROUP_NOUN,
  GROUP_ROWS,
  factWords,
  parseQuery,
  recentRows,
  search,
  startRow,
  topologyRow,
  type Fact,
  type Found,
  type GroupKind,
  type Query,
  type Row,
  type Target,
} from "./palette/search";

/** What the palette's rows do. */
export interface PaletteActions extends DoActions {
  /**
   * Opens a run's, topology's, start's, dataset's or config's page; whether it opened, since a
   * page with unsaved changes may keep it from leaving.
   */
  open: (target: Target) => Promise<boolean>;
}

/** `text` with each query word found in it in bold, as the board marks a match. */
function marked(text: string, words: string[]): ReactNode[] {
  const lower = text.toLowerCase();
  const hits = Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = lower.indexOf(w); w !== "" && at >= 0; at = lower.indexOf(w, at + w.length)) {
      hits.fill(true, at, at + w.length);
    }
  }
  const parts: ReactNode[] = [];
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && hits[j] === hits[i]) j++;
    parts.push(
      <span key={i} className={hits[i] ? "nmc hit" : "nmc"}>
        {text.slice(i, j)}
      </span>,
    );
    i = j;
  }
  return parts;
}

/** A Do row's words: plain parts marked where the query's words are, names and numbers in mono. */
function said(w: Words, words: string[]): ReactNode[] {
  return w.map((p, i) =>
    typeof p === "string" ? (
      <span key={i}>{marked(p, words)}</span>
    ) : (
      <span key={i} className="mono">
        {p.mono}
      </span>
    ),
  );
}

/** One of the list's selectable rows. */
type Option =
  | { kind: "row"; row: Row }
  | { kind: "more"; group: GroupKind; count: number }
  /**
   * `gray` while the platform it needs isn't connected; `wait` from its press until its progress
   * shows (Connect).
   */
  | { kind: "do"; command: Command; gray: boolean; wait: boolean };

/** A group's place in the list: its rows and "N more", or a line in their place. */
interface Shown {
  key: string;
  label: string;
  options: Option[];
  /**
   * "Reading runs…", which from `SLOW_S` says how long and offers Try again (KF04); or a failed
   * read's sentence and Try again.
   */
  line?:
    | { reading: string; read: string; since?: number; retry: () => void }
    | { failed: string; retry: () => void };
}

export function CommandPalette({
  actions,
  onClose,
  page = {},
}: {
  actions: PaletteActions;
  onClose: () => void;
  /** The page it opened over: a bare `T12.3` is its run's, and Do takes it as context. */
  page?: PageContext;
}) {
  const pageRun = page.run;
  // Its groups' reads are asked as it opens, so their counts start here at the earliest (KF04).
  const [openedAt] = useState(() => Date.now());
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // The palette opens to type in.
  useEffect(() => input.current?.focus(), []);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  // The groups whose "N more" was opened, for this query.
  const [opened, setOpened] = useState<GroupKind[]>([]);
  // Whether the last move was a key's, so the row it lands on scrolls into view.
  const keyed = useRef(false);

  const connection = useConnection();
  const platforms = usePlatforms();
  const platform =
    connection.status === "none"
      ? undefined
      : (platforms.data?.platforms.find((p) => p.id === connection.platformId) ?? {
          type: "ssh" as const,
          name: connection.platform,
        });
  const { index, reads } = usePaletteIndex();
  const client = useQueryClient();
  const recents = useRecentlyOpened();
  const recentReads = useRecentReads(recents);
  const selection = useSelection();
  const now = useMinute();

  const connectPressed = usePressed({
    button: "connect",
    platformId: connection.status === "none" ? "" : connection.platformId,
  });

  const typed = query.trim() !== "";
  let q: Query = parseQuery(query);
  // A bare `T12.3` is the open run's; elsewhere it finds nothing.
  if (q.kind === "bare" && pageRun !== undefined) {
    const ref = { run: pageRun, graph: q.graph, openState: q.openState };
    q =
      q.start === undefined
        ? { kind: "topology", ...ref }
        : { kind: "start", ...ref, start: q.start };
  }
  const topologyRef =
    q.kind === "topology" ? { run: q.run, graph: q.graph, openState: q.openState } : undefined;
  // The Start page's key shape, so a start it read is the palette's too.
  const startRef =
    q.kind === "start"
      ? { run: q.run, graph: q.graph, openState: q.openState, start: q.start }
      : undefined;
  const one = useTypedReads(topologyRef, startRef);
  const words = q.kind === "words" ? q.words : [];

  const failureWords = (error: unknown, task: Parameters<typeof failureBox>[1]) =>
    platform === undefined
      ? String((error as { message?: unknown })?.message ?? error)
      : failureBox(error, task, platform).what;

  // The groups' reads are asked as it opens, or as the connection comes up while it's open.
  const asked =
    connection.status === "connected" && connection.since !== null
      ? Math.max(openedAt, connection.since)
      : openedAt;
  const lineOf = (kind: GroupKind, state: ReadState): Shown["line"] | undefined => {
    if (state.kind === "reading") {
      return {
        reading: `Reading ${GROUP_NOUN[kind][1]}…`,
        read: kind,
        since: asked,
        retry: state.retry,
      };
    }
    if (state.kind === "failed") {
      return {
        failed: failureWords(state.error, kind === "results" ? "runs" : kind),
        retry: state.retry,
      };
    }
    return undefined;
  };

  const shown: Shown[] = [];
  let matches = 0;
  let reading = false;
  let none: { what: ReactNode; hint?: ReactNode } | undefined;

  let found: Found | undefined;
  if (q.kind === "words" && typed) {
    found = search(index, words);
    for (const kind of GROUP_KINDS) {
      // A group still reading, or whose read failed, says so in its rows' place.
      const line = lineOf(kind, reads[kind]);
      const rows = line === undefined ? found[kind] : undefined;
      if ((line !== undefined && "reading" in line) || reads[kind].kind === "so far")
        reading = true;
      if (rows === undefined) {
        if (line !== undefined)
          shown.push({ key: kind, label: GROUP_LABEL[kind], options: [], line });
        continue;
      }
      matches += rows.length;
      if (rows.length === 0) continue;
      const open = opened.includes(kind) || rows.length <= GROUP_ROWS;
      const options: Option[] = (open ? rows : rows.slice(0, GROUP_ROWS)).map((row) => ({
        kind: "row",
        row,
      }));
      if (!open) options.push({ kind: "more", group: kind, count: rows.length - GROUP_ROWS });
      shown.push({ key: kind, label: GROUP_LABEL[kind], options });
    }
  } else if (q.kind === "topology" || q.kind === "start") {
    const run = index.runs?.find((r) => r.id === q.run);
    const read = q.kind === "topology" ? one.topology : one.start;
    const state = read?.state ?? { kind: "none" };
    const name = `#${q.run}/T${q.graph}.${q.openState}${q.kind === "start" ? ` · start ${q.start}` : ""}`;
    // Not read and the connection down: nothing kept says it's there.
    const unknown = state.kind === "none" && read?.data === undefined;
    if (
      unknown ||
      (state.kind === "failed" && (state.error as { code?: string })?.code === "not_found")
    ) {
      none = nothingMatches(query);
    } else if (state.kind === "failed") {
      shown.push({
        key: "results",
        label: "Results",
        options: [],
        line: { failed: failureWords(state.error, { reading: name }), retry: state.retry },
      });
    } else if (state.kind === "reading") {
      reading = true;
      shown.push({
        key: "results",
        label: "Results",
        options: [],
        line: { reading: "Reading results…", read: name, retry: state.retry },
      });
    } else {
      const row =
        q.kind === "topology"
          ? topologyRow(q, run, one.topology?.data)
          : startRow(q, run, one.start?.data, index.overview);
      matches += 1;
      shown.push({ key: "results", label: "Results", options: [{ kind: "row", row }] });
    }
  } else if (q.kind === "bare") {
    // The example is a topology that's there: the newest run's best (KF06).
    const newest = (index.runs ?? [])
      .filter((r) => r.best !== null)
      .reduce<RunSummary | undefined>(
        (a, r) => (a === undefined || r.id > a.id ? r : a),
        undefined,
      );
    none = {
      what: "A topology goes with its run.",
      hint:
        newest === undefined ? (
          "Type the run first, or open its run."
        ) : (
          <>
            Type the run first, as in{" "}
            <span className="mono">{`#${newest.id}/T${newest.best!.graph}.${newest.best!.open_state}`}</span>
            , or open its run.
          </>
        ),
    };
  }

  if (!typed) {
    const rows = recentRows(recents ?? [], index, recentReads);
    if (rows.length > 0) {
      shown.push({
        key: "recent",
        label: "Recently opened",
        options: rows.map((row) => ({ kind: "row", row })),
      });
    }
  }

  const pageDataset =
    page.dataset === undefined ? undefined : index.datasets?.find((d) => d.id === page.dataset);
  const dos =
    q.kind !== "words"
      ? []
      : doCommands({
          words,
          typed,
          page,
          configs: index.configs,
          pageDataset,
          matchedDatasets: found?.datasets,
          datasets: index.datasets,
          matchedRuns: found?.runs?.flatMap((row) => {
            const to = row.to;
            const run = to.to === "run" ? index.runs?.find((r) => r.id === to.run) : undefined;
            return run === undefined ? [] : [run];
          }),
          selected: selection.picks,
          platforms: platforms.data?.platforms,
          active:
            connection.status === "none"
              ? undefined
              : { id: connection.platformId, name: platform?.name ?? connection.platform },
          // Connect stays, gray, while the connect it started goes on.
          unconnected:
            connection.status === "not_connected" || connection.status === "connecting"
              ? { id: connection.platformId, name: platform?.name ?? connection.platform }
              : undefined,
          report: reportHere.side(),
        });
  if (dos.length > 0) {
    matches += typed ? dos.length : 0;
    const gray = connection.status !== "connected";
    shown.push({
      key: "do",
      label: "Do",
      options: dos.map((command) => ({
        kind: "do",
        command,
        gray: gray && command.platform,
        wait: command.stays === true && (connectPressed || connection.status === "connecting"),
      })),
    });
  }
  // The groups whose read failed: the count is of what was read, and says what wasn't (#449).
  const unread = shown
    .filter((g) => g.line !== undefined && "failed" in g.line)
    .map((g) => GROUP_NOUN[g.key as GroupKind]?.[1] ?? g.key);
  const failed = unread.length > 0;
  if (typed && none === undefined && matches === 0 && !reading && !failed) {
    // A recent dropped as deleted that the query names says so, rather than nothing (KF05).
    const gone = deletedRecent(recents ?? [], index, recentReads, words);
    none =
      gone === undefined
        ? nothingMatches(query)
        : {
            what: (
              <>
                <span className="mono">{gone}</span> was deleted since you last opened it.
              </>
            ),
          };
  }

  const where = platform === undefined ? "the platform" : inSentence(platform);

  const options = shown.flatMap((g) => g.options);
  const chosen = Math.min(at, options.length - 1);
  const optionId = (i: number) => `${id}-${i}`;

  // A key's move brings its row into view; the pointer's is already there.
  useEffect(() => {
    if (!keyed.current || chosen < 0) return;
    keyed.current = false;
    document.getElementById(optionId(chosen))?.scrollIntoView?.({ block: "nearest" });
  });

  const activate = (o: Option) => {
    if (o.kind === "more") {
      // The first row it opens takes its place, and the selection with it.
      setOpened((x) => [...x, o.group]);
      keyed.current = true;
      return;
    }
    // A gray row opens once the platform's connected; the palette stays.
    if (o.kind === "do" && (o.gray || o.wait)) return;
    // Connect's progress shows in the connection: the palette stays, the row gray meanwhile.
    if (o.kind === "do" && o.command.stays) {
      o.command.run(actions);
      return;
    }
    onClose();
    if (o.kind === "do") o.command.run(actions);
    else {
      const page = o.row.page;
      void actions.open(o.row.to).then((opened) => {
        if (opened && page !== undefined) recordOpened(client, page);
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "," && (isMac() ? e.metaKey : e.ctrlKey) && !e.altKey) {
      // ⌘, opens Settings from here too; taken here, so the shell's own doesn't.
      e.preventDefault();
      onClose();
      actions.settings();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length > 0) {
        keyed.current = true;
        setAt((chosen + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      }
    } else if (e.key === "Enter" && e.target === input.current) {
      e.preventDefault();
      // ⌘↵ opens no row, and (taken here) it presses nothing on the page behind.
      if (!(e.metaKey || e.ctrlKey) && chosen >= 0) activate(options[chosen]);
    } else if (e.key === "Tab") {
      // Focus stays in the palette: the query, and a failed read's Try again.
      e.preventDefault();
      const stops = [...(dialog.current?.querySelectorAll<HTMLElement>("input, button") ?? [])];
      const now = stops.indexOf(document.activeElement as HTMLElement);
      const next = (now + (e.shiftKey ? stops.length - 1 : 1)) % stops.length;
      stops[Math.max(0, next)]?.focus();
    }
  };

  const asOf = heardAtOf(connection);
  const strip =
    connection.status === "reconnecting"
      ? { glyph: "g g-busy", lead: "Reconnecting…" }
      : connection.status !== "connected" && asOf !== null
        ? { glyph: "g g-off", lead: "Not connected" }
        : undefined;

  let n = 0;
  return createPortal(
    <div className="fd-scrim">
      <div
        ref={dialog}
        className={typed ? "palette typed" : "palette"}
        role="dialog"
        aria-modal="true"
        aria-label="Jump to or do"
        onKeyDown={onKeyDown}
      >
        <div className="pinput">
          <SearchIcon />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Jump to or do"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`${id}-list`}
            aria-activedescendant={chosen >= 0 ? optionId(chosen) : undefined}
            placeholder="Jump to a run, result, dataset or config — or type a command"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
              setOpened([]);
            }}
          />
        </div>
        {strip !== undefined && asOf !== null && (
          <div className="pstrip" role="status">
            <span className={strip.glyph} aria-hidden="true" />
            <span>
              {strip.lead} · as of {clock(asOf, now)}, when the connection went
            </span>
          </div>
        )}
        <div className="plist">
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={typed ? "Matches" : "Suggestions"}
            className="plist-in"
          >
            {shown.map((g, gi) => (
              <div key={g.key} role="group" aria-labelledby={`${id}-g-${g.key}`}>
                <div id={`${id}-g-${g.key}`} className={gi > 0 ? "label grp grp-n" : "label grp"}>
                  {g.label}
                </div>
                {g.line !== undefined && "reading" in g.line && (
                  <ReadingLine
                    // Another read, or the same asked again from a new connection, counts anew.
                    key={`${g.line.read} ${g.line.since ?? ""}`}
                    words={g.line.reading}
                    since={g.line.since}
                    where={where}
                    retry={g.line.retry}
                    onRetried={() => input.current?.focus()}
                  />
                )}
                {g.line !== undefined && "failed" in g.line && (
                  <FailedRead
                    words={g.line.failed}
                    retry={g.line.retry}
                    onRetried={() => input.current?.focus()}
                  />
                )}
                {g.options.map((o) => {
                  const i = n++;
                  return (
                    <OptionRow
                      key={
                        o.kind === "row"
                          ? o.row.key
                          : o.kind === "more"
                            ? `more ${o.group}`
                            : o.command.key
                      }
                      id={optionId(i)}
                      option={o}
                      words={words}
                      chosen={i === chosen}
                      onPoint={() => setAt(i)}
                      onPick={() => activate(o)}
                    />
                  );
                })}
              </div>
            ))}
            {none !== undefined && (
              <div className="pnone" role="status">
                <p className="what">{none.what}</p>
                {none.hint !== undefined && <p className="hint">{none.hint}</p>}
              </div>
            )}
          </div>
        </div>
        <div className="pfoot">
          <span className="pkeys">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>navigate
          </span>
          <span className="pkeys">
            <span className="kbd">↵</span>open
          </span>
          <span className="pkeys">
            <span className="kbd">esc</span>close
          </span>
          <span className="pgap" />
          {typed && (
            <span>
              {matches === 0 && !reading && !failed
                ? "No matches"
                : `${matches.toLocaleString("en-US")} ${matches === 1 ? "match" : "matches"}${reading ? " so far" : ""}` +
                  (failed ? ` · ${unread.join(" and ")} not read` : "")}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function nothingMatches(query: string) {
  return {
    what: (
      <>
        Nothing matches “<span className="mono">{query.trim()}</span>”.
      </>
    ),
    hint: (
      <>
        Runs, results, datasets and configs are found by their names and ids, like{" "}
        <span className="mono">#214</span> or <span className="mono">#214/T12.3</span>.
      </>
    ),
  };
}

/** How long a read goes before its line says it's still reading (#399's HF12, KF04). */
const SLOW_S = 10;

/**
 * A group's read still out, in its rows' place: "Reading runs…", and from `SLOW_S` how long it's
 * been, that the platform may be busy, and Try again on the failed row's grid, which asks again
 * while the count goes on from the first ask (LaptopCommandPalette's `slow`). It counts from
 * `since`, else from when it shows.
 */
function ReadingLine({
  words,
  since,
  where,
  retry,
  onRetried,
}: {
  words: string;
  since?: number;
  where: string;
  retry: () => void;
  onRetried: () => void;
}) {
  const [began] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - began) / 1_000));
  const dots = (
    <span className="ic">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
  if (seconds < SLOW_S) {
    return (
      <div className="prow" role="status">
        {dots}
        <span>{words}</span>
      </div>
    );
  }
  return (
    <div className="pfail pslow">
      {dots}
      <p role="status">
        Still reading after {/* The count isn't read out each second; the line is, once. */}
        <span className="n" aria-live="off">
          {seconds}
        </span>
        {"\u00a0"}s; {where} may be busy.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          // Its group reads again in its place, so focus goes back to the query.
          onRetried();
          retry();
        }}
      >
        Try again
      </button>
    </div>
  );
}

/** A group's failed read in its rows' place, with Try again, which gives focus back to the query. */
function FailedRead({
  words,
  retry,
  onRetried,
}: {
  words: string;
  retry: () => void;
  onRetried: () => void;
}) {
  return (
    <div className="pfail" role="alert">
      <span className="ic">
        <span className="g g-failed" aria-hidden="true" />
      </span>
      <p>{words}</p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          // Its group reads again in its place, so focus goes back to the query.
          onRetried();
          retry();
        }}
      >
        Try again
      </button>
    </div>
  );
}

function Facts({ facts, tight }: { facts: Fact[]; tight: boolean }) {
  return (
    <span className="side">
      {facts.map((f, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {typeof f === "string" ? (
            f
          ) : "full" in f ? (
            tight ? (
              f.short
            ) : (
              f.full
            )
          ) : (
            <>
              {f.metric} <span className={f.live ? "mono live-n" : "mono"}>{rmse(f.value)}</span>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

/** A row's name as it reads, without its marks. */
function nameText(r: Row): string {
  if (r.icon === "run" || r.lead === undefined) {
    const lead = r.lead === undefined ? "" : `${r.lead.id} `;
    return `${lead}${r.name}${r.via === undefined ? "" : ` on ${r.via}`}${r.gone ? " deleted" : ""}`;
  }
  const start = r.lead.start === undefined ? "" : ` · start ${r.lead.start}`;
  return `${r.lead.id}${start}${r.name === "" ? "" : ` in ${r.name}`}`;
}

/**
 * A row's title: its whole text, its gray words in full where it shortens them; a gray row's
 * reason in their place.
 */
function titleOf(o: Option): string {
  if (o.kind === "more") return moreWords(o);
  if (o.kind === "row") return [nameText(o.row), ...o.row.facts.map(factWords)].join(" · ");
  const label = wordsText(o.command.label);
  const side = o.gray ? GRAY_WHY : o.wait ? undefined : o.command.side;
  return side === undefined
    ? label
    : `${label} · ${typeof side === "string" ? side : wordsText(side)}`;
}

const GRAY_WHY = "Opens once you’re connected";

const moreWords = (o: Extract<Option, { kind: "more" }>) => {
  const [one, many] = GROUP_NOUN[o.group];
  return `${o.count.toLocaleString("en-US")} more ${o.count === 1 ? one : many}`;
};

/**
 * Whether the row's gray words give way (KF11, KF12): only when, in full, they'd cut its name. It's
 * measured with the full words each time its text changes, before it paints.
 */
function useGivesWay(name: React.RefObject<HTMLElement | null>, text: string, can: boolean) {
  const [tightFor, setTightFor] = useState<string>();
  const tight = can && tightFor === text;
  useLayoutEffect(() => {
    if (!can) return;
    const fit = () => {
      const el = name.current;
      if (el !== null && el.scrollWidth > el.clientWidth) setTightFor(text);
    };
    if (!tight) fit();
    // Another window width measures again, with the full words.
    const again = () => setTightFor(undefined);
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [name, text, can, tight]);
  return tight;
}

function OptionRow({
  id,
  option: o,
  words,
  chosen,
  onPoint,
  onPick,
}: {
  id: string;
  option: Option;
  words: string[];
  chosen: boolean;
  onPoint: () => void;
  onPick: () => void;
}) {
  const nameEl = useRef<HTMLSpanElement>(null);
  const title = titleOf(o);
  const tight = useGivesWay(
    nameEl,
    `${title}\n${words.join(" ")}`,
    o.kind === "do"
      ? !o.gray && !o.wait && o.command.sideShort !== undefined
      : o.kind === "row" && o.row.facts.some((f) => typeof f !== "string" && "full" in f),
  );
  let icon: ReactNode;
  let body: ReactNode;
  let kbd: string | undefined;
  if (o.kind === "do") {
    icon = DO_ICON[o.command.icon];
    kbd = o.command.kbd;
    body = (
      <>
        <span ref={nameEl} className="nm">
          {said(o.command.label, words)}
        </span>
        {o.gray ? (
          <span className="side">{GRAY_WHY}</span>
        ) : (
          !o.wait &&
          o.command.side !== undefined && (
            <span className="side">
              {said((tight && o.command.sideShort) || o.command.side, [])}
            </span>
          )
        )}
      </>
    );
  } else if (o.kind === "more") {
    icon = <MoreIcon />;
    body = <span className="nm">{moreWords(o)}</span>;
  } else {
    const r = o.row;
    icon = ROW_ICON[r.icon];
    const name = r.name === "" ? null : marked(r.name, words);
    body = (
      <>
        {r.icon === "run" || r.lead === undefined ? (
          <span ref={nameEl} className="nm nm-mono">
            {r.lead !== undefined && <span className="idc">{r.lead.id} </span>}
            {name}
            {r.via !== undefined && (
              <>
                <span className="dim via"> on </span>
                {marked(r.via, words)}
              </>
            )}
            {r.gone && <span className="gone">deleted</span>}
          </span>
        ) : (
          <span ref={nameEl} className="nm">
            <span className="mono">{r.lead.id}</span>
            {r.lead.start !== undefined && (
              <>
                {" "}
                · start <span className="mono">{r.lead.start}</span>
              </>
            )}
            {name !== null && (
              <>
                <span className="dim"> in </span>
                <span className="mono">{name}</span>
              </>
            )}
          </span>
        )}
        <Facts facts={r.facts} tight={tight} />
      </>
    );
  }
  const wait = o.kind === "do" && o.wait;
  const gray = (o.kind === "do" && o.gray) || wait;
  // The chosen row opens on ↵; another shows its own shortcut, if it has one.
  const key = chosen && !gray ? "↵" : kbd;
  return (
    <div
      id={id}
      role="option"
      aria-selected={chosen}
      aria-disabled={gray || undefined}
      data-wait={wait || undefined}
      className={`opt${chosen ? " on" : ""}${o.kind === "more" ? " more" : ""}${gray ? " dis" : ""}`}
      title={title}
      onPointerMove={onPoint}
      onClick={onPick}
    >
      <span className="ic">{icon}</span>
      <span className="txt">{body}</span>
      <span className="kc">{key !== undefined && <span className="kbd">{key}</span>}</span>
    </div>
  );
}

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {children}
  </svg>
);

/** LaptopCommandPalette's marks for each kind of row. */
const ROW_ICON: Record<Row["icon"], ReactNode> = {
  run: svg(
    <path
      d="M3.5 3.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM4.5 8h4"
      stroke="currentColor"
      strokeWidth="1.3"
    />,
  ),
  result: svg(
    <>
      <path d="M2 1.5v12.5h12.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 12c3-.5 4-6 10-8" stroke="currentColor" strokeWidth="1.3" />
    </>,
  ),
  topology: <TopologyIcon />,
  dataset: svg(
    <>
      <path
        d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-10a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M1.5 6.5h13M1.5 10h13M6 2.5v11" stroke="currentColor" strokeWidth="1.1" />
    </>,
  ),
  config: svg(
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7.5h5M5.5 10.5h5" stroke="currentColor" strokeWidth="1.2" />
    </>,
  ),
};

const DO_ICON: Record<DoIcon, ReactNode> = {
  connect: <ConnectIcon />,
  plus: <PlusIcon />,
  protocol: <ProtocolIcon />,
  import: <ImportIcon />,
  export: <ExportIcon />,
  compare: <CompareIcon />,
  switch: <SwitchIcon />,
  settings: <SettingsIcon />,
  topology: <TopologyIcon />,
  report: <ReportIcon />,
};

/** A chevron: "N more" opens the rest of its group. */
function MoreIcon() {
  return svg(<path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" />);
}
