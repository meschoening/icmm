/**
 * Interpolated points out of their measure's range (#52): which they are,
 * from `validate_dataset`'s issues, and the one fix that works. The app tries
 * fewer points per gap, then the log x-axis where it's offered: this
 * computer's engine makes each (`regenerate_dataset`), and the platform's
 * checks say which keeps every point in range, by the same rules.
 */
import { useQuery } from "@tanstack/react-query";
import { agentKey, canAsk } from "../setup/queries";
import { useConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { Issue, Point, Protocol } from "../wire/types.gen";
import { measuredOf, outOfRangeAt, PER_GAP } from "./points";
import type { RangeFix } from "./words";

/** A protocol's interpolated points that its checks say are out of range, with the rule they break. */
export function outOfRangeOf(
  issues: Issue[],
  index: number,
  points: Point[],
): { points: Point[]; rule: string } | null {
  const found = issues.flatMap((i) => {
    const at = outOfRangeAt(i, (k) => (k === index ? points : undefined));
    return at === null ? [] : [{ point: points[at.point], rule: i.message }];
  });
  if (found.length === 0) return null;
  return { points: found.map((f) => f.point), rule: found[0].rule };
}

/** Whether `issues` put any of protocol `index`'s interpolated points out of range. */
function inRange(issues: Issue[], index: number, points: Point[]): boolean {
  return outOfRangeOf(issues, index, points) === null;
}

/**
 * The fix that works for `protocol`, whose interpolated points are out of
 * range: the most points per gap below its own that keeps every point in
 * range, else its log x-axis, else neither. `undefined` until the platform
 * answers; `null` when `protocol` is.
 */
export function useRangeFix(
  dataset: string,
  protocol: Protocol | null,
  logOffered: boolean,
): RangeFix | null | undefined {
  const c = useConnection();
  const platform = c.status === "none" ? "" : c.platformId;
  // Marks don't move a spline: switching a point asks nothing again.
  const body =
    protocol === null
      ? null
      : JSON.stringify({
          dataset,
          protocol: { ...protocol, points: measuredOf(protocol.points) },
          logOffered,
        });
  const q = useQuery({
    queryKey: agentKey(platform, "datasets", "range-fix", body),
    queryFn: async (): Promise<RangeFix> => {
      const p = protocol!;
      const measured = measuredOf(p.points);
      // The points were made at no more than 10 per gap, whatever's typed.
      const { log_x } = p.interpolation;
      const m = Math.min(p.interpolation.points_per_gap, PER_GAP.max);
      const tries: { fix: RangeFix; protocol: Protocol }[] = [];
      for (let k = m - 1; k >= 1; k--) {
        tries.push({
          fix: { fewer: k },
          protocol: { ...p, interpolation: { ...p.interpolation, points_per_gap: k } },
        });
      }
      if (logOffered && !log_x) {
        tries.push({
          fix: { log: true },
          protocol: { ...p, interpolation: { ...p.interpolation, log_x: true } },
        });
      }
      if (tries.length === 0) return {};
      const protocols = tries.map((t, i) => ({ ...t.protocol, name: `try${i}`, points: measured }));
      const made = await commands.regenerate_dataset({
        before: null,
        after: { name: dataset, protocols },
      });
      const checked = await commands.validate_dataset({ id: null, content: made });
      const works = tries.findIndex((_, i) => inRange(checked.issues, i, made.protocols[i].points));
      return works < 0 ? {} : tries[works].fix;
    },
    enabled: body !== null && canAsk(c),
    staleTime: Infinity,
  });
  if (protocol === null) return null;
  // Without an answer, the fix that always works.
  return q.data ?? (q.isError ? {} : undefined);
}
