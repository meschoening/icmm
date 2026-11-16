/**
 * State graphs' layouts for drawings, laid out off the page's thread: most
 * take a few milliseconds, but a few dense ones at 14–16 states take most of
 * a second, which mustn't hold up typing. Each graph is laid out once.
 */
import { useEffect, useReducer } from "react";
import { graphKey, layOut, type Spot } from "./layout";
import type { LayoutAsked, LayoutDone } from "./layout.worker";

export interface Laid {
  numStates: number;
  edges: readonly (readonly number[])[];
}

const done = new Map<string, Spot[]>();
const waiting = new Map<string, Set<() => void>>();
/** What the worker's been asked and hasn't answered, to lay out here should it fail. */
const asked = new Map<string, Laid>();
let worker: Worker | null = null;
let workerFailed = false;

function finish({ key, spots }: LayoutDone) {
  done.set(key, spots);
  asked.delete(key);
  for (const tell of waiting.get(key) ?? []) tell();
  waiting.delete(key);
}

/** Asks for `graph`'s layout, and `tell`s when it's done; returns a way to stop waiting. */
function ask(key: string, { numStates, edges }: Laid, tell: () => void): () => void {
  let told = waiting.get(key);
  if (told === undefined) {
    told = new Set();
    waiting.set(key, told);
    if (typeof Worker === "undefined" || workerFailed) {
      // Where there are no workers (tests), just after this render.
      queueMicrotask(() => finish({ key, spots: layOut(numStates, edges) }));
    } else {
      asked.set(key, { numStates, edges });
      if (worker === null) {
        worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<LayoutDone>) => finish(e.data);
        // A worker that can't start or fails: what it was asked is laid out here.
        worker.onerror = () => {
          workerFailed = true;
          for (const [k, g] of asked) finish({ key: k, spots: layOut(g.numStates, g.edges) });
        };
      }
      worker.postMessage({ key, numStates, edges: edges.map((e) => [...e]) } satisfies LayoutAsked);
    }
  }
  told.add(tell);
  return () => told.delete(tell);
}

/** Each of `graphs`' layouts, in order, once every one is done; `undefined` until then. */
export function useLayouts(graphs: readonly Laid[]): Spot[][] | undefined {
  const keys = graphs.map((g) => graphKey(g.numStates, g.edges));
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const joined = keys.join("|");
  useEffect(() => {
    const stops = keys.flatMap((key, i) => (done.has(key) ? [] : [ask(key, graphs[i], redraw)]));
    // One done since this render, which no one was waiting to be told of.
    if (stops.length < keys.length) redraw();
    return () => stops.forEach((stop) => stop());
    // `joined` names the graphs: the same graphs in a new array ask nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return keys.every((key) => done.has(key)) ? keys.map((key) => done.get(key)!) : undefined;
}

/** `graph`'s layout now: the one laid out for a drawing, or laid out here, for a figure. */
export function laidOut(graph: Laid): Spot[] {
  const key = graphKey(graph.numStates, graph.edges);
  return done.get(key) ?? layOut(graph.numStates, graph.edges);
}
