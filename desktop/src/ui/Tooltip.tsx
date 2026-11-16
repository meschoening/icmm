/**
 * A tooltip that keyboard, screen-reader and pointer users can all reach
 * (old ADR-0026). Its caller is a control that owes a blocker: the reason it
 * can't be used, phrased as what clears it; or a count that lists what it
 * counts (`.tipword`, #213), one a line.
 *
 * Ported from the old app's `ui/Tooltip.tsx`, where each rule below was
 * measured:
 *
 * - Three triggers: hover (after `HOVER_OPEN_MS`), keyboard focus, and an
 *   attempted activation. A focus a pointer caused doesn't open it; the
 *   test is `:focus-visible`, which the browser tracks across paths a flag
 *   can't see.
 * - WCAG 1.4.13: Esc closes it without moving pointer or focus, the pointer
 *   can travel onto it, and no timer closes it by itself.
 * - The bubble is always mounted with a stable id, so a control can name it
 *   in `aria-describedby` while it is closed.
 * - It portals to `<body>` at `position: fixed`, below the anchor (above it
 *   when there's no room) and clamped to the viewport, so no overflow or
 *   stacking context clips it. It stops pointer events from reaching the
 *   React parent through the portal, and cancels its mousedown so a click
 *   on it leaves focus on the trigger.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";

/** Hover dwell before the bubble opens. Focus and activation don't wait. */
export const HOVER_OPEN_MS = 300;

/** Grace after the pointer leaves, long enough to cross onto the bubble. */
export const HOVER_CLOSE_MS = 100;

/** Gap between anchor and bubble; the bubble's minimum inset from the viewport. */
const GAP_PX = 6;
const EDGE_PX = 8;

/** Whether `el` shows the focus ring. An engine that can't parse the selector counts as yes. */
function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface Tooltip {
  /** The bubble's id, for the control's `aria-describedby`. */
  id: string;
  /** Spread on the element the pointer meets. */
  hover: {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  };
  /** Spread on the element that takes focus. */
  focus: {
    onFocus: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLElement>) => void;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  };
  /** Opens it now, anchored to `anchor`: an attempted activation. */
  activate: (anchor: HTMLElement) => void;
  /** The bubble, or `null` without text. Render it beside the control. */
  bubble: React.ReactNode;
}

export function useTooltip(content: string | readonly string[] | undefined): Tooltip {
  const list = typeof content !== "string" && content !== undefined;
  // An empty list has nothing to show, as no text hasn't.
  const text = !list ? content : content.length > 0 ? content.join("\n") : undefined;
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const pointerFocus = useRef(false);

  const hasText = text !== undefined;
  const open = hasText && !dismissed && (hovered || focused || pinned);

  const clearTimer = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const leave = () => {
    clearTimer();
    const close = () => {
      setHovered(false);
      setPinned(false);
    };
    if (!hasText) close();
    else timer.current = window.setTimeout(close, HOVER_CLOSE_MS);
  };

  useEffect(() => {
    const t = timer;
    return () => window.clearTimeout(t.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Capture phase, stopped here: in a dialog the first Esc closes the
    // tooltip and the second the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setDismissed(true);
      setPinned(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = bubbleRef.current?.getBoundingClientRect();
      if (a === undefined || b === undefined) return;
      const below = a.bottom + GAP_PX;
      const above = a.top - GAP_PX - b.height;
      const fitsBelow = below + b.height <= window.innerHeight - EDGE_PX;
      setPos({
        top: fitsBelow || above < EDGE_PX ? below : above,
        left: Math.max(EDGE_PX, Math.min(a.left, window.innerWidth - EDGE_PX - b.width)),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, text]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const holdFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const bubble = !hasText
    ? null
    : createPortal(
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          className={list ? "tooltip tooltip-list" : "tooltip"}
          hidden={!open}
          style={{ top: pos.top, left: pos.left }}
          onPointerEnter={clearTimer}
          onPointerLeave={leave}
          onPointerDown={stop}
          onMouseDown={holdFocus}
          onClick={stop}
        >
          {text}
        </span>,
        document.body,
      );

  return {
    id,
    hover: {
      onPointerEnter: (e) => {
        anchor.current = e.currentTarget;
        clearTimer();
        if (!hasText || hovered) return;
        timer.current = window.setTimeout(() => {
          setDismissed(false);
          setHovered(true);
        }, HOVER_OPEN_MS);
      },
      onPointerLeave: leave,
    },
    focus: {
      onPointerDown: () => {
        pointerFocus.current = true;
        window.setTimeout(() => {
          pointerFocus.current = false;
        }, 0);
      },
      onFocus: (e) => {
        anchor.current = e.currentTarget;
        if (!hasText || pointerFocus.current || !focusVisible(e.currentTarget)) return;
        setDismissed(false);
        setFocused(true);
      },
      onBlur: () => {
        setFocused(false);
        setPinned(false);
      },
    },
    activate: (el) => {
      anchor.current = el;
      if (!hasText) return;
      setDismissed(false);
      setPinned(true);
    },
    bubble,
  };
}
