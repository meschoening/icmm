import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { logFrontendEvent } from "../ipc";
import { Page } from "../ui/Page";

/** A page that threw while rendering: say so, and log it. */
export function ErrorPage({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error);
  useEffect(() => {
    logFrontendEvent("error", `page failed to render: ${error instanceof Error ? (error.stack ?? message) : message}`);
  }, [error, message]);
  return (
    <Page heading="Something went wrong">
      <p className="facts">This page stopped working. The details are in the app log.</p>
      <p className="mono error-detail">{message}</p>
    </Page>
  );
}
