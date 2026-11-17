/**
 * Submit run (LaptopSubmitRun, #235), at `/runs/submit?config=<id>`: the
 * config a run would fit, as it was last saved, and the platform it goes to,
 * with Submit run in the head. The config is `?config=` else the one saved
 * last; Change… picks another. Submit run says under it why it can't be
 * pressed (a config that's gone or can't be read, a dataset that was deleted,
 * a platform not set up or not connected), and ⌘↵ presses it from anywhere
 * on the page.
 *
 * Under the head, four tiles say the work, its time, when it begins and what it
 * writes, and the Platform aside where it runs, when it would begin and what
 * happens after (`submit/usePlan.ts` puts the numbers together).
 *
 * A submit that is accepted opens the run's page; one that is refused, or
 * whose answer was lost, says so in a box above the head and keeps focus on
 * the button. Pressing it again sends the same `request_key`, so it makes one
 * run (ADR-0009). Not connected, the page keeps what it last read, as of when
 * the connection went away.
 */
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../connection/useNow";
import { useConfig, useConfigs, useTopologyCounts } from "../configs/queries";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { useDatasets } from "../datasets/queries";
import { isMac, shortcutLabel } from "../platform";
import { usePlatforms } from "../settings/commands";
import { FailureBox, SaidBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { usePlatformSettings, useReadAgain } from "../setup/queries";
import { heardAtOf, useConnection } from "../shell/connection";
import { ConfigCard } from "../submit/ConfigCard";
import { useKept } from "../submit/kept";
import { PlatformAside } from "../submit/PlatformAside";
import { nameOf, settled, shownOf, type Reads, type Seen } from "../submit/shown";
import { useSubmitRun } from "../submit/submit";
import { Tiles } from "../submit/Tiles";
import { useNumberReads, usePlan } from "../submit/usePlan";
import { refusedBox, submitReason, type SubmitState } from "../submit/words";
import { clock } from "../ui/clock";
import { PageHeading } from "../ui/PageHeading";
import { besideProps } from "../ui/working";
import { WorkingButton } from "../ui/WorkingButton";
import type { WireError } from "../wire/types.gen";
import { useShownPath } from "../ui/paths";
import { ReportFromHere } from "../report/ReportFromHere";

/** Submit run's reason, under it. */
const WHY_ID = "sub-why";

export function SubmitRunPage() {
  const c = useConnection();
  const platform = useActivePlatform();
  const saved = usePlatforms().data?.platforms.find(
    (p) => c.status !== "none" && p.id === c.platformId,
  );
  const settings = usePlatformSettings();
  const navigate = useNavigate();
  const { config: wanted } = useSearch({ from: "/runs/submit" });
  const now = useNow([]);
  const connected = c.status === "connected";
  const live = connected || c.status === "reconnecting";

  // What the page reads: the platform's configs, then the one it's on.
  const list = useConfigs();
  const listRead = useReadAgain(
    list.isError ? (list.error as unknown as WireError) : undefined,
    list.refetch,
  );
  const listFailure = useHeldFailure(
    listRead.failure,
    list.isFetching,
    "all",
    list.data !== undefined || !live,
  );
  const id = wanted ?? list.data?.[0]?.id;
  const one = useConfig(id);
  const oneError = one.isError ? (one.error as unknown as WireError) : undefined;
  const oneRead = useReadAgain(one.data === undefined ? oneError : undefined, one.refetch);
  const oneFailure = useHeldFailure(
    oneRead.failure,
    one.isFetching,
    id ?? "",
    one.data !== undefined || !live,
  );
  const countsQ = useTopologyCounts(one.data?.config);
  const counts = countsQ.data;
  const datasets = useDatasets();
  const summary = datasets.data?.find((d) => d.id === one.data?.dataset.id);
  const reads: Reads = {
    configs: list.data,
    listError: listFailure,
    id,
    saved: one.data,
    error: oneError ?? oneFailure,
    counts,
    protocols: summary?.protocols.length,
  };

  // What the tiles and the aside are made of, beside the config: the platform's settings and
  // timings, and the dataset's content when no finished start can say how long an evaluation takes.
  const current = shownOf(reads);
  const numbers = useNumberReads(current.kind === "ready" ? current.saved : undefined);
  const all: Seen = {
    ...reads,
    settings: numbers.settings,
    timings: numbers.timings,
    content: numbers.content,
    summary,
  };

  // Once the connection is gone, the page goes on showing what it last read.
  const kept = useKept(
    settled(current) ? all : undefined,
    { connected, live, platform: c.status === "none" ? "" : c.platformId, heardAt: heardAtOf(c) },
    now,
  );
  const seen = live ? all : kept.value;
  const shown = seen === undefined ? undefined : shownOf(seen);
  const state: SubmitState = {
    platform: platform ?? { type: "ssh", name: "" },
    live,
    // Not live, with nothing kept, `live` is what the reason says.
    config: shown ?? { kind: "none" },
    settingsMissing: settings.data?.saved === null,
  };
  const reason =
    platform === undefined
      ? { why: "Connect to a compute platform to submit", blocked: true }
      : submitReason(state);
  const plan = usePlan({
    platform: platform ?? { type: "ssh", name: "" },
    live,
    seen,
    ready: shown?.kind === "ready" ? shown.saved : undefined,
    // A config that's read but can't be submitted as it is: its dataset is gone or unreadable.
    blocked: shown?.kind === "ready" && reason.blocked,
    reads: { ...numbers, countsFailed: countsQ.isError && counts === undefined },
    dataFolder: saved?.data_folder ?? "",
    // The runs' ETAs are held at the time the reads are from (#326).
    now: kept.asOf ?? now,
  });
  const shownPath = useShownPath(platform);
  // The card, once the configs are listed.
  const listed = seen?.configs === undefined || shown === undefined ? undefined : seen.configs;

  const submit = useSubmitRun();
  const primary = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    // Set again on each mount: StrictMode mounts twice.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A run was accepted: a second press before the run's page opens would make a second run. The
  // ref is read by the press itself, which can come before the state has rendered.
  const [landed, setLanded] = useState(false);
  const landedRef = useRef(false);
  // What the last refused submit was, for the config it was for.
  const [refused, setRefused] = useState<{ id: string; error: unknown }>();
  if (refused !== undefined && refused.id !== id) setRefused(undefined);

  const blocked = reason.blocked || landed;

  const press = async () => {
    if (blocked || landedRef.current || shown?.kind !== "ready") return;
    const config = shown.saved.id;
    const outcome = await submit.submit(config);
    if (!outcome.ok) {
      setRefused({ id: config, error: outcome.error });
      return;
    }
    landedRef.current = true;
    setLanded(true);
    // The page change moves focus to the run page's heading.
    if (alive.current) {
      await navigate({ to: "/runs/$id", params: { id: String(outcome.run) } });
    }
  };

  // ⌘↵ (Ctrl ↵ elsewhere) presses Submit run, from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || !(isMac() ? e.metaKey : e.ctrlKey)) return;
      // Not a key something else took (the palette's rows are its own), nor while a dialog such
      // as Find custom topology is open.
      if (e.defaultPrevented) return;
      if (document.querySelector("[role=alertdialog], [role=dialog][aria-modal=true]")) return;
      e.preventDefault();
      const button = primary.current;
      // A blocked Submit run says why under it; the key does nothing more, and focus stays put.
      if (button === null || button.getAttribute("aria-disabled") === "true") return;
      // The press closes the picker, and with it the search that had focus: focus goes to
      // Submit run first, so it isn't dropped to the page.
      button.focus();
      button.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const box =
    refused !== undefined && platform !== undefined
      ? refusedBox(
          refused.error,
          platform,
          saved === undefined ? "its Data folder" : shownPath(saved.data_folder),
          connected,
        )
      : undefined;
  const name = listed === undefined || shown === undefined ? undefined : nameOf(shown);

  return (
    <div className="page sub-page">
      {box !== undefined && <SaidBox said={box} />}
      <section className="sub-head">
        <div className="sub-head-text">
          <nav aria-label="Breadcrumb" className="crumbs">
            <Link to="/runs" className="link" {...besideProps(submit.working)}>
              Runs
            </Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Submit run</span>
          </nav>
          <PageHeading>Submit run</PageHeading>
          {platform !== undefined && (
            <p className="facts">
              {name !== undefined && (
                <>
                  <span className="mono n">{name}</span> →{" "}
                </>
              )}
              <span className="sub-platform">{platform.name}</span>
              {kept.asOf !== undefined && <> · as of {clock(kept.asOf, now)}</>}
            </p>
          )}
        </div>
        <div className="sub-submit">
          <WorkingButton
            ref={primary}
            type="button"
            className="btn btn-primary"
            working={submit.working}
            words="Submitting…"
            aria-disabled={blocked || undefined}
            aria-describedby={WHY_ID}
            onClick={(e) => {
              // A blocked press explains itself under the button; it does nothing more.
              if (blocked) e.preventDefault();
              else void press();
            }}
          >
            Submit run <span className="kbd kbd-inv">{shortcutLabel("↵")}</span>
          </WorkingButton>
          <p id={WHY_ID} className="sub-why">
            {reason.keep !== undefined && <span className="sub-keep">{reason.keep} </span>}
            {reason.why}
          </p>
        </div>
      </section>
      <ReportFromHere name="Submit run" />
      {platform !== undefined && plan.tiles !== undefined && <Tiles tiles={plan.tiles} />}
      <div className={platform === undefined ? "sub-body solo" : "sub-body"}>
        <div className="sub-main">
          <section aria-labelledby="cfg-h" className="sub-config">
            <h2 id="cfg-h" className="label">
              Config
            </h2>
            {platform === undefined ? (
              <ShowOnceConnected platform={undefined} kind="Configs">
                its configs
              </ShowOnceConnected>
            ) : listed === undefined || seen === undefined || shown === undefined ? (
              seen?.listError !== undefined ? (
                <FailureBox
                  error={seen.listError}
                  task="configs"
                  platform={platform}
                  onRetry={listRead.retry}
                  again={listRead.again}
                />
              ) : connected ? (
                <Reading>Reading the configs on {inSentence(platform)}…</Reading>
              ) : (
                <ShowOnceConnected platform={platform} kind="Configs">
                  its configs
                </ShowOnceConnected>
              )
            ) : (
              <ConfigCard
                platform={platform}
                live={live}
                shown={shown}
                configs={listed}
                id={seen.id}
                protocols={seen.protocols}
                counts={seen.counts}
                now={now}
                working={submit.working}
                onRetry={oneRead.retry}
                again={oneRead.again}
              />
            )}
          </section>
        </div>
        {platform !== undefined && (
          <PlatformAside
            platform={saved ?? platform}
            plan={plan}
            now={now}
            working={submit.working}
          />
        )}
      </div>
    </div>
  );
}
