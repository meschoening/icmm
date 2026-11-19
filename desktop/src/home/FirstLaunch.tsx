/**
 * First launch (LaptopFirstRun): Home until the platform's first run. Four
 * steps, the first in a card on the left and the rest down the right.
 *
 * Step 1 connects a compute platform. With none it's the connect form; once
 * one is the Active platform it's that platform's card, with the connect's
 * strip, then Platform setup in its foot while the Data folder has no
 * Platform settings, then their summary. Cancel while connecting goes back
 * to the connect form. Edit swaps the card for Settings' own form (#117):
 * setup leaves meanwhile and comes back holding what was typed, and after a
 * failed first connect, saving connects. Each later step unlocks in turn,
 * its button the page's one primary. Step 2 is done once the platform has
 * any dataset, and names the newest; step 3 once it has any config, and
 * names the newest with its starts.
 *
 * Platform setup and the summary end with whether ICMM connects to the
 * platform when it opens: Settings' launch choice, set at once. Each connect
 * from step 1 makes its platform the choice, until the switch is changed.
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { failureOf, usePlatformCommands, usePlatforms, useSetLaunch } from "../settings/commands";
import { editId, headingId } from "../settings/ids";
import { LaunchSwitch } from "../settings/launch";
import { LocalFormCard } from "../settings/LocalFormCard";
import { PlatformCard } from "../settings/PlatformCard";
import { SshFormCard } from "../settings/SshFormCard";
import { FailureBox } from "../setup/FailureBox";
import { PlatformSetup, type Typed } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { type Setup, useSetup } from "../setup/queries";
import { SetupSummary } from "../setup/SetupSummary";
import { type Connection, useConnection } from "../shell/connection";
import { PageHeading } from "../ui/PageHeading";
import type {
  ConfigSummary,
  DatasetSummary,
  PlatformsProblem,
  SavedPlatform,
  SshPlatform,
} from "../wire/types.gen";
import { useConfigs } from "../configs/queries";
import { whole } from "../configs/words";
import { count } from "../datasets/format";
import { useDatasets } from "../datasets/queries";
import { ConnectForm } from "./ConnectForm";
import { ReportFromHere } from "../report/ReportFromHere";

const STEP_1 = "first-launch-1";
const STEP_2 = "first-launch-2";

export function FirstLaunch() {
  const connection = useConnection();
  const list = usePlatforms();
  const setup = useSetup();
  const active =
    connection.status === "none"
      ? undefined
      : list.data?.platforms.find((p) => p.id === connection.platformId);
  const done = setup.kind === "done";
  const datasets = useDatasets();
  const configs = useConfigs();
  // Newest first: each list's first is its newest.
  const newest = done ? datasets.data?.[0] : undefined;
  const newestConfig = done ? configs.data?.[0] : undefined;

  // After Save, focus goes to step 2's heading once it's the current step.
  const toStep2 = useRef(false);
  /** The switch was changed: step 1's connects leave the launch choice from then on. */
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    if (toStep2.current && done) {
      toStep2.current = false;
      document.getElementById(STEP_2)?.focus();
    }
  }, [done]);

  return (
    <div className="page first-launch">
      <div className="page-head">
        <PageHeading>Set up ICMM</PageHeading>
      </div>
      <ReportFromHere name="Set up ICMM" />
      <ol className="fl-steps" aria-label="Setup steps">
        <li className="fl-one" aria-labelledby={STEP_1} aria-current={done ? undefined : "step"}>
          <div className="fl-one-head">
            <StepNumber n={1} done={done} />
            <h2 id={STEP_1}>Connect a compute platform</h2>
            <span className="fl-track" aria-hidden="true" />
          </div>
          {list.data !== undefined && (
            <StepOne
              active={active}
              ssh={list.data.platforms.find((p) => p.type === "ssh")}
              anotherSsh={list.data.platforms.some((p) => p.type === "ssh" && p.id !== active?.id)}
              setup={setup}
              localId={list.data.platforms.find((p) => p.type === "local")?.id ?? ""}
              launch={list.data.launch}
              launchName={
                list.data.platforms.find((p) => p.id === list.data?.launch)?.name ?? undefined
              }
              chosen={chosen}
              problem={list.data.problem}
              onChosen={() => setChosen(true)}
              onSaved={() => (toStep2.current = true)}
            />
          )}
        </li>
        <Later
          stage={!done ? 1 : newest === undefined ? 2 : newestConfig === undefined ? 3 : 4}
          lock={lockOf(setup, active)}
          newest={newest}
          newestConfig={newestConfig}
        />
      </ol>
    </div>
  );
}

