/** A topology drawing's scale, and where its states sit in it, in px (#212). */
import type { Spot } from "./layout";

/** A drawing's scale, in px: its states across, neighbors' centers apart, and its numbers' size. */
export interface DrawingSize {
  state: number;
  gap: number;
  font: number;
}

/** Specific IDs' read-back: 20 px states 28 px apart at every number of states. */
export const SPECIFIC_IDS: DrawingSize = { state: 20, gap: 28, font: 10.5 };

/** Find custom topology's drawings (#222): 28 px states 56 px apart. */
export const FIND_TOPOLOGY: DrawingSize = { state: 28, gap: 56, font: 12.5 };

/** Topology's Structure (#233): 27 px states 38 px apart. */
export const TOPOLOGY_PAGE: DrawingSize = { state: 27, gap: 38, font: 11.5 };

/** How far a ring sits out from its state's edge, in px. */
export const RING = 3.5;

/** Where each state's center sits in a drawing, and the drawing's size, in px. */
export function placed(spots: Spot[], size: DrawingSize) {
  // A state's radius and 2 px from each side; a ring spills into whatever holds the drawing.
  const pad = size.state / 2 + 2;
  const at = spots.map((s) => ({
    x: Math.round((s.x * size.gap + pad) * 10) / 10,
    y: Math.round((s.y * size.gap + pad) * 10) / 10,
  }));
  const width = Math.ceil(Math.max(...at.map((p) => p.x)) + pad);
  const height = Math.ceil(Math.max(...at.map((p) => p.y)) + pad);
  return { at, width, height };
}

/** A drawing's size in px at `size`, its states at `spots`: what a box that holds several needs. */
export function drawingBox(spots: Spot[], size: DrawingSize): { width: number; height: number } {
  const { width, height } = placed(spots, size);
  return { width, height };
}
