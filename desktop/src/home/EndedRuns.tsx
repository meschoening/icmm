/**
 * Home's Ended (#391, LaptopMain): the latest 3 runs to end, whatever their
 * age. A run with ranked topologies draws one chart, of its dataset
 * revision's first protocol as its top topology's Best start fits it (#517),
 * simulated on this computer (ADR-0013), which opens that start; its name
 * opens Run detail, and its foot says its RMSE and how it compares with its
 * dataset's best, which a hover says (#398). A failed or canceled run says why and Run detail's next
 * step, with Resume and, where Run detail offers it, Open its log, gray with
 * the reason while Home shows what it read as of when the connection went.
 * All ended runs opens Runs at its Ended list.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { cardNextOf } from "../runs/detail";
import { NewerRevision } from "../runs/NewerRevision";
import { SettingsLinked } from "../runs/RunParts";
import { useResume } from "../runs/resume";
import { fitOf, type Box } from "../runs/start/charts";
import { Labels } from "../runs/start/FitInspector";
import { comparedOf, endedWhy, rmse, topologyName } from "../runs/words";
import { canAsk, platformOf, usePlatformSettings } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { lineOf, revisionQuery, useStartSimulation } from "../simulation/queries";
import { useRun } from "../submit/queries";
import { runGlyph } from "../submit/words";
import { useBlocker } from "../ui/blocker";
import { HoverWord, TipWord } from "../ui/TipWord";
import { WorkingButton } from "../ui/WorkingButton";
import type { RunBest, RunsDataset, RunSummary, SavedPlatform, WireError } from "../wire/types.gen";
import { useEarlierTip } from "./earlier";
import { driftedOf, endedParts, higherTip, shownRmse, type Drifted } from "./ended";
import { Whole } from "../ui/Whole";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** The glance chart's box: 0 and 1 kept on its value axis (#362), its x ticks under it. */
const GLANCE: Box = { width: 360, height: 92, left: 24, right: 4, top: 6, bottom: 20 };

