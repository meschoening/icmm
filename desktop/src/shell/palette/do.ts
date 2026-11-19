/**
 * ⌘K's Do (#408 decisions 7–10, #412; LaptopCommandPalette's `recent`,
 * `dataset` and `compare` views): what ICMM can do from here, each a row.
 *
 * - The page is its context, never the selection: on a dataset's page (or a
 *   page inside it, `/datasets/<id>/…`), New protocol in, New config on and
 *   Export it; New run opens the page's config, else the one saved last. Off a
 *   dataset's page, New protocol and Export come for the top matched dataset,
 *   and typed, any dataset's are found by their own words when the query names
 *   it ("export herg-wt"), best name match first.
 * - Always: New dataset, Import dataset…, Switch platform to … for each other
 *   saved platform, and Settings (`⌘,`); Find custom topology… once typed, and
 *   Report a problem… on the page in view (#470), its gray words naming it.
 * - Compare the best of the top 3 matched runs, in Runs' order, when 2 or more
 *   have a best start; Compare the selection (N) while it isn't empty, its
 *   gray words naming its first two starts (KF09).
 * - Typed, a row matches when its label holds every word, never its gray
 *   words; a dataset's rows come with it when it's matched. One exception:
 *   Report a problem… is found by help, bug, issue, crash, error and feedback
 *   too, the words people try for it (#470).
 * - Rows that need the platform are gray while it isn't connected; New
 *   dataset doesn't (KF13), and Connect to the platform leads (KF14).
 */
import { shortcutLabel } from "../../platform";
import type { SelectedStart } from "../../selection/selection";
import type { ConfigSummary, RunSummary, SavedPlatform } from "../../wire/types.gen";
import { pageRunOf, rank, ranked, type Row } from "./search";

/** The page ⌘K opened over: its run, dataset or config, by its path. */
export interface PageContext {
  run?: number;
  dataset?: string;
  config?: string;
}

/**
 * What `path` is the page of: `/runs/214/T12.3` run 214's, `/datasets/<id>` and the pages inside
 * it (`/datasets/<id>/new-protocol`) a dataset's.
 */
export function pageOf(path: string): PageContext {
  const run = pageRunOf(path);
  if (run !== undefined) return { run };
  const dataset = path.match(/^\/datasets\/([^/]+)(?:\/|$)/);
  if (dataset !== null && dataset[1] !== "new") return { dataset: decodeURIComponent(dataset[1]) };
  const config = path.match(/^\/configs\/([^/]+)\/edit\/?$/);
  if (config !== null) return { config: decodeURIComponent(config[1]) };
  return {};
}

/** What Do's rows do. */
export interface DoActions {
  /** Connects to the Active platform, as Home's Connect does. */
  connect: (id: string) => void;
  /** Opens Submit run on `config`, else on the config saved last. */
  newRun: (config?: string) => void;
  newDataset: () => void;
  /** Opens Datasets and its Import's file chooser. */
  importDataset: () => void;
  newProtocol: (dataset: string) => void;
  newConfig: (dataset: string) => void;
  /** Opens the dataset's page and its Export's save dialog. */
  exportDataset: (dataset: string) => void;
  /** Puts `picks` first in the selection, earlier picks behind them, and opens Compare. */
  compareBest: (picks: SelectedStart[]) => void;
  /** Opens Compare on the selection. */
  compare: () => void;
  switchPlatform: (id: string) => void;
  settings: () => void;
  findTopology: () => void;
  /** Opens Report a problem…'s panel on the page in view (#470). */
  report: () => void;
}

/** A label's or gray words' parts: plain words, and names or numbers in mono. */
export type Words = (string | { mono: string })[];

export const wordsText = (w: Words) => w.map((p) => (typeof p === "string" ? p : p.mono)).join("");

/** A row's mark, as LaptopCommandPalette draws each (`palette/icons.tsx`). */
export type DoIcon =
  | "connect"
  | "plus"
  | "protocol"
  | "import"
  | "export"
  | "compare"
  | "switch"
  | "settings"
  | "topology"
  | "report";

