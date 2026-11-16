/**
 * Results' sentences (LaptopResults, #339): its facts, each Ranking group's
 * name in the Data menu, the note over an earlier group, the empty states,
 * paging, and a row's state under its run. Days follow the clock rule (#116):
 * US order, the year only when it isn't this one.
 */
import { monthDay } from "../ui/clock";
import type { RankingGroup, RankingGroups, Run, RunState } from "../wire/types.gen";

const n = (x: number) => x.toLocaleString("en-US");
const count = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const day = (iso: string, now: number) => monthDay(Date.parse(iso), now);

/**
 * "Current", or the range its data was current: "Jul 20 – Aug 4", or its
 * day when it was current for one: "Oct 31" (RF23).
 */
export function groupName(g: RankingGroup, now: number): string {
  if (g.current_until === null) return "Current";
  const from = day(g.current_from, now);
  const until = day(g.current_until, now);
  return from === until ? from : `${from} – ${until}`;
}

/**
 * "139 ranked topologies from 5 runs · 1 still fitting · 100 shown", or with
 * a filter on, "38 of 139 ranked topologies match · …". Still fitting counts
 * the runs in flight. When every row is one run's, it names `run` once, as
 * Run detail's link (RF01): "41 ranked topologies from #206 nav15-wt-8state ·
 * still fitting · 41 shown".
 */
export function factsWords({
  total,
  ranked,
  runs,
  fitting,
  shown,
  filtered = false,
  run,
}: {
  total: number;
  ranked: number;
  runs: number;
  fitting: number;
  shown: number;
  filtered?: boolean;
  /** The one run every row is from. */
  run?: { id: number; name: string };
}): RunWords {
  const topologies = count(ranked, "ranked topology", "ranked topologies");
  const head = filtered
    ? `${n(total)} of ${topologies} ${total === 1 ? "matches" : "match"}`
    : topologies;
  const fittingWords =
    fitting === 0 ? undefined : run !== undefined ? "still fitting" : `${n(fitting)} still fitting`;
  const tail = [fittingWords, `${n(shown)} shown`].filter((x) => x !== undefined).join(" · ");
  if (run !== undefined) {
    return { before: `${head}${filtered ? ", from " : " from "}`, run, after: ` · ${tail}` };
  }
  const from = filtered ? head : `${head} from ${count(runs, "run", "runs")}`;
  return { before: `${from} · ${tail}`, run: undefined, after: "" };
}

/** The page's size: what Show more adds. */
export const PAGE = 100;

/** "Show 100 more", or the rest when fewer: "Show 39 more"; none once every row shows. */
export function moreWords(shown: number, total: number): string | undefined {
  const rest = total - shown;
  return rest > 0 ? `Show ${n(Math.min(PAGE, rest))} more` : undefined;
}

/** "100 of 139 shown", "All 139 shown". */
export function footShown(shown: number, total: number): string {
  if (shown < total) return `${n(shown)} of ${n(total)} shown`;
  return total === 1 ? "1 shown" : `All ${n(total)} shown`;
}

/**
 * What a row's caption says under its names: in progress, with its starts
 * running and queued, while it fits (#370); a canceled or failed run's state
 * where the topology ended short.
 */
export function startsUnder({
  fitting,
  runState,
  running,
  queued,
  short,
}: {
  fitting: boolean;
  runState: RunState;
  running: number;
  queued: number;
  short: boolean;
}): { glyph: string; words: string; failed: boolean } | undefined {
  if (fitting) {
    return {
      glyph: "g g-running live",
      words: `in progress · ${n(running)} running · ${n(queued)} queued`,
      failed: false,
    };
  }
  if (!short) return undefined;
  if (runState === "canceled") return { glyph: "g g-canceled", words: "canceled", failed: false };
  if (runState === "failed") return { glyph: "g g-failed", words: "failed", failed: true };
  return undefined;
}

const datasetCalled = (g: RankingGroups) => g.dataset.name ?? "This dataset";

