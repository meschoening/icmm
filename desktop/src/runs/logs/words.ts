/**
 * What the log view says (LaptopLogs, #288; built in #289): a Start log's
 * lines in the Log box's columns, a job log's lines with its error line, a
 * log's size, the try switch's and the generation select's words, and the
 * line that ends a log once its try or generation has ended.
 */
import { whole } from "../../configs/words";
import { durationWords } from "../../submit/estimate";
import { clock } from "../../ui/clock";
import type { CoordinatingJob, RunFailure, StartTry } from "../../wire/types.gen";
import { logTable, logText, OVERFLOWED } from "../start/words";
import { ordinal } from "../topology/words";

export { logTable, logText };

const at = (iso: string | null) => (iso === null ? NaN : Date.parse(iso));

/** A line of a job log, with whether it's the error the log ends on. */
export interface TextLine {
  t: string;
  err: boolean;
}

/** A Python traceback's exception, as it ends one: `RuntimeError: …`, flush left. */
const EXCEPTION = /^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b/;

/**
 * A job log's text as its lines, the one it ends on red: its last
 * traceback's exception, or else its last line flush left that says it's an
 * error, as slurmstepd's do.
 */
export function textLines(text: string): TextLine[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const traceback = lines.lastIndexOf("Traceback (most recent call last):");
  let err = -1;
  if (traceback >= 0) {
    err = lines.findIndex((l, i) => i > traceback && EXCEPTION.test(l));
  }
  if (err < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\S/.test(lines[i]) && /error/i.test(lines[i])) {
        err = i;
        break;
      }
    }
  }
  return lines.map((t, i) => ({ t, err: i === err }));
}

/** A log's size: "0 bytes", "812 bytes", "1.4 KB", "131 KB", "1.9 MB". */
export function bytesWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const [n, unit] = bytes < 1_000_000 ? [bytes / 1000, "KB"] : [bytes / 1_000_000, "MB"];
  return `${n < 9.95 ? n.toFixed(1) : Math.round(n)} ${unit}`;
}

/** "1st try", "2nd try". */
export const tryWords = (n: number) => `${ordinal(n)} try`;

/**
 * How a try ended, for the line that ends its log: "start 71 ended 9:06 AM,
 * exit code 1", or for a lost one, "node c03 failed at generation 8,240
 * (NODE_FAIL), the 3rd time a node failed under start 72". `generation` is
 * the last its Start log logged, where that's what's shown.
 */
export function tryEnd(
  start: number,
  t: StartTry,
  tries: StartTry[],
  generation: number | undefined,
  now: number,
): string {
  const gen = generation === undefined ? "" : ` at generation ${whole(generation)}`;
  if (t.cause === "lost") {
    if (t.node === null) return `the cluster lost start ${start}${gen}`;
    const state = t.scheduler_state === null ? "" : ` (${t.scheduler_state})`;
    const times = tries.filter((x) => x.cause === "lost" && x.try_number <= t.try_number).length;
    const again =
      times > 1 ? `, the ${ordinal(times)} time a node failed under start ${start}` : "";
    return `node ${t.node} failed${gen}${state}${again}`;
  }
  const ended = at(t.ended_at);
  const when = Number.isNaN(ended) ? "" : ` ${clock(ended, now)}`;
  const exit = t.exit_code === null ? "" : `, exit code ${t.exit_code}`;
  switch (t.cause) {
    case "error":
      return `start ${start} ended${when}${gen}${exit}`;
    case "time_limit":
      return `start ${start} hit its time limit${when}${gen}`;
    case "out_of_memory":
      return `start ${start} ran out of memory${when}${gen}`;
  }
  switch (t.end_reason) {
    case "canceled":
      return `start ${start} was canceled${when}${gen}`;
    case "budget":
      return `start ${start} finished${when}${gen}`;
    case "overflow":
      return `start ${start} finished${when}${gen}: ${OVERFLOWED}`;
  }
  // Stopped before it wrote its result: how isn't known.
  return `start ${start} ended${when}${gen}`;
}

/** Whether a generation failed: it exited with an error, or was killed before it made progress. */
const failed = (j: CoordinatingJob) =>
  j.ended_at !== null && (j.exit_code === null ? !j.progressed : j.exit_code !== 0);

/** How long a generation ran, from when it claimed the run: "after 2 m". */
const ranFor = (j: CoordinatingJob) => {
  const from = at(j.started_at);
  const to = at(j.ended_at);
  return Number.isNaN(from) || Number.isNaN(to)
    ? ""
    : ` after ${durationWords((to - from) / 1000)}`;
};

/** A generation as the select lists it: "Generation 9 · failed after 2 m · Wed 10:31 AM". */
export function generationWords(j: CoordinatingJob, now: number): string {
  const head = `Generation ${j.generation}`;
  if (j.ended_at === null) {
    const since = at(j.started_at);
    return Number.isNaN(since)
      ? `${head} · starting`
      : `${head} · running since ${clock(since, now)}`;
  }
  return `${head} · ${failed(j) ? "failed" : "ended"}${ranFor(j)} · ${clock(at(j.ended_at), now)}`;
}

/** How a generation ended, for the line that ends its log: "generation 9 ended 10:31 AM after 2 m, exit code 1". */
export function generationEnd(j: CoordinatingJob, now: number): string {
  const exit = j.exit_code === null ? "" : `, exit code ${j.exit_code}`;
  return `generation ${j.generation} ended ${clock(at(j.ended_at), now)}${ranFor(j)}${exit}`;
}

/**
 * The generation the select opens on: the latest, or in a run its
 * coordinating jobs failed, the latest that failed, whose log says why.
 */
export function chosenGeneration(
  jobs: CoordinatingJob[],
  cause: RunFailure["cause"] | null,
): number | undefined {
  const latest = jobs[0]?.generation;
  if (cause !== "coordinator") return latest;
  return jobs.find(failed)?.generation ?? latest;
}
