/**
 * A finished start's Figures… (#344, #336 decision 7c): each protocol's fit
 * chart as the inspector draws it, and the topology drawing, one standalone
 * SVG each, in light colors whatever the app's theme. The geometry is the
 * page's own (`fitOf`, `placed`); the text the page lays over it is laid out
 * beside it, as Compare's figures are (#342). A fit's figure is headed as its
 * card is, its RMSEs and start at the right, and keyed by one row of the
 * marks as its plot draws them, which Compare's figure shares (#362).
 */
import { axisTitles } from "../../datasets/detail/words";
import { escape, f1, figureName, labelText, LIGHT, MONO, SANS } from "../../export/svg";
import type { Spot } from "../../topology/layout";
import { FIND_TOPOLOGY, placed } from "../../topology/size";
import type { Figure, Protocol, StateGraph, Template } from "../../wire/types.gen";
import { rmse } from "../words";
import { fitOf, INSPECTOR, INSPECTOR_R } from "./charts";

const PAD = 24;
const CHART_Y = 64;
const WIDTH = INSPECTOR.width + 2 * PAD;

/** A protocol's fit as the page shows it: its points, the start's line, and its RMSEs. */
export interface FitShown {
  protocol: Protocol;
  template: Template;
  /** What kind of protocol it is: "Activation (G–V)". */
  label: string;
  /** The start's model along the protocol's x, as `simulate_start`'s line has it (#367). */
  line: readonly { x: number; value: number | null }[];
  train: number | null;
  val: number | null;
}

/** Instrument Sans's widths at 12 px of the words a figure sets in it, measured in the app's font. */
const SANS_12: Record<string, number> = {
  "Train RMSE ": 65.7,
  "Val RMSE ": 55.6,
  train: 25.3,
  validation: 53.3,
  interpolated: 67.4,
  "mean ± SD": 59.1,
  model: 35,
};
/** IBM Plex Mono's width at `size` px: 0.6 em a character, at any weight. */
const monoWidth = (t: string, size: number) => t.length * size * 0.6;
/** The header's lines: the protocol's name, then its kind, a line apart. */
const NAME_Y = 30;
const LINE = 19;
/** The least room between the protocol's name and its RMSEs. */
const GAP = 16;

/** A mark the plot draws. */
export type Mark = "dot" | "ring" | "diamond" | "hollow" | "whisker" | "line";

