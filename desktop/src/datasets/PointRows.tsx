/**
 * A protocol's Interpolate and Validation rows (#52, #53), the same on the
 * wizard's Protocols step and in the Protocol builder. Each is a label and
 * its value, for a two-column grid (`.kv3`).
 *
 * Interpolate is a switch; on, points per gap is a `.stepper` (1 to 10),
 * the trade-off is said under it, and a log x-axis is offered while every x
 * is above 0. Interpolated points out of their measure's range say so, with
 * the fix that works. Validation proposes its share of the points, a
 * `.stepper` from 5 to 50 % in 5 % steps (#166), counts the protocol's
 * validation points, with Redraw (a fresh proposal) and None.
 *
 * Changing live interpolation settings or changing the share
 * redraws the validation points: over points picked by hand, it asks in
 * place first, and nothing changes until it's answered (#166).
 */
import { useId, useRef, useState } from "react";
import { grayProps } from "../ui/gray";
import { Stepper } from "../ui/Stepper";
import type { Point } from "../wire/types.gen";
import { Checking } from "./Checking";
import { useRedraw } from "./making";
import { PER_GAP, SHARE, wholeOf, type InterpolationForm, type InterpolationRead } from "./points";
import { tradeOffWords, validationHint } from "./words";

/**
 * The ask before a redraw over points picked by hand (#166): what goes, why,
 * and Keep my points beside the change. The control that asked keeps focus.
 */
function RedrawAsk({
  held,
  why,
  confirm,
  keep,
  go,
  blocked = false,
}: {
  held: number;
  why: string;
  confirm: string;
  keep: () => void;
  go: () => void;
  blocked?: boolean;
}) {
  const id = useId();
  return (
    <div
      className="redraw-ask wide"
      role="alertdialog"
      aria-label="Redraw your validation points?"
      aria-describedby={`${id}-b`}
    >
      <p>
        Redraw the {held === 1 ? "validation point" : `${held} validation points`} you chose?
        <span id={`${id}-b`} className="hint">
          {why}
        </span>
      </p>
      <button type="button" className="btn btn-sm" onClick={keep}>
        Keep my points
      </button>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={blocked || undefined}
        onClick={() => {
          if (!blocked) go();
        }}
      >
        {confirm}
      </button>
    </div>
  );
}

/** A held numeric edit is checked here without committing an intermediate value to its caller. */
function entryIssue(text: string, min: number, max: number, range: string): string | undefined {
  const whole = wholeOf(text);
  if (whole === null) return "Enter a whole number.";
  if (whole < min || whole > max) return range;
  return undefined;
}

