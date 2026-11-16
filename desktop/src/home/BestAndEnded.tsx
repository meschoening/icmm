/**
 * Home's Best per dataset and Ended (#391) over their reads, kept as of
 * when the connection went (`useKept`), as Home's own are (#390). Best per
 * dataset sits beside Live; Ended goes under them.
 */
import { useReadAgain } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { useKept } from "../submit/kept";
import { bestRows } from "./best";
import { BestPerDataset } from "./BestPerDataset";
import { useBestEndedReads } from "./bestEndedReads";
import { latestEnded } from "./ended";
import { EndedRuns } from "./EndedRuns";
import type { SavedPlatform, WireError } from "../wire/types.gen";

/**
 * Both regions, each `null` until its reads are in, whether they are
 * (`ready`), and a failed first read with its Try again, which Home's own
 * reading and failure show with its other reads'. `waitOn` is what Open its
 * log and Resume wait on while Home is as of when the connection went (`HomeKept`).
 */
export function useBestAndEnded({
  now,
  platform,
  waitOn,
}: {
  now: number;
  platform: Pick<SavedPlatform, "type" | "name"> | undefined;
  waitOn: string | undefined;
}) {
  const c = useConnection();
  const { reads, error, refetch, fetching } = useBestEndedReads();
  const kept = useKept(
    reads,
    {
      connected: c.status === "connected",
      live: c.status === "connected" || c.status === "reconnecting",
      platform: c.status === "none" ? "" : c.platformId,
      heardAt: heardAtOf(c),
    },
    now,
  );
  const shown = kept.value;
  // A read that failed before any was in: Home says so, with Try again (#391).
  const read = useReadAgain(
    shown === undefined && error !== undefined ? (error as unknown as WireError) : undefined,
    refetch,
  );
  const state = { ready: shown !== undefined, fetching, ...read };
  if (shown === undefined || platform === undefined) return { ...state, best: null, ended: null };
  const inFlight = shown.runs.filter((r) => r.ended_at === null);
  return {
    ...state,
    best: <BestPerDataset rows={bestRows(shown.datasets, shown.overview.datasets, inFlight)} />,
    ended: (
      <EndedRuns
        runs={latestEnded(shown.runs)}
        total={shown.overview.counts.ended}
        datasets={shown.overview.datasets}
        platform={platform}
        off={waitOn}
        now={now}
      />
    ),
  };
}