export function EndedRuns({
  runs,
  total,
  datasets,
  platform,
  off,
  now,
}: {
  /** The latest ended runs, the latest first. */
  runs: readonly RunSummary[];
  /** How many runs ended on the platform, all told. */
  total: number;
  /** Each dataset's runs and best, which a run's best is compared with. */
  datasets: readonly RunsDataset[];
  platform: Platform;
  /** Why its actions are gray ("Connect to McKelvey HPC"); `undefined` while connected. */
  off: string | undefined;
  now: number;
}) {
  const validation = runs.some((r) => r.validation && r.best !== null);
  return (
    <section className="hm-ended" aria-labelledby="hm-ended">
      <div className="hm-head hm-ehead">
        <h2 id="hm-ended" className="label">
          Ended
        </h2>
        {runs.length > 0 && total > runs.length && (
          <span className="hm-of">
            the latest {runs.length} of {total.toLocaleString("en-US")}
          </span>
        )}
        <span className="hm-grow" />
        {runs.some((r) => r.best !== null) && (
          <>
            <Key validation={validation} />
            <span className="hm-ksep" aria-hidden="true" />
          </>
        )}
        {runs.length > 0 && (
          <Link to="/runs" hash="ended" className="link hm-all">
            All ended runs
          </Link>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="hm-none">
          No run has ended yet. Each one shows here when it ends, with a chart of its best start’s
          fit.
        </p>
      ) : (
        <div className="hm-cards">
          {runs.map((r) => (
            <EndedCard
              key={r.id}
              run={r}
              dataset={datasets.find((d) => d.id === r.dataset.id)}
              platform={platform}
              off={off}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The charts' key: the shared row (#362), with the model line. */
function Key({ validation }: { validation: boolean }) {
  return (
    <span className="hm-key" aria-hidden="true">
      <span>
        <svg width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="2.4" className="sp-k-dot" />
        </svg>
        train data
      </span>
      {validation && (
        <span>
          <svg width="8" height="8" viewBox="0 0 8 8">
            <circle cx="4" cy="4" r="2.4" className="sp-k-ring" />
          </svg>
          validation data
        </span>
      )}
      <span>
        <svg width="16" height="8" viewBox="0 0 16 8">
          <path d="M4 1.2 6.8 4 4 6.8 1.2 4Z" className="sp-k-dot" />
          {validation && <path d="M12 1.4 14.6 4 12 6.6 9.4 4Z" className="sp-k-ring" />}
        </svg>
        interpolated
      </span>
      <span>
        <svg width="16" height="8" viewBox="0 0 16 8">
          <path d="M1 4h14" className="sp-k-line" />
        </svg>
        model
      </span>
    </span>
  );
}

function EndedCard({
  run: r,
  dataset,
  platform,
  off,
  now,
}: {
  run: RunSummary;
  dataset: RunsDataset | undefined;
  platform: Platform;
  off: string | undefined;
  now: number;
}) {
  const job = usePlatformSettings().data?.saved?.settings.job_defaults;
  const slurm = job?.type === "slurm" ? job : undefined;
  const why = endedWhy(r, {
    platform,
    account: slurm?.account ?? null,
    partition: slurm?.partition ?? null,
    logHere: true,
  });
  const next = cardNextOf(r, {
    platform,
    job: slurm,
    partition: slurm?.partition ?? null,
    failedIn: undefined,
    now,
  });
  const earlier = useEarlierTip(r.dataset);
  const ranked = r.best !== null;
  const short = r.state === "failed" || r.state === "canceled";
  const value = r.best === null ? null : r.validation ? r.best.val_rmse : r.best.train_rmse;
  const compared = r.state === "completed" ? comparedOf(r, dataset) : undefined;
  const above = r.state === "completed" ? higherTip(r, dataset) : undefined;
  const ds = r.dataset.name ?? "a dataset this platform never had";
  return (
    <article className="hm-ecard" aria-label={`#${r.id} ${r.config.name}`}>
      <div className="hm-top">
        {r.best !== null ? (
          <Glance run={r} best={r.best} />
        ) : (
          <div className="hm-why">
            <span className="label">{r.state === "failed" ? "Why it failed" : "Why it ended"}</span>
            {why !== undefined && (
              <p>
                <Whole text={why} />
              </p>
            )}
            {next !== undefined && (
              <p className="hm-next">
                <SettingsLinked text={next.next} />
              </p>
            )}
            <span className="hm-meta hm-whyn">
              <span className="n">
                {r.progress.topologies_complete.toLocaleString("en-US")} /{" "}
                {r.progress.topologies.toLocaleString("en-US")}
              </span>{" "}
              topologies
            </span>
          </div>
        )}
      </div>
      <Link
        to="/runs/$id"
        params={{ id: String(r.id) }}
        className="row-link hm-ename"
        aria-describedby={earlier?.id}
      >
        <span className="mono hm-rname">
          <span className="hm-rid">#{r.id}</span> {r.config.name}
        </span>
        <span className="hm-st">
          <span className={runGlyph(r.state)} aria-hidden="true" />
          <span>
            {/* Each dot goes with what follows it, a count with its noun (#449's SF05). */}
            <span className={r.state === "failed" ? "hm-word failed" : "hm-word"}>{r.state}</span> ·
            {"\u00a0"}
            {ds}
            {earlier !== undefined && (
              <>
                {" "}
                ·{"\u00a0"}
                <HoverWord tip={earlier}>earlier data</HoverWord>
              </>
            )}
            {r.dataset.deleted && (
              <>
                {" "}
                ·{"\u00a0"}
                <span className="hm-qual">deleted</span>
              </>
            )}{" "}
            ·{"\u00a0"}
            <span className="n">{r.num_states}</span>
            {"\u00a0"}states ·{"\u00a0"}
            {endedParts(r, now).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && " "}
                <span className="nw">{part}</span>
              </Fragment>
            ))}
          </span>
        </span>
        {ranked && why !== undefined && (
          <span className="hm-whyl">
            <Whole text={why} />
          </span>
        )}
      </Link>
      {short && ranked && (
        <div className="hm-acts">
          <Actions run={r} log={next?.log === true} platform={platform} off={off} />
        </div>
      )}
      <div className="hm-efoot">
        {ranked && (
          <>
            <span className="label">{r.validation ? "Val RMSE" : "Train RMSE"}</span>
            <span className="mono hm-v">{value === null ? "—" : rmse(value)}</span>
          </>
        )}
        <span className="hm-grow" />
        {compared?.best === true && (
          <Link
            to="/results"
            search={{ dataset: r.dataset.id }}
            className="hm-bestlink"
            title={compared.title}
          >
            best on {ds}
          </Link>
        )}
        {compared !== undefined && !compared.best && compared.word !== "—" && (
          <span className="hm-cmp">
            {above === undefined ? compared.word : <TipWord tip={above}>{compared.word}</TipWord>}
          </span>
        )}
        {ranked && r.state === "completed" && r.dataset.earlier && !r.dataset.deleted && (
          <span className="hm-cmp">ranked on earlier data</span>
        )}
        {short && !ranked && (
          <Actions run={r} log={next?.log === true} platform={platform} off={off} />
        )}
      </div>
    </article>
  );
}

/**
 * Resume, and Open its log where Run detail offers it (`log`: its coordinating
 * job failed), gray with the reason while Home is as of when the connection went.
 */
function Actions({
  run: r,
  log: hasLog,
  platform,
  off,
}: {
  run: RunSummary;
  log: boolean;
  platform: Platform;
  off: string | undefined;
}) {
  const resume = useResume(r.id, platform.name);
  const log = useBlocker(off === undefined ? undefined : `${off} to open its log`);
  const again = useBlocker(off === undefined ? undefined : `${off} to resume`);
  return (
    <>
      {resume.message !== undefined && (
        <span className="hm-err" role="alert">
          {resume.message}
        </span>
      )}
      <span className="hm-btns">
        {hasLog && (
          <>
            <Link
              to="/runs/$id/logs"
              params={{ id: String(r.id) }}
              className="btn btn-sm"
              {...log.props}
            >
              Open its log
            </Link>
            {log.bubble}
          </>
        )}
        <WorkingButton
          type="button"
          className="btn btn-sm"
          working={resume.working}
          words="Resuming…"
          title={
            off === undefined ? "Fits the starts it hasn’t finished, as the same run" : undefined
          }
          {...again.props}
          onClick={(e) => {
            again.props.onClick(e);
            if (off === undefined) void resume.resume();
          }}
        >
          Resume
        </WorkingButton>
        {again.bubble}
      </span>
    </>
  );
}

/**
 * A run's chart: its revision's first protocol, the one a start's page opens
 * on, its data and the start's model simulated on this computer, captioned
 * with the start and opening it. A revision that can't be read gets one sentence instead;
 * a start this computer's engine scores differently is flagged under it.
 */
function Glance({ run: r, best }: { run: RunSummary; best: RunBest }) {
  const c = useConnection();
  const platform = platformOf(c);
  const ref = { run: r.id, graph: best.graph, openState: best.open_state, start: best.start };
  const top = `${topologyName(r.id, best)} · start ${best.start}`;
  // The revision's first protocol: cards on one dataset chart the same one (#517).
  const stored = shownRmse(best.scores[0], r.validation);
  const revision = useQuery({
    ...revisionQuery(platform, { id: r.dataset.id, revision: r.dataset.revision }),
    enabled: canAsk(c),
  });
  const error = revision.error as WireError | null;
  const unreadable = error?.code === "unreadable" ? error.data.problem : undefined;
  const simulation = useStartSimulation(unreadable === undefined ? ref : undefined);
  // An unreadable revision's protocols are named as the run recorded them.
  const recorded = useRun(unreadable === undefined ? undefined : r.id).data;
  const protocol = revision.data?.content.protocols[0];
  const name = protocol?.name ?? recorded?.protocols[0]?.name;
  const drawn = simulation.data?.protocols[0];
  const drift = simulation.data?.drift ?? null;
  const failure = (simulation.error ??
    (unreadable === undefined ? error : null)) as WireError | null;

  const head = (
    <span className="hm-hi">
      <span className="label hm-hiname">{name}</span>
      <span className="hm-hival">
        <span className="hm-hiunit">{r.validation ? "val RMSE" : "train RMSE"}</span>
        <span className="mono hm-hiv">{stored === null ? "—" : rmse(stored)}</span>
      </span>
    </span>
  );
  const params = {
    id: String(r.id),
    topology: `T${best.graph}.${best.open_state}`,
    start: String(best.start),
  };
  if (protocol !== undefined && drawn !== undefined) {
    const fit = fitOf(protocol.points, lineOf(drawn), protocol.interpolation.log_x, {
      box: GLANCE,
      validation: r.validation,
      ends: true,
    });
    return (
      <>
        <Link
          to="/runs/$id/$topology/$start"
          params={params}
          className="row-link hm-plot"
          aria-label={`${protocol.name}, the first protocol, as ${top} fits it: opens its page`}
        >
          {head}
          <span className="sp-plot hm-chart">
            <svg
              width="100%"
              height={GLANCE.height}
              viewBox={`0 0 ${GLANCE.width} ${GLANCE.height}`}
              preserveAspectRatio="none"
              fill="none"
              aria-hidden="true"
            >
              <path className="sp-grid" d={fit.grid} />
              <path className="sp-base" d={fit.base} />
              <path className="sp-whisk" d={fit.whiskers} />
              <path className="sp-model" d={fit.model} />
              <path className="sp-k-dot" d={fit.dots} />
              <path className="sp-k-ring" d={fit.rings} />
              <path className="sp-k-dot" d={fit.diamonds} />
              <path className="sp-k-ring" d={fit.hollow} />
            </svg>
            <Labels labels={fit.labels} />
          </span>
          <span className="hm-cap">{top}</span>
        </Link>
        {drift !== null && drift.protocols.length > 0 && (
          <p className="hm-flag">
            <InfoGlyph />
            <span>
              <DriftWords
                names={drift.protocols}
                drifted={driftedOf(
                  drift.protocols,
                  simulation.data?.protocols.map((p) => p.name) ?? [],
                  // Stored as the start's page has them (`read_start_fit`'s), as its Drift box.
                  simulation.fit?.scores ?? best.scores,
                  simulation.data?.protocols.map((p) => p.score) ?? [],
                  r.validation,
                )}
              />{" "}
              <Link
                to="/runs/$id/$topology/$start"
                params={params}
                hash="drift"
                className="link nw"
              >
                Details on start {best.start}
              </Link>
            </span>
          </p>
        )}
      </>
    );
  }
  let say: ReactNode;
  if (unreadable === "newer") {
    say = (
      <NewerRevision dataset={r.dataset} so="so this fit can’t be drawn here." then="to draw it." />
    );
  } else if (unreadable !== undefined) {
    const which = `${r.dataset.name ?? "Its dataset"}’s revision ${r.dataset.revision}`;
    say =
      unreadable === "missing"
        ? `${which} isn’t in the Data folder any more, so this fit can’t be drawn here.`
        : `${which} is damaged, so this fit can’t be drawn here.`;
  } else if (failure !== null) {
    say = failure.message;
  } else if (!canAsk(c) && simulation.fit === undefined) {
    say = "Its fit draws here once ICMM is connected.";
  }
  return (
    <>
      <span className="hm-plot">{head}</span>
      <div className="hm-unread" role={say === undefined ? "status" : undefined}>
        {say === undefined ? (
          <p className="hm-drawing">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Drawing its fit on this computer…
          </p>
        ) : (
          <p>
            <InfoGlyph />
            <span>{say}</span>
          </p>
        )}
      </div>
      <Link to="/runs/$id/$topology/$start" params={params} className="row-link hm-cap">
        {top}
      </Link>
    </>
  );
}

/**
 * What this computer's engine scores differently (#398, HF08): "This
 * computer’s engine scores ssiE 0.0561; it was stored as 0.0548." Where no
 * shown error differs, the protocols alone.
 */
function DriftWords({ names, drifted }: { names: readonly string[]; drifted: Drifted[] }) {
  if (drifted.length === 0) {
    return (
      <>
        This computer’s engine scores <Names names={names} /> differently from the stored error
        {names.length === 1 ? "" : "s"}.
      </>
    );
  }
  const list = (cell: (d: Drifted) => ReactNode) =>
    drifted.map((d, i) => (
      <Fragment key={d.name}>
        {i === 0 ? "" : i === drifted.length - 1 ? " and " : ", "}
        {cell(d)}
      </Fragment>
    ));
  return (
    <>
      This computer’s engine scores{" "}
      {list((d) => (
        <>
          <span className="mono">{d.name}</span> <span className="n">{d.drawn}</span>
        </>
      ))}
      ; {drifted.length === 1 ? "it was" : "they were"} stored as{" "}
      {list((d) => (
        <span className="n">{d.stored}</span>
      ))}
      .
    </>
  );
}

/** "recoveryE and tauE", each name in mono. */
function Names({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={n}>
          {i === 0 ? "" : i === names.length - 1 ? " and " : ", "}
          <span className="mono">{n}</span>
        </Fragment>
      ))}
    </>
  );
}

/** The ⓘ a note leads with. */
function InfoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 3.8v4M7 9.6v.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
