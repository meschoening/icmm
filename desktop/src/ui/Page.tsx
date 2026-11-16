import type { ReactNode } from "react";
import { PageHeading } from "./PageHeading";

/** A page's frame: its page heading, then its content. */
export function Page({ heading, children }: { heading: string; children?: ReactNode }) {
  return (
    <div className="page">
      <PageHeading>{heading}</PageHeading>
      {children}
    </div>
  );
}
