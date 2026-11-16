/**
 * Export figures… (#54, #336 decision 7c): each protocol's overlay on
 * Compare as one standalone SVG, with its strip, its legend and its RMSE
 * table, in light colors whatever the app's theme, since a figure goes into a
 * paper or a slide. The geometry is the page's own (`overlayOf`), drawn at
 * twice its size with its text laid out beside it. Its marks are keyed in
 * the row a start's figure keys them in (#362), and its rows key its lines.
 */
import { escape, figureName as nameOf, labelText, LIGHT, MONO, SANS } from "../export/svg";
import { overlayOf } from "../runs/start/charts";
import { keyItems, keyRow } from "../runs/start/figures";
import type { Figure } from "../wire/types.gen";
import { SLOTS, type ShownProtocol } from "./words";

const STROKES = [LIGHT.cobalt, LIGHT.cobalt2, LIGHT.cobalt2];

const PAD = 24;
/** The overlay and its strip, drawn at the figure's own size: twice the page's. */
const CHART = { width: 424, height: 240, left: 44, right: 8, top: 10, bottom: 26 };
const STRIP_BOX = { width: 424, height: 64, left: 44, right: 8, top: 4, bottom: 4 };
const WIDTH = CHART.width + 2 * PAD;
const CHART_Y = 64;
const STRIP_Y = CHART_Y + CHART.height + 8;
const KEY_Y = STRIP_Y + STRIP_BOX.height + 26;
const ROWS_Y = KEY_Y + 26;
const ROW = 26;

const dashOf = (i: number) => (SLOTS[i].dash === "" ? "" : ` stroke-dasharray="${SLOTS[i].dash}"`);

/**
 * `protocol`'s overlay as an SVG file's text. `names` are the candidates'
 * names, "#211/T12.0 · start 37", in order.
 */
