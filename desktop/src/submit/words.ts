/**
 * What Submit run says in words (LaptopSubmitRun): why its button can't be
 * pressed, the three lines of a submit that was refused or couldn't be
 * confirmed, and a config's run status. Pure, so each state can be tested
 * without a platform.
 */
import { submitBlocker } from "../configs/words";
import { failureOf } from "../failure";
import { asSubject, failureBox, inSentence, type FailureBox } from "../setup/form";
import { monthDay } from "../ui/clock";
import type {
  ConfigDataset,
  ConfigRun,
  RunState,
  SavedPlatform,
  UnreadableError,
} from "../wire/types.gen";
import { freeWords } from "./estimate";

/** A platform as a sentence names it. */
type PlatformName = Pick<SavedPlatform, "type" | "name">;

/** The config the page is on, as far as it has been read. */
export type SubmitConfig =
  /** The platform has no config. */
  | { kind: "none" }
  /** The chosen config was deleted, or this platform never had it. */
  | { kind: "not_found" }
  /** Listed, and its settings are being read. */
  | { kind: "loading"; name: string }
  /** Its read failed. */
  | { kind: "failed"; name: string }
  /** A newer ICMM saved it, or it's damaged. */
  | { kind: "unreadable"; name: string; error: UnreadableError }
  /** Read; its dataset is the one a run would fit. */
  | { kind: "ready"; name: string; dataset: ConfigDataset };

/** What decides whether Submit run can be pressed. */
export interface SubmitState {
  platform: PlatformName;
  /** The agent can be asked: the connection is up. */
  live: boolean;
  config: SubmitConfig;
  /** The platform's Data folder has no Platform settings yet. */
  settingsMissing: boolean;
}

/** What is under Submit run: the reason, and whether it is one that blocks the button. */
export interface SubmitReason {
  why: string;
  /** Something is in the way: Submit run is gray, and `why` says what. */
  blocked: boolean;
  /** Above `why` when nothing is in the way: the run doesn't need ICMM open (#324, SR02). */
  keep?: string;
}

/** The note when nothing is in the way. */
const CANCEL: SubmitReason = {
  keep: "It keeps going if you close ICMM.",
  why: "You can cancel it from the run page at any time.",
  blocked: false,
};

const blocks = (why: string): SubmitReason => ({ why, blocked: true });

/**
 * The reason under Submit run: the first thing in the way, which blocks it,
 * or that a run can be canceled from its page, which doesn't.
 */
export function submitReason(s: SubmitState): SubmitReason {
  if (!s.live) return blocks(`Connect to ${inSentence(s.platform)} to submit`);
  const c = s.config;
  switch (c.kind) {
    case "none":
      return blocks("Needs a config");
    case "not_found":
      return blocks("Choose another config to submit");
    case "unreadable":
      return blocks(
        c.error.data.problem === "newer"
          ? `${c.name} was saved by a newer ICMM. Update ICMM on this computer to submit it.`
          : `ICMM can’t read ${c.name}.`,
      );
    case "loading":
      return blocks(`Waiting for ${c.name} to load`);
    case "failed":
      return blocks(`ICMM couldn’t read ${c.name}`);
    case "ready":
      break;
  }
  const dataset = c.kind === "ready" ? submitBlocker(c.dataset, "Edit config") : undefined;
  if (dataset !== undefined) return blocks(dataset);
  if (s.settingsMissing) return blocks(`Set up ${inSentence(s.platform)} to submit`);
  return CANCEL;
}

/** A detail of a refusal for the raw line: what it names, apart from its sentence. */
function detailOf(e: { code?: string; data?: Record<string, unknown> }): string | undefined {
  const d = e.data ?? {};
  const words = (...parts: unknown[]) =>
    parts.filter((x): x is string => typeof x === "string" && x !== "").join(" ") || undefined;
  switch (e.code) {
    case "not_found":
      return words(d.kind, d.id);
    case "invalid": {
      const issues = Array.isArray(d.issues) ? (d.issues as { path?: string[] }[]) : [];
      return (
        issues
          .map((i) => (i.path ?? []).join("."))
          .filter((p) => p !== "")
          .join(", ") || undefined
      );
    }
    case "unreadable":
      return words(d.details);
    case "conflict":
      return words(d.reason);
    case "unavailable":
      return words(d.source);
  }
  return undefined;
}

