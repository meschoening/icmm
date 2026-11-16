/**
 * A finished start's Export (#344, #340 decision 3, LaptopStart's `open:
 * export`): a button beside Compare with…, whose menu holds Parameters as
 * JSON… and Parameters as CSV… (#360, RF02), each asking for its own kind of
 * file, then Fit… (CSV, with traces) and Figures… (SVG), with their formats
 * in mono. This computer's engine writes each where the user
 * chooses: the parameters canonical (ADR-0007), the fit simulated again
 * with every moment of its traces (ADR-0013), the figures in light colors.
 * On a revision this ICMM can't read, Fit… and Figures… are gray with why;
 * the parameters still export, their protocols named as the run recorded
 * them (#387), without their weights. What's needed is read
 * with the page, so it exports while not connected too.
 *
 * The menu opens under its button with focus on its first item; the arrow
 * keys, Home and End move between items, Escape closes it and puts focus
 * back on the button, and Tab or a press outside closes it.
 */
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { templateWords } from "../../datasets/detail/words";
import { FileIn } from "../../export/Exported";
import { fileStem } from "../../export/names";
import type { Saving } from "../../export/useSave";
import { laidOut } from "../../topology/useLayouts";
import { grayProps } from "../../ui/gray";
import { lineOf } from "../../simulation/queries";
import { WorkingButton } from "../../ui/WorkingButton";
import { commands } from "../../wire/api.gen";
import type {
  Run,
  SavedDataset,
  Start,
  StartFit,
  StartSimulation,
  StateGraph,
  WrittenFit,
} from "../../wire/types.gen";
import { startFigures, topologyFigure, type FitShown } from "./figures";
import { storedRmse } from "./words";

/** What the page has read of the start that its exports are made from. */
export interface Exportable {
  run: Run;
  start: Start;
  graph: number;
  openState: number;
  /** As `read_start_fit` read it; once read. */
  fit: StartFit | undefined;
  /** Its run's revision; once read, and never where this ICMM can't read it. */
  revision: SavedDataset | undefined;
  /** Whether this ICMM can't read its run's revision. */
  unreadable: boolean;
  /** Its best simulated on this computer; once drawn. */
  simulation: StartSimulation | undefined;
  /** Its topology's state graph, for the topology's figure; once read. */
  stateGraph: StateGraph | undefined;
}

interface Item {
  label: string;
  /** Its formats, in mono at its right; none where its label names it. */
  formats?: string;
  /** Why it's gray, if it is. */
  why: string | undefined;
  press: () => void;
}

export function StartExport({ shown, saving }: { shown: Exportable; saving: Saving }) {
  const { run, start, fit, revision } = shown;
  const segment = `T${shown.graph}.${shown.openState}`;
  const n = start.start;
  const dataset = run.dataset.name ?? run.dataset.id;
  const base = fileStem(`${dataset}-${run.id}-${segment}-start-${n}`);
  const unreadable = shown.unreadable
    ? `Needs ${dataset}’s revision ${run.dataset.revision}, which this ICMM can’t read.`
    : undefined;
  const latest = useRef(shown);
  useEffect(() => {
    latest.current = shown;
  });

  const parameters = (format: "json" | "csv") =>
    void saving.save({
      ask: () =>
        commands.choose_export_file({
          title: `Export start ${n}’s parameters as ${format.toUpperCase()}`,
          name: `${base}-parameters.${format}`,
          folder: null,
          formats: [format],
        }),
      write: (path) => {
        const now = latest.current;
        if (now.fit === undefined) return undefined;
        return commands.write_parameters({
          path,
          dataset: now.unreadable ? null : (now.revision?.content ?? null),
          fit: now.fit,
          start: {
            seed: now.start.seed,
            train_rmse: now.start.train_rmse,
            val_rmse: now.start.val_rmse,
            cost: now.start.cost,
          },
          run: {
            config_name: now.run.config.name,
            dataset_name: now.run.dataset.name,
            settings: now.run.settings,
            search_seed: now.run.search_seed,
            protocols: now.run.protocols.map((p) => p.name),
          },
        });
      },
      said: (path) => ({
        lead: (
          <>
            Exported start {n}’s parameters to <FileIn path={path} />.
          </>
        ),
        hint: `Read against open state ${shown.openState}, with b > 0; with its RMSEs, Cost and seed, and #${run.id}’s settings.`,
      }),
      what: "the parameters",
    });

  const fitFile = () =>
    void saving.save<WrittenFit>({
      ask: () =>
        commands.choose_export_file({
          title: `Export start ${n}’s fit`,
          name: `${base}-fit.csv`,
          folder: null,
          formats: ["csv"],
        }),
      write: (path) => {
        const now = latest.current;
        if (now.fit === undefined || now.revision === undefined || now.unreadable) return undefined;
        return commands.write_fit({ path, dataset: now.revision.content, fit: now.fit });
      },
      said: (path, written) => ({
        lead: (
          <>
            Exported start {n}’s fit to <FileIn path={path} />, and its traces to{" "}
            <span className="mono">{written.traces}</span> beside it.
          </>
        ),
        hint: "Each point’s data beside its simulated value; the traces hold each recorded sweep at every moment its time resolution records.",
      }),
      what: "the fit",
    });

  const figures = () => {
    let count = 0;
    void saving.save({
      ask: () =>
        commands.choose_export_folder({
          title: `Export start ${n}’s figures`,
          name: `${base}-figures`,
          folder: null,
        }),
      write: (folder) => {
        const made = figuresOf(latest.current);
        if (made === undefined) return undefined;
        count = made.length;
        return commands.write_figures({ folder, figures: made });
      },
      said: (folder) => ({
        lead: (
          <>
            Exported <span className="n">{count}</span> figures to <FileIn path={folder} />: each
            protocol’s fit and the topology.
          </>
        ),
        hint: "One SVG each, in light colors.",
      }),
      what: "the figures",
    });
  };

  const reading = fit === undefined ? "Reading its parameters…" : undefined;
  const drawing =
    unreadable ??
    (revision === undefined || fit === undefined
      ? "Reading its dataset…"
      : shown.simulation === undefined
        ? "Drawing its fit…"
        : shown.stateGraph === undefined
          ? "Reading its topology…"
          : undefined);
  const items: Item[] = [
    { label: "Parameters as JSON…", why: reading, press: () => parameters("json") },
    { label: "Parameters as CSV…", why: reading, press: () => parameters("csv") },
    {
      label: "Fit…",
      formats: "CSV, with traces",
      why:
        unreadable ??
        (revision === undefined || fit === undefined ? "Reading its dataset…" : undefined),
      press: fitFile,
    },
    { label: "Figures…", formats: "SVG", why: drawing, press: figures },
  ];
  return <ExportMenu start={n} items={items} saving={saving} />;
}

