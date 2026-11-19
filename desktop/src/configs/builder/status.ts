/**
 * The Config builder's header status line and why Save waits
 * (LaptopConfigBuilder, #180): the section with checks to fix, what a new
 * config still needs, "No changes yet", or that all three sections are
 * valid, with the notes counted; one another computer deleted says so, and
 * saves as a new config (CF04). A save waiting for the connection, and a
 * save's failure, say so in its place, as the wizard's Review step does.
 * Its notes count is a link to the first of them (#509, F17).
 */
import { joinAnd } from "../../datasets/format";
import type { Field, FieldIssue } from "./draft";

/** The builder's three sections, and the fields in each. */
const SECTIONS: { name: string; fields: Field[] }[] = [
  { name: "01 Name & data", fields: ["name", "dataset"] },
  { name: "02 Topology", fields: ["states", "which", "sample", "ids"] },
  {
    name: "03 Optimization",
    fields: [
      "starts",
      "population",
      "evaluations",
      "seed",
      "log",
      "sobol",
      "rateMin",
      "rateMax",
      "sigmoidMin",
      "sigmoidMax",
    ],
  },
];

export interface StatusInput {
  /** Every check shown under its field: the engine's errors, a taken name, a deleted dataset. */
  errors: FieldIssue[];
  /** How many notes show under their fields. */
  notes: number;
  /** What a save still needs: "a name", "a number of states". */
  needs: string[];
  editing: boolean;
  /** Another computer deleted the config: Save as a new config saves it, changed or not. */
  deleted: boolean;
  /** How many fields differ from the config as saved; a new config's never counts. */
  changes: number;
  /** Whether a check has answered, for the fields as they are or as they were. */
  checked: boolean;
  /** The platform, as a sentence names it. */
  platform: string;
  connected: boolean;
  /** A save waits for the connection. */
  waiting: boolean;
  /** A save's working state shows. */
  saving: boolean;
  /** What the last save said, when it failed. */
  message: string | undefined;
  /** Why Save waits beyond its checks: another computer's save. */
  blocked: string | undefined;
}

export interface Status {
  text: string;
  tone: "plain" | "bad" | "wait";
  /** The check mark of a config that can be saved, or the mark of one with checks to fix. */
  mark: "ok" | "bad" | null;
  /** Why Save can't save now; `undefined` when it can. */
  blocked: string | undefined;
  /** `text` around its notes count ("1 note", "3 notes"), which links to the first of them. */
  notes?: { before: string; count: string; after: string };
}

/** "02 Topology has 3 checks to fix", or "02 Topology and 03 Optimization have 4 …". */
function checksWords(errors: FieldIssue[]): string {
  const at = SECTIONS.filter((s) => errors.some((e) => s.fields.includes(e.field)));
  const n = errors.length;
  const checks = n === 1 ? "1 check" : `${n} checks`;
  return `${joinAnd(at.map((s) => s.name))} ${at.length === 1 ? "has" : "have"} ${checks} to fix`;
}

/** "1 note", "3 notes", or nothing. */
const notesWords = (n: number) => (n === 0 ? undefined : n === 1 ? "1 note" : `${n} notes`);

export function statusOf(s: StatusInput): Status {
  const offline = `Checks run once ${s.platform} is connected`;
  let blocked: string | undefined;
  if (s.blocked !== undefined) blocked = s.blocked;
  else if (s.errors.length > 0)
    blocked = `${s.errors.length === 1 ? "1 check" : `${s.errors.length} checks`} to fix`;
  else if (s.needs.length > 0) blocked = `Needs ${joinAnd(s.needs)}`;
  else if (s.editing && !s.deleted && s.changes === 0) blocked = "No changes yet";
  else if (!s.checked) blocked = s.connected ? `Checking with ${s.platform}…` : offline;

  if (s.waiting) {
    return {
      text: `Waiting for ${s.platform} to reconnect, then this saves.`,
      tone: "wait",
      mark: null,
      blocked,
    };
  }
  if (s.saving) return { text: `Saving to ${s.platform}…`, tone: "plain", mark: null, blocked };
  if (s.message !== undefined) return { text: s.message, tone: "bad", mark: null, blocked };
  if (s.errors.length > 0)
    return { text: checksWords(s.errors), tone: "bad", mark: "bad", blocked };
  if (s.needs.length > 0) {
    return { text: `Needs ${joinAnd(s.needs)}`, tone: "plain", mark: null, blocked };
  }
  if (s.editing && !s.deleted && s.changes === 0)
    return { text: "No changes yet", tone: "plain", mark: null, blocked };
  if (!s.checked) {
    return {
      text: s.connected ? `Checking with ${s.platform}…` : offline,
      tone: "plain",
      mark: null,
      blocked,
    };
  }
  const count = notesWords(s.notes);
  const [before, after] = s.deleted
    ? ["Deleted on another computer · all three sections are valid", ""]
    : s.editing
      ? ["Unsaved changes · all three sections are valid", ""]
      : ["All three sections are valid", " · not saved yet"];
  return {
    text: count === undefined ? before + after : `${before} · ${count}${after}`,
    tone: "plain",
    mark: blocked === undefined && !s.deleted ? "ok" : null,
    blocked,
    notes: count === undefined ? undefined : { before: `${before} · `, count, after },
  };
}
