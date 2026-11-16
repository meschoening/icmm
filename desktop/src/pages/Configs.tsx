/**
 * Configs (LaptopConfigs, #184): the Active platform's configs, newest
 * modified first, filtered by name or dataset, each row its name over its
 * dataset · states · topologies · starts; and beside the list, the config
 * the row or `?id=` chose (the newest by default), with every setting
 * (`ConfigDetail`). Each row shows its newest run's status, and the facts
 * count the configs with a run running or held.
 *
 * With none, the page says so with New config; with no dataset on the
 * platform, New config says it needs one, and the box points to Datasets.
 * The change feed's `configs`, and `datasets`, read the list again. Not
 * connected, the page keeps its head and says when the configs show;
 * reconnecting keeps what it showed.
 */
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigDetail } from "../configs/ConfigDetail";
import { useNow } from "../connection/useNow";
import { RunStatus } from "../submit/RunStatus";
import { useConfigs } from "../configs/queries";
import { rowFacts } from "../configs/words";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { useDatasets } from "../datasets/queries";
import { FailureBox } from "../setup/FailureBox";
import { inSentence } from "../setup/form";
import { useReadAgain } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { useBlocker } from "../ui/blocker";
import { ListEmpty, ReadingFacts } from "../ui/HeadFacts";
import { PageHeading } from "../ui/PageHeading";
import type { ConfigSummary, SavedPlatform, WireError } from "../wire/types.gen";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** New config's reason, under it. */
const NEW_WHY_ID = "new-why";

export function ConfigsPage() {
  const c = useConnection();
  const platform = useActivePlatform();
  const navigate = useNavigate();
  const { id } = useSearch({ from: "/configs" });
  const list = useConfigs();
  const datasets = useDatasets();
  const read = useReadAgain(
    list.isError ? (list.error as unknown as WireError) : undefined,
    list.refetch,
  );
  const live = c.status === "connected" || c.status === "reconnecting";
  const configs = live ? list.data : undefined;
  const failure = useHeldFailure(
    read.failure,
    list.isFetching,
    "all",
    list.data !== undefined || !live,
  );
  const empty = configs !== undefined && configs.length === 0;
  // What the page shows, its facts line and its body alike.
  const shows =
    !live && configs === undefined
      ? "offline"
      : configs !== undefined
        ? "list"
        : failure !== undefined
          ? "failure"
          : c.status === "connected"
            ? "reading"
            : "offline";
  const needsDataset = live && datasets.data !== undefined && datasets.data.length === 0;
  // The builder it opens needs the platform, as New config from this dataset does.
  const offline = useBlocker(live ? undefined : "Opens once you’re connected");
  // With no `?id=`, the config first shown stays shown while the list changes around it,
  // so another computer's delete of it says so rather than swapping it for the next.
  const [first, setFirst] = useState<string>();
  const shown = id ?? first ?? configs?.[0]?.id;
  if (id === undefined && first === undefined && shown !== undefined) setFirst(shown);
  // What the page last showed, so a disconnect can name the config it was showing.
  const [seen, setSeen] = useState<string>();
  const listedName = configs?.find((x) => x.id === shown)?.name;
  if (listedName !== undefined && listedName !== seen) setSeen(listedName);

  const onDeleted = useCallback(() => {
    setFirst(undefined);
    void navigate({ to: "/configs", search: {} }).then(() =>
      // The same path doesn't move focus by itself.
      document.querySelector<HTMLElement>("h1.page-heading")?.focus(),
    );
  }, [navigate]);

  return (
    <div className="page cf-page">
      <section className="cf-page-head">
        <div className="head-text">
          <PageHeading>Configs</PageHeading>
          {platform === undefined ? null : shows === "list" ? (
            <ListFacts configs={configs!} platform={platform} />
          ) : shows === "failure" ? (
            <p className="facts">Couldn’t read the configs</p>
          ) : shows === "reading" ? (
            <ReadingFacts>Reading the configs on {inSentence(platform)}…</ReadingFacts>
          ) : (
            <p className="facts">Not connected to {inSentence(platform)}</p>
          )}
        </div>
        <div className="cf-new">
          <Link
            to="/configs/new"
            className={`btn${empty ? " btn-primary" : ""}`}
            {...offline.props}
            {...(needsDataset
              ? {
                  "aria-disabled": true,
                  "aria-describedby": NEW_WHY_ID,
                  onClick: (e: React.MouseEvent) => e.preventDefault(),
                }
              : {})}
          >
            <PlusIcon />
            New config
          </Link>
          {offline.bubble}
          {needsDataset && (
            <p id={NEW_WHY_ID} className="cf-why">
              Needs a dataset
            </p>
          )}
        </div>
      </section>
      {platform === undefined || shows === "offline" ? (
        <ShowOnceConnected
          platform={platform}
          kind="Configs"
          one={id !== undefined && seen !== undefined}
        >
          {id !== undefined && seen !== undefined ? (
            <span className="mono">{seen}</span>
          ) : (
            "its configs"
          )}
        </ShowOnceConnected>
      ) : shows === "list" ? (
        empty ? (
          <Empty platform={platform} needsDataset={needsDataset} />
        ) : (
          <div className="cf-body">
            <List configs={configs!} shown={shown} />
            {shown !== undefined && (
              <ConfigDetail
                key={shown}
                id={shown}
                listed={configs!.find((x) => x.id === shown)}
                platform={platform}
                datasets={datasets.data}
                onDeleted={onDeleted}
              />
            )}
          </div>
        )
      ) : shows === "failure" ? (
        <FailureBox
          error={failure!}
          task="configs"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      ) : null}
    </div>
  );
}

