/**
 * A run's fitting time (#326, #324): from its first start running to its end,
 * or now, leaving out each stop. Run detail's stages, pace and ETA count it,
 * and so do Runs' Duration and the run-ended notifications, from a summary.
 */
import type { RunSummary } from "../wire/types.gen";

const at = (iso: string | null | undefined) => (iso == null ? NaN : Date.parse(iso));

/** What a run's times are read from: Runs' summaries have them too. */
export type Times = Pick<
  RunSummary,
  "state" | "submitted_at" | "ended_at" | "resuming" | "first_running_at" | "stops"
>;

/** When it ended, and how: from its end, or, while it resumes, from the end it resumes. */
export function endOf(
  r: Times,
): { at: number; how: "completed" | "failed" | "canceled" } | undefined {
  if (r.resuming !== null && r.ended_at === null) {
    return { at: at(r.resuming.ended_at), how: r.resuming.ended };
  }
  if (r.ended_at === null) return undefined;
  if (r.state !== "completed" && r.state !== "failed" && r.state !== "canceled") return undefined;
  return { at: at(r.ended_at), how: r.state };
}

/**
 * How long the run has spent fitting by `now`, in seconds (#326): from its
 * first start running to its end, or `now`, leaving out each stop, from the
 * end it was resumed from until a start ran again. `undefined` before any
 * start ran.
 */
export function fittingSeconds(r: Times, now: number): number | undefined {
  const first = at(r.first_running_at);
  if (Number.isNaN(first)) return undefined;
  let fit = 0;
  // When the stretch it's fitting in began; NaN while no start has run since a stop.
  let from = first;
  for (const stop of r.stops) {
    const ended = at(stop.ended_at);
    if (ended > from) fit += ended - from;
    from = at(stop.running_at);
  }
  const until = endOf(r)?.at ?? now;
  if (until > from) fit += until - from;
  return fit / 1000;
}
