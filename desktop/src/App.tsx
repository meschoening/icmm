import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import type { AppRouter } from "./router";

/**
 * The desktop's own commands answer from this computer at once, so a query
 * isn't retried and stays fresh until something the app did changes it.
 * The agent's reads stay until the next connection comes up and forgets them
 * (`useAgentDataFollowsConnection`), so a page opened again while not
 * connected still shows what it read, however long ago (RF15, #368).
 */
function newQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  client.setQueryDefaults(["agent"], { gcTime: Infinity });
  return client;
}

/** The app's root: routing around the shell, over the query cache. */
export function App({ router }: { router: AppRouter }) {
  const [queries] = useState(newQueryClient);
  return (
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
