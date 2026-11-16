/**
 * Run detail's top half (LaptopRunDetail, #232): its facts (Dataset, Config,
 * Model space, Search and Platform), the stages with the still-improving note
 * under them (#234), and the box under those, which shows what's on the
 * cluster now while the run goes, and why it waits or stopped once it doesn't.
 */
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { whole } from "../configs/words";
import { plural } from "../submit/estimate";
import { clock } from "../ui/clock";
import type { JobDefaults, Run, SavedPlatform, Topology, TopologySummary } from "../wire/types.gen";
import {
  platformLines,
  searchLines,
  topologyId,
  type CapLine,
  type NotePart,
  type StageView,
  type StateBox,
  unbroken,
  wholeDate,
} from "./detail";
import type { Revision } from "./detailQueries";
import { ImprovingMark } from "./ImprovingMark";
import { NewerRevision } from "./NewerRevision";
import { topologyName } from "./words";
import { Whole } from "../ui/Whole";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** Why a run's dataset revision can't be read, as the Dataset fact marks it. */
const UNREADABLE: Record<NonNullable<Revision["unreadable"]>, string> = {
  newer: "saved by a newer ICMM",
  damaged: "can’t be read",
  missing: "its files are missing",
};

export function RunFacts({
  run: r,
  revision,
  platform,
  job,
}: {
  run: Run;
  revision: Revision;
  platform: Platform;
  job: JobDefaults | undefined;
}) {
  const ds = r.dataset;
  const name = ds.name ?? "a dataset this platform never had";
  const marks = [
    ds.earlier ? "earlier data" : "",
    ds.deleted ? "deleted" : "",
    !r.validation ? "no validation points" : "",
    revision.unreadable === undefined ? "" : UNREADABLE[revision.unreadable],
  ].filter(Boolean);
  const pf = platformLines(platform, job);
  return (
    <dl className="rd-facts">
      <div>
        <dt className="th">Dataset</dt>
        <dd className="rd-dd">
          <span>
            {ds.deleted || ds.name === null ? (
              <span className="mono">{name}</span>
            ) : (
              <Link to="/datasets/$id" params={{ id: ds.id }} className="link mono">
                {name}
              </Link>
            )}
            {revision.protocols !== undefined && (
              <> · {plural(revision.protocols, "protocol", "protocols")}</>
            )}
          </span>
          {marks.map((m) => (
            <span key={m} className="qual-e">
              {m}
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt className="th">Config</dt>
        <dd className="rd-dd">
          {r.config.deleted ? (
            <>
              <span className="mono">{r.config.name}</span>
              <span className="qual-e">deleted</span>
            </>
          ) : (
            <Link to="/configs" search={{ id: r.config.id }} className="link mono">
              {r.config.name}
            </Link>
          )}
        </dd>
      </div>
      <div>
        <dt className="th">Model space</dt>
        <dd className="rd-dd">
          <span>
            <span className="n">{whole(r.num_states)}</span> states ·{" "}
            <span className="n">{whole(r.progress.topologies)}</span>{" "}
            {r.progress.topologies === 1 ? "topology" : "topologies"}
          </span>
          <span>
            <span className="n">{whole(r.progress.starts)}</span>{" "}
            {r.progress.starts === 1 ? "start" : "starts"}
          </span>
        </dd>
      </div>
      <div>
        <dt className="th">Search</dt>
        <dd className="rd-dd">
          {searchLines(r).map((line, i) => (
            <span key={i}>
              {line.map((p, j) => (
                <Fragment key={j}>
                  {p.cls === undefined ? p.t : <span className={p.cls}>{p.t}</span>}
                </Fragment>
              ))}
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt className="th">Platform</dt>
        <dd className="rd-dd">
          <span>{pf.name}</span>
          {pf.cap !== undefined && <span>{pf.cap}</span>}
          <span>
            {pf.each !== undefined && <>{pf.each} · </>}
            <Link to="/settings" hash="platforms" className="link nw">
              Platform settings
            </Link>
          </span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * "herg-wt's revision 4 was saved by a newer ICMM, so …": the one line an
 * unreadable revision gets; a newer ICMM's with its links (#360, RF12).
 */
export function UnreadableLine({ run: r, revision }: { run: Run; revision: Revision }) {
  if (revision.unreadable === undefined) return null;
  const name = `${r.dataset.name ?? "Its dataset"}’s revision ${r.dataset.revision}`;
  const why =
    revision.unreadable === "newer" ? (
      <NewerRevision
        dataset={r.dataset}
        so="so this run’s fits don’t draw on its topologies and starts."
        then="to draw them."
      />
    ) : revision.unreadable === "damaged" ? (
      `${name} can’t be read, so this run’s fits don’t draw on its topologies and starts.`
    ) : (
      `${name}’s files are missing, so this run’s fits don’t draw on its topologies and starts.`
    );
  return (
    <p className="rd-unread">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="6" className="rd-unread-ring" />
        <path d="M7 6.2v3.6M7 4.2v.1" className="rd-unread-mark" />
      </svg>
      <span>{why} Its rankings and numbers are as the run recorded them.</span>
    </p>
  );
}

export function Stages({ stages }: { stages: StageView[] }) {
  return (
    <ol
      aria-label="Stages"
      className="rd-stages"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
    >
      {stages.map((s, i) => (
        <li key={i} className="rd-stage">
          <span className="rd-rail" aria-hidden="true">
            <span className={`rd-node rd-node-${s.node}`} />
            <span className={`rd-line rd-line-${s.line}`} />
          </span>
          <span className="rd-stage-text">
            <span className={s.tone === undefined ? "rd-stage-name" : `rd-stage-name rd-${s.tone}`}>
              {s.time !== "" && (
                <>
                  <span className="mono rd-stage-time">{s.time}</span>{" "}
                </>
              )}
              {s.name}
            </span>
            <span className="rd-stage-what">{unbroken(s.detail)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Under the stages while Mark still-improving starts is on: the share of the
 * finished starts still improving at their end, behind the mark Topology
 * draws on them; none still improving is one gray line, without the mark.
 */
export function StillImproving({
  run: r,
  note,
}: {
  run: Run;
  note: { some: boolean; parts: NotePart[] };
}) {
  return (
    <p className={note.some ? "rd-imp" : "rd-imp none"}>
      {note.some && <ImprovingMark className="rd-imp-mark" size={12} />}
      <span>
        {note.parts.map((p, i) =>
          p.kind === "config" ? (
            <Link key={i} to="/configs" search={{ id: r.config.id }} className="link mono">
              {p.t}
            </Link>
          ) : p.kind === undefined ? (
            p.t
          ) : (
            <span key={i} className={p.kind === "share" ? "n rd-imp-share" : "n"}>
              {p.t}
            </span>
          ),
        )}
      </span>
    </p>
  );
}

function Cap({ cap }: { cap: CapLine }) {
  return (
    <span className="rd-cap">
      {cap.before}
      {cap.link && (
        <Link to="/settings" hash="platforms" className="link">
          Platform settings
        </Link>
      )}
      {cap.after}
    </span>
  );
}

/** What's sent out now: the topology fitting, the next, and how many wait behind it. */
export interface LiveCards {
  run: number;
  fitting: TopologySummary;
  /** Its full read, for its array and queue; `undefined` until read. */
  detail: Topology | undefined;
  next: TopologySummary | undefined;
  /** When the next goes out, in words: "in about 30 m". */
  nextIn: string | undefined;
  waiting: number;
  slurm: boolean;
  now: number;
}

/** The box under the stages: its number and cap line, then the cards, or why. */
export function RunBox({
  run,
  box,
  cards,
}: {
  run: number;
  box: StateBox;
  cards: LiveCards | undefined;
}) {
  return (
    <section aria-labelledby="rd-box-h" className="rd-box">
      <div className="rd-box-head">
        <h2 id="rd-box-h" className="label">
          {box.label}
        </h2>
        <div className="rd-big">
          <span className="mono">{box.big}</span>
          <span>{box.bigOf}</span>
        </div>
        {box.cap !== undefined && <Cap cap={box.cap} />}
        {box.keep !== undefined && <span className="rd-keep">{box.keep}</span>}
      </div>
      {box.live ? (
        cards === undefined ? (
          <div />
        ) : (
          <Cards c={cards} />
        )
      ) : (
        <div className="rd-say">
          <p className="rd-what">
            {box.glyph !== undefined && <span className={box.glyph} aria-hidden="true" />}
            <span>
              <Whole text={box.what ?? ""} />
            </span>
          </p>
          {box.next !== undefined && (
            <p className="rd-next">
              <SettingsLinked text={box.next} />
            </p>
          )}
          {box.raw !== undefined && (
            <p className="rd-hint">
              <span className="term">{box.raw}</span>
              {box.since !== undefined && <> · {box.since}</>}
            </p>
          )}
          {box.hint !== undefined && <p className="rd-hint">{box.hint}</p>}
          {box.log && (
            <p className="rd-open">
              <Link to="/runs/$id/logs" params={{ id: String(run) }} className="btn btn-sm">
                Open its log
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Words that name Platform settings, the name a link to them (#326). */
export function SettingsLinked({ text }: { text: string }) {
  const name = "Platform settings";
  const at = text.indexOf(name);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <Link to="/settings" hash="platforms" className="link">
        {name}
      </Link>
      {text.slice(at + name.length)}
    </>
  );
}

const MAX_TICKS = 200;

function Cards({ c }: { c: LiveCards }) {
  const t = c.fitting;
  const d = c.detail;
  const finished = t.starts_finished;
  const failed = t.starts_failed;
  const running = t.starts_running;
  const queued = Math.max(0, t.starts - finished - failed - running);
  const array = [...(d?.arrays ?? [])].reverse().find((a) => a.job_id !== null);
  const sent = t.first_sent_at === null ? NaN : Date.parse(t.first_sent_at);
  const where = [
    c.slurm && array?.job_id != null ? `SLURM array ${array.job_id.split("_")[0]}` : "",
    Number.isNaN(sent) ? "" : wholeDate(`since ${clock(sent, c.now)}`),
  ]
    .filter(Boolean)
    .join(" · ");
  const kinds: [string, number, string][] = [
    ["finished", finished, "rd-t-done"],
    ["failed", failed, "rd-t-failed"],
    ["running", running, "rd-t-run live"],
    ["queued", queued, "rd-t-queued"],
  ];
  const each = t.starts <= MAX_TICKS;
  return (
    <div className="rd-cards">
      <Link
        to="/runs/$id/$topology"
        params={{ id: String(c.run), topology: topologyId(t) }}
        className="rd-card rd-card-now row-link"
      >
        <span className="rd-card-head">
          <span className="mono rd-card-id">
            <span className="rd-quiet">#{c.run}/</span>
            {topologyId(t)}
          </span>
          <span className="rd-card-where">{where}</span>
        </span>
        <span
          className="rd-ticks"
          role="img"
          aria-label={`${topologyName(c.run, t)}: ${kinds
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${whole(n)} ${k === "finished" ? "starts finished" : k}`)
            .join(", ")}`}
        >
          {each
            ? kinds.flatMap(([k, n, cls]) =>
                Array.from({ length: n }, (_, i) => <span key={`${k}${i}`} className={cls} />),
              )
            : kinds
                .filter(([, n]) => n > 0)
                .map(([k, n, cls]) => <span key={k} className={cls} style={{ flexGrow: n }} />)}
        </span>
        <span className="rd-card-legend">
          {kinds
            .filter(([k, n]) => n > 0 || k !== "failed")
            .map(([k, n, cls]) => (
              <span key={k}>
                <span className={`rd-sw ${cls.replace(" live", "")}`} aria-hidden="true" />
                <span>
                  <span className="n">{whole(n)}</span> {k}
                </span>
              </span>
            ))}
        </span>
      </Link>
      {c.next !== undefined && (
        <>
          <Arrow />
          <div className="rd-card rd-card-next">
            <span className="rd-card-head">
              <span className="mono rd-card-id">{topologyId(c.next)}</span>
              <span className="rd-card-tag">next</span>
            </span>
            <span className="rd-card-say">
              {c.slurm ? "Sent" : "Starts"} when {topologyName(c.run, t)}’s queue empties
              {c.nextIn !== undefined && <> · {c.nextIn}</>}
            </span>
          </div>
        </>
      )}
      {c.waiting > 0 && (
        <>
          <Arrow />
          <div className="rd-card rd-card-more">
            <span className="mono rd-card-id">
              {whole(c.waiting)} <span className="rd-card-more-w">more waiting</span>
            </span>
            <span className="rd-card-quiet">
              {c.slurm
                ? "not sent yet · one array at a time"
                : "not started yet · one topology at a time"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <span className="rd-arrow" aria-hidden="true">
      <svg width="20" height="10" viewBox="0 0 20 10" fill="none">
        <path d="M0 5h18M14 1l4 4-4 4" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </span>
  );
}
