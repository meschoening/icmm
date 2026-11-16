/**
 * Results (LaptopResults, #339; built in #345): one dataset's leaderboard,
 * one **Ranking group** at a time (#336). Dataset and Data (the group, an
 * earlier one named by its range) say what's ranked, with a note under them
 * on how it ranks without validation points, and on Current where earlier
 * data have runs (RF04, RF05); the toolbar's Runs, States, Max val RMSE, Min
 * near best and Include topologies in progress filter it, and never renumber
 * it: # is always the Val rank (Train without validation points, ADR-0006).
 * Each group keeps its filters this session (RF21). Every other column sorts,
 * and the sort is remembered on this computer (Preferences). A row is one
 * run's topology, `#214/T12.3`, through its Best start, 100 a page. Its
 * columns take their content's width from the left, the spare after Spread
 * (#358, RF01), and when every row is one run's, there's no Run column: the
 * facts name the run once. A topology still fitting is in progress, its live
 * numbers underlined (#370).
 *
 * Its ticks fill the session's selection (`selection/`), which the bar at the
 * window's bottom shows. It opens on the dataset it's given (`?dataset=`),
 * else the last one shown on this platform this session, else the latest
 * run's; `?run=` picks that run, in its group, and `?data=` a group.
 * Not connected, it keeps what it read, as of then, opened again too (RF15).
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { FileIn } from "../export/Exported";
import { leaderboardName } from "../export/names";
import { useSave } from "../export/useSave";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { leaderboardCsv, readEveryRow } from "../results/csv";
import { useLeaderboard, useRankingGroups, useStateGraphsOf, graphKey } from "../results/queries";
import type { LeaderboardAsk } from "../results/queries";
import {
  allEarlierWords,
  earlierLine,
  emptyWords,
  factsWords,
  footShown,
  groupName,
  groupNote,
  moreWords,
  NO_VALIDATION_NOTE,
  startsUnder,
  type RunWords,
} from "../results/words";
import { parametersOf, topologyId } from "../runs/detail";
import { ImprovingMark } from "../runs/ImprovingMark";
import { budgetOf } from "../runs/start/words";
import { useMinute, useRunsOverview } from "../runs/queries";
import { rmse } from "../runs/words";
import { filtersShown, lastShown, NO_FILTERS, RANK_SORT, type Filters } from "../results/search";
import { pickKey, useSelection, type SelectedStart } from "../selection/selection";
import { SelectionBar } from "../selection/SelectionBar";
import { usePreferences, useSetPreferences } from "../settings/preferences";
import { FailureBox } from "../setup/FailureBox";
import { inSentence } from "../setup/form";
import { agentKey, canAsk, platformOf, useReadAgain } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { useKept } from "../submit/kept";
import { useRun } from "../submit/queries";
import { clock } from "../ui/clock";
import { useBlocker } from "../ui/blocker";
import { grayProps } from "../ui/gray";
import { LiveN } from "../ui/LiveN";
import { ReadingFacts } from "../ui/HeadFacts";
import { PageHeading } from "../ui/PageHeading";
import { useTooltip } from "../ui/Tooltip";
import { WorkingButton } from "../ui/WorkingButton";
import { commands } from "../wire/api.gen";
import type {
  GroupRun,
  LeaderboardOrder,
  LeaderboardRow,
  LeaderboardSort,
  RankingGroup,
  RankingGroups,
  RunsDataset,
  WireError,
} from "../wire/types.gen";

/**
 * The newest run on the platform: Results' first dataset, where nothing else chooses one. Runs
 * list those in flight first, then by when they ended, and ids never recycle, so it's the
 * highest id on the first page.
 */
function useLatestRun(enabled: boolean) {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "runs", "latest"),
    queryFn: () => commands.list_runs({ filter: null, dataset: null, config: null, after: null }),
    enabled: enabled && canAsk(c),
    select: (list) =>
      list.runs.reduce<(typeof list.runs)[number] | undefined>(
        (newest, r) => (newest === undefined || r.id > newest.id ? r : newest),
        undefined,
      ),
  });
}

/** `value` once it has stood still for a moment, so a limit isn't read at every key. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 200);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

const NO_ROWS: LeaderboardRow[] = [];

/**
 * Each row's parameter count (2N + 2E + 2) from its state graph, by `graphKey`: the same map
 * while the counts are, so the reads it's kept with move only when they do.
 */
function useParams(rows: LeaderboardRow[] | undefined): ReadonlyMap<string, number> {
  const graphs = useStateGraphsOf(rows ?? NO_ROWS);
  const key = [...graphs]
    .map(([k, g]) => `${k}:${g.edges.length}`)
    .sort()
    .join(",");
  return useMemo(
    () =>
      new Map(
        key === ""
          ? []
          : key.split(",").map((entry) => {
              const [at, edges] = entry.split(":");
              return [at, parametersOf(Number(at.split("/")[0]), Number(edges))] as const;
            }),
      ),
    [key],
  );
}

