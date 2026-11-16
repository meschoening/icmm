/**
 * Datasets (LaptopDatasets): the Active platform's datasets, the one saved
 * last first, each with its protocols and their templates, its points (and
 * how many interpolation added), its runs and best Val RMSE, and when it was
 * modified. A dataset whose current revision
 * can't be read says why in place of its protocols. Its runs and best run on
 * its current data come from `runs_overview`; its run count opens Runs on it.
 *
 * Import (#147) opens a box above the list for a dataset file; the dataset
 * it saves tops the list, tinted until the page is left, and takes focus.
 *
 * The change feed's `datasets` reads the list again. Not connected, the
 * page says when the datasets show; reconnecting keeps the last list.
 */
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../connection/useNow";
import { allDatasetsCount } from "../datasets/detail/counts";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { templateWords, modifiedWords } from "../datasets/detail/words";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import type { Imported } from "../datasets/importFile";
import { useImport } from "../datasets/useImport";
import { useDatasets } from "../datasets/queries";
import { useRunsOverview } from "../runs/queries";
import { rmse } from "../runs/words";
import { count } from "../datasets/format";
import { FailureBox } from "../setup/FailureBox";
import { inSentence } from "../setup/form";
import { useReadAgain } from "../setup/queries";
import { useAsked } from "../shell/asked";
import { useConnection } from "../shell/connection";
import { ListEmpty, ReadingFacts } from "../ui/HeadFacts";
import { PageHeading } from "../ui/PageHeading";
import type { DatasetSummary, RunsDataset, SavedPlatform, WireError } from "../wire/types.gen";

export function DatasetsPage() {
  const c = useConnection();
  const platform = useActivePlatform();
  const list = useDatasets();
  const read = useReadAgain(
    list.isError ? (list.error as unknown as WireError) : undefined,
    list.refetch,
  );
  const live = c.status === "connected" || c.status === "reconnecting";
  const datasets = live ? list.data : undefined;
  const failure = useHeldFailure(
    read.failure,
    list.isFetching,
    "all",
    list.data !== undefined || !live,
  );
  // What the page shows, its facts line and its body alike.
  const shows =
    !live && datasets === undefined
      ? "offline"
      : datasets !== undefined
        ? "list"
        : failure !== undefined
          ? "failure"
          : c.status === "connected"
            ? "reading"
            : "offline";
  const [imported, setImported] = useState<Imported>();
  const importer = useImport({
    platform: platform === undefined ? "the platform" : inSentence(platform),
    datasets,
    onImported: setImported,
  });
  // ⌘K's Import dataset… opens the page to import one.
  const navigate = useNavigate();
  useAsked(
    useSearch({ from: "/datasets" }).start,
    true,
    () => importer.start(),
    () => void navigate({ to: "/datasets", search: {}, replace: true }),
  );
  return (
    <div className="page">
      <section className="datasets-head">
        <div className="head-text">
          <PageHeading>Datasets</PageHeading>
          {platform === undefined ? null : shows === "list" ? (
            datasets!.length > 0 ? (
              <ListFacts datasets={datasets!} platform={platform} />
            ) : (
              <p className="facts">None on {inSentence(platform)} yet</p>
            )
          ) : shows === "failure" ? (
            <p className="facts">Couldn’t read the datasets</p>
          ) : shows === "reading" ? (
            <ReadingFacts>Reading the datasets on {inSentence(platform)}…</ReadingFacts>
          ) : (
            <p className="facts">Not connected to {inSentence(platform)}</p>
          )}
        </div>
        <div className="head-acts">
          {importer.button}
          <Link to="/datasets/new" className="btn btn-primary">
            <PlusIcon />
            New dataset
          </Link>
        </div>
      </section>
      {importer.box}
      {imported !== undefined && !importer.open && (
        <p className="ds-imported" role="status">
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1.5 5.2 4 7.5l4.5-5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span>
            Imported <span className="mono">{imported.file}</span> as{" "}
            <span className="mono">{imported.name}</span>, at the top of the list.
          </span>
        </p>
      )}
      {platform === undefined || shows === "offline" ? (
        <ShowOnceConnected platform={platform}>its datasets</ShowOnceConnected>
      ) : shows === "list" ? (
        <List datasets={datasets!} imported={imported?.id} />
      ) : shows === "failure" ? (
        <FailureBox
          error={failure!}
          task="datasets"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      ) : null}
    </div>
  );
}

