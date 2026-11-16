/** Lays out state graphs off the page's thread (`useLayouts`): a few take a second. */
import { layOut, type Spot } from "./layout";

/** What a layout's worker is sent, and answers. */
export interface LayoutAsked {
  key: string;
  numStates: number;
  edges: number[][];
}
export interface LayoutDone {
  key: string;
  spots: Spot[];
}

// The DOM's types name the page's `self`; a worker's posts without an origin.
const worker = self as unknown as {
  onmessage: (e: MessageEvent<LayoutAsked>) => void;
  postMessage: (done: LayoutDone) => void;
};
worker.onmessage = ({ data: { key, numStates, edges } }) =>
  worker.postMessage({ key, spots: layOut(numStates, edges) });
