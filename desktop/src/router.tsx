import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { EditConfigPage, NewConfigPage } from "./configs/builder/BuilderPage";
import { ConfigsPage } from "./pages/Configs";
import { EditProtocolPage, NewProtocolPage } from "./datasets/builder/SavedProtocolPage";
import { DatasetPage } from "./datasets/detail/DatasetPage";
import { NewDatasetPage } from "./datasets/NewDataset";
import { DatasetsPage } from "./pages/Datasets";
import { ErrorPage } from "./pages/Error";
import { HomePage } from "./pages/Home";
import {
  CoordinatorLogPage,
  StartLogsPage,
  type CoordinatorLogSearch,
  type LogsSearch,
} from "./pages/LogsPage";
import { NotFoundPage } from "./pages/NotFound";
import { ComparePage } from "./pages/ComparePage";
import { ResultsPage } from "./pages/Results";
import { validateResultsSearch } from "./results/search";
import { RunPage } from "./pages/RunPage";
import { RunsPage, type RunsSearch } from "./pages/Runs";
import { StartPage } from "./pages/StartPage";
import { SubmitRunPage } from "./pages/SubmitRun";
import { TopologyPage } from "./pages/TopologyPage";
import { SettingsPage } from "./settings/SettingsPage";
import { Shell } from "./shell/Shell";

const root = createRootRoute({ component: Shell });

/** Every page the app routes to, by path. */
const pages = {
  "/": HomePage,
  "/datasets": DatasetsPage,
  "/configs": ConfigsPage,
  "/runs": RunsPage,
  "/results": ResultsPage,
  "/settings": SettingsPage,
} as const;

export const PAGE_PATHS = Object.keys(pages) as (keyof typeof pages)[];

/** The proto harness's component sheet, in dev builds only. A glob, not an import, so the
 * public mirror builds without the harness (release/public-sync.toml): there it finds nothing. */
const sheet = import.meta.env.DEV
  ? import.meta.glob<{ ComponentsPage: ComponentType }>("./proto/ComponentsPage.tsx")[
      "./proto/ComponentsPage.tsx"
    ]
  : undefined;
const devRoutes = sheet
  ? [
      createRoute({
        getParentRoute: () => root,
        path: "/components",
        component: lazyRouteComponent(sheet, "ComponentsPage"),
      }),
    ]
  : [];

/**
 * Settings can open with a platform's form: `?edit=<id>` (Home's Edit does); or to connect to
 * one: `?connect=<id>` (⌘K's Switch platform to …, #412).
 */
export interface SettingsSearch {
  edit?: string;
  connect?: string;
}

const settings = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    ...(typeof search.edit === "string" ? { edit: search.edit } : {}),
    ...(typeof search.connect === "string" ? { connect: search.connect } : {}),
  }),
});

/** Datasets can open to import one: `?start=import` (⌘K's Import dataset…, #412). */
export interface DatasetsSearch {
  start?: "import";
}

const datasets = createRoute({
  getParentRoute: () => root,
  path: "/datasets",
  component: DatasetsPage,
  validateSearch: (search: Record<string, unknown>): DatasetsSearch =>
    search.start === "import" ? { start: "import" } : {},
});

/** Configs can open with a config: `?id=<id>` (its row on Configs does); else the newest shows. */
export interface ConfigsSearch {
  id?: string;
}

const runs = createRoute({
  getParentRoute: () => root,
  path: "/runs",
  component: RunsPage,
  validateSearch: (search: Record<string, unknown>): RunsSearch => ({
    ...(typeof search.dataset === "string" ? { dataset: search.dataset } : {}),
    ...(typeof search.filter === "string" ? { filter: search.filter } : {}),
  }),
});

/** Results can open on a dataset, a run of it, or one of its Ranking groups (`ResultsSearch`). */
const results = createRoute({
  getParentRoute: () => root,
  path: "/results",
  component: ResultsPage,
  validateSearch: validateResultsSearch,
});

/** Compare, from the selection bar's Compare and Topology's Compare… (#342 builds it). */
const compare = createRoute({
  getParentRoute: () => root,
  path: "/results/compare",
  component: ComparePage,
});

const configs = createRoute({
  getParentRoute: () => root,
  path: "/configs",
  component: ConfigsPage,
  validateSearch: (search: Record<string, unknown>): ConfigsSearch =>
    typeof search.id === "string" ? { id: search.id } : {},
});

/**
 * The Config builder can open with a dataset chosen: `?dataset=<id>` (Dataset detail's New
 * config from this dataset does); else the newest is. Find custom topology's New config with
 * its id opens it on Specific IDs: `?states=<N>&ids=<id>` (#222). Results' New config from
 * these… adds its picks' topologies in their runs, `&picks=214/T12.3,211/T7.0`, whose
 * top-ranked's run gives the other settings (#343).
 */
export interface NewConfigSearch {
  dataset?: string;
  states?: string;
  ids?: string;
  picks?: string;
}

/** The Config builder for a new config, from New config and New config from this dataset. */
const newConfig = createRoute({
  getParentRoute: () => root,
  path: "/configs/new",
  component: NewConfigPage,
  validateSearch: (search: Record<string, unknown>): NewConfigSearch => ({
    ...(typeof search.dataset === "string" ? { dataset: search.dataset } : {}),
    // A number in the URL arrives as one.
    ...(["string", "number"].includes(typeof search.states)
      ? { states: String(search.states) }
      : {}),
    ...(typeof search.ids === "string" ? { ids: search.ids } : {}),
    ...(typeof search.picks === "string" ? { picks: search.picks } : {}),
  }),
});