/** "5 datasets · 15 protocols · 183 points · on McKelvey HPC". */
function ListFacts({
  datasets,
  platform,
}: {
  datasets: DatasetSummary[];
  platform: Pick<SavedPlatform, "type" | "name">;
}) {
  const { protocols, points } = allDatasetsCount(datasets);
  return (
    <p className="facts">
      <span className="n">{datasets.length}</span> {datasets.length === 1 ? "dataset" : "datasets"}{" "}
      · <span className="n">{protocols}</span> {protocols === 1 ? "protocol" : "protocols"} ·{" "}
      <span className="n">{points}</span> {points === 1 ? "point" : "points"} · on{" "}
      {inSentence(platform)}
    </p>
  );
}

function List({
  datasets,
  imported,
}: {
  datasets: DatasetSummary[];
  /** The dataset Import just saved: tinted, and focused once it lists. */
  imported: string | undefined;
}) {
  const now = useNow([]);
  const runs = useRunsOverview().data?.datasets;
  const focused = useRef<string | undefined>(undefined);
  const listed = imported !== undefined && datasets.some((d) => d.id === imported);
  useEffect(() => {
    if (!listed || focused.current === imported) return;
    focused.current = imported;
    document.querySelector<HTMLElement>(`[data-dataset="${imported}"] .ds-link`)?.focus();
  }, [listed, imported]);
  if (datasets.length === 0) {
    return (
      <ListEmpty>
        <Foot />
      </ListEmpty>
    );
  }
  return (
    <section className="ds-list" aria-label="Datasets">
      <div role="table" aria-label="Datasets" className="ds-table">
        <div role="row" className="ds-row ds-heads">
          <span role="columnheader" className="th">
            Dataset
          </span>
          <span role="columnheader" className="th">
            Protocols
          </span>
          <span role="columnheader" className="th ds-num">
            Runs
          </span>
          <span role="columnheader" className="th ds-num">
            Best RMSE
          </span>
          <span role="columnheader" className="th">
            Modified
          </span>
        </div>
        {datasets.map((d) => (
          <Row
            key={d.id}
            dataset={d}
            runs={runs?.find((r) => r.id === d.id)}
            now={now}
            fresh={d.id === imported}
          />
        ))}
      </div>
      <Foot className="ds-foot" />
    </section>
  );
}

/** What New dataset and Import are for: under the list, or in the card when there's none. */
function Foot({ className }: { className?: string }) {
  return (
    <p className={className}>
      Build a dataset from an Excel workbook with{" "}
      <Link to="/datasets/new" className="link">
        New dataset
      </Link>
      . Import brings in a dataset that ICMM exported, from another platform or from a labmate.
    </p>
  );
}

