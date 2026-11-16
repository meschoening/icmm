/**
 * Home's Ended (#391, LaptopMain): the latest 3 runs to end, whatever their
 * age, each with one chart, of the protocol its top topology's Best start's
 * page marks highest (`FitSection`'s rule: Val RMSE ranks, else Train RMSE).
 */
import { clock } from "../ui/clock";
import { comparedOf, fitFor, rmse } from "../runs/words";
import { protocolRmse } from "../runs/start/words";
import type { ProtocolScore, RunDataset, RunsDataset, RunSummary } from "../wire/types.gen";

/** How many ended runs Home shows. */
export const ENDED_SHOWN = 3;

/** The latest `n` runs of `runs` to end, the latest first. */
export function latestEnded<T extends Pick<RunSummary, "ended_at">>(
  runs: readonly T[],
  n = ENDED_SHOWN,
): T[] {
  return runs
    .filter((r) => r.ended_at !== null)
    .sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))
    .slice(0, n);
}

/**
 * The protocol with the highest stored error, as a start's page marks it:
 * by val RMSE with validation points, else by train RMSE. One whose sweep
 * failed has none, so it's the highest only when none has one.
 */
export function highestOf(
  scores: readonly ProtocolScore[],
  validation: boolean,
): { index: number; rmse: number | null } | undefined {
  let highest: { index: number; rmse: number | null } | undefined;
  scores.forEach((s, index) => {
    const rmse = validation
      ? protocolRmse(s.val_sse, s.val_points, s.val_failed)
      : protocolRmse(s.train_sse, s.train_points, s.train_failed);
    if (highest === undefined || (rmse !== null && (highest.rmse === null || rmse > highest.rmse)))
      highest = { index, rmse };
  });
  return highest;
}

/** "ended Tue, Aug 11, 11:52 PM after 5 d 5 h"; without its fitting time when no start ran. */
export function endedWords(r: RunSummary, now: number): string {
  return endedParts(r, now).join(" ");
}

/**
 * `endedWords` in the pieces a line keeps whole, so a narrow card breaks
 * between them (#399): "ended Tue, Aug 11, 11:52 PM", "after 5 d 5 h".
 */
export function endedParts(r: RunSummary, now: number): string[] {
  const at = Date.parse(r.ended_at ?? "");
  if (Number.isNaN(at)) return ["ended"];
  const took = fitFor(r, at);
  const when = `ended ${clock(at, now)}`;
  return took === undefined ? [when] : [when, `after ${took}`];
}

/**
 * What "earlier data" means, on hover (#398, HF09): the revision the run fit
 * and the current one, `current` once the datasets are read.
 */
export function earlierTip(d: RunDataset, current: number | undefined): string {
  const name = d.name ?? "its dataset";
  const ranks = `so this run ranks only with runs on revision ${d.revision}.`;
  return current === undefined
    ? `Fit to ${name}’s revision ${d.revision}, an earlier one, ${ranks}`
    : `Fit to ${name}’s revision ${d.revision}. ${name} is at revision ${current} now, ${ranks}`;
}

/**
 * What "4.6 % higher" is above, on hover (#398, HF14): "4.6 % above
 * herg-wt’s best, #211’s 0.0393 Val RMSE."; `undefined` for a run that isn't
 * compared or is its dataset's best.
 */
export function higherTip(r: RunSummary, dataset: RunsDataset | undefined): string | undefined {
  const c = comparedOf(r, dataset);
  const best = c.byTrain ? dataset?.best_train : dataset?.best_val;
  if (c.best || c.word === "—" || best == null) return undefined;
  const percent = c.word.replace(/ higher$/, "");
  return `${percent} above ${r.dataset.name ?? "its dataset"}’s best, #${best.run}’s ${rmse(best.rmse)} ${c.byTrain ? "Train RMSE" : "Val RMSE"}.`;
}

/** A drifting protocol as the card names it: its RMSE drawn here, and as stored. */
export interface Drifted {
  name: string;
  drawn: string;
  stored: string;
}

/**
 * The drifting protocols whose RMSE differs as the card shows it (#398,
 * HF08): Val RMSE with validation points, else Train RMSE, to 4 places.
 * `names` are the revision's protocols, which `stored` and `drawn` follow.
 */
export function driftedOf(
  drifting: readonly string[],
  names: readonly string[],
  stored: readonly ProtocolScore[],
  drawn: readonly ProtocolScore[],
  validation: boolean,
): Drifted[] {
  const shown = (s: ProtocolScore | undefined) => {
    if (s === undefined) return "—";
    const x = validation
      ? protocolRmse(s.val_sse, s.val_points, s.val_failed)
      : protocolRmse(s.train_sse, s.train_points, s.train_failed);
    return x === null ? "—" : rmse(x);
  };
  return drifting.flatMap((name) => {
    const i = names.indexOf(name);
    const d = { name, drawn: shown(drawn[i]), stored: shown(stored[i]) };
    return i < 0 || d.drawn === d.stored ? [] : [d];
  });
}
