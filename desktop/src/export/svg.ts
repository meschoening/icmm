/**
 * What every exported figure shares (#336 decision 7c): LaptopStyles' light
 * tokens, since a figure goes into a paper or a slide whatever the app's
 * theme; its fonts; and text laid over a drawing where the page lays it.
 * Compare's overlays (#342) and a start's fit charts and topology (#344) are
 * drawn with them.
 */
import type { Label } from "../runs/start/charts";

/** LaptopStyles' light tokens, as a figure is always drawn. */
export const LIGHT = {
  bg: "#fdfdfc",
  ground: "#f4f4f2",
  ink: "#111214",
  ink2: "#44464c",
  ink3: "#6a6c72",
  line: "#ebebe8",
  line2: "#d6d6d2",
  cobalt: "#2448d8",
  cobalt2: "#1b37a8",
};
export const SANS = "Instrument Sans, -apple-system, system-ui, sans-serif";
export const MONO = "IBM Plex Mono, ui-monospace, Menlo, monospace";

export const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const f1 = (x: number) => x.toFixed(1);

/** A label laid over the drawing, as text placed where the page places it. */
export function labelText(l: Label, width: number, x0: number, y0: number): string {
  const x = x0 + (parseFloat(l.left) / 100) * width;
  const y = y0 + l.top;
  const anchor =
    l.align === "mid" ? "middle" : l.align === "y" || l.align === "end" ? "end" : "start";
  const dy = l.align === "y" ? 4 : 11;
  return `<text x="${f1(x)}" y="${f1(y + dy)}" text-anchor="${anchor}" font-family="${MONO}" font-size="11" fill="${LIGHT.ink3}">${escape(l.t)}</text>`;
}

/**
 * `gvE.svg`: a name as a file's, kept to what any OS takes, never one
 * `taken` (lowercased: a Mac's or Windows' disk takes `GVE.svg` for `gvE.svg`).
 */
export function figureName(name: string, taken: ReadonlySet<string>): string {
  // eslint-disable-next-line no-control-regex
  const stem = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim() || "figure";
  let file = `${stem}.svg`;
  for (let k = 2; taken.has(file.toLowerCase()); k++) file = `${stem}-${k}.svg`;
  return file;
}
