/**
 * Where Results opens (#336, P1 and P8): the dataset, run and Ranking group
 * its URL names, the dataset it last showed on each platform this session,
 * and the sort it starts with on a new install.
 */
import type { LeaderboardSort } from "../wire/types.gen";

/**
 * Results can open on a dataset (`?dataset=<id>`: Datasets' Best val), one of
 * its runs (`&run=214`: Runs' Results →, which shows that run's group) and a
 * Ranking group (`&data=<scoring digest>`).
 */
export interface ResultsSearch {
  dataset?: string;
  run?: number;
  data?: string;
}

export function validateResultsSearch(search: Record<string, unknown>): ResultsSearch {
  const run = typeof search.run === "number" ? search.run : Number(search.run);
  return {
    ...(typeof search.dataset === "string" ? { dataset: search.dataset } : {}),
    ...(Number.isInteger(run) && run >= 1 ? { run } : {}),
    ...(typeof search.data === "string" ? { data: search.data } : {}),
  };
}

/** The dataset Results last showed on each platform, this session (P1). */
export const lastShown = new Map<string, string>();

/** The toolbar's filters but Runs, which the URL holds. */
export interface Filters {
  states: number | null;
  max: string;
  near: number | null;
  fitting: boolean;
}

export const NO_FILTERS: Filters = { states: null, max: "", near: null, fitting: true };

/**
 * Each Ranking group's filters on each platform, this session (RF21, #368),
 * by `platform/dataset/scoring digest`: leaving Results and coming back
 * keeps them, as the sort is kept.
 */
export const filtersShown = new Map<string, Filters>();

/** Forgets what Results last showed: the app's session starting again (tests). */
export function forgetLastShown(): void {
  lastShown.clear();
  filtersShown.clear();
}

export const RANK_SORT: LeaderboardSort = { order: "rank", descending: false };
