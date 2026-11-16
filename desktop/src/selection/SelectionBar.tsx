/**
 * The session's selection, floating at the window's bottom (#339, pick 1):
 * "N selected", a chip for each of the first 3 starts with ×, "+N more"
 * opening the list of every start, Clear, New config from these… and
 * Compare (⌘↵). It's one component for Results, a start's page and Compare,
 * each of which shows it wherever the selection holds a start; the room it
 * leaves under the page lets the page's end scroll clear of it.
 *
 * Compare holds 3, and a config fits one dataset and one number of states:
 * past those its button is grayed with the reason (old ADR-0026). Removing
 * a start keeps focus on the bar (old ADR-0028): on the chip after it, else
 * the one before, else Clear; once nothing's left, on the page's heading.
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { isMac, shortcutLabel } from "../platform";
import { useBlocker } from "../ui/blocker";
import { PAGE_HEADING_ATTR } from "../ui/pageChangeFocus";
import {
  COMPARE_HOLDS,
  compareWhy,
  configWhy,
  datasetName,
  pickKey,
  pickName,
  topologyOf,
  useSelection,
  type SelectedStart,
} from "./selection";

/**
 * The Config builder on the picks' dataset, with their topologies as Specific IDs, and each
 * pick's topology in its run, `214/T12.3`, whose top-ranked's run gives the other settings (#343).
 */
function newConfigSearch(picks: readonly SelectedStart[]) {
  const ids = [...new Set(picks.map(topologyOf))].join(", ");
  const inRuns = [...new Set(picks.map((p) => `${p.run}/${topologyOf(p)}`))].join(",");
  return {
    dataset: picks[0].dataset.id,
    states: String(picks[0].num_states),
    ids,
    picks: inRuns,
  };
}

const focusHeading = () => document.querySelector<HTMLElement>(`[${PAGE_HEADING_ATTR}]`)?.focus();

function Remove({ pick, onRemove }: { pick: SelectedStart; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="xb"
      aria-label={`Remove ${pickName(pick)}`}
      data-pick={pickKey(pick)}
      onClick={onRemove}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function SelectionBar({ shown }: { shown?: string }) {
  const sel = useSelection();
  const picks = sel.picks;
  const n = picks.length;
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const compareBlocker = compareWhy(picks);
  const configBlocker = configWhy(picks);
  const compare = useBlocker(compareBlocker);
  const config = useBlocker(configBlocker);
  // After a removal, where focus goes once the bar has drawn the starts left: a pick's ×, else
  // Clear, else the page's heading.
  const focusAfter = useRef<{ key?: string } | null>(null);

  const open = listOpen && n > COMPARE_HOLDS;

  useEffect(() => {
    const after = focusAfter.current;
    if (after === null) return;
    focusAfter.current = null;
    if (picks.length === 0) {
      focusHeading();
      return;
    }
    const at =
      after.key === undefined
        ? undefined
        : bar.current?.querySelector<HTMLElement>(`[data-pick="${CSS.escape(after.key)}"]`);
    (at ?? bar.current?.querySelector<HTMLElement>(".selbar-clear"))?.focus();
  }, [picks]);

  // ⌘↵ (Ctrl ↵ elsewhere) opens Compare, as its button does, but not over a dialog.
  const router = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (n === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(isMac() ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) {
        return;
      }
      if (document.querySelector("[aria-modal=true]")) return;
      e.preventDefault();
      router.current?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [n]);

  // The list closes on Escape, or a press outside the bar, and gives focus back to "+N more".
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setListOpen(false);
      moreButton.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  if (n === 0) return null;

  /** Takes out `pick`; focus goes to the start after it in `among`, else the one before. */
  const remove = (pick: SelectedStart, among: readonly SelectedStart[]) => {
    const i = among.findIndex((p) => pickKey(p) === pickKey(pick));
    const next = among[i + 1] ?? among[i - 1];
    focusAfter.current = { key: next === undefined ? undefined : pickKey(next) };
    sel.remove([pickKey(pick)]);
  };
  const chips = picks.slice(0, COMPARE_HOLDS);

  return (
    <>
      <div className="selbar-room" aria-hidden="true" />
      <div className="selbar" role="region" aria-label="Selection" ref={bar}>
        {open && (
          <div className="slist" id={listId} role="dialog" aria-label="Selected starts">
            <div className="slist-head">
              <span>{n.toLocaleString("en-US")} starts selected</span>
              <span>across this session</span>
            </div>
            <ul>
              {picks.map((p) => (
                <li key={pickKey(p)} className="slist-item">
                  <span className="mono">{pickName(p)}</span>
                  <span className="slist-where">
                    {datasetName(p)} · {p.num_states} states
                  </span>
                  <Remove pick={p} onRemove={() => remove(p, picks)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <span className="seln">{n.toLocaleString("en-US")} selected</span>
        <span className="schips">
          {chips.map((p) => (
            <span key={pickKey(p)} className="schip" title={pickName(p)}>
              <span className="mono">{pickName(p)}</span>
              {shown !== undefined && p.dataset.id !== shown && (
                <span className="sds">{datasetName(p)}</span>
              )}
              <Remove pick={p} onRemove={() => remove(p, chips)} />
            </span>
          ))}
          {n > COMPARE_HOLDS && (
            <button
              ref={moreButton}
              type="button"
              className="btn-text moreb"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              onClick={() => setListOpen(!open)}
            >
              +{(n - COMPARE_HOLDS).toLocaleString("en-US")} more
            </button>
          )}
        </span>
        <button
          type="button"
          className="btn-text selbar-clear"
          onClick={() => {
            focusAfter.current = {};
            sel.clear();
          }}
        >
          Clear
        </button>
        <Link
          to="/configs/new"
          search={newConfigSearch(picks)}
          className="btn"
          disabled={configBlocker !== undefined}
          tabIndex={configBlocker !== undefined ? 0 : undefined}
          {...config.props}
        >
          New config from these…
        </Link>
        {config.bubble}
        <Link
          ref={router}
          to="/results/compare"
          className="btn btn-primary"
          disabled={compareBlocker !== undefined}
          tabIndex={compareBlocker !== undefined ? 0 : undefined}
          aria-keyshortcuts={isMac() ? "Meta+Enter" : "Control+Enter"}
          {...compare.props}
        >
          Compare <span className="kbd kbd-inv">{shortcutLabel("↵")}</span>
        </Link>
        {compare.bubble}
      </div>
    </>
  );
}