export interface Command {
  key: string;
  label: Words;
  /** What it's for, in the row's gray words. */
  side?: Words;
  /** Its gray words where the full ones would cut its label (KF11, KF12). */
  sideShort?: Words;
  /** Its shortcut, shown at the right while another row is chosen. */
  kbd?: string;
  icon: DoIcon;
  /** Words it's found by besides its label's (Report a problem…'s, Settings'). */
  also?: string[];
  /** It needs the platform: gray while it isn't connected. */
  platform: boolean;
  /**
   * Its progress shows in the connection, so the palette stays open, the row gray in its own words
   * from the press until the connection's next state (Connect, `connection/pressed.ts`).
   */
  stays?: boolean;
  run: (actions: DoActions) => void;
}

export interface DoContext {
  /** The query's words; none on an empty query. */
  words: string[];
  typed: boolean;
  page: PageContext;
  configs: ConfigSummary[] | undefined;
  /** The page's dataset, once it's read: its id and name. */
  pageDataset: { id: string; name: string } | undefined;
  /** The query's matched datasets, in their group's order. */
  matchedDatasets: Row[] | undefined;
  /** Every dataset, in Datasets' order: typed, their rows are found by their own words. */
  datasets: { id: string; name: string }[] | undefined;
  /** The query's matched runs, in their group's order. */
  matchedRuns: RunSummary[] | undefined;
  /** The selection's starts, in its order. */
  selected: readonly SelectedStart[];
  platforms: SavedPlatform[] | undefined;
  /** The Active platform's id and name. */
  active: { id: string; name: string } | undefined;
  /** The Active platform while it isn't connected and Connect can start it (KF14). */
  unconnected?: { id: string; name: string };
  /** The page in view's gray words for Report a problem…; none while no page offers it. */
  report?: Words;
}

const holds = (c: Command, words: string[]) => {
  const text = [wordsText(c.label), ...(c.also ?? [])].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
};

/** "#211, #210 and #197". */
function runList(ids: number[]): Words {
  const out: Words = [];
  ids.forEach((id, i) => {
    if (i > 0) out.push(i === ids.length - 1 ? " and " : ", ");
    out.push({ mono: `#${id}` });
  });
  return out;
}

/** "#211/T12.3 · 37 and #208/T5.2 · 12"; past two, "…, #208/T5.2 · 12 and 2 more" (KF09). */
function pickList(picks: readonly SelectedStart[]): Words {
  const out: Words = [];
  const named = picks.slice(0, 2);
  named.forEach((p, i) => {
    if (i > 0) out.push(picks.length > 2 ? ", " : " and ");
    out.push({ mono: `#${p.run}/T${p.graph}.${p.open_state}` }, " · ", { mono: String(p.start) });
  });
  if (picks.length > 2) out.push(` and ${picks.length - 2} more`);
  return out;
}

/** The start a run's best is, as the selection holds it. */
const bestPick = (r: RunSummary): SelectedStart => ({
  run: r.id,
  graph: r.best!.graph,
  open_state: r.best!.open_state,
  start: r.best!.start,
  dataset: { id: r.dataset.id, name: r.dataset.name },
  num_states: r.num_states,
});

function datasetCommands(d: { id: string; name: string }, onPage: boolean): Command[] {
  const commands: Command[] = [
    {
      key: `protocol ${d.id}`,
      label: ["New protocol in ", { mono: d.name }, "…"],
      icon: "protocol",
      platform: true,
      run: (a) => a.newProtocol(d.id),
    },
  ];
  if (onPage) {
    commands.push({
      key: `config ${d.id}`,
      label: ["New config on ", { mono: d.name }],
      icon: "plus",
      platform: true,
      run: (a) => a.newConfig(d.id),
    });
  }
  commands.push({
    key: `export ${d.id}`,
    label: ["Export ", { mono: d.name }, "…"],
    icon: "export",
    platform: true,
    run: (a) => a.exportDataset(d.id),
  });
  return commands;
}