export function InterpolateRow({
  name,
  fieldId,
  interp,
  read,
  points,
  picked,
  issue,
  checking = false,
  range,
  onChange,
}: {
  name: string;
  /** The points per gap field's id. */
  fieldId: string;
  interp: InterpolationForm;
  read: InterpolationRead;
  /** Its points as made. */
  points: Point[];
  /** Its validation points picked by hand, which a redraw asks about first; 0 when none were. */
  picked: number;
  /** What its checks say of its settings: points per gap, or a log x-axis it can't have. */
  issue?: string;
  /** The issue is the checks' last answer, asked again (#424 KF21). */
  checking?: boolean;
  /** Its interpolated points out of range, and the fix (`outOfRangeWords`). */
  range?: string;
  onChange: (change: Partial<InterpolationForm>) => void;
}) {
  const added = points.filter((p) => p.interpolated).length;
  const measured = points.length - added;
  /** A change to the live interpolation settings, waiting on the ask. */
  const [pending, setPending] = useState<Partial<InterpolationForm> | null>(null);
  const switchRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLInputElement>(null);
  const shown = {
    ...interp,
    ...(pending?.perGap !== undefined ? { perGap: pending.perGap } : {}),
  };
  const on = interp.enabled;
  const redraws = (change: Partial<InterpolationForm>) => {
    if (change.enabled !== undefined && change.enabled !== on) return true;
    if (on && change.logX !== undefined && read.logOffered && change.logX !== read.made.log_x)
      return true;
    const whole = change.perGap === undefined ? null : wholeOf(change.perGap);
    return (
      on &&
      whole !== null &&
      whole >= PER_GAP.min &&
      whole <= PER_GAP.max &&
      whole !== read.made.points_per_gap
    );
  };
  const change = (c: Partial<InterpolationForm>) => {
    const next = { ...pending, ...c };
    // Hold the entire typed edit, including clearing and partial numbers, so
    // Keep my points returns to the settings from before typing began.
    const invalid =
      next.perGap !== undefined &&
      entryIssue(
        next.perGap,
        PER_GAP.min,
        PER_GAP.max,
        "Points per gap must be a whole number from 1 to 10.",
      ) !== undefined;
    if (picked > 0 && (redraws(next) || invalid)) setPending(next);
    else {
      setPending(null);
      onChange(next);
    }
  };
  const answered = (go: boolean) => {
    if (go && pending !== null) onChange(pending);
    const perGap = pending?.perGap !== undefined && pending.enabled !== true;
    setPending(null);
    // The control that asked takes focus back.
    const logX = pending?.logX !== undefined;
    if (perGap) document.getElementById(fieldId)?.focus();
    else if (logX) logRef.current?.focus();
    else switchRef.current?.focus();
  };
  const after =
    pending?.enabled === false
      ? 0
      : (wholeOf(pending?.perGap ?? interp.perGap) ?? read.made.points_per_gap);
  const pendingIssue =
    pending?.perGap !== undefined && (pending.enabled ?? on)
      ? entryIssue(
          pending.perGap,
          PER_GAP.min,
          PER_GAP.max,
          "Points per gap must be a whole number from 1 to 10.",
        )
      : undefined;
  const shownIssue = pendingIssue ?? issue;
  const stale = pendingIssue === undefined && checking;
  return (
    <>
      <span className="k top">Interpolate</span>
      <span className="v col">
        <span className="ln">
          <label className="switch">
            <input
              ref={switchRef}
              type="checkbox"
              role="switch"
              checked={on}
              aria-label={`Interpolate ${name}`}
              // On starts at 1 per gap (#52).
              onChange={(e) =>
                change(e.target.checked ? { enabled: true, perGap: "1" } : { enabled: false })
              }
            />
            <span className="trk" aria-hidden="true" />
          </label>
          {on && (
            <>
              <Stepper
                id={fieldId}
                value={shown.perGap}
                min={PER_GAP.min}
                max={PER_GAP.max}
                label={`Points per gap, ${name}`}
                more="One more per gap"
                fewer="One fewer per gap"
                aria-invalid={shownIssue !== undefined}
                aria-describedby={shownIssue !== undefined ? `${fieldId}-issue` : undefined}
                onChange={(perGap) => change({ perGap })}
              />
              <span className="unit">
                per gap · {PER_GAP.min} to {PER_GAP.max}
              </span>
            </>
          )}
        </span>
        {shownIssue !== undefined && (
          <span id={`${fieldId}-issue`} className={stale ? "err chk" : "err"}>
            {shownIssue}
            {stale && <Checking />}
          </span>
        )}
        <span className="hint wide">
          {tradeOffWords(
            on && added > 0 ? { added, measured, perGap: read.made.points_per_gap } : null,
          )}
        </span>
        {on && read.logOffered && (
          <span className="ln log-x">
            <label className="cbx">
              <input
                ref={logRef}
                type="checkbox"
                checked={interp.logX}
                onChange={(e) => change({ logX: e.target.checked })}
              />
              Spline on a log x-axis
            </label>
            <span className="hint">suits x spaced by doubling, like gap lengths</span>
          </span>
        )}
        {range !== undefined && (
          <p className="err wide" role="alert">
            {range}
          </p>
        )}
        {pending !== null && (
          <RedrawAsk
            held={picked}
            why={
              pendingIssue ??
              `Interpolating proposes them again over all ${measured + Math.max(0, measured - 1) * after} points, so yours go back to train.`
            }
            confirm="Interpolate"
            blocked={pendingIssue !== undefined}
            keep={() => answered(false)}
            go={() => answered(true)}
          />
        )}
      </span>
    </>
  );
}

