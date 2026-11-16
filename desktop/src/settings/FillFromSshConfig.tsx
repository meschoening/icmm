/**
 * "Fill in from `~/.ssh/config`" (LaptopPlatformForm, LaptopFirstRun): the
 * hosts `ssh` already knows. Choosing one fills the form as `ssh -G` reads
 * it, jump hosts included, and the hint says where it came from and what it
 * goes through. The platform keeps those values, not the alias (Max,
 * 2026-10-01). With no hosts in `~/.ssh/config`, the row isn't there.
 */
import { useRef, useState } from "react";
import type { JumpHost, SshConfigHost } from "../wire/types.gen";
import { failureOf, usePlatformCommands, useSshConfigHosts } from "./commands";

export interface FillFromSshConfigProps {
  /** The select's id. */
  id: string;
  /** The host the form was filled in from, if any. */
  filledFrom: string | undefined;
  /** The jump hosts the form sends now: none once the Login host or port changes. */
  jump: JumpHost[];
  onFill: (alias: string, host: SshConfigHost) => void;
  /** Settings puts the hint beside the menu; First launch, under it. */
  layout: "beside" | "under";
}

export function FillFromSshConfig({
  id,
  filledFrom,
  jump,
  onFill,
  layout,
}: FillFromSshConfigProps) {
  const hosts = useSshConfigHosts().data?.hosts ?? [];
  const commands = usePlatformCommands();
  const [chosen, setChosen] = useState("");
  const [issue, setIssue] = useState<string>();
  /** The latest pick: an answer to an earlier one, which `ssh -G` can make slow, is dropped. */
  const latest = useRef("");
  if (hosts.length === 0) return null;

  const pick = async (alias: string) => {
    latest.current = alias;
    setChosen(alias);
    setIssue(undefined);
    if (alias === "") return;
    try {
      const host = await commands.sshConfigHost(alias);
      if (latest.current === alias) onFill(alias, host);
    } catch (error) {
      if (latest.current !== alias) return;
      const failed = failureOf(error, (path) => (path[0] === "alias" ? "alias" : undefined));
      setIssue(failed.fields.alias ?? failed.message);
    }
  };

  const hint =
    filledFrom === undefined ? null : (
      <p className={layout === "beside" ? "hint beside-field" : "hint"} id={`${id}-hint`}>
        Filled in from <span className="mono">Host {filledFrom}</span>.
        {jump.length > 0 && (
          <>
            {" "}
            It connects through <Route jump={jump} /> first, as <span className="mono">ssh</span>{" "}
            would.
          </>
        )}
      </p>
    );

  return (
    <>
      <div className={layout === "beside" ? "fill-row" : "fill-row under"}>
        <div className="field">
          <label htmlFor={id} className="flabel">
            Fill in from <span className="flabel-mono">~/.ssh/config</span>
          </label>
          <select
            id={id}
            className={chosen === "" ? "input placeholder" : "input mono"}
            value={chosen}
            aria-invalid={issue !== undefined ? true : undefined}
            aria-describedby={
              issue !== undefined
                ? `${id}-issue`
                : filledFrom !== undefined
                  ? `${id}-hint`
                  : undefined
            }
            onChange={(e) => void pick(e.target.value)}
          >
            <option value="">Choose a host you already ssh into…</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          {issue !== undefined && (
            <span className="field-issue" id={`${id}-issue`}>
              {issue}
            </span>
          )}
        </div>
        {hint}
      </div>
      <div className="or" aria-hidden="true">
        or enter the details
      </div>
    </>
  );
}

/** The jump hosts in order: "a", or "a, then b". */
export function Route({ jump }: { jump: JumpHost[] }) {
  return (
    <>
      {jump.map((j, i) => (
        <span key={`${i}-${j.host}`}>
          {i > 0 && ", then "}
          <span className="mono">{j.host}</span>
        </span>
      ))}
    </>
  );
}
