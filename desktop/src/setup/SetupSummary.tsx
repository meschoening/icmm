/**
 * A platform's Platform settings, summed up. On First launch (LaptopFirstRun's
 * `done`) it's step 1's summary of what every computer that connects shares,
 * with the way to change them; when another computer saved first, it says
 * these are theirs. Settings' card shows the fuller one (LaptopSettings's
 * `connected` and `local`): the Data folder too, what each folder holds, the
 * cluster's limits beside At once, and Advanced.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import type {
  PlatformSettings,
  SavedPlatform,
  SchedulerLookup,
  SlurmJobDefaults,
} from "../wire/types.gen";
import { asSubject, clusterLimits, inSentence, onPlatform } from "./form";
import { useFolderCheck } from "./queries";
import { bytes, memory, upTo } from "./units";
import { useShownPath } from "../ui/paths";

type Platform = Pick<SavedPlatform, "type" | "name">;

export interface SetupSummaryProps {
  platform: Platform;
  settings: PlatformSettings;
  /** Another computer set the platform up while this one was filling in the form. */
  otherFirst?: boolean;
  /** Takes focus after a conflict, so the reason is read first. */
  noteRef?: Ref<HTMLParagraphElement>;
  /** Settings' fuller summary, with the platform's Data folder and its scheduler lookup. */
  full?: { dataFolder: string; lookup: SchedulerLookup | undefined };
  /** First launch's Connect when ICMM opens row, under the summary but not one of its settings. */
  launch?: ReactNode;
  /** This computer keeps its settings in its Data folder, on this computer alone. */
  keptIn?: string;
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function SetupSummary({
  platform,
  settings,
  otherFirst = false,
  noteRef,
  full,
  launch,
  keptIn,
}: SetupSummaryProps) {
  const folder = useFolderCheck(settings.output_folder);
  const shown = useShownPath(platform);
  const free = (which: "data_folder" | "output_folder") => {
    const n = folder.data?.[which].free_bytes;
    return n == null ? undefined : `${bytes(n)} free`;
  };
  /** The facts after a folder, each after a `·`. */
  const after = (...facts: (string | undefined)[]) => {
    const said = facts.filter((f) => f !== undefined);
    return said.length === 0 ? null : <span className="hint"> · {said.join(" · ")}</span>;
  };
  const jobs = settings.job_defaults;
  const rows = (
    <dl className="sum">
      <dt>Scheduler</dt>
      <dd>
        {jobs.type === "slurm" ? "SLURM" : `None · starts run as processes ${onPlatform(platform)}`}
      </dd>
      {full !== undefined && (
        <>
          <dt>Data folder</dt>
          <dd>
            <span className="mono">{shown(full.dataFolder)}</span>
            {after(free("data_folder"), "datasets, configs and run history")}
          </dd>
        </>
      )}
      <dt>Output folder</dt>
      <dd>
        <span className="mono">{shown(settings.output_folder)}</span>
        {full !== undefined
          ? after(free("output_folder"), "each start’s results and logs")
          : after(free("output_folder"))}
      </dd>
      {jobs.type === "slurm" && (
        <>
          <dt>Jobs go to</dt>
          <dd>
            {jobs.account !== null ? (
              <span className="mono">{jobs.account}</span>
            ) : (
              "your default account"
            )}{" "}
            on{" "}
            {jobs.partition !== null ? (
              <span className="mono">{jobs.partition}</span>
            ) : (
              "the cluster’s default partition"
            )}
          </dd>
        </>
      )}
      <dt>Each start</dt>
      <dd>
        {jobs.type === "slurm"
          ? `${plural(jobs.cpus_per_start, "CPU", "CPUs")} · ${memory(jobs.memory_per_start_mb)} memory · up to ${upTo(jobs.time_limit_per_start_min)}`
          : plural(jobs.cpus_per_start, "CPU", "CPUs")}
      </dd>
      <dt>At once</dt>
      <dd>
        up to <span className="n">{jobs.max_running_starts.toLocaleString("en-US")}</span>{" "}
        {jobs.max_running_starts === 1 ? "start" : "starts"}
        {jobs.type === "slurm" ? " per run" : `, shared by all runs ${onPlatform(platform)}`}
        {full !== undefined && (
          <AtOnce platform={platform} settings={settings} lookup={full.lookup} />
        )}
      </dd>
      {full !== undefined && jobs.type === "slurm" && (
        <>
          <dt>Advanced</dt>
          <dd>
            <Advanced jobs={jobs} />
          </dd>
        </>
      )}
    </dl>
  );
  if (full !== undefined) return rows;
  return (
    <>
      <div
        className="setup-summary"
        role="group"
        aria-label={`${asSubject(platform)}’s Platform settings`}
      >
        {otherFirst && (
          <p className="ink" ref={noteRef} tabIndex={-1}>
            Another computer set up {asSubject(platform)} first, so these are its settings.
          </p>
        )}
        {rows}
        <p className="hint">
          {keptIn !== undefined ? (
            <>
              Kept in <span className="mono">{shown(keptIn)}</span> on this computer.
            </>
          ) : (
            "Shared by every computer that connects."
          )}{" "}
          <Link to="/settings" hash="platforms" className="link">
            Change in Settings
          </Link>
        </p>
      </div>
      {launch}
    </>
  );
}

/** What bounds At once: the cluster's per-user limits, or the cores of the computer the starts run on. */
function AtOnce({
  platform,
  settings,
  lookup,
}: {
  platform: Platform;
  settings: PlatformSettings;
  lookup: SchedulerLookup | undefined;
}) {
  const jobs = settings.job_defaults;
  let bound: string | undefined;
  if (jobs.type === "local" && lookup?.local != null) {
    bound = `${inSentence(platform)} has ${plural(lookup.local.cores, "core", "cores")}`;
  } else if (jobs.type === "slurm" && lookup !== undefined && jobs.partition !== null) {
    const limits = clusterLimits(lookup, jobs.partition);
    if (limits !== undefined) bound = `your cluster allows ${limits}`;
  }
  return bound === undefined ? null : <span className="hint"> · {bound}</span>;
}

/** The Advanced row: what's set, in a line. */
function Advanced({ jobs }: { jobs: SlurmJobDefaults }) {
  return (
    <>
      {jobs.excluded_nodes.length === 0 ? (
        "no excluded nodes"
      ) : (
        <>
          excludes <span className="mono">{jobs.excluded_nodes.join(", ")}</span>
        </>
      )}
      {` · coordinating job ${upTo(jobs.run_coordinator_time_limit_min)} · looks every ${jobs.check_for_results_every_s.toLocaleString("en-US")} s · `}
      {jobs.container === null ? (
        "no container"
      ) : (
        <>
          <span className="mono">{jobs.container.runtime}</span> image{" "}
          <span className="mono">{jobs.container.image}</span>
        </>
      )}
    </>
  );
}
