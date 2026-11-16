import type { ReactNode } from "react";
import { PAGE_HEADING_ATTR } from "./pageChangeFocus";

/**
 * The page's one `h1`, rendered by `Page` in every state. A page change
 * focuses it (`usePageChangeFocus`), unless the page lands somewhere else
 * (`landing` false: the element it lands on is marked instead); it isn't a
 * Tab stop, so it draws no focus ring.
 */
export function PageHeading({
  children,
  landing = true,
}: {
  children: ReactNode;
  landing?: boolean;
}) {
  return (
    <h1
      className="title page-heading"
      tabIndex={-1}
      {...(landing ? { [PAGE_HEADING_ATTR]: "" } : {})}
    >
      {children}
    </h1>
  );
}
