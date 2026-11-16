/**
 * Home. Until the platform's first run it's First launch's four steps
 * (LaptopFirstRun); a computer that hasn't seen the first run reads first
 * (`home/firstRun.ts`). After it, connected (LaptopMain, #388): the date
 * line, the summary line in Runs' counts, New dataset and New run, then
 * Live; it reads with a line while it reads, and a failed read says so with
 * Try again.
 *
 * When the Active platform isn't connected, connecting or couldn't connect,
 * Home shows its card, with Connect as the page's primary button, and points
 * to Settings for the others (LaptopHomeOffline). The runs on a platform keep
 * going without the app, and the facts line says so. Edit swaps the card for
 * Settings' own form (#117), which says Save, as Settings does, since it
 * isn't connected. A session that was connected keeps Home's reads below the
 * card, as of when the connection went (`kept`), and reconnecting keeps them
 * too: pulses stop and actions that need the platform are gray with why
 * (`home/kept.tsx`).
 */
import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { homeFacts } from "../connection/view";
import { useHeldFailure } from "../datasets/detail/read";
import { FirstLaunch } from "../home/FirstLaunch";
import { useFirstLaunch } from "../home/firstRun";
import { useBestAndEnded } from "../home/BestAndEnded";
import { HomeKeptContext, type HomeKept } from "../home/kept";
import { Live } from "../home/Live";
import { useHomeReads } from "../home/reads";
import { summaryOf } from "../home/words";
import { FailureBox } from "../setup/FailureBox";
import { inSentence } from "../setup/form";
import { failureOf, usePlatformCommands, usePlatforms } from "../settings/commands";
import { editId, headingId } from "../settings/ids";
import { LocalFormCard } from "../settings/LocalFormCard";
import { PlatformCard } from "../settings/PlatformCard";
import { SshFormCard } from "../settings/SshFormCard";
import { useConnection } from "../shell/connection";
import { clock, dateLine } from "../ui/clock";
import { ReadingFacts } from "../ui/HeadFacts";
import { PageHeading } from "../ui/PageHeading";
import type { SavedPlatform } from "../wire/types.gen";

/** "Wed, Aug 12 · 10:44 AM", kept to the minute. */
function Today() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <div className="label">{dateLine(now)}</div>;
}

export function HomePage() {
  return useFirstLaunch() ? <FirstLaunch /> : <AfterFirstRun />;
}

