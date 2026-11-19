/**
 * The platform ICMM connects to when it opens, kept on this computer
 * (LaptopSettings, LaptopFirstRun). Settings sets it with the When ICMM opens
 * menu beside Add compute platform; First launch with a switch row that sets
 * the same choice for the platform in step 1. Either applies at once, with no
 * Save. The launch platform's card carries the auto-connects tag.
 */
import { useId } from "react";
import type { SavedPlatform } from "../wire/types.gen";

/** The tag beside the launch platform's name. */
export function LaunchTag() {
  return (
    <span className="lmark" title="ICMM connects to it when it opens">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M3.6 3.4a3.9 3.9 0 1 0 4.8 0"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path d="M6 1.3v4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      auto-connects
    </span>
  );
}

const DONT_CONNECT = "";
const UNSET = "unset";

/** Settings' When ICMM opens menu: Connect to each saved platform, or Don't connect. */
export function LaunchMenu({
  platforms,
  launch,
  launchSet,
  onChange,
}: {
  platforms: SavedPlatform[];
  launch: string | null;
  launchSet: boolean;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  return (
    <div className="launch">
      <label htmlFor={id}>When ICMM opens</label>
      <select
        id={id}
        className="input input-sm"
        value={launchSet ? (launch ?? DONT_CONNECT) : UNSET}
        onChange={(e) => onChange(e.target.value === DONT_CONNECT ? null : e.target.value)}
      >
        {!launchSet && (
          <option value={UNSET} disabled>
            Choose a platform…
          </option>
        )}
        {platforms.map((p) => (
          <option key={p.id} value={p.id}>
            Connect to {p.name}
          </option>
        ))}
        <option value={DONT_CONNECT}>Don’t connect</option>
      </select>
    </div>
  );
}

/**
 * First launch's row: whether ICMM connects to this platform when it opens.
 * Off, it says where ICMM connects instead, if Settings chose another.
 */
export function LaunchSwitch({
  on,
  other,
  onChange,
}: {
  on: boolean;
  /** The launch platform's name when it's another platform. */
  other?: string;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const hint = on
    ? "this device only"
    : other !== undefined
      ? `ICMM connects to ${other} instead`
      : "ICMM opens without connecting";
  return (
    <div className="lsw">
      <div>
        <label htmlFor={id} className="flabel">
          Connect when ICMM opens
        </label>
        <span className="hint" aria-hidden="true">
          {" · "}
        </span>
        <span id={`${id}-d`} className="hint">
          {hint}
        </span>
      </div>
      <label className="switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-d`}
        />
        <span className="trk" aria-hidden="true" />
      </label>
    </div>
  );
}
