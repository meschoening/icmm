/**
 * A config's detail on Configs (LaptopConfigs), beside the list: its name
 * with Edit, Submit run and ···, its facts, then every setting in Data,
 * Topology and Optimization, and the runs submitted from it. Runs come with
 * Submit & Runs, so until then the runs list shows its no-runs state.
 *
 * Submit run says why it can't under the buttons: the config's dataset was
 * deleted, or its current revision can't be read (#180). ··· holds
 * Duplicate, which saves `<name>-copy` and opens it in the builder ready to
 * name, and Delete…, which asks in place, naming the config, then commits
 * its tombstone (`delete_config`) and lands on the Configs heading.
 *
 * Another computer's delete while it's open puts a note over the config as
 * it was, with its actions grayed; another computer's save shows at once.
 * A config this ICMM can't read says why, and can only be deleted.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ConfigRuns } from "./ConfigRuns";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNow } from "../connection/useNow";
import { FailureBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { useReadAgain } from "../setup/queries";
import { useHeldFailure } from "../datasets/detail/read";
import { count } from "../datasets/format";
import { savedWords } from "../requestKey";
import { useBlocker } from "../ui/blocker";
import { clock } from "../ui/clock";
import { besideProps } from "../ui/working";
import { commands } from "../wire/api.gen";
import type {
  ConfigCheck,
  ConfigSummary,
  DatasetSummary,
  SavedConfig,
  SavedPlatform,
  UnreadableError,
  WireError,
} from "../wire/types.gen";
import { MoreMenu } from "./MoreMenu";
import { useConfig, useTopologyCounts } from "./queries";
import { newerWords } from "../newer";
import { UnreadableBox } from "./UnreadableBox";
import { bound, generationsOf, generationWords, idWords, submitBlocker, whole } from "./words";
import { useDelete } from "./useDelete";
import { useConfigWrite } from "./write";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** Submit run's reason, under the buttons. */
const WHY_ID = "cfg-why";

export function ConfigDetail({
  id,
  listed,
  platform,
  datasets,
  onDeleted,
}: {
  id: string;
  /** The config as the list has it: its name and facts while it's read, or when it can't be. */
  listed: ConfigSummary | undefined;
  platform: Platform;
  /** The platform's datasets, for the protocols its dataset has. */
  datasets: DatasetSummary[] | undefined;
  /** This page deleted it: the page goes back to the newest config, on its heading. */
  onDeleted: () => void;
}) {
  const q = useConfig(id);
  const error = q.isError ? (q.error as unknown as WireError) : undefined;
  const read = useReadAgain(q.data === undefined ? error : undefined, q.refetch);
  // When another computer's delete was first heard: each later read is `not_found` again.
  const [deletedAt, setDeletedAt] = useState<number>();
  if (q.data !== undefined && error?.code === "not_found" && deletedAt === undefined) {
    setDeletedAt(q.errorUpdatedAt);
  }
  const failure = useHeldFailure(read.failure, q.isFetching, id, q.data !== undefined);
  const name = q.data?.config.name ?? listed?.name;
  const unreadable =
    error?.code === "unreadable" ? error : failure?.code === "unreadable" ? failure : undefined;

  if (unreadable !== undefined) {
    return (
      <Unreadable
        id={id}
        name={name}
        listed={listed}
        platform={platform}
        error={unreadable}
        onDeleted={onDeleted}
      />
    );
  }
  if (q.data !== undefined) {
    return (
      <Shown
        saved={q.data}
        platform={platform}
        datasets={datasets}
        deletedAt={deletedAt}
        onDeleted={onDeleted}
      />
    );
  }
  if (failure?.code === "not_found") return <NotHere platform={platform} />;
  const called = name ?? "this config";
  if (failure !== undefined) {
    return (
      <Frame
        id={id}
        name={name}
        facts={listed && <ListedFacts listed={listed} />}
        blocked={`ICMM couldn’t read ${called}`}
      >
        <FailureBox
          error={failure}
          task="config"
          platform={platform}
          onRetry={read.retry}
          again={read.again}
        />
      </Frame>
    );
  }
  return (
    <Frame
      id={id}
      name={name}
      facts={listed && <ListedFacts listed={listed} />}
      blocked={`Waiting for ${called} to load`}
    >
      <Reading>
        {/* One flex item, so the name sits in the sentence. */}
        <span>
          Reading {name === undefined ? "the config" : <span className="mono">{name}</span>} on{" "}
          {inSentence(platform)}…
        </span>
      </Reading>
    </Frame>
  );
}

