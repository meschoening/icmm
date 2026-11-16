/**
 * A decay time's window (#50), the same on the wizard's Protocols step and
 * in the Protocol builder: the Window menu, Other…'s two fields, the sketch
 * of what's timed and its sentence. The presets are words over the two
 * fractions the dataset stores (ADR-0010): the menu shows one when the
 * fractions match it, else Other….
 */
import { useState, type ReactNode } from "react";
import { DecaySketch } from "./charts";
import { Checking } from "./Checking";
import { parsed } from "./draft";
import { WINDOWS, windowValid, windowWords } from "./words";

type Preset = keyof typeof WINDOWS;

export function WindowControl({
  from,
  to,
  menuId,
  menuLabel,
  onPreset,
  issue,
  checking = false,
  children,
}: {
  /** As typed, in percent of the peak. */
  from: string;
  to: string;
  /** The menu's id, for a `<label>` beside it, or its name when there's none. */
  menuId?: string;
  menuLabel?: string;
  onPreset: (window: { from: string; to: string }) => void;
  /** The window's issue: under its sentence, or that sentence in red when it's the rule's. */
  issue?: string;
  /** The issue is the checks' last answer, asked again (#424 KF21). */
  checking?: boolean;
  /** Other…'s two fields, shown while it's chosen. */
  children: ReactNode;
}) {
  const a = parsed(from) ?? Number.NaN;
  const b = parsed(to) ?? Number.NaN;
  // A refused window says its rule once, in %, not the checks' fractions too (#168).
  const refused = issue !== undefined && !windowValid(a, b);
  const entries = Object.entries(WINDOWS) as [Preset, (typeof WINDOWS)[Preset]][];
  const found = entries.find(([, w]) => Number(w.from) === a && Number(w.to) === b);
  /** Other… chosen: its two fractions show, whatever they are. */
  const [other, setOther] = useState(false);
  const preset = other ? "other" : (found?.[0] ?? "other");
  return (
    <>
      <select
        id={menuId}
        className="input input-sm window-menu"
        aria-label={menuLabel}
        value={preset}
        onChange={(e) => {
          const w = WINDOWS[e.target.value as Preset];
          setOther(w === undefined);
          if (w !== undefined) onPreset({ from: w.from, to: w.to });
        }}
      >
        {entries.map(([key, w]) => (
          <option key={key} value={key}>
            {w.label}
          </option>
        ))}
        <option value="other">Other…</option>
      </select>
      {preset === "other" && children}
      <DecaySketch from={a} to={b} />
      <span className={`${refused ? "err" : "hint"} window-words`}>{windowWords(a, b)}</span>
      {issue && !refused && (
        <span className={checking ? "err chk" : "err"}>
          {issue}
          {checking && <Checking />}
        </span>
      )}
    </>
  );
}
