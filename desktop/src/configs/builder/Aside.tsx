/**
 * The Config builder's aside (LaptopConfigBuilder): Work, the starts a run
 * of the config holds (#180: starts only); Time, how long that run takes and
 * each start's evaluations and time (#471); and Data, the chosen dataset's
 * protocols, each a thumbnail of its points.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { logX, templateWords } from "../../datasets/detail/words";
import { useDataset } from "../../datasets/detail/read";
import type { TimeView } from "../../submit/plan";
import type { Protocol, Template, Work as WorkCounts } from "../../wire/types.gen";
import { whole } from "../words";

/** The most starts a run holds (ADR-0017). */
export const MAX_RUN_STARTS = 100_000;

export function Work({
  work,
  perTopology,
  uncounted,
}: {
  /** The engine's work for the fields as they are; `undefined` before it answers. */
  work: WorkCounts | undefined;
  /** Starts per topology, from the answer `work` is (CF09); `null` without one. */
  perTopology: number | null;
  /** Why it can't count yet, when the fields have none of the engine's counts. */
  uncounted: string;
}) {
  const starts = work?.starts ?? null;
  const topologies = work?.topologies ?? null;
  const over = starts !== null && starts > MAX_RUN_STARTS;
  return (
    <section aria-labelledby="cb-work" className="cb-work">
      <h2 id="cb-work" className="label">
        Work
      </h2>
      <span className="cb-total">
        <span className={`mono cb-total-n${over ? " over" : ""}`}>
          {starts === null ? "—" : whole(starts)}
        </span>
        {/* A word apart, as it reads. */}{" "}
        <span className="cb-total-w">{starts === 1 ? "start" : "starts"}</span>
      </span>
      {starts !== null && topologies !== null && perTopology !== null ? (
        <span className="cb-times">
          = <span className="mono">{whole(topologies)}</span>{" "}
          {topologies === 1 ? "topology" : "topologies"} ×{" "}
          <span className="mono">{whole(perTopology)}</span>
        </span>
      ) : (
        <span className="cb-times cb-quiet">{uncounted}</span>
      )}
      {over && (
        <p className="err">
          More than a run holds (<span className="n">{whole(MAX_RUN_STARTS)}</span>).
        </p>
      )}
    </section>
  );
}

/**
 * The run's time as Submit run says it (`time.ts`): the whole run at the
 * running cap, where that comes from, and each start's evaluations and time,
 * with its time limit on SLURM. Past the limit, each start's time is red and
 * Submit's sentence takes the place of where the time comes from.
 */
export function Time({
  time,
  evaluations,
}: {
  time: TimeView;
  /** What each start runs, as the engine counts it; `null` until it can. */
  evaluations: number | null;
}) {
  return (
    <section aria-labelledby="cb-time" className="cb-time">
      <h2 id="cb-time" className="label">
        Time
      </h2>
      <span className="cb-time-head">
        <span className="cb-time-big">{time.big}</span>
        {/* Not drawn in a flex row, but read between the two. */}
        {time.after !== undefined && (
          <>
            {" "}
            <span className="cb-time-after">{time.after}</span>
          </>
        )}
      </span>
      {time.hint !== undefined && <span className="hint cb-time-hint">{time.hint}</span>}
      {time.past !== undefined && (
        <p className="cb-time-past">
          <span className="g g-failed" aria-hidden="true" />
          <span>{time.past}</span>
        </p>
      )}
      <dl className="cb-each">
        <div className="cb-kv">
          <dt>Each start</dt>
          <dd className="cb-each-dd">
            <span>
              <span className="mono">{evaluations === null ? "—" : whole(evaluations)}</span>{" "}
              evaluations
            </span>
            <span className={time.over ? "cb-each-time over" : "cb-each-time"}>
              {time.each}
              {time.limit !== undefined && <span className="cb-each-limit"> · {time.limit}</span>}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The chosen dataset: its protocols' points, its point counts, and Open. A
 * dataset deleted, or not chosen yet, says its protocols show once one is.
 */
export function Data({
  id,
  name,
  live,
}: {
  /** The chosen dataset, by id; `""` while none is. */
  id: string;
  name: string | undefined;
  /** Whether the platform still has it. */
  live: boolean;
}) {
  if (id === "" || !live) {
    return (
      <section aria-labelledby="cb-data" className="cb-data">
        <h2 id="cb-data" className="label">
          Data
        </h2>
        <p className="hint">Its protocols show here once you choose a dataset.</p>
      </section>
    );
  }
  return <Chosen id={id} name={name} />;
}

function Chosen({ id, name }: { id: string; name: string | undefined }) {
  const q = useDataset(id);
  // A connection that ends forgets its reads; the builder keeps showing this one.
  const [kept, setKept] = useState(q.data);
  if (q.data !== undefined && q.data !== kept) setKept(q.data);
  const saved = q.data ?? (kept?.id === id ? kept : undefined);
  const content = saved?.content;
  const points = content?.protocols.flatMap((p) => p.points) ?? [];
  const validation = points.filter((p) => p.validation).length;
  return (
    <section aria-labelledby="cb-data" className="cb-data">
      <div className="cb-data-head">
        <h2 id="cb-data" className="label">
          Data · <span className="mono">{content?.name ?? name ?? id}</span>
        </h2>
        <Link to="/datasets/$id" params={{ id }} className="link">
          Open
        </Link>
      </div>
      {content !== undefined && (
        <>
          <div className="cb-thumbs">
            {content.protocols.map((p, i) => (
              <Thumb key={p.name} protocol={p} template={saved!.templates[i]} />
            ))}
          </div>
          <p className="hint">
            <span className="mono ink-2">{whole(points.length)}</span>{" "}
            {points.length === 1 ? "point" : "points"} ·{" "}
            <span className="mono ink-2">{whole(validation)}</span> validation, set in the dataset
          </p>
          {/* What that means, as a plain line: a fact's consequence, not a note (CF17). */}
          {validation === 0 && (
            <p className="hint">Its runs rank by Train RMSE, below runs with validation points.</p>
          )}
        </>
      )}
      {q.isError && content === undefined && (
        <p className="hint">Its protocols show here once ICMM can read {name ?? "it"}.</p>
      )}
    </section>
  );
}

/** A protocol's measured points, small, with its name under them. */
function Thumb({ protocol, template }: { protocol: Protocol; template: Template | undefined }) {
  const measured = protocol.points.filter((p) => !p.interpolated);
  const shown = measured.length > 0 ? measured : protocol.points;
  const log = logX(protocol);
  const fx = (x: number) => (log ? Math.log10(Math.max(x, 1e-9)) : x);
  const xs = shown.map((p) => fx(p.x));
  const ys = shown.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const px = (x: number) => (x1 === x0 ? 33 : 5 + ((fx(x) - x0) / (x1 - x0)) * 56);
  const py = (y: number) => (y1 === y0 ? 20 : 35 - ((y - y0) / (y1 - y0)) * 30);
  const words =
    template === undefined ? protocol.name : templateWords(template, protocol.steps.length);
  return (
    <div className="cb-thumb" title={words}>
      <svg
        width="100%"
        height="36"
        viewBox="0 0 66 40"
        fill="none"
        role="img"
        aria-label={`${protocol.name}, ${words}`}
      >
        <path d="M3 38.5H63" className="cb-thumb-base" />
        <g className="cb-thumb-dots">
          {shown.map((p, i) => (
            <circle key={i} cx={px(p.x)} cy={py(p.value)} r="1.7" />
          ))}
        </g>
      </svg>
      <span className="mono cb-thumb-name">{protocol.name}</span>
    </div>
  );
}
