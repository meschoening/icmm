/**
 * The header's connection pill: which platform, and whether it's connected.
 * The glyph carries the state; it links to the platform's section of
 * Settings. Matching the hash keeps it from claiming to be the current page
 * whenever Settings is open.
 */
import { Link } from "@tanstack/react-router";
import { STATUS_LOOK, type ConnectionState } from "./connection";

export function ConnectionPill({ state }: { state: ConnectionState }) {
  const { glyph, words } = STATUS_LOOK[state.status];
  const platform = state.status === "none" ? undefined : state.platform;
  return (
    <Link
      to="/settings"
      hash="platforms"
      activeOptions={{ includeHash: true, includeSearch: false }}
      className="conn"
      data-status={state.status}
      aria-label={
        platform === undefined ? `Compute platform: ${words}` : `Compute platform: ${platform}, ${words}`
      }
    >
      <span className={`g ${glyph}`} />
      {platform === undefined ? (
        <span className="conn-state">Not connected</span>
      ) : (
        <span>
          <span className="conn-name">{platform}</span>{" "}
          <span className="conn-state">· {words}</span>
        </span>
      )}
    </Link>
  );
}
