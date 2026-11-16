/**
 * A config's runs on Configs (LaptopConfigs' Runs from this config, #236):
 * its newest few, each with its state, how far it has got and its ETA, and
 * its best RMSE, saying val or train (RF23), underlined while it runs, with a
 * hover that says why (#373); All runs opens Runs on its name.
 * A run follows its config's id, so a config renamed keeps its runs.
 */
import { Link } from "@tanstack/react-router";
import { useEtas, useMinute, useRunsUpTo } from "../runs/queries";
import { etaParts, rmse, RUNNING_TIP } from "../runs/words";
import { runGlyph } from "../submit/words";
import { useTooltip } from "../ui/Tooltip";
import type { RunSummary } from "../wire/types.gen";
import { whole } from "./words";

/** How many runs it lists: the rest are on Runs. */
const SHOWN = 5;

export function ConfigRuns({ id, name }: { id: string; name: string }) {
  const { runs: found, done } = useRunsUpTo(SHOWN, null, id);
  const now = useMinute();
  const runs = found.slice(0, SHOWN);
  const etas = useEtas(runs, now);
  return (
    <section aria-labelledby="cfg-runs" className="cf-section">
      <div className="cf-runs-head">
        <h3 id="cfg-runs" className="label">
          Runs from this config
        </h3>
        {runs.length > 0 && (
          <Link to="/runs" search={{ filter: name }} className="link cf-runs-all">
            All runs
          </Link>
        )}
      </div>
      {runs.length === 0 ? (
        done && <p className="ds-none">No runs have used this config yet.</p>
      ) : (
        <div role="table" aria-label="Runs from this config" className="cf-runs">
          <div role="row" className="cf-run cf-run-heads">
            <span role="columnheader" className="th">
              Status
            </span>
            <span role="columnheader" className="th">
              Run
            </span>
            <span role="columnheader" className="th cf-run-num">
              Best RMSE
            </span>
          </div>
          {runs.map((r) => (
            <Row key={r.id} run={r} eta={etas.get(r.id)} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function Row({ run: r, eta, now }: { run: RunSummary; eta: number | undefined; now: number }) {
  const p = r.progress;
  const value = r.best === null ? null : (r.best.val_rmse ?? r.best.train_rmse);
  // A run in flight's best can still change: underlined, with a hover; the row, its Tab stop,
  // names the bubble.
  const live = r.ended_at === null && value !== null;
  const tip = useTooltip(live ? RUNNING_TIP : undefined);
  const by = r.best === null ? undefined : r.best.val_rmse !== null ? "val" : "train";
  const e = eta === undefined ? undefined : etaParts(eta, now);
  return (
    <Link
      to="/runs/$id"
      params={{ id: String(r.id) }}
      role="row"
      className="cf-run row-link"
      aria-describedby={live ? tip.id : undefined}
    >
      <span role="cell" className={r.state === "failed" ? "st st-failed" : "st"}>
        <span className={runGlyph(r.state)} aria-hidden="true" />
        {r.state}
      </span>
      <span role="cell" className="cf-run-what">
        <span className="mono">#{r.id}</span>
        <span className="cf-run-lines">
          <span>
            {whole(p.topologies_complete)} / {whole(p.topologies)} topologies
          </span>
          {r.ended_at === null && (
            <span>
              {whole(p.starts_finished)} / {whole(p.starts)} starts
            </span>
          )}
          {e !== undefined && (
            <span>
              ETA {e.day === "Today" ? e.time : `${e.day}, ${e.time}`} · {e.left}
            </span>
          )}
        </span>
      </span>
      <span role="cell" className="cf-run-best">
        <span className="cf-run-by">
          {value !== null && <span className="cf-run-metric">{by}</span>}
          <span className={live ? "mono live-n" : "mono"} {...(live ? tip.hover : {})}>
            {value === null ? "—" : rmse(value)}
          </span>
        </span>
        {tip.bubble}
      </span>
    </Link>
  );
}
