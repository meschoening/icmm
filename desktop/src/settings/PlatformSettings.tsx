/**
 * The Active platform's Platform settings, in the foot of its Settings card
 * (LaptopSettings): a summary with Change settings, which opens Platform
 * setup's form in place. Not connected, the foot says when they show; a Data
 * folder with none yet gets Platform setup. The change feed keeps the summary
 * current, and tells an open form when another computer saves.
 */
import type { Connection } from "../shell/connection";
import { FailureBox } from "../setup/FailureBox";
import { LookupState, PlatformSetup, Reading, SetupForm } from "../setup/PlatformSetup";
import { SetupSummary } from "../setup/SetupSummary";
import { inSentence } from "../setup/form";
import { useSchedulerLookup, useSetup } from "../setup/queries";
import type { SavedPlatform } from "../wire/types.gen";
import { changeSettingsId } from "./ids";
import { useShownPath } from "../ui/paths";

export interface PlatformSettingsProps {
  platform: SavedPlatform;
  connection: Connection;
  /** Whether the form is open: the page keeps one form open at a time. */
  editing: boolean;
  /** Initial setup shares the page's one open form. */
  setupAllowed: boolean;
  onChange: () => void;
  /** The form closed: saved, or canceled. */
  onClose: () => void;
  /** Platform setup, shown at once on a Data folder without settings, saved them. */
  onSetUp: () => void;
  onSetupDirty: (changes: number) => void;
  onDirty: (changes: number) => void;
  onWaiting: (waiting: boolean) => void;
}

export function PlatformSettings(props: PlatformSettingsProps) {
  const { platform: p, connection } = props;
  const live = connection.status === "connected" || connection.status === "reconnecting";
  if (connection.status === "not_connected") return <ShowOnceConnected platform={p} />;
  return live ? <Live {...props} /> : null;
}

/** Not connected, or reconnecting before they were ever read: when they show. */
function ShowOnceConnected({ platform: p }: { platform: SavedPlatform }) {
  return (
    <div className="strip">
      <span className="strip-line">
        {p.name} keeps its Platform settings in its Data folder, so they show here once it’s
        connected.
      </span>
    </div>
  );
}

function Live({
  platform: p,
  connection,
  editing,
  setupAllowed,
  onChange,
  onClose,
  onSetUp,
  onSetupDirty,
  onDirty,
  onWaiting,
}: PlatformSettingsProps) {
  const setup = useSetup();
  const lookup = useSchedulerLookup(true);
  const local = p.type === "local";
  const shown = useShownPath(p);

  if (setup.kind === "needed") {
    if (!setupAllowed) return null;
    return (
      <div className="card-foot">
        <PlatformSetup
          platform={p}
          onSaved={onSetUp}
          onConflict={onSetUp}
          tracking={{ onDirty: onSetupDirty, onWaiting }}
          inSettings
        />
      </div>
    );
  }
  if (setup.kind === "error") {
    return (
      <div className="card-foot">
        <FailureBox
          error={setup.error}
          task="settings"
          platform={p}
          onRetry={setup.retry}
          again={setup.again}
        />
      </div>
    );
  }
  if (setup.kind !== "done" && connection.status !== "connected") {
    return <ShowOnceConnected platform={p} />;
  }
  if (setup.kind !== "done") {
    return (
      <div className="card-foot">
        <Reading>Reading {inSentence(p)}’s Platform settings…</Reading>
      </div>
    );
  }

  const shared = local ? (
    <>
      Kept in <span className="mono">{shown(p.data_folder)}</span> on this computer.
    </>
  ) : (
    <>Shared by every computer that connects to {p.name}.</>
  );
  const headingId = `${p.id}-settings-h`;

  if (!editing) {
    return (
      <section className="card-foot settings-foot" aria-labelledby={headingId}>
        <div className="settings-head">
          <div className="settings-title">
            <h4 id={headingId}>Platform settings</h4>
            <p className="hint">{shared}</p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            id={changeSettingsId(p.id)}
            onClick={onChange}
          >
            Change settings
          </button>
        </div>
        <SetupSummary
          platform={p}
          settings={setup.saved.settings}
          full={{ dataFolder: p.data_folder, lookup: lookup.data }}
        />
      </section>
    );
  }

  const head = (
    <div className="settings-title">
      <h4 id={headingId}>Platform settings</h4>
      <p className="hint">
        {shared} Changes reach runs in flight too, and each run keeps its Output folder.
      </p>
    </div>
  );
  return (
    <div className="card-foot settings-foot">
      {lookup.data !== undefined ? (
        <SetupForm
          headingId={headingId}
          head={head}
          lookup={lookup.data}
          platform={p}
          saveLabel="Save settings"
          onSaved={onClose}
          edit={{
            // The form keeps the settings it opened on; `latest` moves with the feed.
            saved: setup.saved,
            latest: setup.saved,
            onCancel: onClose,
            onDirty,
            onWaiting,
          }}
        />
      ) : (
        <>
          {head}
          <LookupState lookup={lookup} platform={p} onCancel={onClose} />
        </>
      )}
    </div>
  );
}