/** The note over an earlier group: when its data changed, or its dataset was deleted. */
export function groupNote(g: RankingGroups, shown: RankingGroup, now: number): string | undefined {
  if (shown.current_until === null) return undefined;
  const name = datasetCalled(g);
  const runs = shown.runs.length;
  if (g.dataset.deleted) {
    const all = g.groups.reduce((sum, x) => sum + x.runs.length, 0);
    const deleted = g.groups[0]?.current_until ?? shown.current_until;
    const these = all === 1 ? "it ranks" : runs === 1 ? "this one ranks" : `these ${n(runs)} rank`;
    const from = day(shown.current_from, now);
    const until = day(shown.current_until, now);
    return (
      `${name} was deleted on ${day(deleted, now)}. ` +
      `${all === 1 ? "Its run keeps the data it was" : `Its ${n(all)} runs keep the data they were`} fit to; ` +
      `${these} on its data ${from === until ? `of ${from}` : `from ${from} to ${until}`}.`
    );
  }
  return (
    `${name} changed on ${day(shown.current_until, now)}. ` +
    (runs === 1
      ? "This run keeps the data it was fit to, so it ranks on its own."
      : `These ${n(runs)} runs keep the data they were fit to, so they rank only with each other.`)
  );
}

/**
 * On Current, the line under Data when earlier data have runs (RF05):
 * "herg-wt’s earlier data have 2 runs, ranked on their own: pick them in Data."
 */
export function earlierLine(g: RankingGroups, shown: RankingGroup): string | undefined {
  if (!shown.current) return undefined;
  const runs = g.groups.reduce((sum, x) => sum + (x.current ? 0 : x.runs.length), 0);
  if (runs === 0) return undefined;
  return `${datasetCalled(g)}’s earlier data have ${count(runs, "run", "runs")}, ranked on their own: pick them in Data.`;
}

/** The note under Dataset and Data without validation points (RF04). */
export const NO_VALIDATION_NOTE = "No validation points: ranked by the Best start’s Train RMSE.";

export interface RunWords {
  /** The sentence before the run, its link, and after. */
  before: string;
  run: { id: number; name: string } | undefined;
  after: string;
}

/**
 * A dataset with runs only on earlier data: its latest run, and the earlier
 * data it ranks on, newest first; `undefined` while its current data has runs.
 */
export function allEarlierWords(
  g: RankingGroups,
  now: number,
): (RunWords & { lead: string; button: string; digest: string }) | undefined {
  const current = g.groups.find((x) => x.current);
  const earlier = g.groups.filter((x) => !x.current && x.runs.length > 0);
  if (current === undefined || current.runs.length > 0 || earlier.length === 0) return undefined;
  const name = datasetCalled(g);
  const all = earlier.flatMap((x) => x.runs);
  const latest = all.reduce((a, b) => (b.id > a.id ? b : a));
  const one = all.length === 1;
  return {
    lead: `No run on ${name}’s current data yet.`,
    before: `${name} changed on ${day(current.current_from, now)}. ${one ? "Its run, " : `Its ${n(all.length)} runs, the latest `}`,
    run: { id: latest.id, name: latest.config.name },
    after: one
      ? ", was fit to the data before, and ranks there."
      : ", were fit to the data before, and rank there.",
    button: `Show its data from ${groupName(earlier[0], now)}`,
    digest: earlier[0].scoring_digest,
  };
}

/** Nothing ranked yet: how a topology ranks, and the run in flight, if one is. */
export function emptyWords(dataset: string, latest: Run | undefined): RunWords & { lead: string } {
  const lead = `Nothing on ${dataset} is ranked yet.`;
  const rule = "A topology ranks once one of its starts finishes.";
  if (latest === undefined) return { lead, before: rule, run: undefined, after: "" };
  const p = latest.progress;
  const running = p.starts_running;
  const first = p.topologies_complete + p.topologies_failed === 0;
  const after =
    latest.state === "running"
      ? ` is fitting${first ? " its first topology" : ""}: ${n(running)} of its starts ${running === 1 ? "is" : "are"} running and none has finished.`
      : ` is ${latest.state}, and none of its starts has finished.`;
  return { lead, before: `${rule} `, run: { id: latest.id, name: latest.config.name }, after };
}
