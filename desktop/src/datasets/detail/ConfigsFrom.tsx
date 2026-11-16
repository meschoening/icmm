/**
 * Dataset detail's "Configs from herg-wt" (#213, CF14; LaptopDatasetDetail),
 * above the runs they make: the configs that name the dataset, by id, so
 * herg-wt-37c's don't count as herg-wt's. Each row is the config's name, its
 * states · topologies · starts (its row on Configs, less the dataset) and its
 * runs, and opens it on Configs. Runs come with Submit & Runs, so until then
 * each row says it has none, as Configs' rows do.
 */
import { useNow } from "../../connection/useNow";
import { RunStatus } from "../../submit/RunStatus";
import { Link } from "@tanstack/react-router";
import { rowFacts } from "../../configs/words";
import type { ConfigSummary } from "../../wire/types.gen";

/** The section's heading, which the facts' count links to. */
export const CONFIGS_HEADING_ID = "configs-h";

/**
 * " · 3 configs" in the facts, after the points, linking to the section as
 * Jump to links to a protocol; nothing at none.
 */
export function ConfigsFact({ configs }: { configs: ConfigSummary[] | undefined }) {
  if (configs === undefined || configs.length === 0) return null;
  return (
    <>
      {" · "}
      <a
        href={`#${CONFIGS_HEADING_ID}`}
        className="link dd-facts-link"
        onClick={(e) => {
          e.preventDefault();
          const heading = document.getElementById(CONFIGS_HEADING_ID);
          heading?.closest("section")?.scrollIntoView({ block: "start" });
          heading?.focus({ preventScroll: true });
        }}
      >
        <span className="n">{configs.length}</span> {configs.length === 1 ? "config" : "configs"}
      </a>
    </>
  );
}

/** Within a fact, and before each dot, a space a line doesn't break at. */
const NB = "\u00a0";

/** Where a dataset with no configs came from, and how many configs that one has. */
export interface Source {
  name: string;
  configs: number;
}

export function ConfigsFrom({
  name,
  configs,
  copyOf,
  savedFrom,
  gone = false,
}: {
  name: string;
  configs: ConfigSummary[];
  /** A copy just duplicated: the dataset it copied, whose configs stay with it. */
  copyOf?: Source;
  /** Saved again as a new dataset: the deleted one, whose configs can choose this one. */
  savedFrom?: Source;
  /** Deleted on another computer: its configs can't submit until they name another. */
  gone?: boolean;
}) {
  const one = configs.length === 1;
  return (
    <section aria-labelledby={CONFIGS_HEADING_ID} className="ds-runs-list">
      <h2 id={CONFIGS_HEADING_ID} className="label" tabIndex={-1}>
        Configs from {name}
      </h2>
      {configs.length === 0 ? (
        <p className="ds-none">
          None yet.
          {copyOf !== undefined && copyOf.configs > 0 && (
            <>
              {" "}
              {copyOf.name}’s <span className="n">{copyOf.configs}</span>{" "}
              {copyOf.configs === 1 ? "config stays" : "configs stay"} with {copyOf.name}.
            </>
          )}
          {savedFrom !== undefined && savedFrom.configs > 0 && (
            <>
              {" "}
              The <span className="n">{savedFrom.configs}</span>{" "}
              {savedFrom.configs === 1 ? "config" : "configs"} from the deleted {savedFrom.name} can
              choose this one in Edit.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="dd-configs">
            {configs.map((x) => (
              <Row key={x.id} config={x} />
            ))}
          </div>
          {gone && (
            <p className="hint dd-configs-note">
              {one ? "It" : "They"} can’t submit until you choose another dataset in Edit.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * A config: its name, its facts, a line breaking only after a dot, or that a
 * newer ICMM saved it, as its row on Configs says; and its runs.
 */
function Row({ config: x }: { config: ConfigSummary }) {
  const now = useNow([]);
  return (
    <Link to="/configs" search={{ id: x.id }} className="row-link dd-config">
      <span className="mono dd-config-name">{x.name}</span>
      <span className="dd-config-facts">
        {x.unreadable !== null ? (
          <>
            <span className="g g-failed" aria-hidden="true" />
            saved by a newer ICMM
          </>
        ) : (
          rowFacts(x)
            .map((f) => f.replaceAll(" ", NB))
            .join(`${NB}· `)
        )}
      </span>
      <span className="dd-config-runs">
        <RunStatus run={x.latest_run} now={now} />
      </span>
    </Link>
  );
}