/**
 * The detail's head: the name, with Edit, Submit run and ···, and why Submit
 * run can't be used under them; the facts under the whole row; then the
 * rest. Without `actions`, each is grayed with `blocked` as its reason.
 */
function Frame({
  id,
  name,
  deleted = false,
  facts,
  blocked,
  actions,
  children,
}: {
  id: string;
  name: string | undefined;
  deleted?: boolean;
  facts?: ReactNode;
  /** Why the actions can't be used, where `actions` isn't given. */
  blocked?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article aria-labelledby="cfg-title" className="cf-detail" data-config={id}>
      <div className="cf-head">
        <div className="cf-title-row">
          <h2 id="cfg-title" className="mono cf-title">
            {name ?? "Config"}
            {deleted && <span className="del-word">deleted</span>}
          </h2>
          {actions ?? <BlockedActions name={name} blocked={blocked ?? ""} />}
        </div>
        {facts !== undefined && <p className="facts">{facts}</p>}
      </div>
      {children}
    </article>
  );
}

/** Edit, Submit run and ··· where none can be used yet, each saying why. */
function BlockedActions({ name, blocked }: { name: string | undefined; blocked: string }) {
  const edit = useBlocker(blocked);
  const submit = useBlocker(blocked);
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div className="cf-actions">
      <div className="cf-buttons">
        <button type="button" className="btn" {...edit.props}>
          Edit
        </button>
        {edit.bubble}
        <button type="button" className="btn btn-primary" {...submit.props}>
          Submit run
        </button>
        {submit.bubble}
        <MoreMenu
          name={name ?? "this config"}
          duplicating={undefined}
          blocked={blocked}
          onDuplicate={() => Promise.resolve()}
          onDelete={() => {}}
          buttonRef={more}
        />
      </div>
    </div>
  );
}

/** The facts as the list has them, while the config reads or when it can't. */
function ListedFacts({ listed }: { listed: ConfigSummary }) {
  const { dataset, num_states, which, topologies, starts } = listed;
  return (
    <Facts
      dataset={dataset.name ?? dataset.id}
      deleted={dataset.deleted}
      states={num_states}
      which={which}
      topologies={topologies}
      each={topologies !== null && topologies > 0 && starts !== null ? starts / topologies : null}
      starts={starts}
    />
  );
}

function DatasetName({ name, deleted }: { name: string; deleted: boolean }) {
  return (
    <>
      <span className="mono n">{name}</span>
      {deleted && <span className="cf-gone"> deleted</span>}
    </>
  );
}

/** A blocked action whose reason shows under the buttons (#180), rather than in a tooltip. */
function saysWhy(why: string | undefined): {
  "aria-disabled"?: true;
  "aria-describedby"?: string;
  onClick?: (e: React.MouseEvent) => void;
} {
  if (why === undefined) return {};
  return { "aria-disabled": true, "aria-describedby": WHY_ID, onClick: (e) => e.preventDefault() };
}

