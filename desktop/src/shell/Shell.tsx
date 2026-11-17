import { usePlatformCommands } from "../settings/commands";
import { Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { idWords } from "../configs/words";
import { useRunsFollowed } from "../runs/follow";
import { useAgentDataFollowsChanges, useAgentDataFollowsConnection } from "../setup/queries";
import { FindTopology } from "../topology/FindTopology";
import { isMac } from "../platform";
import { reportHere } from "../report/fromHere";
import { selections } from "../selection/selection";
import { usePageChangeFocus } from "../ui/pageChangeFocus";
import { CommandPalette, type PaletteActions } from "./CommandPalette";
import { useConnection } from "./connection";
import { pageOf, type PageContext } from "./palette/do";
import type { Target } from "./palette/search";
import { Header } from "./Header";

/**
 * The window's frame: the header bar over the page, and what ⌘K opens over
 * it: the command palette, whose New run opens Submit run (#235), and Find
 * custom topology from it (#222), and the run, topology, start, dataset or
 * config a search finds (#410). Each gives focus back to where it was when
 * it closes; a page it opens takes focus on its heading instead. ⌘, (Ctrl ,
 * elsewhere) opens Settings from anywhere but over a dialog. It follows
 * the Active platform's runs whatever page is open, for the run-ended
 * notifications and the first run (`runs/follow.ts`).
 */
export function Shell() {
  usePageChangeFocus();
  useAgentDataFollowsConnection();
  useAgentDataFollowsChanges();
  useRunsFollowed();
  const navigate = useNavigate();
  const router = useRouter();
  const connection = useConnection();
  // The page the palette opened over, read as it opens: the page can't change under it, and
  // following the path would render the frame on every navigation.
  const [page, setPage] = useState<PageContext>({});
  const [open, setOpen] = useState<"palette" | "find" | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const onSearch = useCallback(() => {
    back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPage(pageOf(router.state.location.pathname));
    setOpen("palette");
  }, [router]);
  const close = () => {
    setOpen(null);
    back.current?.focus();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(isMac() ? e.metaKey : e.ctrlKey) || e.altKey) return;
      // The palette takes its own; over another dialog it does nothing.
      if (e.defaultPrevented || document.querySelector("[aria-modal=true]")) return;
      e.preventDefault();
      void navigate({ to: "/settings" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);
  const platformCommands = usePlatformCommands();
  const actions: PaletteActions = {
    connect: (id) => void platformCommands.connect(id).catch(() => {}),
    newRun: (config) =>
      void navigate({ to: "/runs/submit", search: config === undefined ? {} : { config } }),
    newDataset: () => void navigate({ to: "/datasets/new" }),
    importDataset: () => void navigate({ to: "/datasets", search: { start: "import" } }),
    newProtocol: (id) => void navigate({ to: "/datasets/$id/new-protocol", params: { id } }),
    newConfig: (dataset) => void navigate({ to: "/configs/new", search: { dataset } }),
    exportDataset: (id) =>
      void navigate({ to: "/datasets/$id", params: { id }, search: { start: "export" } }),
    compareBest: (picks) => {
      if (connection.status !== "none") selections.lead(connection.platformId, picks);
      void navigate({ to: "/results/compare" });
    },
    compare: () => void navigate({ to: "/results/compare" }),
    // Settings connects, asking first about a form's unsaved changes, and shows its steps.
    switchPlatform: (id) => void navigate({ to: "/settings", search: { connect: id } }),
    settings: () => void navigate({ to: "/settings" }),
    findTopology: () => setOpen("find"),
    // Under the page head, on the page in view (#470).
    report: () => reportHere.ask(),
    open: async (target) => {
      const to = routeOf(target);
      await navigate(to);
      return router.state.location.pathname === router.buildLocation(to).pathname;
    },
  };
  return (
    <div className="app">
      <Header onSearch={onSearch} />
      <main className="app-main">
        <Outlet />
      </main>
      {open === "palette" && <CommandPalette actions={actions} onClose={close} page={page} />}
      {open === "find" && (
        <FindTopology
          target={{
            kind: "new",
            onNewConfig: (found) => {
              back.current = null;
              setOpen(null);
              void navigate({
                to: "/configs/new",
                search: {
                  states: String(found.num_states),
                  ids: idWords({ graph: found.graph, open_state: found.open_state }),
                },
              });
            },
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

/** Where a row the palette found opens: a config in the Config builder, as Recently opened has it (#408). */
function routeOf(t: Target) {
  const topology = (x: { graph: number; openState: number }) => `T${x.graph}.${x.openState}`;
  switch (t.to) {
    case "run":
      return { to: "/runs/$id", params: { id: String(t.run) } } as const;
    case "topology":
      return {
        to: "/runs/$id/$topology",
        params: { id: String(t.run), topology: topology(t) },
      } as const;
    case "start":
      return {
        to: "/runs/$id/$topology/$start",
        params: { id: String(t.run), topology: topology(t), start: String(t.start) },
      } as const;
    case "dataset":
      return { to: "/datasets/$id", params: { id: t.id } } as const;
    case "config":
      return { to: "/configs/$id/edit", params: { id: t.id } } as const;
  }
}