export function figureOf(
  protocol: ShownProtocol,
  names: readonly string[],
  says = `${protocol.metric ?? "Each start’s ranking"} RMSE per protocol.`,
): string {
  const o = overlayOf(protocol.points, protocol.lines, protocol.logx, {
    overlay: CHART,
    strip: STRIP_BOX,
  });
  const rows = protocol.rows;
  const foot = ROWS_Y + rows.length * ROW + 18;
  // What the rows read, a clause a line, as the page says it under its fits.
  const notes = [
    ...(protocol.from === undefined ? [] : [`${protocol.from}.`]),
    ...says.split(/(?<=;) /),
    "The dot marks the lowest among starts on the same data.",
    "Lower strip: model − data, each start against its own data.",
  ];
  const height = foot + 18 * (notes.length - 1) + 10;
  const at = `translate(${PAD} ${CHART_Y})`;
  const stripAt = `translate(${PAD} ${STRIP_Y})`;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<title>${escape(`${protocol.name} · ${protocol.label}`)}</title>`,
    `<rect width="${WIDTH}" height="${height}" fill="${LIGHT.bg}"/>`,
    `<text x="${PAD}" y="30" font-family="${MONO}" font-size="15" font-weight="500" fill="${LIGHT.ink}">${escape(protocol.name)}</text>`,
    `<text x="${PAD}" y="49" font-family="${SANS}" font-size="13" fill="${LIGHT.ink3}">${escape(protocol.label)}</text>`,
    `<g transform="${at}" fill="none">`,
    `<path d="${o.grid}" stroke="${LIGHT.line}"/>`,
    `<path d="${o.base}" stroke="${LIGHT.line2}"/>`,
    `<path d="${o.whiskers}" stroke="${LIGHT.ink}" stroke-opacity="0.45"/>`,
    ...o.models.flatMap((d, i) =>
      d === ""
        ? []
        : [`<path class="model" d="${d}" stroke="${STROKES[i]}" stroke-width="1.8"${dashOf(i)}/>`],
    ),
    `<path d="${o.dots}" fill="${LIGHT.ink}"/>`,
    `<path d="${o.rings}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`,
    `<path d="${o.diamonds}" fill="${LIGHT.ink}"/>`,
    `<path d="${o.hollow}" fill="${LIGHT.bg}" stroke="${LIGHT.ink}" stroke-width="1.1"/>`,
    `</g>`,
    ...o.labels.map((l) => labelText(l, CHART.width, PAD, CHART_Y)),
    `<g transform="${stripAt}" fill="none">`,
    `<path d="${o.strip.box}" fill="${LIGHT.ground}"/>`,
    `<path d="${o.strip.zero}" stroke="${LIGHT.ink3}"/>`,
    ...o.strip.lines.flatMap((d, i) =>
      d === "" ? [] : [`<path d="${d}" stroke="${STROKES[i]}" stroke-width="1.6"${dashOf(i)}/>`],
    ),
    `</g>`,
    ...o.strip.labels.map((l) => labelText(l, STRIP_BOX.width, PAD, STRIP_Y)),
    ...keyRow(
      keyItems({ validation: protocol.points.some((p) => p.validation), model: false }),
      PAD,
      KEY_Y,
    ),
    `<line x1="${PAD}" y1="${ROWS_Y - 8}" x2="${WIDTH - PAD}" y2="${ROWS_Y - 8}" stroke="${LIGHT.line}"/>`,
  ];
  rows.forEach((r, i) => {
    const y = ROWS_Y + i * ROW + 10;
    parts.push(
      `<line x1="${PAD}" y1="${y - 4}" x2="${PAD + 22}" y2="${y - 4}" stroke="${STROKES[i]}" stroke-width="1.8"${dashOf(i)}/>`,
      `<text x="${PAD + 30}" y="${y}" font-family="${MONO}" font-size="13" fill="${LIGHT.ink2}">${r.letter}</text>`,
      `<text x="${PAD + 46}" y="${y}" font-family="${MONO}" font-size="12" fill="${LIGHT.ink2}">${escape(names[i] ?? "")}</text>`,
    );
    if (r.note !== "")
      parts.push(
        `<text x="${PAD + 232}" y="${y}" font-family="${SANS}" font-size="12" fill="${LIGHT.ink3}">${escape(r.note)}</text>`,
      );
    // The row's metric, when the starts rank by different ones, before its value in the sans.
    const word = r.metric === undefined ? "" : `${r.metric} `;
    const room = r.metric === "train" ? 30 : r.metric === "val" ? 22 : 0;
    if (r.lowest)
      parts.push(
        `<circle cx="${WIDTH - PAD - 62 - room}" cy="${y - 4}" r="3" fill="${LIGHT.cobalt}"/>`,
      );
    const value = `font-family="${MONO}" font-size="13" font-weight="${r.lowest ? 600 : 400}" fill="${r.lowest ? LIGHT.ink : LIGHT.ink2}"`;
    parts.push(
      word === ""
        ? `<text x="${WIDTH - PAD}" y="${y}" text-anchor="end" ${value}>${escape(r.value)}</text>`
        : `<text x="${WIDTH - PAD}" y="${y}" text-anchor="end"><tspan font-family="${SANS}" font-size="12" fill="${LIGHT.ink3}">${word}</tspan><tspan ${value}>${escape(r.value)}</tspan></text>`,
      `<line x1="${PAD}" y1="${y + 9}" x2="${WIDTH - PAD}" y2="${y + 9}" stroke="${LIGHT.line}"/>`,
    );
  });
  const say = (y: number, t: string) =>
    `<text x="${PAD}" y="${y}" font-family="${SANS}" font-size="12" fill="${LIGHT.ink3}">${t}</text>`;
  parts.push(...notes.map((t, i) => say(foot + 18 * i, escape(t))), `</svg>`);
  return parts.join("\n");
}

/** `gvE.svg`: a protocol's name as a file's, never one `taken` (`figureName`). */
export function figureName(protocol: string, taken: ReadonlySet<string>): string {
  return nameOf(protocol.trim() === "" ? "protocol" : protocol, taken);
}

/** Each protocol's figure, named for its protocol; `says` is what the rows read. */
export function figuresOf(
  protocols: readonly ShownProtocol[],
  names: readonly string[],
  says: string,
): Figure[] {
  const taken = new Set<string>();
  return protocols.map((p) => {
    const name = figureName(p.name, taken);
    taken.add(name.toLowerCase());
    return { name, svg: figureOf(p, names, says) };
  });
}