function StepNumber({ n, done, current = true }: { n: number; done: boolean; current?: boolean }) {
  if (done) {
    return (
      <span className="num num-done" role="img" aria-label="Done">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.3 5 8.6l4.6-5.2" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </span>
    );
  }
  return (
    <span className={`num mono ${current ? "num-on" : "num-off"}`} aria-hidden="true">
      {n}
    </span>
  );
}

/** What step 2 waits on while step 1 isn't done. */
function lockOf(setup: Setup, active: SavedPlatform | undefined): string {
  if (setup.kind !== "offline" && active !== undefined) {
    return `Opens once ${inSentence(active)} is set up.`;
  }
  return active?.type === "local"
    ? "Opens once you’re connected. Datasets already on this computer will appear then."
    : "Opens once you’re connected. Datasets already on the cluster will appear then.";
}

function StepOne({
  active,
  ssh,
  anotherSsh,
  setup,
  localId,
  launch,
  launchName,
  chosen,
  problem,
  onChosen,
  onSaved,
}: {
  active: SavedPlatform | undefined;
  /** The newest saved SSH platform, for the form when This computer is active. */
  ssh: SshPlatform | undefined;
  /** Whether an SSH platform besides the Active one is saved, to take its place after Remove. */
  anotherSsh: boolean;
  setup: Setup;
  localId: string;
  /** The platform ICMM connects to when it opens. */
  launch: string | null;
  launchName: string | undefined;
  /** Whether the switch was changed. */
  chosen: boolean;
  /** Why the saved platforms couldn't be read, said above the connect form. */
  problem: PlatformsProblem | null;
  onChosen: () => void;
  onSaved: () => void;
}) {
  const connection = useConnection();
  const commands = usePlatformCommands();
  const setLaunch = useSetLaunch();
  /** The card; the connect form after Cancel while connecting; or Settings' form after Edit. */
  const [mode, setMode] = useState<"card" | "connect" | "edit">("card");
  /** What Platform setup had typed, per platform and Data folder, while Edit has the card. */
  const [drafts] = useState(() => new Map<string, Typed>());
  /** Where focus goes once the card is back: Edit, or its heading when Edit isn't shown. */
  const focusTo = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = focusTo.current;
    if (ids === null) return;
    focusTo.current = null;
    ids
      .map((id) => document.getElementById(id))
      .find((el) => el !== null)
      ?.focus();
  });
  /** A Cancel's disconnect, which the form's next action waits for. */
  const [leaving, setLeaving] = useState<Promise<unknown> | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [otherFirst, setOtherFirst] = useState(false);
  /**
   * The platform Remove took away while another SSH platform was saved: the
   * connect form starts afresh once the list names that one instead.
   */
  const [removed, setRemoved] = useState<string>();
  const note = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (otherFirst && setup.kind === "done") note.current?.focus();
  }, [otherFirst, setup.kind]);

  /**
   * A connect from step 1 makes its platform the launch choice, until the
   * switch is changed. Don't connect stays: the desktop sets an unset choice
   * on the first connect itself.
   */
  const follow = (id: string) => {
    if (!chosen && launch !== null && launch !== id) void run(() => setLaunch(id));
  };
  const run = async (action: () => Promise<unknown>) => {
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(failureOf(error).message);
    }
  };

  if (connection.status === "none" || active === undefined || mode === "connect") {
    const platform = active?.type === "ssh" ? active : ssh;
    return (
      <ConnectForm
        key={removed !== undefined && platform?.id !== removed ? `after ${removed}` : ""}
        platform={platform}
        leaving={leaving}
        localId={localId}
        focusFirst={mode === "connect"}
        note={problem !== null && <PlatformsNote problem={problem} />}
        onConnecting={(id) => {
          setMode("card");
          setLeaving(undefined);
          follow(id);
        }}
      />
    );
  }

  const c: Connection = connection;
  if (mode === "edit") {
    const back = (...focus: string[]) => {
      setMode("card");
      focusTo.current = focus;
    };
    // After a failed first connect, connecting is the point: saving connects.
    const connects =
      c.status === "failed"
        ? async () => {
            await commands.retry();
            follow(active.id);
          }
        : undefined;
    const form = {
      connection: c,
      connects,
      onDirty: () => {},
      onCancel: () => back(editId(active.id), headingId(active.id)),
      onSaved: () => back(headingId(active.id)),
    };
    return active.type === "ssh" ? (
      <SshFormCard
        platform={active}
        launch={launch === active.id}
        // Setup comes before any run.
        keepGoing={false}
        // The connect form takes the card's place, with focus in Name.
        onRemoved={() => {
          if (anotherSsh) setRemoved(active.id);
          setMode("connect");
        }}
        {...form}
      />
    ) : (
      <LocalFormCard platform={active} {...form} />
    );
  }

  const live = c.status === "connected" || c.status === "reconnecting";
  const launchRow = (
    <LaunchSwitch
      on={launch === active.id}
      other={launch !== null && launch !== active.id ? launchName : undefined}
      onChange={(on) =>
        void run(async () => {
          await setLaunch(on ? active.id : null);
          onChosen();
        })
      }
    />
  );

  let foot: React.ReactNode = null;
  if (live && setup.kind === "needed") {
    const key = `${active.id} ${active.data_folder}`;
    foot = (
      <PlatformSetup
        platform={active}
        launch={launchRow}
        onSaved={onSaved}
        onConflict={() => setOtherFirst(true)}
        draft={{
          fields: drafts.get(key),
          keep: (fields) => {
            if (fields === undefined) drafts.delete(key);
            else drafts.set(key, fields);
          },
        }}
      />
    );
  } else if (live && setup.kind === "done") {
    foot = (
      <SetupSummary
        platform={active}
        settings={setup.saved.settings}
        otherFirst={otherFirst}
        noteRef={note}
        launch={launchRow}
        keptIn={active.type === "local" ? active.data_folder : undefined}
      />
    );
  } else if (live && setup.kind === "error") {
    foot = (
      <FailureBox
        error={setup.error}
        task="settings"
        platform={active}
        onRetry={setup.retry}
        again={setup.again}
      />
    );
  }

  return (
    <>
      {failure !== undefined && (
        <p className="field-issue" role="alert">
          {failure}
        </p>
      )}
      <PlatformCard
        className="step-card"
        platform={active}
        connection={c}
        primary
        actions={!(setup.kind === "done" && c.status === "connected")}
        onEdit={() => setMode("edit")}
        onConnect={() =>
          void run(async () => {
            await commands.connect(active.id);
            follow(active.id);
          })
        }
        onDisconnect={() => {
          const ending = run(() => commands.disconnect());
          // First launch's Cancel goes back to the connect form, its fields kept.
          if (c.status === "connecting") {
            setLeaving(ending);
            setMode("connect");
          }
        }}
        onRetry={() => void run(() => commands.retry())}
        onUseThisComputer={(id) =>
          void run(async () => {
            await commands.connect(id);
            follow(id);
          })
        }
        // Setup comes before any run.
        keepGoing={false}
      >
        {foot !== null && <div className="card-foot">{foot}</div>}
      </PlatformCard>
    </>
  );
}

