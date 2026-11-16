/**
 * A start's ··· menu (LaptopStart's `menu`): Open full log, its logs page
 * (#289), gray with why while it can't open, and Copy job ID, on a cluster
 * once the scheduler has taken its job. It opens under its button with
 * focus on its first item; the arrow keys, Home and End move between items,
 * Escape closes it and puts focus back on the button, and Tab or a press
 * outside closes it.
 */
import { useEffect, useId, useRef, useState } from "react";

export function StartMenu({
  start,
  onOpenLog,
  logBlocked,
  onCopy,
  buttonRef: button,
}: {
  start: number;
  onOpenLog: () => void;
  /** Why Open full log can't open yet, if it can't. */
  logBlocked: string | undefined;
  /** Copies its job ID; none where it has none. */
  onCopy: (() => void) | undefined;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const whyId = useId();
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
    <div className="cf-more">
      <button
        type="button"
        className="btn-icon"
        ref={button}
        aria-label={`More actions for start ${start}`}
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
          aria-label={`Actions for start ${start}`}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={logBlocked !== undefined || undefined}
            aria-describedby={logBlocked === undefined ? undefined : whyId}
            onClick={() => {
              if (logBlocked !== undefined) return;
              setOpen(false);
              onOpenLog();
            }}
          >
            Open full log
          </button>
          {logBlocked !== undefined && (
            <span id={whyId} className="rd-menu-why">
              {logBlocked}
            </span>
          )}
          {onCopy !== undefined && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                onCopy();
                close(true);
              }}
            >
              Copy job ID
            </button>
          )}
        </div>
      )}
    </div>
  );
}