function AfterFirstRun() {
  const connection = useConnection();
  const list = usePlatforms();
  const commands = usePlatformCommands();
  const [failure, setFailure] = useState<string | undefined>();
  /** Edit has swapped the card for its form. */
  const [editing, setEditing] = useState(false);
  /** Where focus goes once the card is back: Edit, or its heading when Edit isn't shown. */
  const focusTo = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = focusTo.current;
    if (ids === null) return;
    focusTo.current = null;
    ids
      .map((id) => document.getElementById(id))
      .find((el) => el !== null)
      ?.focus();
  });
  const offline =
    connection.status === "not_connected" ||
    connection.status === "connecting" ||
    connection.status === "failed"
      ? connection
      : undefined;
  const platform =
    offline === undefined
      ? undefined
      : list.data?.platforms.find((p) => p.id === offline.platformId);
  const shown = offline !== undefined && platform !== undefined;

  // Home's reads, kept as of when the connection went (#390).
  const active =
    connection.status === "none"
      ? undefined
      : (list.data?.platforms.find((p) => p.id === connection.platformId) ?? {
          type: "ssh" as const,
          name: connection.platform,
        });
  const home = useHomeReads(active);
  const queryClient = useQueryClient();
  const live = connection.status === "connected" || connection.status === "reconnecting";
  const keptView = useKeptView(active, home.asOf, home.reads !== undefined, live);
  const regions = useBestAndEnded({ now: home.now, platform: active, waitOn: keptView.waitOn });

  // Once connected the card goes; focus that was on it waits on the heading.
  const wasShown = useRef(shown);
  useEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (wasShown.current && !shown && lost) {
      document.querySelector<HTMLElement>("h1.page-heading")?.focus();
    }
    wasShown.current = shown;
  }, [shown]);
  // A card that goes takes its form with it.
  const [wasOpen, setWasOpen] = useState(shown);
  if (wasOpen !== shown) {
    setWasOpen(shown);
    if (!shown) setEditing(false);
  }

  const run = async (action: () => Promise<unknown>) => {
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(failureOf(error).message);
    }
  };
  const back = (...focus: string[]) => {
    setEditing(false);
    focusTo.current = focus;
  };

  // Home reads as a whole: Best per dataset and Ended's reads too (#391), unless the
  // connection went before they were in.
  const ready = home.reads !== undefined && (regions.ready || !live);
  const failed = home.failure !== undefined ? home : regions;
  const readFailure = useHeldFailure(
    failed.failure,
    home.fetching || regions.fetching,
    "home",
    ready || !live,
  );
  const summary =
    home.reads === undefined || active === undefined
      ? undefined
      : summaryOf({
          counts: home.reads.overview.counts,
          runs: home.reads.runs,
          platform: active,
          slurm: home.slurm,
          now: home.now,
        });
  const asOf = home.asOf === undefined ? "" : clock(home.asOf, home.now);
  const idle = home.reads !== undefined && home.reads.runs.every((r) => r.ended_at !== null);

  const where = active === undefined ? "" : inSentence(active);
  // The card, and below it Home as of when the connection went (LaptopHomeOffline).
  const card = shown && (
    <section className="home-platform" aria-label="Compute platform">
      {failure !== undefined && (
        <p className="field-issue" role="alert">
          {failure}
        </p>
      )}
      {editing && platform.type === "ssh" ? (
        <SshFormCard
          platform={platform}
          connection={offline}
          launch={list.data?.launch === platform.id}
          onDirty={() => {}}
          onCancel={() => back(editId(platform.id), headingId(platform.id))}
          onSaved={() => back(headingId(platform.id))}
          onRemoved={() => setEditing(false)}
        />
      ) : editing && platform.type === "local" ? (
        <LocalFormCard
          platform={platform}
          connection={offline}
          onDirty={() => {}}
          onCancel={() => back(editId(platform.id), headingId(platform.id))}
          onSaved={() => back(headingId(platform.id))}
        />
      ) : (
        <PlatformCard
          platform={platform}
          connection={offline}
          launch={list.data?.launch === platform.id}
          primary
          onEdit={() => setEditing(true)}
          onConnect={() => void run(() => commands.connect(platform.id))}
          onDisconnect={() => void run(() => commands.disconnect())}
          onRetry={() => void run(() => commands.retry())}
          onUseThisComputer={(id) => void run(() => commands.connect(id))}
        />
      )}
      <p className="hint">
        Your other compute platforms are in{" "}
        <Link to="/settings" hash="platforms" className="link">
          Settings
        </Link>
        .
      </p>
    </section>
  );
  const reads = active !== undefined && (live || keptView.kept);
  const body =
    reads && ready ? (
      <div className={keptView.stale ? "home-body stale" : "home-body"}>
        {keptView.kept && summary !== undefined && (
          <p className="home-asof">
            As of {asOf}, when the connection went · {summary}
          </p>
        )}
        {/* Live, Best of ended runs and Ended in one grid; with nothing in flight, Ended
            moves up into Live's column beside Best (#399, HF13). */}
        <div className={idle ? "home-grid idle" : "home-grid"}>
          <Live
            reads={home.reads!}
            platform={active}
            slurm={home.slurm}
            now={home.now}
            asOf={home.asOf}
          />
          {regions.best}
          {regions.ended}
        </div>
      </div>
    ) : reads && readFailure !== undefined ? (
      <FailureBox
        error={readFailure}
        task="runs"
        platform={active}
        onRetry={failed.retry}
        again={failed.again}
      />
    ) : null;

  return (
    <div className="page">
      <div className="home-headrow">
        <div className="page-head home">
          <Today />
          <PageHeading>Home</PageHeading>
          {shown ? (
            <p className="facts">{homeFacts(offline)}</p>
          ) : !reads ? null : ready && summary !== undefined ? (
            <p className="facts">
              {summary}
              {home.asOf !== undefined && <> · as of {asOf}</>}
            </p>
          ) : readFailure !== undefined ? (
            <p className="facts">Couldn’t read your runs and datasets</p>
          ) : (
            <HomeReading where={where} onRetry={() => void askAgain(queryClient)} />
          )}
        </div>
        {!shown && (
          <div className="home-acts">
            <Link to="/datasets/new" className="btn">
              New dataset
            </Link>
            <Link to="/runs/submit" className="btn btn-primary">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              New run
            </Link>
          </div>
        )}
      </div>
      <HomeKeptContext.Provider value={keptView}>
        {/* One element either way, so the body doesn't mount again when the connection goes:
            not connected with its reads kept, the card is Live's first item and Best of ended
            runs rises beside it (#445, SF13); otherwise it lays out as the page does. */}
        <div
          className={
            card !== false && keptView.kept && ready
              ? idle
                ? "home-kept idle"
                : "home-kept"
              : "home-flow"
          }
        >
          {card}
          {body}
        </div>
      </HomeKeptContext.Provider>
    </div>
  );
}

/** How long Home reads before it says it's still reading (#399, HF12). */
const SLOW_S = 10;

/**
 * Asks again for every first read still under way: a refetch alone would wait
 * on the one already asked, so each is dropped first (#399, HF12).
 */
async function askAgain(client: QueryClient): Promise<void> {
  const stuck = (q: Query) => q.state.data === undefined && q.state.fetchStatus === "fetching";
  const asked = new Set(client.getQueryCache().findAll({ predicate: stuck }));
  await client.cancelQueries({ predicate: stuck });
  await client.refetchQueries({ predicate: (q) => asked.has(q) });
}

/**
 * Home's reading line, and past `SLOW_S` how long it's been, that the
 * platform may be busy, and Try again, which asks again while the count
 * goes on from the first ask (LaptopMain's `slow`).
 */
function HomeReading({ where, onRetry }: { where: string; onRetry: () => void }) {
  const [began] = useState(() => Date.now());
  const [now, setNow] = useState(began);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - began) / 1_000);
  if (seconds < SLOW_S) {
    return <ReadingFacts>Reading your runs and datasets on {where}…</ReadingFacts>;
  }
  return (
    <ReadingFacts
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      }
    >
      Still reading after {/* The count isn't read out each second; the line is, once. */}
      <span className="n" aria-live="off">
        {seconds}
      </span>
      {"\u00a0"}s; {where} may be busy.
    </ReadingFacts>
  );
}

/**
 * Whether Home's reads are as of when the connection went: below the card
 * once it's gone (`kept`, only for a session that was connected and read
 * them), or while it reconnects; and what an action that needs the agent
 * waits on.
 */
function useKeptView(
  platform: Pick<SavedPlatform, "type" | "name"> | undefined,
  asOf: number | undefined,
  read: boolean,
  live: boolean,
): HomeKept {
  const c = useConnection();
  if (platform === undefined || c.status === "connected" || asOf === undefined) {
    return { kept: false, stale: false, asOf: undefined, waitOn: undefined };
  }
  const where = inSentence(platform);
  if (live) {
    return { kept: false, stale: true, asOf, waitOn: `Wait for ${where} to reconnect` };
  }
  return { kept: read, stale: read, asOf, waitOn: `Connect to ${where}` };
}
