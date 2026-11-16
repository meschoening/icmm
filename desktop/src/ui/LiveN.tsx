/**
 * A number that can still change (#370, #373): its dotted cobalt underline (`.live-n`), and a
 * hover that says why. Every live number opens it on hover; one in each group (`tab`) is also
 * a Tab stop that names the bubble, so a keyboard reaches it once, as Val does on Results.
 * Without `tip` it's a plain span: the number is final.
 */
import type { ReactNode } from "react";
import { useTooltip } from "./Tooltip";

export function LiveN({
  tip,
  tab = false,
  className,
  children,
}: {
  /** Why it can change; none for a final number. */
  tip: string | undefined;
  /** Whether it's its group's Tab stop. */
  tab?: boolean;
  /** Its other classes; `live-n` is added while it's live. */
  className?: string;
  children: ReactNode;
}) {
  const t = useTooltip(tip);
  if (tip === undefined) return <span className={className}>{children}</span>;
  const cls = className === undefined ? "live-n" : `${className} live-n`;
  return (
    <>
      <span
        className={cls}
        {...t.hover}
        {...(tab ? { tabIndex: 0, "aria-describedby": t.id, ...t.focus } : {})}
      >
        {children}
      </span>
      {t.bubble}
    </>
  );
}
