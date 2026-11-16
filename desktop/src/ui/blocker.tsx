/**
 * Controls that can't be used yet and say why (old ADR-0026).
 *
 * A control blocked on something the user can do, or on something they
 * can't fix from here, stays a Tab stop, is `aria-disabled` rather than
 * `disabled`, and names its blocker in a tooltip it points at with
 * `aria-describedby`. Activating it opens the tooltip instead of acting.
 *
 * The props go on the same element whether or not it is blocked, so a
 * control that becomes blocked while focused keeps focus (old ADR-0029).
 */
import type React from "react";
import { useTooltip } from "./Tooltip";

export interface Blocker {
  /** Spread on the control. */
  props: {
    "aria-disabled"?: true;
    "aria-describedby"?: string;
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
    onFocus: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLElement>) => void;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onClick: (e: React.MouseEvent<HTMLElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  };
  /** The tooltip, or `null` when unblocked. Render it beside the control. */
  bubble: React.ReactNode;
  /** Shows the reason at `anchor`, as a press does: for the control's shortcut (⌘K). */
  explain: (anchor: HTMLElement) => void;
}

/** `blocker` is what clears the block (“Opens once you’re connected”), or `undefined`. */
export function useBlocker(blocker: string | undefined): Blocker {
  const t = useTooltip(blocker);
  const blocked = blocker !== undefined;
  return {
    props: {
      "aria-disabled": blocked ? true : undefined,
      "aria-describedby": blocked ? t.id : undefined,
      ...t.hover,
      ...t.focus,
      onClick: (e) => {
        if (!blocked) return;
        e.preventDefault();
        t.activate(e.currentTarget);
      },
      // A link without `href` does nothing on Enter; a blocked one explains.
      onKeyDown: (e) => {
        if (blocked && e.key === "Enter") t.activate(e.currentTarget);
      },
    },
    bubble: t.bubble,
    explain: (anchor) => {
      if (blocked) t.activate(anchor);
    },
  };
}