/** The Config builder on a saved config, from Edit and Duplicate. */
const editConfig = createRoute({
  getParentRoute: () => root,
  path: "/configs/$id/edit",
  component: EditConfigPage,
});

/** Submit run can open with a config: `?config=<id>` (a config's Submit run does). */
export interface SubmitSearch {
  config?: string;
}

/** Submit run, from a config's Submit run and ⌘K's New run. */
const submitRun = createRoute({
  getParentRoute: () => root,
  path: "/runs/submit",
  component: SubmitRunPage,
  validateSearch: (search: Record<string, unknown>): SubmitSearch =>
    typeof search.config === "string" ? { config: search.config } : {},
});

/**
 * A run's page, where Submit lands once a run is accepted: `/runs/<id>`. The router ranks
 * the static `/runs/submit` above it, so Submit run is never a run called "submit".
 */
const run = createRoute({
  getParentRoute: () => root,
  path: "/runs/$id",
  component: RunPage,
});

/** A run's topology, `#214/T12.3`, at `/runs/214/T12.3` (#238): from Run detail's rows. */
const topology = createRoute({
  getParentRoute: () => root,
  path: "/runs/$id/$topology",
  component: TopologyPage,
});

/** A start of a run's topology, a finished one's Result (#346): where Topology's sent starts lead. */
const start = createRoute({
  getParentRoute: () => root,
  path: "/runs/$id/$topology/$start",
  component: StartPage,
});

/** A whole number from 1, as a search param arrives: a number or a string. */
function countOf(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * A start's logs (#289): its Start log, or its job log with `?log=job`, of its latest try, or
 * of an earlier one with `?try=2`. From the Start page's Open full log and Open job log, and
 * Topology's Failed group.
 */
const startLogs = createRoute({
  getParentRoute: () => root,
  path: "/runs/$id/$topology/$start/logs",
  component: StartLogsPage,
  validateSearch: (search: Record<string, unknown>): LogsSearch => {
    const attempt = countOf(search.try);
    return {
      ...(search.log === "job" ? { log: "job" } : {}),
      ...(attempt === undefined ? {} : { try: attempt }),
    };
  },
});

/**
 * A run's coordinating job log (#289), its latest generation, or the latest that failed in a
 * run they failed, or one by `?generation=9`. From Run detail's Open its log; the router ranks
 * the static `logs` above a topology's `$topology`.
 */
const coordinatorLog = createRoute({
  getParentRoute: () => root,
  path: "/runs/$id/logs",
  component: CoordinatorLogPage,
  validateSearch: (search: Record<string, unknown>): CoordinatorLogSearch => {
    const generation = countOf(search.generation);
    return generation === undefined ? {} : { generation };
  },
});

/** The Dataset wizard, from Datasets' New dataset. */
const newDataset = createRoute({
  getParentRoute: () => root,
  path: "/datasets/new",
  component: NewDatasetPage,
});

/** Dataset detail can open to export it: `?start=export` (⌘K's Export <dataset>…, #412). */
export interface DatasetSearch {
  start?: "export";
}

/** Dataset detail, from a dataset's name on Datasets. */
const dataset = createRoute({
  getParentRoute: () => root,
  path: "/datasets/$id",
  component: DatasetPage,
  validateSearch: (search: Record<string, unknown>): DatasetSearch =>
    search.start === "export" ? { start: "export" } : {},
});

/** The Protocol builder on a saved dataset: a new protocol (New protocol…). */
const newProtocol = createRoute({
  getParentRoute: () => root,
  path: "/datasets/$id/new-protocol",
  component: NewProtocolPage,
});

/** The Protocol builder on one of a saved dataset's protocols (Edit protocol…). */
const editProtocol = createRoute({
  getParentRoute: () => root,
  path: "/datasets/$id/protocols/$protocol",
  component: EditProtocolPage,
});

const routeTree = root.addChildren([
  ...PAGE_PATHS.filter(
    (path) =>
      path !== "/settings" &&
      path !== "/datasets" &&
      path !== "/configs" &&
      path !== "/runs" &&
      path !== "/results",
  ).map((path) => createRoute({ getParentRoute: () => root, path, component: pages[path] })),
  settings,
  datasets,
  configs,
  runs,
  results,
  compare,
  newConfig,
  editConfig,
  submitRun,
  run,
  topology,
  start,
  startLogs,
  coordinatorLog,
  newDataset,
  dataset,
  newProtocol,
  editProtocol,
  ...devRoutes,
]);

export interface AppRouterOptions {
  /** Start at this path with in-memory history (tests); else the window's URL. */
  initialPath?: string;
}

export function createAppRouter({ initialPath }: AppRouterOptions = {}) {
  return createRouter({
    routeTree,
    history:
      initialPath === undefined
        ? createBrowserHistory()
        : createMemoryHistory({ initialEntries: [initialPath] }),
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: ErrorPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/history" {
  interface HistoryState {
    /**
     * Dataset detail, and the Config builder, open a copy just duplicated ready to name: the
     * copied dataset's or config's name.
     */
    copyOf?: string;
    /** Dataset detail shows a dataset just saved again from a deleted one: that one's name. */
    savedAgain?: string;
    /**
     * Dataset detail shows a copy just duplicated, or a dataset just saved again from a deleted
     * one: the dataset it came from, by id, whose configs it counts.
     */
    from?: string;
    /** Dataset detail lands on this element's id, not its heading: where the builder was opened. */
    land?: string;
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
