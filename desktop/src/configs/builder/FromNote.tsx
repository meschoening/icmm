/**
 * The note under the builder's head when it opens from Results' New config
 * from these… (#339's `from-results`): what it took from Results and from
 * which run, and what's left to do. When the run's settings can't be used,
 * it says why the others are the defaults.
 */
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { runName } from "../../runs/words";
import type { FromResults } from "./fromResults";

/** `#210`, `#210 and #211`, `#209, #210 and #211`, each in mono as ids are. */
function runsWords(runs: number[]): ReactNode {
  return runs.map((r, i) => (
    <Fragment key={r}>
      {i === 0 ? "" : i === runs.length - 1 ? " and " : ", "}
      <span className="mono">#{r}</span>
    </Fragment>
  ));
}

export function FromNote({ from, dataset }: { from: FromResults; dataset: string }) {
  const { run, topologies } = from;
  const chose =
    topologies === 1 ? (
      "the topology you chose"
    ) : (
      <>
        the <span className="n">{topologies.toLocaleString("en-US")}</span> topologies you chose
      </>
    );
  const runLink =
    run === null ? null : (
      <Link to="/runs/$id" params={{ id: String(run.id) }} className="link mono">
        {runName(run)}
      </Link>
    );
  const search =
    from.scoring_digest === undefined ? { dataset } : { dataset, data: from.scoring_digest };
  return (
    <div className="cb-from" role="note">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.5 5.6v3.6" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6.5" cy="3.8" r=".8" fill="currentColor" />
      </svg>
      <p>
        From{" "}
        <Link to="/results" search={search} className="link">
          Results
        </Link>
        : {chose}, as Specific IDs
        {run === null ? (
          <>
            . The other settings are the defaults: {runsWords(from.runs)}{" "}
            {from.runs.length === 1 ? "was" : "were"} deleted.
          </>
        ) : run.settings === null ? (
          <>
            . The other settings are the defaults: a newer ICMM submitted {runLink}, the top-ranked
            pick’s run.
          </>
        ) : (
          <>, and the other settings of {runLink}, the top-ranked pick’s run.</>
        )}{" "}
        Set the starts per topology, then save.
      </p>
    </div>
  );
}
