import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { inApp, logFrontendEvent } from "./ipc";
import { createAppRouter } from "./router";
import { followConnection } from "./shell/connection";
import { installRightClickMenus } from "./shell/rightClick";
import { platformOf, systemMenus } from "./shell/systemMenus";
import { UnsupportedWebView } from "./startup/UnsupportedWebView";
import { loadTimeFormat } from "./ui/clock";
import { probeWebView } from "./startup/webviewProbe";
import { startTheme, type ThemeChoice } from "./theme";
import { commands } from "./wire/api.gen";

// Errors outside rendering never reach the router's error page; log them.
window.addEventListener("error", (e) => {
  const stack = e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : "";
  logFrontendEvent(
    "error",
    `uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}${stack}`,
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const reason =
    e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason);
  logFrontendEvent("error", `unhandled rejection: ${reason}`);
});

// The system's own right-click menus, and never the WebView's (#298). `tauri dev` serves the page
// from Vite and keeps the WebView's, for Inspect.
if (inApp() && !import.meta.env.DEV) {
  const open = systemMenus({ platform: platformOf(navigator.userAgent) });
  installRightClickMenus(document, (kind, at) => {
    open(kind, at).catch((e: unknown) =>
      logFrontendEvent("warn", `couldn't open the right-click menu: ${String(e)}`),
    );
  });
}

async function boot() {
  let theme: ThemeChoice | undefined;
  // `import.meta.env.DEV` is `false` in a production build, so the harness
  // is dropped from it. It must be in place before anything calls Tauri.
  // A glob, not an import, so the public mirror builds without the harness
  // and its fixtures (release/public-sync.toml): there it finds nothing.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("proto")) {
    const harness = import.meta.glob<{ installProto(url: URL): { theme?: ThemeChoice } }>(
      "./proto/install.tsx",
    );
    const load = harness["./proto/install.tsx"];
    if (load) theme = (await load()).installProto(new URL(window.location.href)).theme;
  }
  // The harness's pin wins; otherwise the user's choice, which the window already has.
  if (theme === undefined && inApp()) {
    theme = await commands
      .preferences()
      .then((p) => p.theme)
      .catch(() => undefined);
  }
  startTheme(window.matchMedia("(prefers-color-scheme: dark)"), theme);
  if (inApp()) {
    await Promise.all([
      followConnection().catch((e: unknown) =>
        logFrontendEvent("error", `couldn't follow the connection: ${String(e)}`),
      ),
      loadTimeFormat(),
    ]);
  }
  const report = await probeWebView();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {report.missing.length > 0 ? (
        <UnsupportedWebView report={report} />
      ) : (
        <App router={createAppRouter()} />
      )}
    </StrictMode>,
  );
}

void boot();
