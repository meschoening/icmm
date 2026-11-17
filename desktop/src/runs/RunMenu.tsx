/**
 * A run's ··· menu (LaptopRunDetail's `menu`): Copy run path and Export its
 * config… (#344), then Report a problem… (#470), then Cancel run… while it's
 * queued, held or running, or Delete run… once it has ended. Export its config… is gray, with why, for a
 * run a newer ICMM submitted. Not connected, or while the run is canceling or resuming, the write
 * is gray and the menu says why. It opens under its button with focus on
 * the first item; the arrow keys, Home and End move between items, Escape
 * closes it and puts focus back on the button, and Tab or a press outside
 * closes it.
 */
import { useEffect, useRef, useState } from "react";

export function RunMenu({
  id,
  write,
  why,
  onCopy,
  onExport,
  exportWhy,
  onWrite,
  onReport,
  buttonRef: button,
}: {
  id: number;
  /** The write it offers: Cancel run… or Delete run…. */
  write: "cancel" | "delete";
  /** Why the write is gray, if it is. */
  why: string | undefined;
  onCopy: () => void;
  /** Export its config…: the save dialog opens once the menu has closed. */
  onExport: () => void;
  /** Why Export its config… is gray, if it is. */
  exportWhy: string | undefined;
  onWrite: () => void;
  /** Report a problem…: its panel opens once the menu has closed, focus back on ···. */
  onReport: () => void;
  /** The ··· button, which focus goes back to once a confirm closes. */
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, button]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="cf-more rd-more">
      <button
        type="button"
        className="btn-icon"
        ref={button}
        aria-label={`More actions for run #${id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          className="cf-menu"
          role="menu"
          aria-label={`Actions for run #${id}`}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              onCopy();
              close(true);
            }}
          >
            Copy run path
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={exportWhy !== undefined || undefined}
            aria-describedby={exportWhy === undefined ? undefined : "rd-menu-export-why"}
            onClick={() => {
              if (exportWhy !== undefined) return;
              close(true);
              onExport();
            }}
          >
            Export its config…
          </button>
          {exportWhy !== undefined && (
            <span id="rd-menu-export-why" className="rd-menu-why">
              {exportWhy}
            </span>
          )}
          <span className="cf-menu-rule" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(true);
              onReport();
            }}
          >
            Report a problem…
          </button>
          <span className="cf-menu-rule" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="danger"
            aria-disabled={why !== undefined || undefined}
            aria-describedby={why === undefined ? undefined : "rd-menu-why"}
            onClick={() => {
              if (why !== undefined) return;
              setOpen(false);
              onWrite();
            }}
          >
            {write === "cancel" ? "Cancel run…" : "Delete run…"}
          </button>
          {why !== undefined && (
            <span id="rd-menu-why" className="rd-menu-why">
              {why}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
