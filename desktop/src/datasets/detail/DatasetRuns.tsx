/**
 * A dataset's runs on Dataset detail (LaptopDatasetDetail, #236): in its
 * facts, how many and its best; and the section listing them, those on its
 * current data first, its best tinted, then those fit to earlier data, which
 * keep the data they were fit to and aren't ranked against the rest
 * (ADR-0003). A run opens its page; All runs opens Runs on the dataset, and
 * its best opens Results on it (#339).
 */
import { Link } from "@tanstack/react-router";
import { useDatasetRuns, useRunsUpTo } from "../../runs/queries";
import { rmse, RUNNING_TIP } from "../../runs/words";
import { runGlyph } from "../../submit/words";
import { useTooltip } from "../../ui/Tooltip";
import type { RunsDataset, RunSummary } from "../../wire/types.gen";

/** " · 8 runs (4 on earlier data) · best val 0.0393 (#211)", or " · no runs yet". */
export function RunsFact({ runs }: { runs: RunsDataset | undefined }) {
  if (runs === undefined || runs.runs === 0) return <> · no runs yet</>;
  const best = runs.best_val ?? runs.best_train;
  return (
    <>
      {" · "}
      <a
        href="#runs-h"
        className="link dd-facts-link"
        onClick={(e) => {
          e.preventDefault();
          const heading = document.getElementById("runs-h");
          heading?.closest("section")?.scrollIntoView({ block: "start" });
          heading?.focus({ preventScroll: true });
        }}
      >
        <span className="n">{runs.runs.toLocaleString("en-US")}</span>{" "}
        {runs.runs === 1 ? "run" : "runs"}
      </a>
      {runs.runs_earlier > 0 && runs.runs_earlier < runs.runs && (
        <> ({runs.runs_earlier.toLocaleString("en-US")} on earlier data)</>
      )}
      {best !== null && (
        <>
          {" "}
          · best {runs.best_val !== null ? "val" : "train"}{" "}
          <Link to="/results" search={{ dataset: runs.id }} className="best-v mono">
            {rmse(best.rmse)}
          </Link>{" "}
          <span className="mono">(#{best.run})</span>
        </>
      )}
    </>
  );
}

/** The dataset's runs: on its current data, then on earlier data, the newest first in each. */
export function DatasetRuns({ id, name }: { id: string | undefined; name: string | undefined }) {
  const runs = useDatasetRuns(id);
  // Until it has found them all, or a page's worth (200, the agent's `PAGE`); the rest are on Runs.
  const { runs: all, done } = useRunsUpTo(Math.min(runs?.runs ?? 1, 200), id ?? null);
  const called = name ?? "this dataset";
  // In flight first, then by when they ended, as Runs lists them: here, newest by number.
  const sorted = [...all].sort((a, b) => b.id - a.id);
  const now = sorted.filter((r) => !r.dataset.earlier);
  const earlier = sorted.filter((r) => r.dataset.earlier);
  const bestId = runs?.best_val?.run ?? runs?.best_train?.run;
  const byTrain = runs !== undefined && runs.best_val === null && runs.best_train !== null;
  return (
    <section aria-labelledby="runs-h" className="ds-runs-list">
      <div className="dd-runs-head">
        <h2 id="runs-h" className="label" tabIndex={-1}>
          Runs fit to {called}
        </h2>
        {id !== undefined && runs !== undefined && runs.runs > 0 && (
          <Link to="/runs" search={{ dataset: id }} className="link dd-runs-all">
            All {runs.runs.toLocaleString("en-US")} {runs.runs === 1 ? "run" : "runs"}
          </Link>
        )}
      </div>
      {all.length === 0 ? (
        done && <p className="ds-none">None yet.</p>
      ) : (
        <div role="table" aria-label={`Runs fit to ${called}`} className="dd-runs">
          <div role="row" className="dd-run dd-run-heads">
            <span role="columnheader" className="th">
              Status
            </span>
            <span role="columnheader" className="th">
              Run
            </span>
            <span role="columnheader" className="th">
              Name
            </span>
            <span role="columnheader" className="th">
              Progress
            </span>
            <span role="columnheader" className="th dd-run-num">
              {byTrain ? "Best train RMSE" : "Best val RMSE"}
            </span>
          </div>
          {now.map((r) => (
            <RunRow key={r.id} run={r} best={r.id === bestId} name={called} />
          ))}
          {earlier.length > 0 && (
            <>
              <div className="dd-runs-div" role="presentation">
                <h3 className="label">On earlier data</h3>
                <span>
                  {called} changed since these runs. They keep the data they were fit to, and aren’t
                  ranked against the runs above.
                </span>
              </div>
              {earlier.map((r) => (
                <RunRow key={r.id} run={r} best={false} name={called} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RunRow({ run: r, best, name }: { run: RunSummary; best: boolean; name: string }) {
  const value = r.best === null ? null : (r.best.val_rmse ?? r.best.train_rmse);
  // A run in flight's best can still change: underlined, with a hover; the row, its Tab stop,
  // names the bubble (#373).
  const live = r.ended_at === null && value !== null;
  const tip = useTooltip(live ? RUNNING_TIP : undefined);
  return (
    <Link
      to="/runs/$id"
      params={{ id: String(r.id) }}
      role="row"
      className={`dd-run row-link${best ? " dd-run-best" : ""}`}
      aria-describedby={live ? tip.id : undefined}
    >
      <span role="cell" className={r.state === "failed" ? "st st-failed" : "st"}>
        <span className={runGlyph(r.state)} aria-hidden="true" />
        {r.state}
      </span>
      <span role="cell" className="mono dd-run-id">
        #{r.id}
      </span>
      <span role="cell" className="mono dd-run-name">
        {r.config.name}
      </span>
      <span role="cell" className="dd-run-prog">
        <span className="mono">
          {r.progress.topologies_complete.toLocaleString("en-US")} /{" "}
          {r.progress.topologies.toLocaleString("en-US")}
        </span>{" "}
        topologies
      </span>
      <span role="cell" className="dd-run-best-cell">
        {best && <span className="dd-run-tag">best on {name}</span>}
        <span className="mono dd-run-v">
          <span className={live ? "live-n" : undefined} {...(live ? tip.hover : {})}>
            {value === null ? "—" : rmse(value)}
          </span>
        </span>
        {tip.bubble}
      </span>
    </Link>
  );
}