function Row({
  dataset: d,
  runs,
  now,
  fresh,
}: {
  dataset: DatasetSummary;
  /** Its runs and best run, once read. */
  runs: RunsDataset | undefined;
  now: number;
  /** Import just saved it. */
  fresh: boolean;
}) {
  const points = d.protocols.reduce((n, p) => n + p.points, 0);
  // Up to 6 protocols list; past 6, the first 5 and a link to the rest (SF09).
  const shown = d.protocols.length > 6 ? d.protocols.slice(0, 5) : d.protocols;
  const more = d.protocols.length - shown.length;
  return (
    <div role="row" className={`ds-row${fresh ? " ds-new" : ""}`} data-dataset={d.id}>
      <div role="cell" className="ds-name">
        <Link to="/datasets/$id" params={{ id: d.id }} className="row-link mono ds-link">
          {d.name}
        </Link>
        <span className="ds-sub">
          <span className="nw">
            <span className="n">{d.protocols.length}</span>{" "}
            {d.protocols.length === 1 ? "protocol" : "protocols"}
          </span>{" "}
          ·{" "}
          <span className="nw">
            <span className="n">{points}</span> {points === 1 ? "point" : "points"}
            {d.interpolated !== null && d.interpolated > 0 && (
              <>
                , <span className="n">{d.interpolated}</span> interpolated
              </>
            )}
          </span>
          {d.validation !== null && (
            <>
              {" "}
              ·{" "}
              <span className="nw">
                {d.validation > 0 ? (
                  <>
                    <span className="n">{d.validation}</span> validation
                  </>
                ) : (
                  "no validation"
                )}
              </span>
            </>
          )}
        </span>
      </div>
      <div role="cell" className="ds-protocols">
        {d.unreadable !== null ? (
          <div className="ds-fail">
            <p className="ds-fail-what">
              <span className="g g-failed" aria-hidden="true" />
              <span>{d.unreadable.message}</span>
            </p>
            <p className="term ds-fail-raw">{d.unreadable.data.details}</p>
          </div>
        ) : (
          <>
            <dl className="ds-plist" aria-label={`Protocols in ${d.name}`}>
              {shown.map((p) => (
                <div key={p.name} className="ds-plist-row">
                  <dt>{p.name}</dt>
                  <dd>{templateWords(p.template, p.steps)}</dd>
                </div>
              ))}
            </dl>
            {more > 0 && (
              <p className="ds-plist-more">
                <Link
                  to="/datasets/$id"
                  params={{ id: d.id }}
                  className="link"
                  aria-label={`+ ${more} more protocols in ${d.name}`}
                >
                  + {more} more
                </Link>
              </p>
            )}
          </>
        )}
      </div>
      <span role="cell" className="ds-runs">
        {runs !== undefined && runs.runs > 0 ? (
          <Link
            to="/runs"
            search={{ dataset: d.id }}
            className="row-link mono"
            aria-label={`${count(runs.runs, "run")} on ${d.name}`}
          >
            {runs.runs.toLocaleString("en-US")}
          </Link>
        ) : (
          <span className="mono" aria-label={`${count(0, "run")} on ${d.name}`}>
            0
          </span>
        )}
      </span>
      <Best runs={runs} />
      <span role="cell" className="ds-mod">
        {modifiedWords(d.modified_at, now)}
      </span>
    </div>
  );
}

/**
 * The dataset's best run on its current data: its Val RMSE, or its Train
 * RMSE without validation points, each saying which ("val 0.0393", RF23),
 * then which run, at how many states; "—" before one, saying why.
 */
function Best({ runs }: { runs: RunsDataset | undefined }) {
  const best = runs?.best_val ?? runs?.best_train ?? null;
  if (runs === undefined || best === null) {
    const why =
      runs === undefined || runs.runs === 0
        ? "no runs yet"
        : runs.runs_earlier === runs.runs
          ? `${runs.runs_earlier.toLocaleString("en-US")} on earlier data`
          : undefined;
    return (
      <div role="cell" className="ds-best">
        <span className="mono ds-dash" aria-label="none">
          —
        </span>
        {why !== undefined && <span className="ds-sub">{why}</span>}
      </div>
    );
  }
  return (
    <div role="cell" className="ds-best">
      <span className="ds-best-by">
        <span className="ds-by">{runs.best_val === null ? "train" : "val"}</span>
        <Link to="/results" search={{ dataset: runs.id }} className="mono ds-best-v">
          {rmse(best.rmse)}
        </Link>
      </span>
      <span className="ds-sub">
        <span className="mono">#{best.run}</span> · {best.num_states} states
      </span>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
