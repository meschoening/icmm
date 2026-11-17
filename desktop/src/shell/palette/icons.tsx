/** ⌘K's marks for Do's rows (LaptopCommandPalette's `icons()`). */
import type { ReactNode } from "react";

const svg = (children: ReactNode, box = "0 0 16 16", size = 16) => (
  <svg width={size} height={size} viewBox={box} fill="none" aria-hidden="true">
    {children}
  </svg>
);
const line = (d: string, w = 1.3) => <path d={d} stroke="currentColor" strokeWidth={w} />;

/** A plug: Connect to the platform (LaptopCommandPalette's `conn`, KF14). */
export function ConnectIcon() {
  return svg(
    <>
      {line("M5.5 1.5v3M10.5 1.5v3")}
      {line("M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0zM8 11.5v3")}
    </>,
  );
}

/** A plus: every "New …" (LaptopCommandPalette's `plus`). */
export function PlusIcon() {
  return svg(line("M8 2.5v11M2.5 8h11", 1.4));
}

export function ProtocolIcon() {
  return svg(line("M1.5 11.5h3v-7h4v5h3v-3h3"));
}

export function ImportIcon() {
  return svg(
    <>
      {line("M8 1.5v8m0 0-3-3m3 3 3-3")}
      {line("M2.5 10.5v3h11v-3")}
    </>,
  );
}

export function ExportIcon() {
  return svg(
    <>
      {line("M8 9.5v-8m0 0-3 3m3-3 3 3")}
      {line("M2.5 10.5v3h11v-3")}
    </>,
  );
}

export function CompareIcon() {
  return svg(
    line(
      "M2.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM10.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z",
    ),
  );
}

export function SwitchIcon() {
  return svg(line("M2 5h9.5m0 0-2.5-2.5M11.5 5 9 7.5M14 11H4.5m0 0L7 8.5M4.5 11 7 13.5"));
}

export function SettingsIcon() {
  return svg(
    <>
      {line("M3 5h1.2M7.8 5H15M3 9h7.2M13.8 9H15M3 13h3.2M9.8 13H15", 1.4)}
      <circle cx="6" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    </>,
    "0 0 18 18",
  );
}

/** Three states, two transitions: Find custom topology's mark. */
export function TopologyIcon() {
  return svg(
    <>
      <circle cx="3.5" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.5" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.5" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      {line("M5.3 7.1 10.7 4.4M5.3 8.9l5.4 2.7M12.5 5.5v5")}
    </>,
  );
}

/** A flag: Report a problem… (LaptopCommandPalette's `rep`, #470). */
export function ReportIcon() {
  return svg(
    <>
      {line("M3.5 14.5V2")}
      {line("M3.5 2.5h8.5l-2 3 2 3H3.5")}
    </>,
  );
}
