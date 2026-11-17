/**
 * Compare (LaptopCompare, #54; built in #342), at `/results/compare`: up to
 * three starts from the session's selection side by side. Results' selection
 * bar, a start's page's Compare with… and Topology's Compare… lead here, and
 * Add candidate leads back to Results with the selection kept.
 *
 * Its chips are the selection's first three starts, A, B and C. Under them,
 * each protocol's fit with every start's curve over one data's points, and
 * each model against its own data in a strip; Metrics; the spread across
 * each topology's Top 10; the parameters and topologies. When every start
 * has one topology, its parameters line up and it's drawn once (#361).
 * Starts rank only among starts on the same data (ADR-0006). Not connected, what it last read
 * stays, as of when the connection went, and Export figures… still works.
 */
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useCandidate, useCandidateReads, type CandidateReads } from "../compare/queries";
import { LinedUp } from "../compare/LinedUp";
import {
  Chips,
  FitSection,
  Metrics,
  OneTopology,
  Parameters,
  Spread,
  Topologies,
  type Chip,
} from "../compare/Parts";
import { useExportFigures } from "../compare/useExportFigures";
import {
  candidateName,
  caveatOf,
  dataOf,
  exportFolderName,
  factsOf,
  fitFoot,
  metricsFoot,
  metricsOf,
  protocolsOf,
  sharedTopology,
  warningsOf,
  type Candidate,
} from "../compare/words";
import { ShowOnceConnected } from "../datasets/detail/ShowOnceConnected";
import { useActivePlatform, useHeldFailure } from "../datasets/detail/read";
import { graphKey, useStateGraphsOf } from "../results/queries";
import { useMinute } from "../runs/queries";
import { COMPARE_HOLDS, pickKey, useSelection, type SelectedStart } from "../selection/selection";
import { FailureBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { useReadAgain } from "../setup/queries";
import { usePreferences } from "../settings/preferences";
import { heardAtOf, useConnection } from "../shell/connection";
import { useKept } from "../submit/kept";
import { clock } from "../ui/clock";
import { PageHeading } from "../ui/PageHeading";
import { PAGE_HEADING_ATTR } from "../ui/pageChangeFocus";
import type { StateGraph, WireError } from "../wire/types.gen";
import { ReportFromHere } from "../report/ReportFromHere";

/** What the page shows, read whole: kept as of the connection's end while it's gone. */
interface Shown {
  candidates: Candidate[];
  graphs: (StateGraph | undefined)[];
}

const focusHeading = () => document.querySelector<HTMLElement>(`[${PAGE_HEADING_ATTR}]`)?.focus();

/** "these 3 starts", as the failure says what it was reading. */
const readingName = (picks: readonly SelectedStart[]) =>
  picks.length === 1 ? "this start" : `these ${picks.length} starts`;

export function ComparePage() {
  const sel = useSelection();
  const picks = useMemo(() => sel.picks.slice(0, COMPARE_HOLDS), [sel.picks]);
  const c = useConnection();
  const platform = useActivePlatform();
  const now = useMinute();
  const live = c.status === "connected" || c.status === "reconnecting";
  const marking = usePreferences().data?.mark_still_improving === true;

  const r0 = useCandidateReads(picks[0]);
  const r1 = useCandidateReads(picks[1]);
  const r2 = useCandidateReads(picks[2]);
  const reads = [r0, r1, r2].filter((r): r is CandidateReads => r !== undefined);
  const graphsBy = useStateGraphsOf(
    picks.map((p) => ({ num_states: p.num_states, graph: p.graph })),
  );
  const graphs = picks.map((p) => graphsBy.get(graphKey(p.num_states, p.graph)));

  const c0 = useCandidate(r0, graphs[0]?.edges.length, now);
  const c1 = useCandidate(r1, graphs[1]?.edges.length, now);
  const c2 = useCandidate(r2, graphs[2]?.edges.length, now);
  const [g0, g1, g2] = graphs;
  const shownNow = useMemo<Shown | undefined>(() => {
    const candidates = [c0, c1, c2].slice(0, picks.length);
    return picks.length >= 2 && candidates.every((x) => x !== undefined)
      ? { candidates: candidates as Candidate[], graphs: [g0, g1, g2].slice(0, picks.length) }
      : undefined;
  }, [c0, c1, c2, g0, g1, g2, picks.length]);
  const kept = useKept(
    shownNow,
    {
      connected: c.status === "connected",
      live,
      platform: c.status === "none" ? "" : c.platformId,
      heardAt: heardAtOf(c),
    },
    now,
  );
  const failed = reads.find((r) => r.error !== undefined)?.error;
  const again = useReadAgain(failed, () => Promise.all(reads.map((r) => r.refetch())));
  const failure = useHeldFailure<WireError>(
    again.failure,
    reads.some((r) => r.fetching),
    picks.map(pickKey).join(","),
    shownNow !== undefined || !live,
  );
  const shown = picks.length >= 2 ? kept.value : undefined;
  // The kept view while it's this selection's; one start removed while not connected drops it.
  const current =
    shown !== undefined && shown.candidates.length === picks.length ? shown : undefined;

  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const addRef = useRef<HTMLAnchorElement>(null);
  const remove = (pick: SelectedStart, at: number) => {
    sel.remove([pickKey(pick)]);
    // Focus stays in the chips: on the one after, else the one before, else Add candidate.
    queueMicrotask(() => {
      const left = picks.length - 1;
      if (left === 0) focusHeading();
      else (chipRefs.current[Math.min(at, left - 1)] ?? addRef.current)?.focus();
    });
  };

  const [pointsFrom, setPointsFrom] = useState(0);
  const candidates = current?.candidates;
  const groups = useMemo(() => (candidates === undefined ? [] : dataOf(candidates)), [candidates]);
  const from = Math.min(pointsFrom, Math.max(groups.length - 1, 0));
  const protocols = useMemo(
    () => (candidates === undefined ? undefined : protocolsOf(candidates, from)),
    [candidates, from],
  );
  const span = groups.length > 1;
  const chips: Chip[] = picks.map((p, i) => {
    const cand = candidates?.[i];
    const r = [r0, r1, r2][i];
    return {
      pick: p,
      data:
        span && cand !== undefined ? groups.find((g) => g.members.includes(i))?.label : undefined,
      fitting: cand?.topology.fitting ?? r?.topology?.provisional ?? false,
    };
  });
  // A fit this computer's engine is still drawing: its figure would have no curve yet. It's
  // the shown view's, so a view kept while not connected keeps it too.
  const drawing = candidates?.some((x) => x.drawing) ?? false;
  const exportWhy =
    picks.length < 2
      ? "Needs 2 starts to compare."
      : candidates === undefined
        ? "Opens once the starts are read."
        : drawing
          ? "Opens once their fits are drawn."
          : undefined;
  const exporting = useExportFigures(
    {
      protocols,
      names: (candidates ?? []).map(candidateName),
      says: candidates === undefined ? "" : fitFoot(candidates).says,
    },
    exportFolderName(candidates ?? []),
    exportWhy,
  );

  // The facts: from what's read, else what the picks say.
  const facts =
    candidates !== undefined
      ? factsOf(candidates)
      : picks.length === 0
        ? "Nothing in the selection yet"
        : `${picks.length} start${picks.length === 1 ? "" : "s"} on ${[
            ...new Set(picks.map((p) => p.dataset.name ?? p.dataset.id)),
          ].join(" and ")}`;
  const asOf = picks.length >= 2 ? kept.asOf : undefined;

  const head = (
    <section className="cmp-head">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link to="/results" className="link">
          Results
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Compare</span>
      </nav>
      <div className="cmp-trow">
        <div className="cmp-ttext">
          <PageHeading>Compare</PageHeading>
          <p className="facts">
            {facts}
            {asOf !== undefined && <> · as of {clock(asOf, now)}</>}
          </p>
        </div>
        {exporting.button}
      </div>
      {exporting.outcome}
      <ReportFromHere name="Compare" />
      <Chips
        chips={chips}
        full={picks.length >= COMPARE_HOLDS}
        onRemove={remove}
        chipRef={(i) => (el) => {
          chipRefs.current[i] = el;
        }}
        addRef={addRef}
        still={asOf !== undefined}
      />
    </section>
  );

  let body: ReactNode;
  if (picks.length === 0) {
    body = (
      <div className="cmp-empty">
        <p className="lead">Nothing to compare yet.</p>
        <p>
          Tick up to 3 starts on Results, or press Compare with… on a start’s page. They stay in the
          selection while ICMM is open.
        </p>
      </div>
    );
  } else if (picks.length === 1) {
    body = (
      <div className="cmp-empty">
        <p className="lead">Compare needs a second start.</p>
        <p>
          Add one with Add candidate, which opens Results with this selection kept, or press Compare
          with… on any start’s page.
        </p>
      </div>
    );
  } else if (platform === undefined || (!live && current === undefined)) {
    body = (
      <ShowOnceConnected platform={platform} kind="Results">
        these starts
      </ShowOnceConnected>
    );
  } else if (current === undefined && failure !== undefined) {
    body = (
      <FailureBox
        error={failure}
        task={{ reading: readingName(picks) }}
        platform={platform}
        onRetry={again.retry}
        again={again.again}
      />
    );
  } else if (current === undefined || candidates === undefined || protocols === undefined) {
    body = (
      <Reading>
        <span>
          Reading {picks.length} starts on {inSentence(platform)}…
        </span>
      </Reading>
    );
  } else {
    const drawErrors = reads.flatMap((r, i) =>
      r.drawError === undefined || candidates[i]?.unreadable !== undefined
        ? []
        : [
            {
              letter: "ABC"[i],
              text: `This computer’s engine couldn’t draw start ${r.pick.start}’s fit: ${r.drawError.message}`,
            },
          ],
    );
    const shared = sharedTopology(candidates);
    body = (
      <>
        <FitSection
          protocols={protocols}
          groups={groups}
          pointsFrom={from}
          onPointsFrom={setPointsFrom}
          validation={groups.some((g) => g.data.validation !== 0)}
          caveat={caveatOf(candidates)}
          warnings={[...warningsOf(candidates), ...drawErrors]}
          foot={fitFoot(candidates)}
        />
        <div className="cmp-mid">
          <Metrics
            candidates={candidates}
            groups={groups}
            rows={metricsOf(candidates, { marking, now })}
            foot={metricsFoot(candidates, marking)}
          />
          <section className="cmp-aside">
            <Spread candidates={candidates} one={shared?.oneRun === true} />
            {shared === undefined ? (
              <Parameters candidates={candidates} />
            ) : (
              <OneTopology c={candidates[0]} graph={current.graphs[0]} oneRun={shared.oneRun} />
            )}
          </section>
        </div>
        {shared === undefined ? (
          <Topologies candidates={candidates} graphs={current.graphs} />
        ) : (
          <LinedUp candidates={candidates} name={shared.name} oneRun={shared.oneRun} />
        )}
      </>
    );
  }

  return (
    <div className={asOf === undefined ? "page cmp" : "page cmp stale"}>
      {head}
      {body}
    </div>
  );
}