/** Every figure: each protocol's fit and the topology; `undefined` until both are drawn. */
function figuresOf(s: Exportable) {
  const { revision, simulation, run, start, stateGraph: g } = s;
  if (revision === undefined || simulation === undefined || g === undefined || s.unreadable)
    return undefined;
  const fits: FitShown[] = revision.content.protocols.map((protocol, i) => ({
    protocol,
    template: revision.templates[i],
    label: templateWords(revision.templates[i], protocol.steps.length),
    line: lineOf(simulation.protocols[i]),
    train: storedRmse(start, i, false),
    val: storedRmse(start, i, true),
  }));
  const segment = `T${s.graph}.${s.openState}`;
  const title = `#${run.id}/${segment}`;
  const topology = {
    id: segment,
    svg: topologyFigure(g, laidOut({ numStates: run.num_states, edges: g.edges }), s.openState, {
      title,
      caption: `open state ${s.openState} · ${run.num_states} states · ${g.edges.length} ${g.edges.length === 1 ? "transition" : "transitions"} · ${2 * run.num_states + 2 * g.edges.length + 2} parameters`,
    }),
  };
  return startFigures(fits, topology, {
    name: `${title} · start ${start.start}`,
    validation: run.validation,
  });
}

function ExportMenu({ start, items, saving }: { start: number; items: Item[]; saving: Saving }) {
  const whyId = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    all()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const each = all();
    const at = each.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => each[(i + each.length) % each.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(each.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="cf-more sp-export">
      <WorkingButton
        type="button"
        className="btn"
        ref={button}
        working={saving.working}
        words="Exporting…"
        aria-haspopup="menu"
        aria-expanded={open}
        {...grayProps(saving.gray)}
        onClick={() => {
          if (saving.gray || saving.working.busy()) return;
          setOpen(!open);
        }}
      >
        <span className="sp-exp">
          Export
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      </WorkingButton>
      {open && (
        <div
          className="cf-menu sp-expmenu"
          role="menu"
          aria-label={`Export start ${start}`}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          {items.map((item, i) => (
            <Fragment key={item.label}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.why !== undefined || undefined}
                aria-describedby={item.why === undefined ? undefined : `${whyId}-${i}`}
                onClick={() => {
                  if (item.why !== undefined) return;
                  close(true);
                  item.press();
                }}
              >
                <span>{item.label}</span>
                {item.formats !== undefined && <span className="mfmt">{item.formats}</span>}
              </button>
              {item.why !== undefined && (
                <span id={`${whyId}-${i}`} className="rd-menu-why">
                  {item.why}
                </span>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