/** A typed limit, or `null` when it isn't a number. */
function limitOf(typed: string): number | null {
  const t = typed.trim();
  if (t === "" || !/^\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}

/** What the page shows, read whole: kept as of the connection's end while it's gone. */
interface Reads {
  datasets: RunsDataset[];
  groups: RankingGroups;
  group: RankingGroup | undefined;
  board: Board | undefined;
  /** Each row's parameter count, by `graphKey`, as its state graph's read answers. */
  params: ReadonlyMap<string, number>;
}

interface Board {
  rows: LeaderboardRow[];
  /**
   * The Runs and States filters its rows answer: a new filter's ask keeps the rows before it
   * until its own come, and their facts and Run column stay theirs (RF01).
   */
  run: number | null;
  states: number | null;
  total: number;
  /** How many of every row the filters keep were still improving, from the read (RF20). */
  stillImproving: number;
  ranked: number;
  validation: boolean;
  more: boolean;
}

export function ResultsPage() {
  const search = useSearch({ from: "/results" });
  const navigate = useNavigate({ from: "/results" });
  const c = useConnection();
  const platform = useActivePlatform();
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";
  const platformId = c.status === "none" ? "" : c.platformId;
  const preferences = usePreferences().data;
  const setPreferences = useSetPreferences();
  const sort = preferences?.leaderboard ?? RANK_SORT;

  const overviewQ = useRunsOverview();
  const remembered = lastShown.get(platformId);
  const needLatest = search.dataset === undefined && remembered === undefined;
  const latestQ = useLatestRun(needLatest);
  // The overview's first dataset only once the latest run has answered, and found none.
  const dataset =
    search.dataset ??
    remembered ??
    latestQ.data?.dataset.id ??
    (latestQ.isSuccess ? overviewQ.data?.datasets[0]?.id : undefined);
  useEffect(() => {
    if (dataset !== undefined && platformId !== "") lastShown.set(platformId, dataset);
  }, [dataset, platformId]);

  const groupsQ = useRankingGroups(dataset);
  const groups = groupsQ.data;
  const group =
    groups?.groups.find((g) => g.scoring_digest === search.data) ??
    (search.run === undefined
      ? undefined
      : groups?.groups.find((g) => g.runs.some((r) => r.id === search.run))) ??
    groups?.groups[0];
  const runFilter =
    search.run !== undefined && group?.runs.some((r) => r.id === search.run) ? search.run : null;

  // The filters go with the group they filter, and stay with it this session (RF21).
  const groupKey = `${dataset ?? ""}/${group?.scoring_digest ?? ""}`;
  const keptKey = `${platformId}/${groupKey}`;
  const keptOf = (key: string) => filtersShown.get(key) ?? NO_FILTERS;
  const [filters, setFilters] = useState<{ key: string; f: Filters }>(() => ({
    key: keptKey,
    f: keptOf(keptKey),
  }));
  if (filters.key !== keptKey) setFilters({ key: keptKey, f: keptOf(keptKey) });
  const f = filters.key === keptKey ? filters.f : keptOf(keptKey);
  const setF = (next: Partial<Filters>) => {
    const now = { ...f, ...next };
    filtersShown.set(keptKey, now);
    setFilters({ key: keptKey, f: now });
  };
  const max = limitOf(useSettled(f.max));

  const ask =
    dataset === undefined || group === undefined || group.runs.length === 0
      ? undefined
      : {
          dataset,
          scoring_digest: group.scoring_digest,
          order: sort.order,
          descending: sort.descending,
          run: runFilter,
          num_states: f.states,
          max_rmse: max,
          min_near_best: f.near,
          fitting: f.fitting,
        };
  const boardQ = useLeaderboard(ask);
  const [answered, setAnswered] = useState({ run: runFilter, states: f.states });
  if (
    boardQ.data !== undefined &&
    !boardQ.isPlaceholderData &&
    (answered.run !== runFilter || answered.states !== f.states)
  ) {
    setAnswered({ run: runFilter, states: f.states });
  }
  const board = useMemo((): Board | undefined => {
    const pages = boardQ.data?.pages;
    if (pages === undefined) return undefined;
    // A row whose place moved between pages can be listed twice: it keeps its first place.
    const seen = new Set<string>();
    const rows = pages.flatMap((p) =>
      p.rows.filter((r) => {
        const key = `${r.run.id}/${r.graph}.${r.open_state}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    const last = pages[pages.length - 1];
    return {
      rows,
      run: answered.run,
      states: answered.states,
      total: last.total,
      stillImproving: last.still_improving,
      ranked: last.ranked,
      validation: last.validation,
      more: last.next !== null,
    };
  }, [boardQ.data, answered]);

  const params = useParams(board?.rows);
  const reads: Reads | undefined =
    overviewQ.data === undefined ||
    groups === undefined ||
    (ask !== undefined && board === undefined)
      ? undefined
      : {
          datasets: overviewQ.data.datasets,
          groups,
          group,
          board: ask === undefined ? undefined : board,
          params,
        };
  const kept = useKept(
    reads,
    {
      connected: c.status === "connected",
      live,
      platform: platformId,
      heardAt: heardAtOf(c),
    },
    now,
  );
  // The latest run, while it chooses the dataset: its failure is the page's, and Try again its.
  const queries = needLatest ? [overviewQ, latestQ, groupsQ, boardQ] : [overviewQ, groupsQ, boardQ];
  const failed = queries.find((q) => q.isError)?.error ?? undefined;
  const read = useReadAgain(
    reads === undefined && failed !== undefined ? (failed as unknown as WireError) : undefined,
    () => Promise.all(queries.map((q) => q.refetch())),
  );
  const failure = useHeldFailure(
    read.failure,
    queries.some((q) => q.isFetching),
    groupKey,
    reads !== undefined || !live,
  );
  const shown = kept.value;
  const name =
    shown?.groups.dataset.name ??
    groups?.dataset.name ??
    overviewQ.data?.datasets.find((d) => d.id === dataset)?.name ??
    (latestQ.data?.dataset.id === dataset ? latestQ.data?.dataset.name : undefined) ??
    "this dataset";

  const onSort = (order: LeaderboardOrder) => {
    const descending =
      order === sort.order ? !sort.descending : order === "near_best" || order === "starts";
    if (preferences !== undefined) {
      void setPreferences({ ...preferences, leaderboard: { order, descending } }).catch(() => {});
    }
  };

  const exporting = useExportCsv(
    ask,
    leaderboardName(shown?.groups.dataset.name ?? name, shown?.group ?? group),
    platform === undefined || (c.status === "connected" && kept.asOf === undefined)
      ? undefined
      : `Connect to ${inSentence(platform)} to export.`,
  );

  const which = dataset === undefined ? "the leaderboard" : `${name}’s leaderboard`;
  // What the page shows, its facts line and its body alike.
  const shows =
    platform === undefined || (!live && shown === undefined)
      ? "offline"
      : shown !== undefined
        ? "shown"
        : dataset === undefined && latestQ.isSuccess && overviewQ.isSuccess
          ? "none"
          : failure !== undefined
            ? "failure"
            : "reading";

  return (
    <div className={kept.asOf !== undefined ? "page lb stale" : "page lb"}>
      <section className="lb-head">
        <PageHeading>Results</PageHeading>
        {platform === undefined ? null : shows === "offline" ? (
          <p className="facts">
            {c.status === "connecting"
              ? `Connecting to ${inSentence(platform)}…`
              : `Not connected to ${inSentence(platform)}`}
          </p>
        ) : shows === "none" ? (
          <p className="facts">Nothing ranked yet</p>
        ) : shows === "failure" ? (
          <p className="facts">Couldn’t read {which}</p>
        ) : shows === "reading" ? (
          <ReadingFacts>
            Reading {which} on {inSentence(platform)}…
          </ReadingFacts>
        ) : (
          <Facts
            reads={shown!}
            runFilter={runFilter}
            filters={f}
            max={max}
            asOf={kept.asOf}
            now={now}
            improving={preferences?.mark_still_improving === true}
          />
        )}
      </section>
      {exporting.outcome}
      {shows === "offline" ? (
        <ShowOnceConnected platform={platform} kind="Results">
          its runs
        </ShowOnceConnected>
      ) : shown !== undefined ? (
        <Shown
          reads={shown}
          now={now}
          live={live}
          runFilter={runFilter}
          filters={f}
          setFilters={setF}
          sort={sort}
          onSort={onSort}
          improving={preferences?.mark_still_improving === true}
          exportButton={exporting.button}
          loadMore={
            shown.board?.more && live
              ? { busy: boardQ.isFetchingNextPage, load: () => void boardQ.fetchNextPage() }
              : undefined
          }
          onDataset={(id) => void navigate({ search: { dataset: id }, replace: true })}
          onGroup={(digest) =>
            void navigate({
              search: { dataset: shown.groups.dataset.id, data: digest },
              replace: true,
            })
          }
          onRun={(run) =>
            void navigate({
              search: {
                dataset: shown.groups.dataset.id,
                ...(shown.group === undefined ? {} : { data: shown.group.scoring_digest }),
                ...(run === null ? {} : { run }),
              },
              replace: true,
            })
          }
        />
      ) : shows === "none" ? (
        // Every run was deleted since the platform's first: nothing to rank.
        <div className="lb-empty">
          <p className="lb-lead">Nothing on {inSentence(platform!)} is ranked yet.</p>
          <p>A topology ranks once one of its starts finishes.</p>
        </div>
      ) : shows === "failure" ? (
        <FailureBox
          error={failure!}
          task={{ reading: which }}
          platform={platform!}
          onRetry={read.retry}
          again={read.again}
        />
      ) : null}
      <SelectionBar shown={shown?.groups.dataset.id} />
    </div>
  );
}

/** The group's runs the Runs and States filters keep. */
function runsKept(group: RankingGroup | undefined, run: number | null, states: number | null) {
  return (group?.runs ?? []).filter(
    (r) => (run === null || r.id === run) && (states === null || r.num_states === states),
  );
}

/**
 * The one run every row is from, when the filters keep one (RF01): one run in the group, or
 * the Runs filter's one. The table has no Run column then, and the facts name it once.
 */
function oneRun(group: RankingGroup | undefined, run: number | null, states: number | null) {
  const kept = runsKept(group, run, states);
  return kept.length === 1 ? kept[0] : undefined;
}

const runOf = (r: GroupRun) => ({ id: r.id, name: r.config.name });

const inFlight = (state: string) => state === "running" || state === "queued" || state === "held";

function Facts({
  reads,
  runFilter,
  filters: f,
  max,
  asOf,
  now,
  improving,
}: {
  reads: Reads;
  runFilter: number | null;
  filters: Filters;
  max: number | null;
  asOf: number | undefined;
  now: number;
  improving: boolean;
}) {
  const b = reads.board;
  const allEarlier =
    reads.group?.current === true && allEarlierWords(reads.groups, now) !== undefined;
  const runs = runsKept(
    reads.group,
    b === undefined ? runFilter : b.run,
    b === undefined ? f.states : b.states,
  );
  const still = improving ? (b?.stillImproving ?? 0) : 0;
  // "38 of 139 … match" only where a filter leaves some out.
  const filtered =
    (runFilter !== null || f.states !== null || max !== null || f.near !== null || !f.fitting) &&
    b !== undefined &&
    b.total < b.ranked;
  const one = runs.length === 1 ? runs[0] : undefined;
  const words: RunWords = allEarlier
    ? { before: "Nothing ranked on its current data", run: undefined, after: "" }
    : b === undefined || b.ranked === 0
      ? { before: "Nothing ranked yet", run: undefined, after: "" }
      : factsWords({
          total: b.total,
          ranked: b.ranked,
          runs: runs.length,
          fitting: runs.filter((r) => inFlight(r.state)).length,
          shown: b.rows.length,
          filtered,
          run: one === undefined ? undefined : runOf(one),
        });
  return (
    <p className="facts">
      <RunSentence words={words} />
      {still > 0 && (
        <>
          {" · "}
          <span className="lb-impw">
            <ImprovingMark className="lb-imp" label="still improving at its end" />
            {still.toLocaleString("en-US")} still improving
          </span>
        </>
      )}
      {asOf !== undefined && <> · as of {clock(asOf, now)}</>}
    </p>
  );
}

function Shown({
  reads,
  now,
  live,
  runFilter,
  filters: f,
  setFilters,
  sort,
  onSort,
  improving,
  exportButton,
  loadMore,
  onDataset,
  onGroup,
  onRun,
}: {
  reads: Reads;
  now: number;
  live: boolean;
  runFilter: number | null;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  sort: LeaderboardSort;
  onSort: (order: LeaderboardOrder) => void;
  improving: boolean;
  /** Export CSV…, at the end of the filters. */
  exportButton: ReactNode;
  loadMore: { busy: boolean; load: () => void } | undefined;
  onDataset: (id: string) => void;
  onGroup: (digest: string) => void;
  onRun: (run: number | null) => void;
}) {
  const { groups, group, board } = reads;
  const name = groups.dataset.name ?? "This dataset";
  const allEarlier = group?.current === true ? allEarlierWords(groups, now) : undefined;
  // Under Dataset and Data: an earlier group's note, how it ranks without validation points
  // (RF04), and on Current, the earlier data's runs (RF05).
  const notes = [
    group === undefined ? undefined : groupNote(groups, group, now),
    board !== undefined && board.ranked > 0 && !board.validation ? NO_VALIDATION_NOTE : undefined,
    group === undefined || allEarlier !== undefined ? undefined : earlierLine(groups, group),
  ].filter((x) => x !== undefined);
  return (
    <>
      <Scope reads={reads} now={now} onDataset={onDataset} onGroup={onGroup} />
      {notes.map((note) => (
        <p key={note} className="lb-gnote">
          <InfoIcon />
          <span>{note}</span>
        </p>
      ))}
      {allEarlier !== undefined ? (
        <div className="lb-empty">
          <p className="lb-lead">{allEarlier.lead}</p>
          <p>
            <RunSentence words={allEarlier} />
          </p>
          <button type="button" className="btn" onClick={() => onGroup(allEarlier.digest)}>
            {allEarlier.button}
          </button>
        </div>
      ) : board === undefined || board.ranked === 0 ? (
        <NothingRanked name={name} group={group} live={live} />
      ) : (
        <Table
          reads={{ ...reads, board }}
          runFilter={runFilter}
          filters={f}
          setFilters={setFilters}
          sort={sort}
          onSort={onSort}
          improving={improving}
          exportButton={exportButton}
          loadMore={loadMore}
          onRun={onRun}
        />
      )}
    </>
  );
}

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 5.6v3.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="3.8" r=".8" fill="currentColor" />
    </svg>
  );
}

/** A sentence with a run's link in it: `#216 kv11-wt-6state` opens Run detail. */
function RunSentence({ words }: { words: RunWords }) {
  return (
    <>
      {words.before}
      {words.run !== undefined && (
        <Link to="/runs/$id" params={{ id: String(words.run.id) }} className="link mono">
          #{words.run.id} {words.run.name}
        </Link>
      )}
      {words.after}
    </>
  );
}

/** Nothing ranked yet: how a topology ranks, and the group's newest run in flight. */
function NothingRanked({
  name,
  group,
  live,
}: {
  name: string;
  group: RankingGroup | undefined;
  live: boolean;
}) {
  const flying = group?.runs.find((r) => inFlight(r.state));
  const run = useRun(flying?.id).data;
  const words = emptyWords(name, run);
  return (
    <div className="lb-empty">
      <p className="lb-lead">{words.lead}</p>
      {(flying === undefined || run !== undefined || !live) && (
        <p>
          <RunSentence words={run === undefined ? emptyWords(name, undefined) : words} />
        </p>
      )}
    </div>
  );
}

function Scope({
  reads,
  now,
  onDataset,
  onGroup,
}: {
  reads: Reads;
  now: number;
  onDataset: (id: string) => void;
  onGroup: (digest: string) => void;
}) {
  const { datasets, groups, group } = reads;
  const byName = (a: RunsDataset, b: RunsDataset) => (a.name ?? a.id).localeCompare(b.name ?? b.id);
  const current = datasets.filter((d) => !d.deleted).sort(byName);
  const deleted = datasets.filter((d) => d.deleted).sort(byName);
  const listed = datasets.some((d) => d.id === groups.dataset.id);
  const named = (d: { id: string; name: string | null }) => d.name ?? d.id;
  const now_ = groups.groups.find((g) => g.current);
  const earlier = groups.groups.filter((g) => !g.current && g.runs.length > 0);
  return (
    <div className="lb-scope" role="group" aria-label="What’s ranked">
      <label className="lb-field">
        <span className="flabel">Dataset</span>
        <select
          className="input mono lb-dataset"
          value={groups.dataset.id}
          title={named(groups.dataset)}
          onChange={(e) => onDataset(e.target.value)}
        >
          {!listed && <option value={groups.dataset.id}>{named(groups.dataset)}</option>}
          {current.map((d) => (
            <option key={d.id} value={d.id}>
              {named(d)}
            </option>
          ))}
          {deleted.length > 0 && <hr />}
          {deleted.map((d) => (
            <option key={d.id} value={d.id}>
              {named(d)} (deleted)
            </option>
          ))}
        </select>
      </label>
      <label className="lb-field">
        <span className="flabel">Data</span>
        <select
          className="input lb-data"
          value={group?.scoring_digest ?? ""}
          title={
            group === undefined ? undefined : group.current ? "Current" : groupName(group, now)
          }
          onChange={(e) => onGroup(e.target.value)}
        >
          {now_ !== undefined && <option value={now_.scoring_digest}>Current</option>}
          {earlier.length > 0 &&
            (now_ !== undefined ? (
              <optgroup label="Earlier data, ranked on its own">
                {earlier.map((g) => (
                  <option key={g.scoring_digest} value={g.scoring_digest}>
                    {groupName(g, now)}
                  </option>
                ))}
              </optgroup>
            ) : (
              earlier.map((g) => (
                <option key={g.scoring_digest} value={g.scoring_digest}>
                  {groupName(g, now)}
                </option>
              ))
            ))}
        </select>
      </label>
    </div>
  );
}

/** Each column but # and the checkbox: its order, its words, and what its head's title says. */
const COLUMNS: { order: LeaderboardOrder; label: string; right: boolean; title?: string }[] = [
  { order: "topology", label: "Topology", right: false },
  { order: "run", label: "Run", right: false },
  {
    order: "states",
    label: "States · Params",
    right: true,
    title: "Sorts by its number of states",
  },
  {
    order: "starts",
    label: "Starts",
    right: true,
    title: "Finished starts, of the topology’s starts",
  },
  {
    order: "near_best",
    label: "Near best",
    right: true,
    title:
      "Finished starts within 1 % of the Best start’s Train RMSE, the Best start included, of the finished starts",
  },
  { order: "train", label: "Train", right: true, title: "The Best start’s Train RMSE" },
  { order: "rank", label: "Val", right: true, title: "The Best start’s Val RMSE: it ranks" },
  { order: "spread", label: "Spread", right: true },
];

/** Spread's head, in the app's tooltip on hover or focus (RF04). */
const SPREAD_TIP =
  "The median over the parameters of each one’s SD across the Top 10 by Train RMSE, as a share of its bound range. Lower is tighter: the Top 10 agree more.";

/** A live number's, on hover or focus (#370). */
const LIVE_TIP = "In progress: these change as its starts finish.";

function Table({
  reads,
  runFilter,
  filters: f,
  setFilters,
  sort,
  onSort,
  improving,
  exportButton,
  loadMore,
  onRun,
}: {
  reads: Reads & { board: Board };
  runFilter: number | null;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  sort: LeaderboardSort;
  onSort: (order: LeaderboardOrder) => void;
  improving: boolean;
  exportButton: ReactNode;
  loadMore: { busy: boolean; load: () => void } | undefined;
  onRun: (run: number | null) => void;
}) {
  const { groups, group, board } = reads;
  const sel = useSelection();
  const val = board.validation;
  const runs = group?.runs ?? [];
  const states = [...new Set(runs.map((r) => r.num_states))].sort((a, b) => a - b);
  const picks = useMemo(
    () =>
      board.rows.map((r): SelectedStart => ({
        run: r.run.id,
        graph: r.graph,
        open_state: r.open_state,
        start: r.best.start,
        dataset: { id: groups.dataset.id, name: groups.dataset.name },
        num_states: r.num_states,
      })),
    [board.rows, groups.dataset],
  );
  const allOn = picks.length > 0 && picks.every((p) => sel.has(pickKey(p)));
  // Every row one run's: no Run column, as the facts name it (RF01).
  const one = oneRun(group, board.run, board.states) !== undefined;
  const columns = COLUMNS.filter((c) => (val || c.order !== "rank") && (!one || c.order !== "run"));
  // Without validation points, the Val rank is by Train RMSE: Train's head shows it.
  const on = (order: LeaderboardOrder) =>
    sort.order === order || (!val && order === "train" && sort.order === "rank");
  const dash = val && board.rows.some((r) => r.best.val_rmse === null);
  const still = improving && board.rows.some((r) => r.still_improving === true);
  const more = moreWords(board.rows.length, board.total);
  return (
    <section className="lb-board" aria-label="Leaderboard">
      <form className="lb-bar" aria-label="Which rows show" onSubmit={(e) => e.preventDefault()}>
        <label className="lb-fi">
          <span>Runs</span>
          <select
            className="input input-sm"
            value={runFilter === null ? "all" : String(runFilter)}
            onChange={(e) => onRun(e.target.value === "all" ? null : Number(e.target.value))}
          >
            <option value="all">{runs.length === 1 ? "1 run" : `All ${runs.length} runs`}</option>
            {runs.map((r) => (
              <option key={r.id} value={String(r.id)}>
                #{r.id} only
              </option>
            ))}
          </select>
        </label>
        <label className="lb-fi">
          <span>States</span>
          <select
            className="input input-sm mono"
            value={f.states === null ? "all" : String(f.states)}
            onChange={(e) =>
              setFilters({ states: e.target.value === "all" ? null : Number(e.target.value) })
            }
          >
            <option value="all">All</option>
            {states.map((s) => (
              <option key={s} value={String(s)}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="lb-fi">
          <span>{val ? "Max val RMSE" : "Max train RMSE"}</span>
          <input
            className="input input-sm mono lb-max"
            type="text"
            inputMode="decimal"
            placeholder="any"
            value={f.max}
            onChange={(e) => setFilters({ max: e.target.value })}
          />
        </label>
        <label className="lb-fi">
          <span>Min near best</span>
          <select
            className="input input-sm"
            value={f.near === null ? "any" : String(f.near)}
            onChange={(e) =>
              setFilters({ near: e.target.value === "any" ? null : Number(e.target.value) })
            }
          >
            <option value="any">Any</option>
            <option value="5">5 or more</option>
            <option value="10">10 or more</option>
          </select>
        </label>
        <label className="lb-chk">
          <input
            type="checkbox"
            checked={f.fitting}
            onChange={(e) => setFilters({ fitting: e.target.checked })}
          />
          Include topologies in progress
        </label>
        {exportButton}
      </form>
      <div
        role="table"
        aria-label="Ranked topologies"
        className={["lb-table", val ? "" : "lb-nv", one ? "lb-one" : ""].filter(Boolean).join(" ")}
      >
        <div role="row" className="lb-row lb-colhead">
          <span role="columnheader" className="lb-cb">
            <input
              type="checkbox"
              aria-label="Select every row shown"
              checked={allOn}
              onChange={() => (allOn ? sel.remove(picks.map(pickKey)) : sel.add(picks))}
            />
          </span>
          <span
            role="columnheader"
            className="th lb-r"
            title={
              val
                ? "Rank by Val RMSE, whatever the sort"
                : "Rank by Train RMSE: this dataset has no validation points"
            }
          >
            #
          </span>
          {columns.map((c) => (
            <Head
              key={c.order}
              column={c}
              lit={on(c.order)}
              descending={sort.descending}
              onSort={() => onSort(on(c.order) ? sort.order : c.order)}
            />
          ))}
        </div>
        {board.rows.map((r, i) => (
          <Row
            key={`${r.run.id}/${r.graph}.${r.open_state}`}
            row={r}
            pick={picks[i]}
            validation={val}
            improving={improving}
            one={one}
            params={reads.params.get(graphKey(r.num_states, r.graph))}
          />
        ))}
        {board.rows.length === 0 && (
          <p className="lb-none">No ranked topology matches these filters.</p>
        )}
      </div>
      <div className="lb-foot">
        <div className="lb-more">
          {more !== undefined && loadMore !== undefined && (
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={loadMore.busy ? true : undefined}
              onClick={() => !loadMore.busy && loadMore.load()}
            >
              {more}
            </button>
          )}
          <span>{footShown(board.rows.length, board.total)}</span>
        </div>
        <p className="lb-note">
          Near best: finished starts within 1&#160;% of the Best start’s Train RMSE, the Best start
          included. Spread: the median over the parameters, the open state’s pair left out, of each
          one’s SD across the Top&#160;10 by Train RMSE, as a share of its bound range.
          {dash && " “—”: its validation sweep failed, so it ranks after every scored topology."}
          {still && (
            <>
              {" "}
              <ImprovingMark className="lb-imp lb-imp-note" />
              its Best start was still improving at its end.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/** A column's head: its sort button, and what it counts in a title, or Spread's in a tooltip. */
function Head({
  column: c,
  lit,
  descending,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  lit: boolean;
  descending: boolean;
  onSort: () => void;
}) {
  const tip = useTooltip(c.order === "spread" ? SPREAD_TIP : undefined);
  const sp = c.order === "states";
  return (
    <span
      role="columnheader"
      className={
        c.right ? (c.order === "states" ? "lb-r lb-numh lb-sph" : "lb-r lb-numh") : undefined
      }
      aria-sort={lit ? (descending ? "descending" : "ascending") : "none"}
      title={c.title}
      {...tip.hover}
    >
      <button
        type="button"
        className={lit ? "lb-sort on" : "lb-sort"}
        aria-describedby={c.order === "spread" ? tip.id : undefined}
        {...(c.order === "spread" ? tip.focus : {})}
        onClick={onSort}
      >
        {sp ? (
          // Lined up on its dot, as the rows' states and parameters are.
          <span className="lb-sp">
            <span className="lb-sps">States</span>
            <span className="lb-spd">{" · "}</span>
            <span className="lb-spp">Params</span>
          </span>
        ) : (
          c.label
        )}
        <span className="lb-ar" aria-hidden="true">
          {lit ? (descending ? "↓" : "↑") : ""}
        </span>
      </button>
      {tip.bubble}
    </span>
  );
}

function Row({
  row: r,
  pick,
  validation,
  improving,
  one,
  params,
}: {
  row: LeaderboardRow;
  pick: SelectedStart;
  validation: boolean;
  improving: boolean;
  /** Every row is one run's: no Run cell. */
  one: boolean;
  params: number | undefined;
}) {
  const sel = useSelection();
  const id = topologyId(r);
  const name = `#${r.run.id}/${id}`;
  const checked = sel.has(pickKey(pick));
  const short = r.starts_finished < r.starts;
  const under = startsUnder({
    fitting: r.fitting,
    runState: r.run.state,
    running: r.starts_running,
    queued: r.starts_queued,
    short,
  });
  // A topology in progress: its live numbers carry the dotted underline (#370).
  const live = r.fitting ? "live-n" : undefined;
  const val = r.best.val_rmse;
  return (
    <div role="row" className={checked ? "lb-row lb-trow lb-sel" : "lb-row lb-trow"}>
      <span role="cell" className="lb-cb">
        <input
          type="checkbox"
          aria-label={`Select ${name}’s Best start`}
          checked={checked}
          onChange={() => sel.toggle(pick)}
        />
      </span>
      <span role="cell" className="lb-num lb-rank">
        {r.rank.toLocaleString("en-US")}
      </span>
      <span role="cell" className="lb-topo">
        <Link
          to="/runs/$id/$topology/$start"
          params={{ id: String(r.run.id), topology: id, start: String(r.best.start) }}
          className="lb-tid"
          aria-label={`Open ${name}’s Best start`}
        >
          <span className="lb-rid">#{r.run.id}/</span>
          {id}
        </Link>
        {/* The caption below is drawn across the row; a screen reader hears it here. */}
        {under !== undefined && <span className="sr-only">, {under.words}</span>}
      </span>
      {!one && (
        <span role="cell" className="lb-runc">
          <Link
            to="/runs/$id"
            params={{ id: String(r.run.id) }}
            className="lb-rlink"
            title={`#${r.run.id} ${r.run.config.name}`}
          >
            <span className="lb-rid">#{r.run.id}</span> {r.run.config.name}
          </Link>
        </span>
      )}
      <span role="cell" className="lb-num lb-sp">
        <span className="lb-sps">{r.num_states}</span>
        <span className="lb-spd">{" · "}</span>
        <span className="lb-spp">{params ?? "—"}</span>
      </span>
      <span role="cell" className={short ? "lb-num lb-short" : "lb-num"}>
        {r.starts_finished.toLocaleString("en-US")} / {r.starts.toLocaleString("en-US")}
      </span>
      <span role="cell" className="lb-num">
        {r.near_best === null
          ? "—"
          : `${r.near_best.toLocaleString("en-US")} / ${r.starts_finished.toLocaleString("en-US")}`}
      </span>
      <span role="cell" className="lb-num">
        {improving && r.still_improving === true && <Improving run={r.run.id} />}
        <span className={live}>{r.best.train_rmse === null ? "—" : rmse(r.best.train_rmse)}</span>
      </span>
      {validation && (
        <span
          role="cell"
          className="lb-num"
          title={
            val === null
              ? "Its validation sweep failed, so it ranks after every scored topology"
              : undefined
          }
        >
          {/* Its number is the row's Tab stop that names the bubble (#370). */}
          <LiveN
            tip={r.fitting ? LIVE_TIP : undefined}
            tab
            className={val === null ? undefined : r.rank === 1 ? "lb-vbest" : "lb-vb"}
          >
            {val === null ? "—" : rmse(val)}
          </LiveN>
        </span>
      )}
      <span role="cell" className="lb-num">
        <span className={live}>{r.spread === null ? "—" : r.spread.median.toFixed(2)}</span>
      </span>
      {under !== undefined && (
        <span className={under.failed ? "lb-rst failed" : "lb-rst"} aria-hidden="true">
          <span className={under.glyph} />
          {under.words}
        </span>
      )}
    </div>
  );
}

/**
 * The ↓ of a row whose Best start was still improving at its end, with its rule in a tooltip
 * (RF04): its Train RMSE fell more than 1 % over the last tenth of its run's budget.
 */
function Improving({ run }: { run: number }) {
  const budget = useRun(run).data;
  const per = budget === undefined ? undefined : budgetOf(budget);
  const tip = useTooltip(
    `Its Best start was still improving at its end: its Train RMSE fell more than 1\u00a0% over ${
      per === undefined
        ? "the last tenth of its evaluations"
        : `its last ${Math.round(per / 10).toLocaleString("en-US")} evaluations`
    }.`,
  );
  return (
    <>
      <span
        className="lb-impt"
        tabIndex={0}
        aria-describedby={tip.id}
        {...tip.hover}
        {...tip.focus}
      >
        <ImprovingMark className="lb-imp" label="still improving at its end" />
      </span>
      {tip.bubble}
    </>
  );
}

/**
 * Export CSV… (#344, LaptopResults' `exported` and `not-connected`): every
 * row the filters keep, each with its Best start, read from the platform a
 * page at a time once the save dialog answers, and written by this
 * computer's engine, named for its dataset and, for earlier data, its days
 * (`leaderboardName`). Not connected, it's gray with `blocker`.
 */
function useExportCsv(
  ask: LeaderboardAsk | undefined,
  file: string,
  blocker: string | undefined,
): { button: ReactNode; outcome: ReactNode } {
  const saving = useSave();
  const b = useBlocker(blocker);
  // The filters when the dialog answers, which may have changed while it was open.
  const latest = useRef({ ask, blocker });
  useEffect(() => {
    latest.current = { ask, blocker };
  });
  const press = () => {
    if (ask === undefined || blocker !== undefined) return;
    let count = 0;
    void saving.save({
      ask: () =>
        commands.choose_export_file({
          title: "Export the leaderboard",
          name: file,
          folder: null,
          formats: ["csv"],
        }),
      write: (path) => {
        const now = latest.current;
        if (now.ask === undefined || now.blocker !== undefined) return undefined;
        const asked = now.ask;
        return readEveryRow(asked).then((every) => {
          count = every.rows.length;
          return commands.write_export_file({ path, text: leaderboardCsv(every) });
        });
      },
      said: (path) => ({
        lead: (
          <>
            Exported <span className="n">{count.toLocaleString("en-US")}</span>{" "}
            {count === 1 ? "row" : "rows"} to <FileIn path={path} />.
          </>
        ),
        hint: "Every row these filters keep, each with its Best start, as the table shows them.",
      }),
      what: "the leaderboard",
    });
  };
  return {
    button: (
      <span className="lb-export">
        <WorkingButton
          type="button"
          className="btn btn-sm"
          working={saving.working}
          words="Exporting…"
          {...b.props}
          {...grayProps(saving.gray)}
          onClick={(e) => {
            b.props.onClick(e);
            press();
          }}
        >
          Export CSV…
        </WorkingButton>
        {b.bubble}
      </span>
    ),
    outcome: saving.outcome,
  };
}
