/**
 * What the desktop follows of the Active platform's runs, whatever page is
 * open (#229, #236): a notification when a run ends, and the platform's first
 * run.
 *
 * - **Run-ended notifications** (LaptopRunNotifications). While connected,
 *   each `runs` change asks `ended_runs` what ended since the change last
 *   seen, and each completed or failed run notifies as its row on Runs says
 *   it. On connecting, the runs that ended while ICMM was away (closed,
 *   disconnected, or on another platform) notify together, or one alone as
 *   usual, with when it ended. A cancel never notifies. The desktop keeps the
 *   change last seen per platform (`mark_runs`), so a restart picks up where
 *   it left off; a platform seen for the first time, or whose runs database
 *   was swapped, starts from its latest change, with nothing to say. The
 *   desktop shows a notification only while Notifications is on.
 * - **The first run.** Once any run is read on a platform, the desktop
 *   records that it has had one, so First launch gives way to Home, and
 *   Results opens, while it isn't connected.
 *
 * Checks run one at a time, each from where the one before saw to, so a
 * change and a connect at once notify a run once.
 */
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { inApp } from "../ipc";
import { getConnection, watchConnection } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type {
  Changes,
  EndedRun,
  FeedPosition,
  JobDefaults,
  RunsOverview,
  RunSummary,
  SavedPlatform,
  WireError,
} from "../wire/types.gen";
import { runMarksKey } from "./queries";
import { awayNotice, endedNotice, type Notice } from "./words";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** Where a platform no change has been seen on starts: no feed, so `ended_runs` resets. */
const NOWHERE: FeedPosition = { feed: "", seq: 0 };

/** The most runs that notify one by one while connected; past them, one notification counts them. */
const ONE_BY_ONE = 3;

/** What a check asks of the platform and the desktop: the app's commands, or a test's. */
export interface Asks {
  endedRuns: (after: FeedPosition) => Promise<{
    runs: EndedRun[];
    count: number;
    reset: boolean;
    latest: FeedPosition;
  }>;
  readRun: (id: number) => Promise<RunSummary>;
  overview: () => Promise<RunsOverview>;
  jobDefaults: () => Promise<JobDefaults | undefined>;
  marks: (platform: string) => Promise<{ first_run: boolean; ended_seen: FeedPosition | null }>;
  mark: (platform: string, first_run: boolean, seen: FeedPosition | null) => Promise<void>;
  notify: (n: Notice) => Promise<void>;
  now: () => number;
}

const APP: Asks = {
  endedRuns: (after) => commands.ended_runs({ after }),
  readRun: (id) => commands.read_run({ id }),
  overview: commands.runs_overview,
  jobDefaults: async () => (await commands.platform_settings()).saved?.settings.job_defaults,
  marks: (platform_id) => commands.run_marks({ platform_id }),
  mark: (platform_id, first_run, ended_seen) =>
    commands.mark_runs({ platform_id, first_run, ended_seen }),
  notify: (n) => commands.show_notification(n),
  now: () => Date.now(),
};

/**
 * The runs of one platform, followed while it's connected: `check` after
 * each connect (`away`) and each `runs` change. One follower per connection
 * session; checks queue behind each other.
 */
export class RunsFollower {
  private seen: FeedPosition | null | undefined;
  private firstRun: boolean | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly platformId: string;
  /** How notifications name it; the connection's name until the saved platform is read. */
  platform: Platform;
  /** Whether a run's notification names its platform: not until the saved ones are read. */
  private named = false;
  private readonly asks: Asks;
  /** Called once it records the platform's first run. */
  private readonly onMarked: () => void;

  constructor(platformId: string, platform: Platform, asks: Asks = APP, onMarked = () => {}) {
    this.platformId = platformId;
    this.platform = platform;
    this.asks = asks;
    this.onMarked = onMarked;
  }

  /**
   * What the saved platforms tell it: how notifications name this one, and
   * whether they name it at all, once a platform besides This computer is
   * saved (#323).
   */
  saved(platforms: SavedPlatform[]): void {
    const found = platforms.find((p) => p.id === this.platformId);
    if (found !== undefined) this.platform = found;
    this.named = platforms.some((p) => p.type !== "local");
  }

  /** Stops it: a check under way sends nothing more. */
  stop(): void {
    this.stopped = true;
  }