/**
 * Why the saved platforms couldn't be read (#117's U05), in three lines:
 * what happened, what connecting here does to the file, and the file and
 * where it broke. A problem that won't move the file aside says only what
 * happened.
 */
function PlatformsNote({ problem }: { problem: PlatformsProblem }) {
  return (
    <div className="fail-box compact" role="alert">
      <div className="fail-say">
        <p className="fail-what">{problem.reason}</p>
        {problem.moves_aside && (
          <p className="fail-next">
            They’re still in that file. Connecting here starts a new list and moves the old file
            aside, so nothing is lost.
          </p>
        )}
        <p className="term fail-raw">{problem.details}</p>
      </div>
    </div>
  );
}

interface LaterStep {
  title: string;
  description: string;
  lock: string;
  button: string;
  to: "/datasets/new" | "/configs/new" | "/runs/submit";
}

const LATER: LaterStep[] = [
  {
    title: "Add a dataset",
    description:
      "Drop in the Excel workbook of your voltage-clamp recordings. Each sheet becomes a protocol: start from a template (G/V activation, inactivation, recovery, decay time, time to peak) or build your own step by step.",
    lock: "",
    button: "New dataset",
    to: "/datasets/new",
  },
  {
    title: "Create a config",
    description:
      "Choose how many kinetic states to try. A new config fits 5 of their topologies, drawn at random, from 100 starts each.",
    lock: "Needs a dataset.",
    button: "New config",
    to: "/configs/new",
  },
  {
    title: "Submit a run",
    description:
      "Each topology’s starts run in parallel; topologies are then ranked by how well they predict the recordings held out for validation.",
    lock: "Needs a config.",
    button: "Submit a run",
    to: "/runs/submit",
  },
];