/** Answers the agent gives before it records anything: the submit made no run. */
const REFUSALS = ["not_found", "invalid", "unreadable", "conflict", "unavailable"];

/**
 * A submit that didn't land, as its box says it (#116's three lines): a full
 * Data folder or a refusal says nothing was submitted; an answer lost says
 * the run may have been, and that submitting again makes no second one, since
 * it sends the same key (ADR-0009). `dataFolder` is the folder as the
 * platform's settings write it; `connected` says whether the retry can be
 * sent now (the page's connection, so a box and its state agree).
 */
export function refusedBox(
  error: unknown,
  platform: PlatformName,
  dataFolder: string,
  connected: boolean,
): FailureBox {
  const e = (error ?? {}) as { code?: string; message?: unknown; data?: Record<string, unknown> };
  const box = { report: false, retry: false } as const;
  const nothing = "Nothing was submitted, so you won’t get two runs.";
  if (e.code === "no_space") {
    const free = e.data?.free_bytes;
    // The disk can't always be read: its free space is then left out.
    const left = typeof free === "number" ? `${freeWords(free)} free` : undefined;
    return {
      what: `${asSubject(platform)}’s Data folder, ${dataFolder}, is full, so the run wasn’t recorded.`,
      next: `Free some space in ${dataFolder.startsWith("~/") ? "your home folder" : dataFolder}, then submit again. ${nothing}`,
      raw: ["no_space", left, dataFolder].filter((x) => x !== undefined).join(" · "),
      ...box,
    };
  }
  if (e.code === "not_connected" || e.code === "timeout") {
    const once = connected ? "" : ` once ${inSentence(platform)} is connected`;
    return {
      what: "Couldn’t confirm the run was submitted.",
      next: `Submitting again is safe${once}: it won’t make a second run.`,
      raw: e.code,
      ...box,
    };
  }
  if (e.code !== undefined && REFUSALS.includes(e.code)) {
    const detail = detailOf(e);
    return {
      // An invalid answer's sentence is its issues'; with none, the agent's own.
      what:
        failureOf(error, () => undefined).message ??
        (typeof e.message === "string" ? e.message : `Something went wrong: ${String(error)}`),
      next:
        e.code === "unavailable"
          ? "Submit again in a moment; it won’t make a second run."
          : nothing,
      raw: detail === undefined ? e.code : `${e.code} · ${detail}`,
      ...box,
    };
  }
  return failureBox(error, "submit", platform);
}

/** The glyph of each state a run is in (status.css): the glyph carries the state. */
const GLYPHS: Record<RunState, string> = {
  running: "g g-running live",
  queued: "g g-queued",
  held: "g g-held",
  completed: "g g-completed",
  failed: "g g-failed",
  canceled: "g g-canceled",
};

/** The glyph of a run's state, as its class names it. */
export const runGlyph = (state: RunState): string => GLYPHS[state];

/** The states a run is in flight in: only these show their glyph in a config's run status. */
const IN_FLIGHT: RunState[] = ["running", "queued", "held"];

/** A config's newest run as a status: a glyph for one in flight, else when the last ended. */
export function runStatus(
  r: ConfigRun | null,
  now: number,
): { glyph?: string; run?: string; word: string } {
  if (r === null) return { word: "no runs yet" };
  if (IN_FLIGHT.includes(r.state))
    return { glyph: GLYPHS[r.state], run: `#${r.id}`, word: r.state };
  // An ended run has its end time; one without would be the agent's mistake, shown as its state.
  if (r.ended_at === null) return { run: `#${r.id}`, word: r.state };
  return { word: `last run ${monthDay(Date.parse(r.ended_at), now)}` };
}
