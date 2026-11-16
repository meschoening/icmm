/**
 * Submit run's config picker (LaptopSubmitRun's `picker`): a popover under
 * the card's head with a search and a radio row for each config on the
 * platform. Opening focuses the search; Escape or a click outside closes it;
 * so does tabbing out of it. A click on a row picks it; the arrow keys move
 * between rows without picking, and Enter or Space picks the row the focus is on.
 * From the search, ↓ goes to the rows it matches, at the one chosen or the
 * first, and ↑ at the one chosen or the last (#326).
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type RefObject } from "react";
import { rowFacts } from "../configs/words";
import type { ConfigSummary } from "../wire/types.gen";
import { RunStatus } from "./RunStatus";

/** The popover's id: Change… controls it. */
export const PICKER_ID = "cfg-picker";

/** Whether `text` holds the search, ignoring case. */
const holds = (text: string, search: string) => text.toLowerCase().includes(search);

/** A row's second line: its dataset and facts, or that a newer ICMM saved it. */
function Spec({ config: c }: { config: ConfigSummary }) {
  if (c.unreadable !== null) {
    return (
      <>
        <span className="g g-failed" aria-hidden="true" />
        saved by a newer ICMM
      </>
    );
  }
  const dataset = `${c.dataset.name ?? c.dataset.id}${c.dataset.deleted ? " deleted" : ""}`;
  return <>{[dataset, ...rowFacts(c)].join(" · ")}</>;
}

export function Picker({
  configs,
  chosen,
  platform,
  now,
  onPick,
  onClose,
  change,
}: {
  configs: ConfigSummary[];
  /** The config the page is on. */
  chosen: string | undefined;
  platform: { name: string };
  now: number;
  onPick: (id: string) => void;
  /** Closes it; `refocus` puts focus back on Change…. */
  onClose: (refocus: boolean) => void;
  /** Change…, which toggles the picker itself. */
  change: RefObject<HTMLButtonElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  // The row the radios show; moving between rows doesn't pick.
  const [lit, setLit] = useState(chosen);
  const q = search.trim().toLowerCase();
  const matching =
    q === "" ? configs : configs.filter((c) => holds(c.name, q) || holds(c.dataset.name ?? "", q));

  useEffect(() => field.current?.focus(), []);
  /** From the search into the rows it matches: the one lit, or the first (↓) or last (↑). */
  const intoRows = (key: string) => {
    if (matching.length === 0) return false;
    const to =
      matching.find((c) => c.id === lit) ?? (key === "ArrowDown" ? matching[0] : matching.at(-1)!);
    setLit(to.id);
    const radios = box.current?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [];
    [...radios].find((r) => r.value === to.id)?.focus();
    return true;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose(true);
    };
    // A click that lands on nothing leaves focus nowhere, so it goes back to Change….
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (box.current?.contains(target) || change.current?.contains(target)) return;
      onClose(document.activeElement === null || document.activeElement === document.body);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [onClose, change]);

  return (
    <div
      id={PICKER_ID}
      ref={box}
      className="sub-picker"
      onBlur={(e) => {
        // Focus moving on to something else closes it; a click on nothing (null) doesn't.
        const to = e.relatedTarget as Node | null;
        if (to !== null && !e.currentTarget.contains(to) && to !== change.current) onClose(false);
      }}
    >
      <div className="sub-picker-top">
        <div className="sub-search">
          <label htmlFor="cfg-search" className="sr-only">
            Search configs
          </label>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            id="cfg-search"
            ref={field}
            className="input"
            type="search"
            placeholder={`Search configs on ${platform.name}`}
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              if (intoRows(e.key)) e.preventDefault();
            }}
          />
        </div>
        <Link to="/configs/new" className="link sub-create">
          Create new
        </Link>
      </div>
      <fieldset className="sub-choices">
        <legend className="sr-only">Choose a config</legend>
        {matching.length === 0 ? (
          <p className="sub-none">No configs match “{search.trim()}”.</p>
        ) : (
          <div className="sub-items">
            {matching.map((c) => (
              <label
                key={c.id}
                className={`sub-item${c.id === lit ? " sel" : ""}`}
                // A pointer's click picks; the click a key makes on a radio (no detail) doesn't.
                onClick={(e) => {
                  if (e.detail > 0) onPick(c.id);
                }}
              >
                <input
                  type="radio"
                  name="sub-config"
                  value={c.id}
                  checked={c.id === lit}
                  onChange={() => setLit(c.id)}
                  onKeyDown={(e) => {
                    if ((e.key !== "Enter" && e.key !== " ") || e.ctrlKey || e.metaKey) return;
                    e.preventDefault();
                    onPick(c.id);
                  }}
                />
                <span className="sub-item-text">
                  <span className="mono sub-item-name">{c.name}</span>
                  <span className="sub-item-spec">
                    <Spec config={c} />
                  </span>
                </span>
                <RunStatus run={c.latest_run} now={now} />
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
