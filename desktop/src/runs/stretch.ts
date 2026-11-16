/** Where things sit in a chart that stretches with the window (`StretchChart.tsx`). */

/** The plot's width in its own units, whatever its width on the page. */
export const SPAN = 1000;

/** Where `f` of the way across the plot sits, from the frame's left edge: past the 48 px axis. */
export const across = (f: number) => `calc(48px + (100% - 52px) * ${f.toFixed(4)})`;

/**
 * A dot at (`x`, `y`) in the plot's units: a round-cap stroke too short to see. Not zero-length:
 * WebKit stretches a zero-length stroke's caps with the plot, so its dots would widen with the window.
 */
export const dotAt = (x: number, y: number) => `M${x.toFixed(1)} ${y.toFixed(1)}h0.01`;
