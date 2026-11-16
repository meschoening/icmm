/** Export's file names (#344). */

/** A file's name, kept to what any OS takes in one: `herg-wt-214-T12.3-start-71`. */
export function fileStem(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim() || "export";
}

/** A day as a file's name gives it, on this computer's calendar: `2026-07-21`. */
function isoDay(iso: string): string {
  const d = new Date(Date.parse(iso));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * The leaderboard's file: `herg-wt-leaderboard.csv`, and for earlier data,
 * the days it was current, as the Data menu names it (RF14, #368):
 * `herg-wt-2026-07-21-to-2026-08-04-leaderboard.csv`, or one day alone.
 */
export function leaderboardName(
  dataset: string,
  group: { current_from: string; current_until: string | null } | undefined,
): string {
  if (group === undefined || group.current_until === null) {
    return `${fileStem(dataset)}-leaderboard.csv`;
  }
  const [from, until] = [isoDay(group.current_from), isoDay(group.current_until)];
  return `${fileStem(dataset)}-${from === until ? from : `${from}-to-${until}`}-leaderboard.csv`;
}
