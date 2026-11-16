/**
 * A protocol's points as the dataset holds them (ADR-0011): its measured
 * points, the points interpolation adds between them, and each one's mark,
 * train or validation. The desktop's engine makes the added points and the
 * proposed split (`regenerate_dataset`, `propose_split`; ADR-0013), at the
 * protocol's own validation share (#166); this keeps what it made with what
 * it was made from, so a protocol is made again only when its measured
 * points, live interpolation settings or share change, as
 * `icmm.dataset.regenerate` decides.
 */
import type { Issue, Measure, Point, Protocol } from "../wire/types.gen";

export type Interpolation = Protocol["interpolation"];

/** Points per gap the engine takes (`icmm.dataset.model`). */
export const PER_GAP = { min: 1, max: 10 } as const;

/** A validation share the engine takes, in %, and the stepper's step (`icmm.dataset.model`). */
export const SHARE = { min: 5, max: 50, step: 5 } as const;

/** What the engine made for a protocol, and from what (`keyOf`). */
export interface Made {
  key: string;
  interpolation: Interpolation;
  /** The validation share its proposal marked. */
  share: number;
  points: Point[];
  /** Its marks were switched by hand since: a redraw asks first (#166). */
  picked?: boolean;
}

/** A protocol's measured points, in x order. */
export function measuredOf(points: Point[]): Point[] {
  return points.filter((p) => !p.interpolated).sort((a, b) => a.x - b.x);
}

/**
 * What decides a protocol's made points: its measured points' x and values,
 * its interpolation settings while it's on, and its validation share. SD,
 * marks and every other setting change without a remake.
 */
export function keyOf(measured: Point[], interpolation: Interpolation, share: number): string {
  const points = measured.map((p) => [p.x, p.value]).sort((a, b) => a[0] - b[0]);
  return JSON.stringify([interpolation.enabled ? interpolation : null, share, points]);
}

/** A saved protocol's points as made: what it was saved with. */
export function madeOf(
  protocol: Pick<Protocol, "points" | "interpolation" | "validation_share">,
): Made {
  return {
    key: keyOf(measuredOf(protocol.points), protocol.interpolation, protocol.validation_share),
    interpolation: protocol.interpolation,
    share: protocol.validation_share,
    points: protocol.points,
  };
}

/**
 * The points a protocol shows and saves: what was made for it, its measured
 * points' SD as they are now; while that's being made again, what was made
 * before; with nothing made, its measured points, unmarked.
 */
export function shownPoints(measured: Point[], made: Made | undefined): Point[] {
  if (made === undefined) return measured;
  const sd = new Map(measured.map((p) => [p.x, p.sd]));
  return made.points.map((p) => (p.interpolated || !sd.has(p.x) ? p : { ...p, sd: sd.get(p.x)! }));
}

/** `points` with the point at `x` switched between train and validation. */
export function switchedAt(points: Point[], x: number): Point[] {
  return points.map((p) => (p.x === x ? { ...p, validation: !p.validation } : p));
}

/** `points`, every one a train point. */
export function unmarked(points: Point[]): Point[] {
  return points.map((p) => (p.validation ? { ...p, validation: false } : p));
}

/** How many validation points a protocol holds that were picked by hand (#166); 0 when none were. */
export function pickedOf(made: Made | undefined, points: Point[]): number {
  return made?.picked ? points.filter((p) => p.validation).length : 0;
}

/** A share as the stepper shows it: 0.2 is "20". */
export function percentOf(share: number): string {
  return String(Number((share * 100).toPrecision(12)));
}

/** What the Validation row makes of its share as typed (#166). */
export interface ShareRead {
  /** The share its points are proposed at: as last typed within 5 to 50 %. */
  made: number;
  /** The share it saves, as typed; `null` while that isn't a whole number. */
  saved: number | null;
}

export function readShare(typed: string, made: Made | undefined, start: number): ShareRead {
  const whole = wholeOf(typed);
  const inRange = whole !== null && whole >= SHARE.min && whole <= SHARE.max;
  return {
    made: inRange ? whole / 100 : (made?.share ?? start),
    saved: whole === null ? null : Math.min(whole, SENT_MAX) / 100,
  };
}

/** Points per gap as typed, while it's a whole number. */
export function wholeOf(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** Interpolate's settings as the user set them: the switch, points per gap as typed, the log x-axis. */
export interface InterpolationForm {
  enabled: boolean;
  perGap: string;
  logX: boolean;
}

export function formOfInterpolation(i: Interpolation): InterpolationForm {
  return { enabled: i.enabled, perGap: String(i.points_per_gap), logX: i.log_x };
}

/** What a protocol's Interpolate row makes of its settings, over its measured points. */
export interface InterpolationRead {
  /** The log x-axis is offered: every x is above 0. */
  logOffered: boolean;
  /** The settings its points are made with: points per gap as last typed within 1 to 10. */
  made: Interpolation;
  /** The settings it saves, points per gap as typed; `null` while that isn't a whole number. */
  saved: Interpolation | null;
}

/** The largest count a draft sends, so a long one stays a number the wire takes. */
const SENT_MAX = 1_000_000;

export function readInterpolation(
  form: InterpolationForm,
  measured: Point[],
  made: Made | undefined,
): InterpolationRead {
  const logOffered = measured.length > 0 && measured.every((p) => p.x > 0);
  const log_x = logOffered && form.logX;
  const whole = wholeOf(form.perGap);
  const inRange = whole !== null && whole >= PER_GAP.min && whole <= PER_GAP.max;
  const kept = made?.interpolation.points_per_gap ?? PER_GAP.min;
  const perGap = inRange ? whole : kept;
  return {
    logOffered,
    made: { enabled: form.enabled, points_per_gap: perGap, log_x },
    saved:
      whole === null && form.enabled
        ? null
        : {
            enabled: form.enabled,
            points_per_gap: form.enabled ? Math.min(whole!, SENT_MAX) : perGap,
            log_x,
          },
  };
}

/** How a chart says a point: "−50 mV", "0.151 ± 0.039". */
export interface PointWords {
  /** The swept quantity's unit. */
  unit: "mV" | "ms";
  /** Decimals of a value and its SD: 3 for fractions, 1 for ms. */
  digits: number;
  /** Its values are times, in ms: a time to peak, or a decay time not normalized. */
  inMs: boolean;
}

/** A protocol's point words: by what it sweeps, and what its values are in. */
export function pointWords(
  sweepsDuration: boolean,
  measure: Measure["kind"] | undefined,
  normalized: boolean,
): PointWords {
  const ms = measure === "time_to_peak" || (measure === "decay_time" && !normalized);
  return { unit: sweepsDuration ? "ms" : "mV", digits: ms ? 1 : 3, inMs: ms };
}

/** The interpolated point an issue says is out of its measure's range: its protocol and place. */
export function outOfRangeAt(
  issue: Issue,
  pointsOf: (protocol: number) => Point[] | undefined,
): { protocol: number; point: number } | null {
  const [root, i, key, k, field] = issue.path;
  if (issue.path.length !== 5 || root !== "protocols" || key !== "points" || field !== "value") {
    return null;
  }
  const at = { protocol: Number(i), point: Number(k) };
  return pointsOf(at.protocol)?.[at.point]?.interpolated === true ? at : null;
}

/** The dataset's issue that every point is a validation point: saving keeps one train point. */
export function keepOneTrain(issues: Issue[]): Issue | undefined {
  return issues.find((i) => i.path.length === 1 && i.path[0] === "protocols");
}