/** The config as read: its facts, its settings and its runs. */
function Shown({
  saved,
  platform,
  datasets,
  deletedAt,
  onDeleted,
}: {
  saved: SavedConfig;
  platform: Platform;
  datasets: DatasetSummary[] | undefined;
  deletedAt: number | undefined;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const now = useNow([]);
  const { config, dataset } = saved;
  const name = config.name;
  const del = useDelete(saved.id, name, platform.name, onDeleted);
  // This page's delete landed though its answer was lost: it goes as a delete does.
  const landed = deletedAt !== undefined && del.sent;
  useEffect(() => {
    if (landed) onDeleted();
  }, [landed, onDeleted]);
  const gone =
    deletedAt !== undefined && !del.sent ? `Another computer deleted ${name}.` : undefined;
  const why = gone === undefined ? submitBlocker(dataset) : undefined;
  const duplicateWrite = useConfigWrite(platform.name);
  const alive = useRef(true);
  useEffect(() => {
    // Set again on each mount: StrictMode mounts twice.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const duplicate = async () => {
    const done = await duplicateWrite.run(
      { id: saved.id },
      (key) => commands.duplicate_config({ request_key: key, id: saved.id }),
      { ...savedWords(`the copy of ${name}`), again: "Duplicating" },
    );
    if (done.ok && alive.current) {
      await navigate({
        to: "/configs/$id/edit",
        params: { id: done.value.id },
        state: { copyOf: name },
      });
    }
  };
  const edit = useBlocker(gone);
  const submit = useBlocker(gone);
  const busy = del.working.pending ? del.working : duplicateWrite.working;
  const message = duplicateWrite.message;

  return (
    <Frame
      id={saved.id}
      name={name}
      deleted={gone !== undefined}
      facts={<ShownFacts saved={saved} />}
      actions={
        <div className="cf-actions">
          <div className="cf-buttons">
            <Link
              to="/configs/$id/edit"
              params={{ id: saved.id }}
              className="btn"
              {...edit.props}
              {...besideProps(busy)}
            >
              Edit
            </Link>
            {edit.bubble}
            <Link
              to="/runs/submit"
              search={{ config: saved.id }}
              className="btn btn-primary"
              {...(gone !== undefined ? submit.props : saysWhy(why))}
              {...besideProps(busy)}
            >
              Submit run
            </Link>
            {submit.bubble}
            <MoreMenu
              name={name}
              duplicating={duplicateWrite.working}
              blocked={gone}
              onDuplicate={duplicate}
              onDelete={() => {
                duplicateWrite.setMessage(undefined);
                del.open();
              }}
              buttonRef={del.more}
            />
          </div>
          {why !== undefined && (
            <p id={WHY_ID} className="cf-why">
              {why}
            </p>
          )}
          {message !== undefined && (
            <p className="cf-why err" role="alert">
              {message}
            </p>
          )}
        </div>
      }
    >
      {gone === undefined && del.ask}
      {gone !== undefined && (
        <div className="note-ask" role="status">
          <p>
            Another computer deleted {name} at {clock(deletedAt!, now)}.
            <span className="hint">This page shows {name} as it was.</span>
          </p>
        </div>
      )}
      <Settings saved={saved} datasets={datasets} />
    </Frame>
  );
}

/** The facts as the config was saved. */
function ShownFacts({ saved }: { saved: SavedConfig }) {
  const { config, dataset, topologies, starts } = saved;
  return (
    <Facts
      dataset={dataset.name ?? dataset.id}
      deleted={dataset.deleted}
      states={config.topology.num_states}
      which={config.topology.which.kind}
      topologies={topologies}
      each={config.search.starts_per_topology}
      starts={starts}
    />
  );
}

/** "herg-wt · 11 states · 5 random topologies × 100 = 500 starts" (LaptopConfigs). */
function Facts({
  dataset,
  deleted,
  states,
  which,
  topologies,
  each,
  starts,
}: {
  dataset: string;
  deleted: boolean;
  states: number | null;
  which: ConfigSummary["which"];
  topologies: number | null;
  /** Starts per topology. */
  each: number | null;
  starts: number | null;
}) {
  return (
    <>
      <DatasetName name={dataset} deleted={deleted} />
      {states !== null && (
        <>
          {" "}
          · <span className="mono n">{states}</span> {states === 1 ? "state" : "states"}
        </>
      )}
      {topologies !== null && each !== null && starts !== null && (
        <>
          {" "}
          · <Topologies which={which} n={topologies} /> ×{" "}
          <span className="mono n">{whole(each)}</span> ={" "}
          <span className="mono n">{whole(starts)}</span> {starts === 1 ? "start" : "starts"}
        </>
      )}
    </>
  );
}

/** "5 random topologies", its number in mono. */
function Topologies({ which, n }: { which: ConfigSummary["which"]; n: number }) {
  const noun = n === 1 ? "topology" : "topologies";
  const num = <span className="mono n">{whole(n)}</span>;
  if (which === "all")
    return (
      <>
        all {num} {noun}
      </>
    );
  return (
    <>
      {num} {which === "sample" ? "random " : which === "ids" ? "specific " : ""}
      {noun}
    </>
  );
}

/** Data, Topology and Optimization, then the runs from this config (LaptopConfigs). */
function Settings({
  saved,
  datasets,
}: {
  saved: SavedConfig;
  datasets: DatasetSummary[] | undefined;
}) {
  const { config, dataset } = saved;
  const { search, bounds, topology } = config;
  const protocols = datasets?.find((d) => d.id === dataset.id)?.protocols.length;
  const generations = generationsOf(search.evaluation_budget, search.population);
  return (
    <div className="cf-sections">
      <section aria-labelledby="cfg-data" className="cf-section">
        <h3 id="cfg-data" className="label">
          Data
        </h3>
        <dl>
          <Kv k="Dataset">
            {dataset.deleted ? (
              <>
                <span className="mono cf-v">{dataset.name ?? dataset.id}</span>
                <span className="del-word">deleted</span>
              </>
            ) : (
              <>
                <Link to="/datasets/$id" params={{ id: dataset.id }} className="link mono cf-v">
                  {dataset.name ?? dataset.id}
                </Link>
                {protocols !== undefined && (
                  <span className="cf-aside"> · {count(protocols, "protocol")}</span>
                )}
              </>
            )}
          </Kv>
        </dl>
      </section>
      <section aria-labelledby="cfg-topology" className="cf-section">
        <h3 id="cfg-topology" className="label">
          Topology
        </h3>
        <dl>
          <Kv k="States">
            <span className="mono cf-v">{topology.num_states ?? "—"}</span>
          </Kv>
          <Kv k="Which">
            <Which saved={saved} />
          </Kv>
        </dl>
        <p className="hint cf-note">
          Max cycle length and max degree are fixed at 4 by the engine.
        </p>
      </section>
      <section aria-labelledby="cfg-optimization" className="cf-section">
        <h3 id="cfg-optimization" className="label">
          Optimization
        </h3>
        {/* A saved config has a population of at least 2 and a budget, so this always shows. */}
        {generations !== null && (
          <p className="hint cf-lead">
            Each start runs <span className="n">{whole(search.population)}</span> objective function
            evaluations a generation for <span className="n">{whole(generations)}</span>
            {"\u00a0"}
            {generationWords(generations)}.
          </p>
        )}
        <dl>
          <Kv k="Starts per topology">
            <span className="mono cf-v">{whole(search.starts_per_topology)}</span>
          </Kv>
          <Kv k="Population size">
            <span className="mono cf-v">{whole(search.population)}</span>
          </Kv>
          <Kv k="Evaluations">
            <span className="mono cf-v">{whole(search.evaluation_budget)}</span>{" "}
            <span className="cf-aside">per start</span>
          </Kv>
          <Kv k="Log every">
            <span className="mono cf-v">{whole(search.log_every_generations)}</span>{" "}
            {search.log_every_generations === 1 ? "generation" : "generations"}
          </Kv>
          <Kv k="Search seed">
            {search.search_seed === null ? (
              <span className="cf-quiet">drawn at submit</span>
            ) : (
              <span className="mono cf-v">{search.search_seed}</span>
            )}
          </Kv>
          <Kv k="Start points">{search.sobol_start_points ? "Sobol" : "at random"}</Kv>
          <Kv k="Parameter bounds">
            <span className="mono cf-v">{bound(bounds.rate_min)}</span> to{" "}
            <span className="mono cf-v">{bound(bounds.rate_max)}</span>
          </Kv>
          <Kv k="Voltage dependence bounds">
            <span className="mono cf-v">{bound(bounds.sigmoid_min_mV)}</span> to{" "}
            <span className="mono cf-v">{bound(bounds.sigmoid_max_mV)}</span>
            {"\u00a0"}mV
          </Kv>
        </dl>
      </section>
      <div className="cf-side">
        <ConfigRuns id={saved.id} name={config.name} />
      </div>
    </div>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="cf-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Which topologies it fits: "A random sample of 5 · of 66,282", "All 411",
 * or what its Specific IDs fit, as the builder says it. `kept`: the counts a
 * page held while connected (Submit run's), for when they can't be read again.
 */
export function Which({ saved, kept }: { saved: SavedConfig; kept?: ConfigCheck }) {
  const { which } = saved.config.topology;
  const counted = useTopologyCounts(saved.config).data ?? kept;
  if (which.kind === "sample") {
    return (
      <>
        A random sample of <span className="mono cf-v">{whole(which.count)}</span>
        {counted?.counts != null && (
          <span className="cf-aside">
            {" "}
            ·{"\u00a0"}of{"\u00a0"}
            {whole(counted.counts.topologies)}
          </span>
        )}
      </>
    );
  }
  if (which.kind === "all") {
    return (
      <>
        All{" "}
        <span className="mono cf-v">
          {whole(saved.topologies ?? counted?.counts?.topologies ?? 0)}
        </span>
      </>
    );
  }
  const perId = counted?.work.per_id;
  const fits = perId !== undefined && perId.length === which.ids.length;
  const total = fits ? perId.reduce((a, b) => a + b, 0) : undefined;
  return (
    <span className="cf-ids">
      {total !== undefined && <>{count(total, "topology", "topologies")}: </>}
      {which.ids.map((id, i) => (
        <span key={i}>
          {i > 0 && (i === which.ids.length - 1 ? " and " : ", ")}
          <span className="mono cf-v">{idWords(id)}</span>
          {fits && id.open_state === null && (
            <>
              {perId[i] === 1
                ? " at its one open state"
                : ` at each of its ${perId[i]} open states`}
            </>
          )}
        </span>
      ))}
      .
    </span>
  );
}

/** A config this platform doesn't have: deleted, or never saved here. */
function NotHere({ platform }: { platform: Platform }) {
  return (
    <article aria-labelledby="cfg-title" className="cf-detail">
      <div className="cf-head">
        <h2 id="cfg-title" className="cf-title cf-title-plain">
          Config not found
        </h2>
        <p className="facts">This config isn’t on {inSentence(platform)} any more.</p>
      </div>
    </article>
  );
}

/**
 * A config this ICMM can't read: why, in the three-line box. It can't be
 * edited, submitted or copied here, but it can be deleted.
 */
function Unreadable({
  id,
  name,
  listed,
  platform,
  error,
  onDeleted,
}: {
  id: string;
  name: string | undefined;
  listed: ConfigSummary | undefined;
  platform: Platform;
  error: UnreadableError;
  onDeleted: () => void;
}) {
  const called = name ?? "this config";
  const blocked =
    error.data.problem === "newer" ? newerWords(called) : `ICMM can’t read ${called}.`;
  const del = useDelete(id, called, platform.name, onDeleted);
  return (
    <Frame
      id={id}
      name={name}
      facts={listed && <ListedFacts listed={listed} />}
      actions={
        <div className="cf-actions">
          <div className="cf-buttons">
            <button type="button" className="btn" {...saysWhy(blocked)}>
              Edit
            </button>
            <button type="button" className="btn btn-primary" {...saysWhy(blocked)}>
              Submit run
            </button>
            <MoreMenu
              name={called}
              duplicating={undefined}
              onDuplicate={() => Promise.resolve()}
              onDelete={del.open}
              buttonRef={del.more}
            />
          </div>
          {/* Under the buttons, as LaptopConfigs' `damaged` draws it (#452). */}
          <p id={WHY_ID} className="cf-why">
            {blocked}
          </p>
        </div>
      }
    >
      {del.ask}
      <UnreadableBox name={called} error={error} />
    </Frame>
  );
}
