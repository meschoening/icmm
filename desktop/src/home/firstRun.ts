/**
 * Whether Home is First launch: the Active platform has had no run, so
 * Results has nothing to show. The desktop records the platform's first run
 * the first time it reads one of its runs (`runs/follow.ts`), so it holds
 * while the platform isn't connected. A computer that hasn't recorded it (a
 * new laptop on a Data folder with runs) asks the runs read (#400): First
 * launch once it finds none, and Home, reading or saying the read failed,
 * until then. A Data folder without Platform settings has no runs.
 *
 * A quick read finding none keeps First launch in place, without a flash of
 * Home: a read still under way shows Home's Reading only from
 * `READ_GRACE_MS`, as a slow action's button shows it's working only from
 * 150 ms. A failed read shows at once.
 *
 * Tests can say otherwise, to reach Home as it is after the first run.
 */
import { useEffect, useState } from "react";
import { useRunMarks, useRunsOverview } from "../runs/queries";
import { useSetup } from "../setup/queries";
import { useConnection } from "../shell/connection";

export const READ_GRACE_MS = 1000;

let pretend = false;

export function pretendFirstRun(done: boolean): void {
  pretend = done;
}

export function useFirstLaunch(): boolean {
  const c = useConnection();
  const marks = useRunMarks(c.status === "none" ? undefined : c.platformId);
  const marked = pretend || marks.data?.first_run === true;
  const overview = useRunsOverview(!marked);
  const setup = useSetup();
  const counts = overview.data?.counts;
  const unknown = !marked && counts === undefined && setup.kind === "done";
  const late = useHeldFor(unknown, READ_GRACE_MS);
  if (marked) return false;
  if (counts !== undefined) {
    return counts.running + counts.canceling + counts.queued + counts.held + counts.ended === 0;
  }
  if (unknown) return !(late || overview.isError);
  return true;
}

/** Whether `on` has held for `ms`. */
function useHeldFor(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  if (!on && late) setLate(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && late;
}