/** "5 configs · 3 datasets", or "None on McKelvey HPC yet". */
function ListFacts({ configs, platform }: { configs: ConfigSummary[]; platform: Platform }) {
  if (configs.length === 0) return <p className="facts">None on {inSentence(platform)} yet</p>;
  const datasets = new Set(configs.map((x) => x.dataset.id)).size;
  return (
    <p className="facts">
      <span className="mono n">{configs.length}</span> {configs.length === 1 ? "config" : "configs"}{" "}
      · <span className="mono n">{datasets}</span> {datasets === 1 ? "dataset" : "datasets"}
      {(["running", "held"] as const).map((state) => {
        const n = configs.filter((x) => x.latest_run?.state === state).length;
        return n === 0 ? null : (
          <span key={state}>
            {" "}
            · <span className="mono n">{n}</span> with a {state} run
          </span>
        );
      })}
    </p>
  );
}

/** No configs yet: what one is, or, with no dataset to fit, where to add one. */
function Empty({ platform, needsDataset }: { platform: Platform; needsDataset: boolean }) {
  return (
    <ListEmpty>
      {needsDataset ? (
        <p>
          A config fits a dataset, and {inSentence(platform)} has none yet. Add one on{" "}
          <Link to="/datasets" className="link">
            Datasets
          </Link>
          , then make a config from it.
        </p>
      ) : (
        <p>
          A config holds what a run fits: a dataset, how many states to try and how hard to search.
          Make one with New config, then submit runs from it.
        </p>
      )}
    </ListEmpty>
  );
}

/** Whether `text` holds the filter, ignoring case. */
const holds = (text: string, filter: string) => text.toLowerCase().includes(filter);

/** The list, under its filter; `/` focuses the filter from anywhere on the page. */
function List({ configs, shown }: { configs: ConfigSummary[]; shown: string | undefined }) {
  const [filter, setFilter] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const q = filter.trim().toLowerCase();
  const matching =
    q === "" ? configs : configs.filter((x) => holds(x.name, q) || holds(x.dataset.name ?? "", q));
  return (
    <nav aria-label="Configs" className="cf-nav">
      <div className="cf-filter">
        <label htmlFor="cfg-filter" className="sr-only">
          Filter configs
        </label>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <input
          id="cfg-filter"
          ref={field}
          className="input"
          type="search"
          placeholder="Filter by name or dataset"
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="kbd" aria-hidden="true">
          /
        </span>
      </div>
      {matching.length === 0 ? (
        <p className="cf-none">
          No configs match <span className="mono">{filter.trim()}</span>.
        </p>
      ) : (
        <div className="cf-items">
          {matching.map((x) => (
            <Item key={x.id} config={x} selected={x.id === shown} />
          ))}
        </div>
      )}
    </nav>
  );
}

/** Within a fact, and before each dot, a space a line doesn't break at. */
const NB = "\u00a0";

/**
 * A row: the name, its runs, then its facts, a deleted dataset marked
 * (CF11); a line breaks only after a dot.
 */
function Item({ config: x, selected }: { config: ConfigSummary; selected: boolean }) {
  const now = useNow([]);
  return (
    <Link
      to="/configs"
      search={{ id: x.id }}
      className={`cf-item${selected ? " sel" : ""}`}
      aria-current={selected ? "page" : undefined}
      data-config={x.id}
    >
      <span className="cf-item-top">
        <span className="mono cf-item-name">{x.name}</span>
        <span className="cf-item-runs">
          <RunStatus run={x.latest_run} now={now} />
        </span>
      </span>
      <span className="cf-item-facts">
        {x.unreadable !== null ? (
          <>
            <span className="g g-failed" aria-hidden="true" />
            saved by a newer ICMM
          </>
        ) : (
          <>
            {x.dataset.name ?? x.dataset.id}
            {x.dataset.deleted && <span className="cf-del">{NB}deleted</span>}
            {rowFacts(x).map((f) => `${NB}· ${f.replaceAll(" ", NB)}`)}
          </>
        )}
      </span>
    </Link>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