  /** Queues a check: `away` for one on connecting. Resolves once it's done, whatever happened. */
  check(away: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.run(away)).catch(() => undefined);
    return this.queue;
  }

  private async run(away: boolean): Promise<void> {
    if (this.stopped) return;
    if (this.seen === undefined || this.firstRun === undefined) {
      const marks = await this.asks.marks(this.platformId);
      this.seen = marks.ended_seen;
      this.firstRun = marks.first_run;
    }
    const known = this.seen;
    const ended = await this.asks.endedRuns(known ?? NOWHERE);
    if (this.stopped) return;
    let ranBefore = false;
    if (!this.firstRun) ranBefore = ended.runs.length > 0 || (await this.anyRun());
    if (known !== null && !ended.reset) await this.notify(ended, away);
    if (this.stopped) return;
    const first = ranBefore && !this.firstRun;
    await this.asks.mark(this.platformId, first, ended.latest);
    this.seen = ended.latest;
    if (first) {
      this.firstRun = true;
      this.onMarked();
    }
  }

  /** Whether the platform has any run, in flight or ended. */
  private async anyRun(): Promise<boolean> {
    const { counts } = await this.asks.overview();
    return counts.running + counts.canceling + counts.queued + counts.held + counts.ended > 0;
  }

  private async notify(ended: { runs: EndedRun[]; count: number }, away: boolean): Promise<void> {
    // A cancel never notifies: the user asked for it, here or on the cluster.
    const canceled = ended.runs.filter((r) => r.state === "canceled").length;
    const runs = ended.runs.filter((r) => r.state !== "canceled");
    const count = ended.count - canceled;
    if (count <= 0 || runs.length === 0) return;
    const now = this.asks.now();
    if (count > 1 && (away || count > ONE_BY_ONE)) {
      const notice = awayNotice(runs, count, { platform: this.platform, now });
      await this.asks.notify(
        away
          ? notice
          : {
              ...notice,
              title: notice.title.replace(/ while ICMM was away$/, ""),
            },
      );
      return;
    }
    const [overview, job] = await Promise.all([this.asks.overview(), this.asks.jobDefaults()]);
    const datasets = new Map(overview.datasets.map((d) => [d.id, d]));
    // Each is read before any notifies: a read that fails (a timeout, a lost
    // connection) fails the check, so it doesn't move on past them, and the
    // next check notifies them all once.
    const read: RunSummary[] = [];
    // The earliest first, as they ended.
    for (const e of [...runs].reverse()) {
      if (this.stopped) return;
      const run = await Promise.resolve()
        .then(() => this.asks.readRun(e.id))
        .catch((error: unknown) => {
          // A run deleted since it ended has nothing to say.
          if ((error as Partial<WireError> | undefined)?.code === "not_found") return undefined;
          throw error;
        });
      if (run !== undefined) read.push(run);
    }
    for (const run of read) {
      if (this.stopped) return;
      if (run.state === "canceled" || run.ended_at === null) continue;
      await this.asks.notify(
        endedNotice(run, {
          platform: this.platform,
          named: this.named,
          dataset: datasets.get(run.dataset.id),
          account: job?.type === "slurm" ? job.account : null,
          partition: job?.type === "slurm" ? job.partition : null,
          away: away ? 1 : undefined,
          now,
        }),
      );
    }
  }
}

/**
 * Follows the Active platform's runs from the shell, whatever page is open:
 * a follower for each connection to it, checking on connecting and on each
 * `runs` change.
 */
export function useRunsFollowed(): void {
  const queries = useQueryClient();
  useEffect(() => {
    // Outside the app (plain `npm run dev`, tests without the IPC mock) there's no platform.
    if (!inApp()) return;
    let follower: RunsFollower | undefined;
    const onConnection = () => {
      const c = getConnection();
      if (c.status !== "connected") {
        // Reconnecting keeps the follower: its feed comes back as it was.
        if (c.status !== "reconnecting") {
          follower?.stop();
          follower = undefined;
        }
        return;
      }
      if (follower?.platformId === c.platformId) return;
      follower?.stop();
      const platformId = c.platformId;
      const made = new RunsFollower(
        platformId,
        { type: "ssh", name: c.platform },
        APP,
        () => void queries.invalidateQueries({ queryKey: runMarksKey(platformId) }),
      );
      follower = made;
      // The saved platforms say whether it's This computer, which notifications name so, and
      // whether there's another to tell it from.
      void commands
        .platforms()
        .then((saved) => made.saved(saved.platforms))
        .catch(() => undefined)
        .then(() => made.check(true));
    };
    onConnection();
    const unwatch = watchConnection(onConnection);
    const stop = listen<Changes>("agent_changes", (e) => {
      if (getConnection().status !== "connected") return;
      if (e.payload.changes.some((c) => c.topic === "runs")) void follower?.check(false);
    }).catch(() => undefined);
    return () => {
      unwatch();
      follower?.stop();
      // A test's IPC mock may be gone by the time the shell unmounts.
      void stop.then((unlisten) => unlisten?.()).catch(() => {});
    };
  }, [queries]);
}
