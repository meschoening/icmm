import type { WebviewReport } from "./webviewProbe";

const UPDATE: Record<string, string> = {
  macos: "Update macOS to 13.3 or later.",
  windows: "Update the Microsoft Edge WebView2 Runtime; Windows Update installs it.",
  linux: "Update the libwebkit2gtk-4.1-0 package to 2.50 or later.",
};

/** Shown instead of the app when the web engine can't draw it. */
export function UnsupportedWebView({ report }: { report: WebviewReport }) {
  const { info, missing } = report;
  return (
    <main className="page">
      <h1 className="title">ICMM needs a newer web engine</h1>
      <p className="facts">
        This computer’s web engine
        {info?.version ? (
          <>
            {" "}
            (<span className="mono">{info.version}</span>)
          </>
        ) : null}{" "}
        can’t draw the app. It lacks {missing.join(", ")}.
      </p>
      <p className="facts">{(info && UPDATE[info.os]) ?? "Update your operating system."}</p>
    </main>
  );
}