/** Do's rows, in the board's order. */
export function doCommands(x: DoContext): Command[] {
  const { words, typed } = x;
  const out: Command[] = [];

  // Not connected, Connect leads, as Home's does (KF14).
  if (x.unconnected !== undefined) {
    const { id, name } = x.unconnected;
    const connect: Command = {
      key: "connect",
      label: [`Connect to ${name}`],
      icon: "connect",
      platform: false,
      stays: true,
      run: (a) => a.connect(id),
    };
    if (!typed || holds(connect, words)) out.push(connect);
  }

  // The page's dataset, else (typed) the top matched one.
  if (x.pageDataset !== undefined) {
    const own = datasetCommands(x.pageDataset, true);
    const matched = x.matchedDatasets?.some((r) => r.key === `dataset ${x.pageDataset!.id}`);
    out.push(...(typed && !matched ? own.filter((c) => holds(c, words)) : own));
  } else if (typed && x.page.dataset === undefined) {
    // The top matched dataset's rows come with it; any dataset's rows are found by their own
    // words, once the query names the dataset and holds a word its name doesn't ("export
    // herg-wt"), best name match first.
    const top = x.matchedDatasets?.[0];
    const topId = top?.to.to === "dataset" ? top.to.id : undefined;
    if (top !== undefined && topId !== undefined) {
      out.push(...datasetCommands({ id: topId, name: top.name }, false));
    }
    for (const d of ranked(x.datasets ?? [], (d) => rank(d.name, words))) {
      if (d.id === topId) continue;
      // The query names it, and words its name doesn't hold name the row.
      const name = d.name.toLowerCase();
      if (!words.some((w) => name.includes(w)) || words.every((w) => name.includes(w))) continue;
      out.push(...datasetCommands(d, false).filter((c) => holds(c, words)));
    }
  }

  if (typed) {
    const best = (x.matchedRuns ?? []).filter((r) => r.best !== null);
    if (best.length >= 2) {
      const top = best.slice(0, 3);
      out.push({
        key: "compare best",
        label: ["Compare the best of ", ...runList(top.map((r) => r.id))],
        // Of the matched runs, those with a best start (KF12); "matched" gives way first (KF11).
        side: [
          top.length < best.length
            ? `the top ${top.length} of ${best.length} matched runs with a best start`
            : `the ${top.length} matched runs with a best start`,
        ],
        sideShort: [
          top.length < best.length
            ? `the top ${top.length} of ${best.length} runs with a best start`
            : `the ${top.length} runs with a best start`,
        ],
        icon: "compare",
        platform: true,
        run: (a) => a.compareBest(top.map(bestPick)),
      });
    }
  }

  const always: Command[] = [];
  const pageConfig =
    x.page.config === undefined ? undefined : x.configs?.find((c) => c.id === x.page.config);
  const savedLast = x.configs?.[0];
  always.push({
    key: "run",
    label: ["New run"],
    side:
      x.page.config !== undefined
        ? pageConfig === undefined
          ? undefined
          : ["with ", { mono: pageConfig.name }]
        : savedLast === undefined
          ? undefined
          : ["with ", { mono: savedLast.name }, ", saved last"],
    icon: "plus",
    platform: true,
    run: (a) => a.newRun(x.page.config),
  });
  always.push(
    {
      // Its wizard asks nothing of the platform until it's saved (KF13).
      key: "dataset",
      label: ["New dataset"],
      icon: "plus",
      platform: false,
      run: (a) => a.newDataset(),
    },
    {
      key: "import",
      label: ["Import dataset…"],
      icon: "import",
      platform: true,
      run: (a) => a.importDataset(),
    },
  );
  if (x.selected.length > 0) {
    always.push({
      key: "compare",
      label: ["Compare the selection (", { mono: String(x.selected.length) }, ")"],
      side: pickList(x.selected),
      icon: "compare",
      platform: true,
      run: (a) => a.compare(),
    });
  }
  for (const p of x.platforms ?? []) {
    if (p.id === x.active?.id) continue;
    always.push({
      key: `switch ${p.id}`,
      label: [`Switch platform to ${p.name}`],
      side: x.active === undefined ? undefined : [`now: ${x.active.name}`],
      icon: "switch",
      platform: false,
      run: (a) => a.switchPlatform(p.id),
    });
  }
  always.push({
    key: "settings",
    label: ["Settings"],
    kbd: shortcutLabel(","),
    icon: "settings",
    // What it holds: ICMM's versions at its foot, and the diagnostic logs (#509, F15).
    also: ["version", "about", "logs", "preferences"],
    platform: false,
    run: (a) => a.settings(),
  });
  if (typed) {
    always.push({
      key: "find",
      label: ["Find custom topology…"],
      side: ["type a model’s transitions"],
      icon: "topology",
      platform: false,
      run: (a) => a.findTopology(),
    });
    if (x.report !== undefined) {
      always.push({
        key: "report",
        label: ["Report a problem…"],
        side: x.report,
        icon: "report",
        also: ["help", "bug", "issue", "crash", "error", "feedback"],
        platform: false,
        run: (a) => a.report(),
      });
    }
  }
  out.push(...(typed ? always.filter((c) => holds(c, words)) : always));
  return out;
}
