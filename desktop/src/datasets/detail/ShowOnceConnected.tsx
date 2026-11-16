import type { ReactNode } from "react";
import { usePressed } from "../../connection/pressed";
import { usePlatformCommands } from "../../settings/commands";
import { useConnection } from "../../shell/connection";
import { grayProps } from "../../ui/gray";
import type { SavedPlatform } from "../../wire/types.gen";

/**
 * What an open Datasets, Configs, run or Results page shows in place of its
 * data while the Active platform isn't connected: "McKelvey HPC keeps its
 * datasets in its Data folder, so they show here once it's connected.", with
 * Connect beside it (#358, RF15). `children` names what it keeps; `one` makes
 * the sentence singular. With no platform, `kind` names what shows once
 * there's one, and there's nothing to connect.
 *
 * Connect has no working state: its progress shows in the connection. From
 * the press it's gray in its own words until the connection's next state
 * (`connection/pressed.ts`), and while that connect goes on, as the pill says
 * "connecting…".
 */
export function ShowOnceConnected({
  platform,
  one = false,
  kind = "Datasets",
  children,
}: {
  platform: Pick<SavedPlatform, "name"> | undefined;
  one?: boolean;
  kind?: "Datasets" | "Configs" | "Runs" | "Results";
  children: ReactNode;
}) {
  if (platform === undefined) {
    return (
      <p className="ds-offline">{kind} show here once you’re connected to a compute platform.</p>
    );
  }
  return (
    <div className="ds-offline offline-note">
      <p>
        {platform.name} keeps {children} in its Data folder, so {one ? "it shows" : "they show"}{" "}
        here once it’s connected.
      </p>
      <Connect />
    </div>
  );
}

function Connect() {
  const c = useConnection();
  const commands = usePlatformCommands();
  const id = c.status === "none" ? undefined : c.platformId;
  const pressed = usePressed({ button: "connect", platformId: id ?? "" });
  if (id === undefined) return null;
  const gray = pressed || c.status === "connecting";
  return (
    <button
      type="button"
      className="btn btn-sm"
      {...grayProps(gray)}
      onClick={() => {
        if (!gray) void commands.connect(id).catch(() => {});
      }}
    >
      Connect
    </button>
  );
}
