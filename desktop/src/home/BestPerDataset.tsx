/**
 * Home's Best of ended runs (#391, #399, LaptopMain): each dataset's best on
 * its current data, named by its Best start, which a row opens; a dataset with
 * no runs opens Dataset detail, and one whose runs haven't ranked, its
 * latest run. A run fitting adds its live best on a line of its own (HF07).
 * Past 6, "N more in Datasets".
 */
import { Link } from "@tanstack/react-router";
import { rmse } from "../runs/words";
import { LiveN } from "../ui/LiveN";
import { BEST_SHOWN, type BestRow } from "./best";

/** A fitting run's best on hover: it's live (#373). */
const FIT_TIP = "In progress: this changes as its starts finish.";

export function BestPerDataset({ rows }: { rows: readonly BestRow[] }) {
  const shown = rows.slice(0, BEST_SHOWN);
  const more = rows.length - shown.length;
  return (
    <section className="hm-best" aria-labelledby="hm-best">
      <div className="home-region-head">
        <h2 id="hm-best" className="label">
          Best of ended runs
        </h2>
        <Link to="/results" className="link">
          All results
        </Link>
      </div>
      <div className="hm-btable">
        <div className="hm-bth" aria-hidden="true">
          <span className="th">Dataset</span>
          <span className="th">Val RMSE</span>
        </div>
        {rows.length === 0 ? (
          <p className="hm-bnone">
            No datasets yet. Make one with{" "}
            <Link to="/datasets/new" className="link">
              New dataset
            </Link>
            .
          </p>
        ) : (
          <ul className="hm-blist" aria-label="Best of ended runs">
            {shown.map((row) => (
              <li key={row.id}>
                <BestLink row={row} />
              </li>
            ))}
          </ul>
        )}
        {more > 0 && (
          <p className="hm-bmore">
            <Link to="/datasets" className="link">
              {more.toLocaleString("en-US")} more
            </Link>{" "}
            in Datasets
          </p>
        )}
      </div>
    </section>
  );
}

function BestLink({ row }: { row: BestRow }) {
  const body = (
    <>
      <span className="mono hm-bds">{row.name}</span>
      <span className="mono hm-bv">
        {row.byTrain && <span className="hm-btrain">train </span>}
        {row.rmse === undefined ? "—" : rmse(row.rmse)}
      </span>
      <span className="hm-meta">
        {row.named === undefined ? (
          row.sub
        ) : (
          <>
            <span className="n">{row.named.topology}</span> · start{" "}
            <span className="n">{row.named.start}</span> ·{" "}
            <span className="n">{row.named.states}</span> states
          </>
        )}
      </span>
      {row.fitting !== undefined && (
        <span className="hm-meta hm-bfit">
          #{row.fitting.run} is fitting ·{" "}
          <LiveN tip={FIT_TIP} className="n">
            {rmse(row.fitting.rmse)}
          </LiveN>{" "}
          so far
        </span>
      )}
    </>
  );
  const title = row.byTrain
    ? `${row.name} has no validation points, so its best is by Train RMSE`
    : undefined;
  const to = row.to;
  switch (to.kind) {
    case "start":
      return (
        <Link
          to="/runs/$id/$topology/$start"
          params={{
            id: String(to.run),
            topology: `T${to.graph}.${to.openState}`,
            start: String(to.start),
          }}
          className="row-link hm-brow"
          title={title}
        >
          {body}
        </Link>
      );
    case "run":
      return (
        <Link to="/runs/$id" params={{ id: String(to.run) }} className="row-link hm-brow">
          {body}
        </Link>
      );
    case "dataset":
      return (
        <Link to="/datasets/$id" params={{ id: to.id }} className="row-link hm-brow">
          {body}
        </Link>
      );
  }
}
