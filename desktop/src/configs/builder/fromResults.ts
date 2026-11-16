/**
 * New config from these… (#343; LaptopConfigBuilder's `from-results`): the
 * Config builder on the picks' dataset, their topologies as Specific IDs,
 * and the other settings of the top-ranked pick's run. Across several of
 * the dataset's Ranking groups, that's the top-ranked pick in the newest.
 *
 * Results' selection bar sends the picks as `?picks=214/T12.3,211/T7.0`,
 * beside Find custom topology's `dataset`, `states` and `ids`. Each pick's
 * rank is one `read_group_rank`, the groups' order is `list_ranking_groups`,
 * and the run's settings are `read_run`'s, as recorded at submit.
 */
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useRankingGroups } from "../../results/queries";
import { agentKey, canAsk, platformOf } from "../../setup/queries";
import { useConnection } from "../../shell/connection";
import { useRun } from "../../submit/queries";
import { commands } from "../../wire/api.gen";
import type { GroupRank, RankingGroup, Run, WireError } from "../../wire/types.gen";
import { draftOf, newDraft, type ConfigDraft } from "./draft";

/** A pick's topology in its run, as the builder's `picks` search writes it: `214/T12.3`. */
export interface PickedTopology {
  run: number;
  graph: number;
  open_state: number;
}

/** `214/T12.3`: a pick's topology in its run. */
export const pickedText = (p: PickedTopology) => `${p.run}/T${p.graph}.${p.open_state}`;

const PICKED = /^\s*(\d+)\/T(\d+)\.(\d+)\s*$/;

/** The picks `?picks=` names, each once; any entry that isn't one is left out. */
export function parsePicks(text: string): PickedTopology[] {
  const seen = new Set<string>();
  return text.split(",").flatMap((entry) => {
    const m = entry.match(PICKED);
    if (m === null) return [];
    const p = { run: Number(m[1]), graph: Number(m[2]), open_state: Number(m[3]) };
    if (!(p.run >= 1) || seen.has(pickedText(p))) return [];
    seen.add(pickedText(p));
    return [p];
  });
}

/** A pick and its topology's rank in its run's Ranking group; `null` once its run is gone. */
export interface Ranked {
  pick: PickedTopology;
  rank: GroupRank | null;
}

/**
 * The pick whose run gives the other settings: in the newest Ranking group
 * the picks are in, the best Val rank, then the first picked; unranked picks
 * (no start of theirs finished) after the ranked, and gone runs never.
 * `undefined` when every pick's run is gone.
 */
export function topPick(
  ranked: readonly Ranked[],
  groups: readonly Pick<RankingGroup, "scoring_digest">[],
): PickedTopology | undefined {
  const age = (r: GroupRank) => {
    const i = groups.findIndex((g) => g.scoring_digest === r.scoring_digest);
    return i < 0 ? groups.length : i;
  };
  const kept = ranked.filter((r): r is Ranked & { rank: GroupRank } => r.rank !== null);
  const sorted = kept
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        age(a.r.rank) - age(b.r.rank) ||
        (a.r.rank.rank ?? Infinity) - (b.r.rank.rank ?? Infinity) ||
        a.i - b.i,
    );
  return sorted[0]?.r.pick;
}

/**
 * The free name it opens with (#339): the run's config's, `-refit`, or
 * `-refit-2`, `-refit-3`… when another config has it, ignoring case, cut to
 * fit 64, as Duplicate's `-copy` is.
 */
export function refitName(name: string, names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const end = n === 1 ? "-refit" : `-refit-${n}`;
    const candidate = name.slice(0, 64 - end.length) + end;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Where the builder's settings came from, as its note says it. */
export interface FromResults {
  /** The top-ranked pick's run; `null` when every pick's run is gone. */
  run: Run | null;
  /** That pick's Ranking group, for the note's Results link. */
  scoring_digest: string | undefined;
  /** How many topologies were picked: a topology two runs fit, picked from each, is one. */
  topologies: number;
  /** The picks' runs, each once, in the order picked. */
  runs: number[];
}

export type FromResultsRead =
  | { state: "reading" }
  | { state: "failed"; error: WireError; retry: () => Promise<unknown> }
  | { state: "ready"; from: FromResults };

const isGone = (error: unknown) => (error as WireError | null)?.code === "not_found";

/**
 * The top-ranked pick's run, read once its picks' ranks and the dataset's
 * Ranking groups are: a run deleted since it was picked is passed over.
 */
export function useFromResults(
  dataset: string | undefined,
  picks: readonly PickedTopology[] | undefined,
): FromResultsRead {
  const c = useConnection();
  const asked = picks ?? [];
  const ranks = useQueries({
    queries: asked.map((p) => ({
      queryKey: agentKey(platformOf(c), "runs", "group_rank", p.run, p.graph, p.open_state),
      queryFn: () => commands.read_group_rank(p),
      enabled: canAsk(c),
    })),
  });
  const groups = useRankingGroups(picks === undefined ? undefined : dataset);
  /** Runs `read_run` found gone after their pick's rank was read. */
  const [gone, setGone] = useState<readonly number[]>([]);

  const ranked: Ranked[] = asked.map((pick, i) => {
    const q = ranks[i];
    return { pick, rank: gone.includes(pick.run) || isGone(q.error) ? null : (q.data ?? null) };
  });
  const settled = ranks.every((q) => q.data !== undefined || isGone(q.error));
  const top =
    settled && groups.data !== undefined ? topPick(ranked, groups.data.groups) : undefined;
  const run = useRun(top?.run);
  if (top !== undefined && isGone(run.error) && !gone.includes(top.run)) {
    setGone([...gone, top.run]);
  }

  const failed = [...ranks, groups, run].find((q) => q.error != null && !isGone(q.error));
  if (failed !== undefined) {
    const retry = () =>
      Promise.all(
        [...ranks, groups, run]
          .filter((q) => q.error != null && !isGone(q.error))
          .map((q) => q.refetch()),
      );
    return { state: "failed", error: failed.error as unknown as WireError, retry };
  }
  if (!settled || groups.data === undefined) return { state: "reading" };
  if (top !== undefined && run.data === undefined) return { state: "reading" };
  const rank = ranked.find((r) => r.pick === top)?.rank;
  return {
    state: "ready",
    from: {
      run: top === undefined ? null : run.data!,
      scoring_digest: rank?.scoring_digest,
      topologies: new Set(asked.map((p) => `T${p.graph}.${p.open_state}`)).size,
      runs: [...new Set(asked.map((p) => p.run))],
    },
  };
}

/**
 * What the builder opens on: the run's settings, or the defaults when a
 * newer ICMM submitted it or every pick's run is gone; the picks' dataset,
 * number of states and topologies; and the free name, `""` without a run.
 */
export function fromResultsDraft(
  from: FromResults,
  picked: { dataset: string; states: string; ids: string },
  names: readonly string[],
): ConfigDraft {
  const run = from.run;
  const base = run?.settings != null ? draftOf(run.settings) : newDraft(picked.dataset);
  return {
    ...base,
    name: run === null ? "" : refitName(run.config.name, names),
    dataset: picked.dataset,
    states: picked.states,
    which: "ids",
    ids: picked.ids,
  };
}