export function ValidationRow({
  name,
  fieldId,
  points,
  share,
  madeShare,
  picked,
  onShare,
  shareIssue,
  checking = false,
  redraw,
  none,
  issue,
}: {
  name: string;
  /** The share field's id. */
  fieldId: string;
  /** Its points as made, with their marks. */
  points: Point[];
  /** Its validation share in %, as typed (#166). */
  share: string;
  /** The share its points were proposed at, 0 to 1. */
  madeShare: number;
  /** Its validation points picked by hand, which a new share asks about first; 0 when none were. */
  picked: number;
  onShare: (share: string) => void;
  /** What its checks say of its share. */
  shareIssue?: string;
  /** The share's issue is the checks' last answer, asked again (#424 KF21). */
  checking?: boolean;
  /** Redraw: a fresh proposal, from this computer's engine. */
  redraw: () => Promise<void>;
  none: () => void;
  /** What went wrong: a Redraw the engine couldn't make, or every point held out. */
  issue?: string;
}) {
  /** A share that proposes again, waiting on the ask. */
  const [pending, setPending] = useState<string | null>(null);
  const change = (text: string) => {
    const whole = wholeOf(text);
    const redraws =
      whole === null || whole < SHARE.min || whole > SHARE.max || whole / 100 !== madeShare;
    if (picked > 0 && redraws) setPending(text);
    else {
      setPending(null);
      onShare(text);
    }
  };
  const pendingIssue =
    pending === null
      ? undefined
      : entryIssue(pending, SHARE.min, SHARE.max, "The validation share must be from 5 % to 50 %.");
  const shownIssue = pendingIssue ?? shareIssue;
  const stale = pendingIssue === undefined && checking;
  const answered = (go: boolean) => {
    if (go && pending !== null) onShare(pending);
    setPending(null);
    document.getElementById(fieldId)?.focus();
  };
  const drawing = useRedraw(redraw);
  const redrawButton = useRef<HTMLButtonElement>(null);
  const failed =
    drawing.error === undefined
      ? undefined
      : `ICMM couldn’t redraw ${name}’s validation points on this computer. ${drawing.error.message ?? ""}`.trim();
  const held = points.filter((p) => p.validation).length;
  return (
    <>
      <span className="k top">Validation</span>
      <span className="v col">
        <span className="ln vrow">
          <Stepper
            id={fieldId}
            value={pending ?? share}
            min={SHARE.min}
            max={SHARE.max}
            step={SHARE.step}
            label={`Validation share, ${name}, in %`}
            more="5 % more"
            fewer="5 % less"
            aria-invalid={shownIssue !== undefined}
            aria-describedby={shownIssue !== undefined ? `${fieldId}-issue` : undefined}
            onChange={change}
          />
          <span className="unit">% proposed ·</span>{" "}
          <span className="vcount">
            <span className="mono">{held}</span> of <span className="mono">{points.length}</span>{" "}
            {points.length === 1 ? "point" : "points"}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            ref={redrawButton}
            {...grayProps(drawing.gray)}
            onClick={() => void drawing.press()}
          >
            Redraw
          </button>
          {held > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                none();
                // None goes as it's pressed: focus goes to Redraw beside it.
                redrawButton.current?.focus();
              }}
            >
              None
            </button>
          )}
        </span>
        {shownIssue !== undefined && (
          <span id={`${fieldId}-issue`} className={stale ? "err wide chk" : "err wide"}>
            {shownIssue}
            {stale && <Checking />}
          </span>
        )}
        {(failed ?? issue) !== undefined && (
          <span className="err wide" role="alert">
            {failed ?? issue}
          </span>
        )}
        {pending !== null && (
          <RedrawAsk
            held={picked}
            why={
              pendingIssue ??
              `Proposing ${wholeOf(pending)}\u00a0% draws them again over all ${points.length} points, so yours go back to train.`
            }
            confirm="Redraw"
            blocked={pendingIssue !== undefined}
            keep={() => answered(false)}
            go={() => answered(true)}
          />
        )}
        <span className="hint wide">{validationHint({ name, points: points.length, held })}</span>
      </span>
    </>
  );
}
