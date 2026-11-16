/**
 * A hover word (`.tipword`, #213): a count in a sentence that lists what it
 * counts, one a line, or a word that says what it means in a sentence
 * (#398), in the app's Tooltip, on hover or keyboard focus. It's a Tab stop
 * that names its tooltip in `aria-describedby`, and does nothing on a click:
 * it never navigates, so it isn't a `.link`. Inside a link, where it would
 * be a second Tab stop, the link names the tooltip instead (`HoverWord`).
 */
import type React from "react";
import { useTooltip, type Tooltip } from "./Tooltip";

export function TipWord({
  tip: say,
  children,
}: {
  /** What it counts, as the list says them; or the sentence that says what it means. */
  tip: string | readonly string[];
  /** The count or word, as the sentence says it: "3 configs". */
  children: React.ReactNode;
}) {
  const tip = useTooltip(say);
  return (
    <>
      <span
        className="tipword"
        tabIndex={0}
        aria-describedby={tip.id}
        {...tip.hover}
        {...tip.focus}
      >
        {children}
      </span>
      {tip.bubble}
    </>
  );
}

/**
 * A hover word inside a link (#398): it opens `tip` on hover, and the link,
 * the Tab stop, names it in `aria-describedby`.
 */
export function HoverWord({ tip, children }: { tip: Tooltip; children: React.ReactNode }) {
  return (
    <>
      <span className="tipword" {...tip.hover}>
        {children}
      </span>
      {tip.bubble}
    </>
  );
}
