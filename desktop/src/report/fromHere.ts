/**
 * Report a problem… from the page in view (#470): ⌘K's Do row asks the page,
 * which opens its panel under its head (`useReport`'s `page` look). A page
 * offers it while it's mounted (`useReportFromHere`), naming itself in the
 * row's gray words; with no page offering it, ⌘K has no row.
 *
 * A start, a topology and a run offer their own (StartPage, TopologyPage,
 * RunPage); every other page offers `ReportFromHere` (`ReportFromHere.tsx`),
 * by its name.
 */
import { useEffect, useRef } from "react";
import type { Words } from "../shell/palette/do";
import type { Run } from "../wire/types.gen";

interface Here {
  side: () => Words;
  open: () => void;
}

/** The page that offers it now: the last one mounted. */
let here: Here | undefined;

export const reportHere = {
  /** The page's gray words, "about #214/T12.3 · start 23"; none while no page offers it. */
  side: (): Words | undefined => here?.side(),
  /** Opens the page's panel, as its ··· does. */
  ask: () => here?.open(),
};

/** Offers Report a problem… to ⌘K while the page is mounted: `side` names it, `open` opens it. */
export function useReportFromHere(side: Words, open: () => void): void {
  const latest = useRef({ side, open });
  useEffect(() => {
    latest.current = { side, open };
  });
  useEffect(() => {
    const mine: Here = { side: () => latest.current.side, open: () => latest.current.open() };
    here = mine;
    return () => {
      if (here === mine) here = undefined;
    };
  }, []);
}

/** A run as it was submitted, as a report holds it: its config's settings, search seed and engine. */
export function submitted(run: Run): string {
  return JSON.stringify(
    {
      run: run.id,
      num_states: run.num_states,
      settings: run.settings,
      search_seed: run.search_seed,
      engine: run.engine,
    },
    null,
    2,
  );
}
