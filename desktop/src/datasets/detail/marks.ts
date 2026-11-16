/**
 * Dataset detail's changing mode (#53): the validation marks the user
 * wants, by protocol and point, over whichever revision the page shows. A
 * point keeps its saved mark until it's switched, redrawn or cleared, so the
 * marks wanted carry over to a revision Reload shows.
 */
import type { DatasetContent, Point, Protocol } from "../../wire/types.gen";

/** Each protocol's wanted marks, by its name and each point's x. */
export type Wanted = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

const at = (x: number) => String(x);

/** The point's mark as wanted, or as saved. */
function markOf(wanted: Wanted, protocol: string, p: Point): boolean {
  return wanted[protocol]?.[at(p.x)] ?? p.validation;
}

/** `content` with the marks wanted. */
export function withWanted(content: DatasetContent, wanted: Wanted): DatasetContent {
  return {
    ...content,
    protocols: content.protocols.map((p) => ({
      ...p,
      points: p.points.map((q) => {
        const validation = markOf(wanted, p.name, q);
        return validation === q.validation ? q : { ...q, validation };
      }),
    })),
  };
}

/** How many points the marks wanted switch in `content`. */
export function changesIn(content: DatasetContent, wanted: Wanted): number {
  return content.protocols.reduce(
    (n, p) => n + p.points.filter((q) => markOf(wanted, p.name, q) !== q.validation).length,
    0,
  );
}

/** The marks wanted with the point at `x` in `protocol` switched. */
export function switched(wanted: Wanted, content: DatasetContent, protocol: string, x: number) {
  const p = content.protocols.find((q) => q.name === protocol);
  const point = p?.points.find((q) => q.x === x);
  if (point === undefined) return wanted;
  return {
    ...wanted,
    [protocol]: { ...wanted[protocol], [at(x)]: !markOf(wanted, protocol, point) },
  };
}

/** Every protocol's marks as `protocols` have them: a redraw, or none. */
export function wantedOf(protocols: Pick<Protocol, "name" | "points">[]): Wanted {
  return Object.fromEntries(
    protocols.map((p) => [
      p.name,
      Object.fromEntries(p.points.map((q) => [at(q.x), q.validation])),
    ]),
  );
}

/** The protocol's known data and definition; names, weights and marks may change independently. */
function identity(p: Protocol): string {
  return JSON.stringify([
    p.source === null ? null : [p.source.workbook, p.source.sheet],
    p.holding_mV,
    p.steps.map((s) => [
      s.voltage_mV,
      s.duration_ms,
      s.measure?.kind === "decay_time"
        ? [s.measure.kind, s.measure.from, s.measure.to]
        : s.measure?.kind ?? null,
    ]),
    p.normalized,
    p.time_resolution_ms,
    [p.interpolation.enabled, p.interpolation.points_per_gap, p.interpolation.log_x],
    [...p.points]
      .sort((a, b) => a.x - b.x)
      .map((q) => [q.x, q.value, q.sd, q.interpolated]),
  ]);
}

/**
 * Carries every wanted mark to known data in a new revision. Protocols have
 * no persistent ID: keep an unchanged name only with unchanged data, and
 * infer a rename only from a unique match in both revisions. Never map by
 * position or x alone, or partially discard edits when a match is missing
 * or ambiguous. The caller retains the old revision on a refusal.
 */
export function reloadedWanted(
  before: DatasetContent,
  after: DatasetContent,
  wanted: Wanted,
): { ok: true; wanted: Wanted } | { ok: false; protocol: string } {
  const oldKeys = new Map(before.protocols.map((p) => [p, identity(p)]));
  const newKeys = new Map(after.protocols.map((p) => [p, identity(p)]));
  const next = new Map<string, Readonly<Record<string, boolean>>>();
  for (const [name, marks] of Object.entries(wanted)) {
    const old = before.protocols.find((p) => p.name === name);
    if (old === undefined) return { ok: false, protocol: name };
    const key = oldKeys.get(old)!;
    const candidates = after.protocols.filter((p) => newKeys.get(p) === key);
    const sameName = candidates.find((p) => p.name === name);
    const match =
      sameName ??
      (candidates.length === 1 && before.protocols.filter((p) => oldKeys.get(p) === key).length === 1
        ? candidates[0]
        : undefined);
    if (
      match === undefined ||
      next.has(match.name) ||
      Object.keys(marks).some((x) => !match.points.some((p) => at(p.x) === x))
    ) {
      return { ok: false, protocol: name };
    }
    next.set(match.name, marks);
  }
  return { ok: true, wanted: Object.fromEntries(next) };
}