/**
 * Steps 2 to 4: each locked until the one before it is done, then current
 * with its button. Step 2 done names the newest dataset, and step 3 the
 * newest config.
 */
function Later({
  stage,
  lock,
  newest,
  newestConfig,
}: {
  stage: number;
  lock: string;
  newest: DatasetSummary | undefined;
  newestConfig: ConfigSummary | undefined;
}) {
  return (
    <>
      {LATER.map((s, i) => {
        const n = i + 2;
        const current = n === stage;
        const locked = n > stage;
        const id = n === 2 ? STEP_2 : `first-launch-${n}`;
        return (
          <li
            key={s.title}
            className={`fl-later${current ? " current" : ""}`}
            style={{ gridRow: i + 1 }}
            aria-labelledby={id}
            aria-current={current ? "step" : undefined}
          >
            <div className="fl-rail">
              <StepNumber n={n} done={n < stage} current={current} />
              {i < LATER.length - 1 && <span className="fl-vtrack" aria-hidden="true" />}
            </div>
            <div className="fl-body">
              <div className="fl-text">
                <h2 id={id} tabIndex={-1}>
                  {s.title}
                </h2>
                <p>{s.description}</p>
              </div>
              {locked && (
                <div className="lock">
                  <LockIcon />
                  <span>{n === 2 ? lock : s.lock}</span>
                </div>
              )}
              {current && (
                <div>
                  <Link to={s.to} className="btn btn-primary">
                    {s.button}
                  </Link>
                </div>
              )}
              {n === 2 && n < stage && newest !== undefined && (
                <div className="fl-done">
                  <Link to="/datasets/$id" params={{ id: newest.id }} className="link">
                    {newest.name}
                  </Link>{" "}
                  · {count(newest.protocols.length, "protocol")}
                </div>
              )}
              {n === 3 && n < stage && newestConfig !== undefined && (
                <div className="fl-done">
                  <Link to="/configs" search={{ id: newestConfig.id }} className="link">
                    {newestConfig.name}
                  </Link>
                  {newestConfig.starts !== null && (
                    <>
                      {" "}
                      · {whole(newestConfig.starts)}{" "}
                      {newestConfig.starts === 1 ? "start" : "starts"}
                    </>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="6" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
