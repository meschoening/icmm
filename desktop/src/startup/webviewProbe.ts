/**
 * The startup check that the web engine can draw the app.
 *
 * The installers set the minimum OS versions (macOS 13.3, Windows 10 22H2
 * with Evergreen WebView2, WebKitGTK 2.50), but WKWebView's user agent is
 * frozen, so only asking the engine proves them on a user's machine. The
 * features are the canvas's load-bearing ones, from "WebView support for the
 * canvas's CSS" (issue #11); flex `gap` can't be probed, and the floors
 * guarantee it.
 */
import { logFrontendEvent, webviewInfo, type WebviewInfo } from "../ipc";

type Supports = (property: string, value?: string) => boolean;

const REQUIRED: [name: string, property: string, value?: string][] = [
  ["color-mix", "color", "color-mix(in oklab, red 50%, blue)"],
  ["subgrid", "grid-template-rows", "subgrid"],
  ["aspect-ratio", "aspect-ratio", "1 / 1"],
  ["overflow-wrap: anywhere", "overflow-wrap", "anywhere"],
  [":focus-visible", "selector(:focus-visible)"],
];

/** The load-bearing features `supports` says the engine lacks. */
export function missingCss(supports: Supports): string[] {
  return REQUIRED.filter(([, property, value]) =>
    value === undefined ? !supports(property) : !supports(property, value),
  ).map(([name]) => name);
}

export interface WebviewReport {
  missing: string[];
  /** `null` outside the app, where there's no engine to ask. */
  info: WebviewInfo | null;
}

/** Probes the engine, logs what it found, and returns it. */
export async function probeWebView(): Promise<WebviewReport> {
  const missing = missingCss((p, v) => (v === undefined ? CSS.supports(p) : CSS.supports(p, v)));
  const info = await webviewInfo().catch(() => null);
  const engine = `${info?.os ?? "unknown OS"}, web engine ${info?.version ?? "unknown"}`;
  if (missing.length === 0) logFrontendEvent("info", `CSS support: complete (${engine})`);
  else logFrontendEvent("error", `CSS support: missing ${missing.join(", ")} (${engine})`);
  return { missing, info };
}