/** A mark as the plot draws it (`fitOf` in the inspector's size), centered at (x, y). */
export function mark(kind: Mark, x: number, y: number): string {
  const r = INSPECTOR_R;
  const q = r * 1.3;
  const diamond = `M${f1(x)} ${f1(y - q)}l${q} ${q}l${-q} ${q}l${-q} ${-q}Z`;
  switch (kind) {
    case "dot":
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${r}" fill="${LIGHT.ink}"/>`;
    case "ring":
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${r}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`;
    case "diamond":
      return `<path d="${diamond}" fill="${LIGHT.ink}"/>`;
    case "hollow":
      return `<path d="${diamond}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`;
    case "whisker":
      return (
        `<path d="M${f1(x)} ${f1(y - 7)}V${f1(y + 7)}" stroke="${LIGHT.ink}" stroke-opacity="0.45"/>` +
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="2.4" fill="${LIGHT.ink}"/>`
      );
    case "line":
      return `<path d="M${f1(x - 9)} ${f1(y)}h18" stroke="${LIGHT.cobalt}" stroke-width="1.8"/>`;
  }
}

/** A word of a figure's key, after the marks it names. */
export interface KeyItem {
  marks: Mark[];
  word: string;
}

/**
 * What a fit's marks are: train, validation (where there are validation
 * points), interpolated, mean ± SD, and the model's line, which Compare's
 * figure leaves to its rows.
 */
export function keyItems(o: { validation: boolean; model: boolean }): KeyItem[] {
  return [
    { marks: ["dot"], word: "train" },
    ...(o.validation ? [{ marks: ["ring"], word: "validation" } satisfies KeyItem] : []),
    { marks: o.validation ? ["diamond", "hollow"] : ["diamond"], word: "interpolated" },
    { marks: ["whisker"], word: "mean ± SD" },
    ...(o.model ? [{ marks: ["line"], word: "model" } satisfies KeyItem] : []),
  ];
}

/**
 * The key in one row from `x0`, its words' baseline at `y`: each mark as
 * the plot draws it, then its word in Instrument Sans 12 ink-2, 20 px apart.
 */
export function keyRow(items: readonly KeyItem[], x0: number, y: number): string[] {
  const out: string[] = [];
  let x = x0;
  for (const it of items) {
    for (const m of it.marks) {
      const w = m === "line" ? 18 : 8;
      out.push(mark(m, x + w / 2, y - 4));
      x += w + 4;
    }
    x += 2;
    out.push(text(x, y, it.word, { size: 12, fill: LIGHT.ink2 }));
    x += SANS_12[it.word] + 20;
  }
  return out;
}

const text = (
  x: number,
  y: number,
  t: string,
  o: { font?: string; size?: number; fill?: string; weight?: number; anchor?: string } = {},
) =>
  `<text x="${f1(x)}" y="${f1(y)}"${o.anchor === undefined ? "" : ` text-anchor="${o.anchor}"`} font-family="${o.font ?? SANS}" font-size="${o.size ?? 12}"${o.weight === undefined ? "" : ` font-weight="${o.weight}"`} fill="${o.fill ?? LIGHT.ink3}">${escape(t)}</text>`;

/**
 * `fit`'s chart as an SVG file's text, headed as its card is: the protocol's
 * name and kind at the left, its RMSEs and the start at the right, or a line
 * down where its name would meet them. Under it, its points with the start's
 * line over them on titled axes, and one row keying the marks. `name` is the
 * start's, "#214/T12.3 · start 71".
 */
export function fitFigure(
  fit: FitShown,
  o: { name: string; validation: boolean },
): string {
  const { protocol } = fit;
  const f = fitOf(protocol.points, fit.line, protocol.interpolation.log_x, {
    box: INSPECTOR,
    r: INSPECTOR_R,
    validation: o.validation,
    titles: axisTitles(protocol, fit.template),
  });
  const right = WIDTH - PAD;
  const train = fit.train === null ? "—" : rmse(fit.train);
  const val = fit.val === null ? "—" : rmse(fit.val);
  const scoresWidth =
    SANS_12["Train RMSE "] +
    monoWidth(train, 14) +
    (o.validation ? 14 + SANS_12["Val RMSE "] + monoWidth(val, 14) : 0);
  const down = PAD + monoWidth(protocol.name, 15) + GAP > right - scoresWidth ? LINE : 0;
  const chartY = CHART_Y + down;
  const below = chartY + INSPECTOR.height + 26;
  const height = below + 30;
  const value = (t: string) =>
    `<tspan font-family="${MONO}" font-size="14" fill="${LIGHT.ink}">${escape(t)}</tspan>`;
  const scores =
    `<text x="${f1(right)}" y="${f1(NAME_Y + down)}" text-anchor="end" font-family="${SANS}" font-size="12" fill="${LIGHT.ink3}">` +
    `<tspan>Train RMSE </tspan>${value(train)}` +
    (o.validation ? `<tspan dx="14">Val RMSE </tspan>${value(val)}` : "") +
    `</text>`;
  const at = `translate(${PAD} ${chartY})`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<title>${escape(`${protocol.name} · ${o.name}`)}</title>`,
    `<rect width="${WIDTH}" height="${height}" fill="${LIGHT.bg}"/>`,
    text(PAD, NAME_Y, protocol.name, { font: MONO, size: 15, weight: 500, fill: LIGHT.ink }),
    text(PAD, NAME_Y + LINE, fit.label, { size: 13 }),
    scores,
    text(right, NAME_Y + LINE + down, o.name, {
      font: MONO,
      size: 12,
      fill: LIGHT.ink3,
      anchor: "end",
    }),
    `<g transform="${at}" fill="none">`,
    `<path d="${f.grid}" stroke="${LIGHT.line}"/>`,
    `<path d="${f.base}" stroke="${LIGHT.line2}"/>`,
    `<path d="${f.whiskers}" stroke="${LIGHT.ink}" stroke-opacity="0.45"/>`,
    ...(f.model === ""
      ? []
      : [`<path class="model" d="${f.model}" stroke="${LIGHT.cobalt}" stroke-width="1.8"/>`]),
    `<path d="${f.dots}" fill="${LIGHT.ink}"/>`,
    `<path d="${f.rings}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`,
    `<path d="${f.diamonds}" fill="${LIGHT.ink}"/>`,
    `<path d="${f.hollow}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`,
    `</g>`,
    ...f.labels.map((l) => labelText(l, INSPECTOR.width, PAD, chartY)),
    `<line x1="${PAD}" y1="${below - 6}" x2="${right}" y2="${below - 6}" stroke="${LIGHT.line}"/>`,
    ...keyRow(keyItems({ validation: o.validation, model: true }), PAD, below + 16),
    `</svg>`,
  ].join("\n");
}

/**
 * The topology drawn as Find custom topology draws it, its open state
 * filled, as an SVG file's text: `title` over it ("#214/T12.3") and
 * `caption` under it ("open state 3 · 5 states · 6 transitions · 24
 * parameters").
 */
export function topologyFigure(
  graph: Pick<StateGraph, "edges">,
  spots: Spot[],
  open: number,
  o: { title: string; caption: string },
): string {
  const size = FIND_TOPOLOGY;
  const { at, width: w, height: h } = placed(spots, size);
  const width = Math.max(w + 2 * PAD, 360);
  const x0 = (width - w) / 2;
  const y0 = 48;
  const height = y0 + h + 44;
  const r = size.state / 2;
  const edges = graph.edges
    .map(
      ([a, b]) =>
        `M${f1(x0 + at[a].x)} ${f1(y0 + at[a].y)}L${f1(x0 + at[b].x)} ${f1(y0 + at[b].y)}`,
    )
    .join("");
  const states = at.map((p, s) => {
    const on = s === open;
    return (
      `<circle cx="${f1(x0 + p.x)}" cy="${f1(y0 + p.y)}" r="${r}" fill="${on ? LIGHT.ink : LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.3"/>` +
      `<text x="${f1(x0 + p.x)}" y="${f1(y0 + p.y + size.font * 0.36)}" text-anchor="middle" font-family="${MONO}" font-size="${size.font}" fill="${on ? LIGHT.bg : LIGHT.ink}">${s}</text>`
    );
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escape(o.title)}</title>`,
    `<rect width="${width}" height="${height}" fill="${LIGHT.bg}"/>`,
    text(PAD, 30, o.title, { font: MONO, size: 15, weight: 500, fill: LIGHT.ink }),
    `<path d="${edges}" fill="none" stroke="${LIGHT.ink3}" stroke-width="1.3"/>`,
    ...states,
    text(PAD, y0 + h + 28, o.caption, { size: 13 }),
    `</svg>`,
  ].join("\n");
}

/**
 * Each protocol's fit, named for its protocol, then the topology, named for
 * its id (`T12.3.svg`).
 */
export function startFigures(
  fits: readonly FitShown[],
  topology: { svg: string; id: string },
  o: { name: string; validation: boolean },
): Figure[] {
  const taken = new Set<string>();
  const named = (name: string, svg: string): Figure => {
    const file = figureName(name, taken);
    taken.add(file.toLowerCase());
    return { name: file, svg };
  };
  return [
    ...fits.map((f) => named(f.protocol.name, fitFigure(f, o))),
    named(topology.id, topology.svg),
  ];
}
