/**
 * The app's header bar: brand, the five sections, search (the command
 * palette, also ⌘K, which while blocked shows its reason as a press does),
 * the connection pill and Settings. Sections that need a
 * connection are blocked, with the reason, until there is one, and while its
 * Data folder isn't set up. Results waits for the first run. Once a session's
 * connection with its Data folder set up goes, they stay open: each page
 * shows what it read, as of when it went (LaptopHomeOffline's `kept`, #388).
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useFirstLaunch } from "../home/firstRun";
import { isMac, shortcutLabel } from "../platform";
import { usePlatforms } from "../settings/commands";
import { inSentence } from "../setup/form";
import { usePlatformSettings, useSetup } from "../setup/queries";
import { useBlocker } from "../ui/blocker";
import { connectionBlocker, heardAtOf, useConnection } from "./connection";
import { ConnectionPill } from "./ConnectionPill";
import { LogoMark, SearchIcon, SettingsIcon } from "./icons";

/**
 * The current section's look. The query doesn't count toward "current": it
 * filters a page, it doesn't leave it.
 */
const CURRENT = { className: "on" };

function Section({
  to,
  label,
  blocker,
}: {
  to: "/datasets" | "/configs" | "/runs" | "/results";
  label: string;
  blocker: string | undefined;
}) {
  const b = useBlocker(blocker);
  const blocked = blocker !== undefined;
  return (
    <>
      {/* Disabled, the router drops `href` and keeps marking it current. */}
      <Link
        to={to}
        disabled={blocked}
        tabIndex={blocked ? 0 : undefined}
        activeOptions={{ includeSearch: false }}
        activeProps={CURRENT}
        {...b.props}
      >
        {label}
      </Link>
      {b.bubble}
    </>
  );
}

/** Search, and ⌘K (Ctrl K elsewhere) from anywhere: the command palette, once it can open. */
function Search({ blocker, onOpen }: { blocker: string | undefined; onOpen: () => void }) {
  const b = useBlocker(blocker);
  const button = useRef<HTMLButtonElement>(null);
  const explain = b.explain;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(isMac() ? e.metaKey : e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      // Not over another dialog.
      if (document.querySelector("[aria-modal=true]")) return;
      // Blocked, it says why under Search, as a press does (KF07).
      if (blocker !== undefined) {
        if (button.current !== null) explain(button.current);
      } else onOpen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [blocker, onOpen, explain]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="search"
        aria-haspopup="dialog"
        {...b.props}
        onClick={(e) => {
          b.props.onClick(e);
          if (blocker === undefined) onOpen();
        }}
      >
        <SearchIcon />
        <span className="search-text">Search or jump to…</span>
        <span className="kbd">{shortcutLabel("K")}</span>
      </button>
      {b.bubble}
    </>
  );
}

export function Header({ onSearch }: { onSearch: () => void }) {
  const connection = useConnection();
  const setup = useSetup();
  const settings = usePlatformSettings();
  const platforms = usePlatforms();
  // The connection went this session with the Data folder set up: its pages keep what they read.
  const kept = heardAtOf(connection) !== null && settings.data?.saved != null;
  const active =
    connection.status === "none"
      ? undefined
      : platforms.data?.platforms.find((p) => p.id === connection.platformId);
  const blocker = kept
    ? undefined
    : (connectionBlocker(connection) ??
      (setup.kind !== "done" && connection.status !== "none"
        ? `Opens once ${active !== undefined ? inSentence(active) : connection.platform} is set up`
        : undefined));
  const results = useFirstLaunch() ? "Opens once you submit a run" : blocker;
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="ICMM home">
        <LogoMark />
        <span className="brand-name">icmm</span>
      </Link>
      <nav className="nav" aria-label="Main">
        <Link to="/" activeOptions={{ exact: true, includeSearch: false }} activeProps={CURRENT}>
          Home
        </Link>
        <Section to="/datasets" label="Datasets" blocker={blocker} />
        <Section to="/configs" label="Configs" blocker={blocker} />
        <Section to="/runs" label="Runs" blocker={blocker} />
        <Section to="/results" label="Results" blocker={results} />
      </nav>
      <div className="header-gap" />
      <Search blocker={blocker} onOpen={onSearch} />
      <ConnectionPill state={connection} />
      <Link
        to="/settings"
        className="icon-btn settings"
        aria-label="Settings"
        activeOptions={{ includeSearch: false }}
        activeProps={CURRENT}
      >
        <SettingsIcon />
      </Link>
    </header>
  );
}
