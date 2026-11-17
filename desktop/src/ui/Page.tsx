import type { ReactNode } from "react";
import { ReportFromHere } from "../report/ReportFromHere";
import { PageHeading } from "./PageHeading";

/** A page's frame: its page heading, Report a problem…'s panel when ⌘K opens it (#470), then its content. */
export function Page({ heading, children }: { heading: string; children?: ReactNode }) {
  return (
    <div className="page">
      <PageHeading>{heading}</PageHeading>
      <ReportFromHere name={heading} />
      {children}
    </div>
  );
}
