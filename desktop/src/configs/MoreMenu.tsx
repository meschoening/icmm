/**
 * A config's ··· menu (LaptopConfigs' `menu`): Duplicate, then Delete…. It
 * opens under its button with focus on the first item; the arrow keys,
 * Home and End move between items, Escape closes it and puts focus back on
 * the button, and Tab or a press outside closes it. Duplicate works in
 * place, its words "Duplicating…", until the copy opens.
 */
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "../ui/blocker";
import { WorkingButton } from "../ui/WorkingButton";
import type { Working } from "../ui/working";

export function MoreMenu({
  name,
  duplicating,
  blocked,
  onDuplicate,
  onDelete,
  buttonRef,
}: {
  name: string;
  /** Duplicate's working state; `undefined` where it can't copy the config. */
  duplicating: Working | undefined;
  /** Why the menu can't open, if it can't. */
  blocked?: string;
  onDuplicate: () => Promise<unknown>;
  onDelete: () => void;
  /** The ··· button, which focus goes back to. */
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const b = useBlocker(blocked);
  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const isOpen = open && blocked === undefined;
  useEffect(() => {
    if (!isOpen) return;
    items()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [isOpen, buttonRef]);

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
        ref={buttonRef}
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        {...b.props}
        onClick={(e) => {
          b.props.onClick(e);
          if (blocked === undefined && !duplicating?.busy()) setOpen(!open);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
      {b.bubble}
      {isOpen && (
        <div
          className="cf-menu"
          role="menu"
          aria-label={`Actions for ${name}`}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          {duplicating !== undefined && (
            <>
              <WorkingButton
                type="button"
                role="menuitem"
                tabIndex={-1}
                working={duplicating}
                words="Duplicating…"
                onClick={() => {
                  if (duplicating.busy()) return;
                  // The copy opens on success; otherwise the menu closes on what went wrong,
                  // and focus goes back to its button.
                  void onDuplicate().finally(() => close(true));
                }}
              >
                Duplicate
              </WorkingButton>
              <span className="cf-menu-rule" role="separator" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="danger"
            onClick={() => {
              if (duplicating?.busy()) return;
              setOpen(false);
              onDelete();
            }}
          >
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}
