/**
 * Where each state of a state graph sits in its drawing (#212): in units of
 * the distance between neighboring states, x to the right and y down, the
 * leftmost state at x 0 and the topmost at y 0.
 *
 * States go in columns by their distance from one end of the graph's longest
 * chain, so that a chain reads left to right as papers draw schemes
 * (`layered`). A graph whose columns would cross, run an edge through a
 * state, or stretch goes on a grid instead, where no edge crosses another
 * (`onGrid`): every ICMM state graph is planar, since no loop through more
 * than 4 states rules out K₅ and K₃,₃. Neither depends on the open state, so
 * a graph draws the same at each of its topologies.
 *
 * `layered` and the test that sends a graph to the grid are the prototype's
 * (`prototypes/212-topology-drawings/tools/layout.py` on
 * `prototype/212-topology-drawings`), ported exactly: they draw what the
 * folded board drew. The grid search is new: the prototype's annealing left
 * one graph in four to eight that went on the grid crossed, and took seconds.
 */

/** A state's place, in units of the distance between neighboring states. */
export interface Spot {
  x: number;
  y: number;
}

/** Two states joined by a transition. */
type Edge = readonly [number, number];

const laidOut = new Map<string, readonly Spot[]>();

/**
 * Where each of a state graph's `numStates` states sits. Kept per graph, so a
 * graph is laid out once however often it's drawn.
 */
export function layOut(numStates: number, edges: readonly (readonly number[])[]): Spot[] {
  const sorted = sortedEdges(edges);
  const key = graphKey(numStates, edges);
  let spots = laidOut.get(key);
  if (spots === undefined) {
    const columns = layered(numStates, sorted);
    // Columns crossed even on the grid would still show every state and edge.
    spots =
      cost(numStates, sorted, columns) < FAULT ? columns : (onGrid(numStates, sorted) ?? columns);
    laidOut.set(key, spots);
  }
  return spots.map((s) => ({ ...s }));
}

/**
 * Where each state of any connected graph sits, quickly: a typed topology
 * that breaks ICMM's rules (#222) may have no drawing on the grid at all
 * (K₅, the Petersen graph), where `layOut`'s searches take seconds to
 * minutes. On the grid if the grid's quick beam search finds a clean drawing
 * for a graph of at most 16 states with at most 4 neighbors each, as it does
 * a ladder; else in columns, crossed or not.
 */
export function layOutAny(numStates: number, edges: readonly (readonly number[])[]): Spot[] {
  const sorted = sortedEdges(edges);
  const key = `any ${graphKey(numStates, edges)}`;
  let spots = laidOut.get(key);
  if (spots === undefined) {
    const small = numStates <= 16 && neighborsOf(numStates, sorted).every((a) => a.length <= 4);
    spots = (small ? onGrid(numStates, sorted, true) : null) ?? layered(numStates, sorted);
    laidOut.set(key, spots);
  }
  return spots.map((s) => ({ ...s }));
}

/** Each edge lower state first, in order: a graph's edges however they came. */
function sortedEdges(edges: readonly (readonly number[])[]): Edge[] {
  return edges
    .map(([a, b]) => (a < b ? [a, b] : [b, a]) as unknown as Edge)
    .sort((e, f) => e[0] - f[0] || e[1] - f[1]);
}

/** A state graph's name for its layout: the same however its edges came. */
export function graphKey(numStates: number, edges: readonly (readonly number[])[]): string {
  return `${numStates}:${sortedEdges(edges).join(" ")}`;
}

// ---- Columns from one end of the longest chain (the prototype's `layered`) ----

function neighborsOf(n: number, edges: readonly Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj.map((states) => states.sort((a, b) => a - b));
}

/** Each state's distance from `from`, in edges. */
function distances(adj: number[][], from: number): number[] {
  const dist = adj.map(() => -1);
  dist[from] = 0;
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const t of adj[queue[i]]) {
      if (dist[t] < 0) {
        dist[t] = dist[queue[i]] + 1;
        queue.push(t);
      }
    }
  }
  return dist;
}

/** One end of the graph's longest chain: the lowest-numbered state farthest from another. */
function chainEnd(adj: number[][]): { end: number; column: number[] } {
  const all = adj.map((_, s) => distances(adj, s));
  const reach = all.map((d) => Math.max(...d));
  let end = 0;
  for (let s = 1; s < adj.length; s++) if (reach[s] > reach[end]) end = s;
  return { end, column: all[end] };
}

/**
 * Python's `sum` of floats, which the prototype's heights add with: since
 * 3.12, Neumaier's compensated sum. A plain sum can differ in its last bit,
 * and move a state the board drew.
 */
function pythonSum(xs: number[]): number {
  let sum = xs[0];
  let c = 0;
  for (const x of xs.slice(1)) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return c !== 0 && Number.isFinite(c) ? sum + c : sum;
}

/**
 * States in columns by their distance from one end of the longest chain, each
 * column ordered by sweeps toward its neighbors' places, then each state
 * pulled toward its neighbors' heights, at least one unit from the states
 * beside it in its column.
 */
function layered(n: number, edges: readonly Edge[]): Spot[] {
  const adj = neighborsOf(n, edges);
  const { column: x } = chainEnd(adj);
  const columns: number[][] = Array.from({ length: Math.max(...x) + 1 }, () => []);
  for (let s = 0; s < n; s++) columns[x[s]].push(s);
  const place: number[] = [];
  const number = () => columns.forEach((col) => col.forEach((s, i) => (place[s] = i)));
  number();
  // Each state's neighbors' mean place in the column on `side`, or its own place without any.
  const mean = (s: number, side: number) => {
    const nb = adj[s].filter((t) => x[t] === x[s] + side).map((t) => place[t]);
    return nb.length > 0 ? nb.reduce((a, b) => a + b, 0) / nb.length : place[s];
  };
  const K = columns.length;
  for (let sweep = 0; sweep < 8; sweep++) {
    const right = sweep % 2 === 0;
    for (let i = 0; i < K - 1; i++) {
      const k = right ? i + 1 : K - 2 - i;
      const keyed = columns[k].map((s) => [mean(s, right ? -1 : 1), s] as const);
      columns[k] = keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, s]) => s);
      columns[k].forEach((s, j) => (place[s] = j));
    }
  }
  const y: number[] = [];
  for (const col of columns) col.forEach((s, i) => (y[s] = i - (col.length - 1) / 2));
  for (let pass = 0; pass < 20; pass++) {
    for (let i = 0; i < K; i++) {
      const col = columns[pass % 2 === 0 ? i : K - 1 - i];
      const wanted = col.map((s) => {
        const nb = adj[s].filter((t) => x[t] !== x[s]).map((t) => y[t]);
        return nb.length > 0 ? pythonSum(nb) / nb.length : y[s];
      });
      // As near the wanted heights as a gap of 1 allows: pool adjacent violators.
      const blocks: { sum: number; count: number; members: number[] }[] = [];
      wanted.forEach((w, j) => {
        blocks.push({ sum: w - j, count: 1, members: [j] });
        for (let b = blocks.length; b > 1; b = blocks.length) {
          const [prev, last] = [blocks[b - 2], blocks[b - 1]];
          if (prev.sum / prev.count < last.sum / last.count) break;
          blocks.pop();
          prev.sum += last.sum;
          prev.count += last.count;
          prev.members.push(...last.members);
        }
      });
      for (const { sum, count, members } of blocks) {
        for (const j of members) y[col[j]] = sum / count + j;
      }
    }
  }
  const top = Math.min(...y);
  return Array.from({ length: n }, (_, s) => ({ x: x[s], y: y[s] - top }));
}

// ---- The prototype's measure of a drawing ----

/** A crossing, an edge through a state, or an edge along another: past it, a drawing's faulted. */
const FAULT = 1000;

/** Which side of a–b c is on: 1, −1, or 0 within rounding. */
function side(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

/** Do a–b and c–d cross, or overlap along one line? */
function crosses(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  // Apart, side by side or one above the other: the quick answer for most pairs.
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) return false;
  if (Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) return false;
  const c = side(ax, ay, bx, by, cx, cy);
  const d = side(ax, ay, bx, by, dx, dy);
  if (c * d < 0 && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0) return true;
  if (c !== 0 || d !== 0) return false;
  const [p, q, r, s] = ax === bx ? [ay, by, cy, dy] : [ax, bx, cx, dx];
  return Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s)) > 1e-9;
}

/** Does a–b pass within half a unit of c, away from its ends? */
function through(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  if (cx < Math.min(ax, bx) - 0.5 || cx > Math.max(ax, bx) + 0.5) return false;
  if (cy < Math.min(ay, by) - 0.5 || cy > Math.max(ay, by) + 0.5) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const t = ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy);
  if (t <= 0.02 || t >= 0.98) return false;
  const px = ax + t * dx - cx;
  const py = ay + t * dy - cy;
  return px * px + py * py < 0.25;
}

/** Do two edges from o, to u and to v, lie along each other? */
function along(ox: number, oy: number, ux: number, uy: number, vx: number, vy: number): boolean {
  const [ax, ay, bx, by] = [ux - ox, uy - oy, vx - ox, vy - oy];
  return ax * by - ay * bx === 0 && ax * bx + ay * by > 0;
}

/** Are two edges from o, to u and to v, under 30° apart? */
function narrow(ox: number, oy: number, ux: number, uy: number, vx: number, vy: number): boolean {
  const [ax, ay, bx, by] = [ux - ox, uy - oy, vx - ox, vy - oy];
  const dot = ax * bx + ay * by;
  return dot > 0 && Math.abs(ax * by - ay * bx) < 0.58 * dot;
}

/**
 * The prototype's measure: short level edges, no narrow angles, a low wide
 * drawing, and `FAULT` for each crossing, edge through a state, or edge along
 * another. A layered drawing that reaches `FAULT` goes on the grid.
 */
function cost(n: number, edges: readonly Edge[], at: Spot[]): number {
  let c = 0;
  edges.forEach(([a, b], i) => {
    const [p, q] = [at[a], at[b]];
    const dx = Math.abs(p.x - q.x);
    const dy = Math.abs(p.y - q.y);
    c += 5 * (dx * dx + dy * dy - 1);
    if (dx && dy) c += dx === dy ? 1.5 : 6;
    for (const [a2, b2] of edges.slice(i + 1)) {
      const [r, s] = [at[a2], at[b2]];
      const shared = a === a2 || a === b2 ? a : b === a2 || b === b2 ? b : -1;
      if (shared < 0) {
        if (crosses(p.x, p.y, q.x, q.y, r.x, r.y, s.x, s.y)) c += FAULT;
        continue;
      }
      const [o, u, v] = [at[shared], at[a === shared ? b : a], at[a2 === shared ? b2 : a2]];
      if (along(o.x, o.y, u.x, u.y, v.x, v.y)) c += FAULT;
      else if (narrow(o.x, o.y, u.x, u.y, v.x, v.y)) c += 30;
    }
    for (let k = 0; k < n; k++) {
      if (k !== a && k !== b && through(p.x, p.y, q.x, q.y, at[k].x, at[k].y)) c += FAULT;
    }
  });
  const xs = at.map((s) => s.x);
  const ys = at.map((s) => s.y);
  return c + (Math.max(...xs) - Math.min(...xs)) + 10 * (Math.max(...ys) - Math.min(...ys));
}

// ---- On a grid, with no crossing ----

/** A search's graph and the states it has placed so far. */
interface Board {
  n: number;
  /** Each edge's ends, by its place in the sorted edges. */
  from: number[];
  to: number[];
  adj: number[][];
  /** Each state's edges, by their place. */
  incident: number[][];
  /** Each state's column in `layered`: the grid keeps states near it. */
  column: number[];
  /**
   * For each state, the states it shares a loop with: its 2-connected pieces
   * of more than one edge (a triangle, a square, K₄, K₂,₃…), joined.
   */
  looped: Set<number>[];
  x: number[];
  y: number[];
  placed: boolean[];
  /** The state at each spot taken, by `spot(x, y)`. */
  taken: Map<number, number>;
}

const spot = (x: number, y: number) => (x + 1024) * 2048 + (y + 1024);

function boardOf(n: number, edges: readonly Edge[]): Board {
  const adj = neighborsOf(n, edges);
  const incident: number[][] = Array.from({ length: n }, () => []);
  edges.forEach(([a, b], i) => {
    incident[a].push(i);
    incident[b].push(i);
  });
  return {
    n,
    from: edges.map((e) => e[0]),
    to: edges.map((e) => e[1]),
    adj,
    incident,
    column: chainEnd(adj).column,
    looped: loopsOf(adj),
    x: Array<number>(n).fill(0),
    y: Array<number>(n).fill(0),
    placed: Array<boolean>(n).fill(false),
    taken: new Map(),
  };
}

/**
 * Each state's loop-mates: the states of its 2-connected pieces (Tarjan's
 * blocks) bigger than one edge.
 */
function loopsOf(adj: number[][]): Set<number>[] {
  const n = adj.length;
  const looped = adj.map(() => new Set<number>());
  const order = Array<number>(n).fill(-1);
  const low = Array<number>(n).fill(0);
  const stack: [number, number][] = [];
  let time = 0;
  const visit = (u: number, parent: number) => {
    order[u] = low[u] = time++;
    for (const v of adj[u]) {
      if (order[v] < 0) {
        stack.push([u, v]);
        visit(v, u);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] < order[u]) continue;
        // u cuts off v's piece: its edges are the stack's down to u–v.
        const piece = new Set<number>();
        let edges = 0;
        for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
          piece.add(e[0]).add(e[1]);
          edges++;
          if (e[0] === u && e[1] === v) break;
        }
        if (edges > 1) for (const s of piece) for (const t of piece) if (s !== t) looped[s].add(t);
      } else if (v !== parent && order[v] < order[u]) {
        stack.push([u, v]);
        low[u] = Math.min(low[u], order[v]);
      }
    }
  };
  visit(0, -1);
  return looped;
}

function put(b: Board, v: number, x: number, y: number) {
  b.x[v] = x;
  b.y[v] = y;
  b.placed[v] = true;
  b.taken.set(spot(x, y), v);
}

function lift(b: Board, v: number) {
  b.placed[v] = false;
  b.taken.delete(spot(b.x[v], b.y[v]));
}

/** Is (x, y) free, with no placed edge but `v`'s passing through it? */
function spotClear(b: Board, x: number, y: number, v: number): boolean {
  if (b.taken.has(spot(x, y))) return false;
  const { from, to, placed } = b;
  for (let i = 0; i < from.length; i++) {
    const [c, d] = [from[i], to[i]];
    if (c === v || d === v || !placed[c] || !placed[d]) continue;
    if (through(b.x[c], b.y[c], b.x[d], b.y[d], x, y)) return false;
  }
  return true;
}

/**
 * Can an edge run from (x, y), where state `v` would sit (−1 for one not yet
 * known), to placed state `a`: crossing no placed edge, along none of `a`'s,
 * and through no placed state?
 */
function edgeClear(b: Board, x: number, y: number, v: number, a: number): boolean {
  const { from, to, placed } = b;
  const ax = b.x[a];
  const ay = b.y[a];
  for (let i = 0; i < from.length; i++) {
    const [c, d] = [from[i], to[i]];
    if (c === v || d === v || !placed[c] || !placed[d]) continue;
    if (c === a || d === a) {
      const o = c === a ? d : c;
      if (along(ax, ay, x, y, b.x[o], b.y[o])) return false;
    } else if (crosses(x, y, ax, ay, b.x[c], b.y[c], b.x[d], b.y[d])) {
      return false;
    }
  }
  for (let k = 0; k < b.n; k++) {
    if (k !== v && k !== a && placed[k] && through(x, y, ax, ay, b.x[k], b.y[k])) return false;
  }
  return true;
}

/** Can state `v` sit at (x, y), with its edges to `mine`, its placed neighbors? */
function fits(b: Board, v: number, mine: number[], x: number, y: number): boolean {
  if (!spotClear(b, x, y, v)) return false;
  for (let i = 0; i < mine.length; i++) {
    if (!edgeClear(b, x, y, v, mine[i])) return false;
    // Nor may two of its own edges lie along each other.
    for (let j = i + 1; j < mine.length; j++) {
      const [u, w] = [mine[i], mine[j]];
      if (along(x, y, b.x[u], b.y[u], b.x[w], b.y[w])) return false;
    }
  }
  return true;
}

/** `v`'s placed neighbors. */
const placedOf = (b: Board, v: number) => b.adj[v].filter((a) => b.placed[a]);

/**
 * The prototype's measure, without faults, of what's placed: never less once
 * more is placed, so a search can stop a branch that can't beat its best.
 */
function measure(b: Board): number {
  const { from, to, placed, x, y } = b;
  let c = 0;
  let [x1, x2, y1, y2] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let s = 0; s < b.n; s++) {
    if (!placed[s]) continue;
    c += 2 * Math.abs(x[s] - b.column[s]);
    x1 = Math.min(x1, x[s]);
    x2 = Math.max(x2, x[s]);
    y1 = Math.min(y1, y[s]);
    y2 = Math.max(y2, y[s]);
    // Each pair of its placed edges under 30° apart.
    const mine = b.incident[s];
    for (let i = 0; i < mine.length; i++) {
      const u = from[mine[i]] === s ? to[mine[i]] : from[mine[i]];
      if (!placed[u]) continue;
      for (let j = i + 1; j < mine.length; j++) {
        const w = from[mine[j]] === s ? to[mine[j]] : from[mine[j]];
        if (placed[w] && narrow(x[s], y[s], x[u], y[u], x[w], y[w])) c += 30;
      }
    }
  }
  for (let i = 0; i < from.length; i++) {
    const [a, t] = [from[i], to[i]];
    if (!placed[a] || !placed[t]) continue;
    const dx = Math.abs(x[a] - x[t]);
    const dy = Math.abs(y[a] - y[t]);
    c += 5 * (dx * dx + dy * dy - 1);
    if (dx && dy) c += dx === dy ? 1.5 : 6;
  }
  return c + (x2 - x1) + 10 * (y2 - y1);
}

/** The spots state `v` can take within `reach` of each placed neighbor. */
function spotsFor(b: Board, v: number, reach: number): [number, number][] {
  const mine = placedOf(b, v);
  const [ox, oy] = [b.x[mine[0]], b.y[mine[0]]];
  const found: [number, number][] = [];
  for (let x = ox - reach; x <= ox + reach; x++) {
    for (let y = oy - reach; y <= oy + reach; y++) {
      const near = mine.every(
        (a) => Math.abs(b.x[a] - x) <= reach && Math.abs(b.y[a] - y) <= reach,
      );
      if (near && fits(b, v, mine, x, y)) found.push([x, y]);
    }
  }
  return found;
}

/**
 * Does each placed state near (x, y) still have room within `reach` for its
 * unplaced neighbors? A state shut in by its neighbors' edges is found as it's
 * shut in, not when the search reaches the states hung off it.
 */
function roomy(b: Board, x: number, y: number, reach: number): boolean {
  for (let w = 0; w < b.n; w++) {
    if (!b.placed[w] || Math.max(Math.abs(b.x[w] - x), Math.abs(b.y[w] - y)) > 2 * reach) continue;
    const need = b.adj[w].filter((t) => !b.placed[t]).length;
    let room = 0;
    for (let dx = -reach; dx <= reach && room < need; dx++) {
      for (let dy = -reach; dy <= reach && room < need; dy++) {
        const [sx, sy] = [b.x[w] + dx, b.y[w] + dy];
        if ((dx || dy) && spotClear(b, sx, sy, -1) && edgeClear(b, sx, sy, -1, w)) room++;
      }
    }
    if (room < need) return false;
  }
  return true;
}

/**
 * How many unplaced states hang off each placed one: the sizes of the
 * unplaced pieces it borders, summed.
 */
function hanging(b: Board): number[] {
  const need = Array<number>(b.n).fill(0);
  const seen = [...b.placed];
  for (let s = 0; s < b.n; s++) {
    if (seen[s]) continue;
    const piece = [s];
    const borders = new Set<number>();
    seen[s] = true;
    for (let i = 0; i < piece.length; i++) {
      for (const t of b.adj[piece[i]]) {
        if (b.placed[t]) borders.add(t);
        else if (!seen[t]) {
          seen[t] = true;
          piece.push(t);
        }
      }
    }
    for (const w of borders) need[w] += piece.length;
  }
  return need;
}

/**
 * How many free spots, up to `enough`, placed state `w` reaches by steps to
 * a neighboring spot that cross no edge: the room in the faces around it.
 */
function room(b: Board, w: number, enough: number): number {
  const seen = new Set([spot(b.x[w], b.y[w])]);
  const queue = [b.x[w], b.y[w]];
  let found = 0;
  for (let i = 0; i < queue.length && found < enough; i += 2) {
    const [px, py] = [queue[i], queue[i + 1]];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const [qx, qy] = [px + dx, py + dy];
        const key = spot(qx, qy);
        if ((!dx && !dy) || seen.has(key)) continue;
        // A spot a state can't take blocks the way from every side.
        if (!spotClear(b, qx, qy, -1)) {
          seen.add(key);
          continue;
        }
        if (stepCrosses(b, px, py, qx, qy)) continue;
        seen.add(key);
        queue.push(qx, qy);
        found++;
      }
    }
  }
  return found;
}

/** Does the step from (px, py) to (qx, qy) cross a placed edge, or run along one? */
function stepCrosses(b: Board, px: number, py: number, qx: number, qy: number): boolean {
  const { from, to, placed } = b;
  for (let i = 0; i < from.length; i++) {
    const [c, d] = [from[i], to[i]];
    if (placed[c] && placed[d] && crosses(px, py, qx, qy, b.x[c], b.y[c], b.x[d], b.y[d])) {
      return true;
    }
  }
  return false;
}

/**
 * Can every placed state still reach as many free spots as states hang off
 * it? A state shut in a face too small for what hangs off it is found as the
 * face closes, not deep in the search, when the states hung off it come.
 */
function roomForAll(b: Board): boolean {
  const need = hanging(b);
  return need.every((n, w) => n === 0 || room(b, w, n) >= n);
}

/**
 * Can the unplaced states joined to two or more placed ones all be placed at
 * once, each at a spot of its own, their edges clear of each other? Placing
 * one at a time, a K₂,₃'s last middle finds the two before it took its room
 * only after every way to place them; this finds it once the hubs are placed.
 */
function pinnedFit(b: Board, reach: number): boolean {
  const pinned: { v: number; mine: number[]; spots: [number, number][] }[] = [];
  for (let v = 0; v < b.n; v++) {
    if (b.placed[v]) continue;
    const mine = placedOf(b, v);
    if (mine.length >= 2) pinned.push({ v, mine, spots: spotsFor(b, v, reach) });
  }
  if (pinned.length < 2) return true;
  pinned.sort((p, q) => p.spots.length - q.spots.length);
  const at: [number, number][] = [];
  // Do v at p's edges and w at q's clear each other?
  const clearOf = (i: number, p: [number, number], j: number, q: [number, number]) => {
    if (p[0] === q[0] && p[1] === q[1]) return false;
    for (const a of pinned[i].mine) {
      const [ax, ay] = [b.x[a], b.y[a]];
      if (through(p[0], p[1], ax, ay, q[0], q[1])) return false;
      for (const c of pinned[j].mine) {
        const [cx, cy] = [b.x[c], b.y[c]];
        if (
          a === c
            ? along(ax, ay, p[0], p[1], q[0], q[1])
            : crosses(p[0], p[1], ax, ay, q[0], q[1], cx, cy)
        ) {
          return false;
        }
      }
    }
    return pinned[j].mine.every((c) => !through(q[0], q[1], b.x[c], b.y[c], p[0], p[1]));
  };
  const go = (i: number): boolean =>
    i === pinned.length ||
    pinned[i].spots.some((p) => {
      if (!at.every((q, j) => clearOf(i, p, j, q))) return false;
      at.push(p);
      if (go(i + 1)) return true;
      at.pop();
      return false;
    });
  return go(0);
}

/** The states in the order a beam places them: outward from the chain's end, nearest first. */
function outward(b: Board, from: number): number[] {
  const order = [from];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) {
    for (const t of b.adj[order[i]]) {
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
  }
  return order;
}

/**
 * A beam search: each state in turn, at every spot that fits within `reach`
 * of its placed neighbors and leaves room for theirs, keeping the `width`
 * best drawings so far. Quick, and for most graphs it finds the drawing the
 * prototype's measure likes; `null` when every drawing it kept ran out of room.
 */
function beam(b: Board, order: number[], reach: number, width: number): Spot[] | null {
  type Kept = { x: number[]; y: number[]; measure: number };
  let kept: Kept[] = [{ x: [0], y: [0], measure: 0 }];
  for (let i = 1; i < order.length; i++) {
    const next: Kept[] = [];
    for (const k of kept) {
      clear(b);
      k.x.forEach((x, j) => put(b, order[j], x, k.y[j]));
      for (const [x, y] of spotsFor(b, order[i], reach)) {
        put(b, order[i], x, y);
        if (roomy(b, x, y, reach))
          next.push({ x: [...k.x, x], y: [...k.y, y], measure: measure(b) });
        lift(b, order[i]);
      }
    }
    if (next.length === 0) return null;
    kept = next.sort((p, q) => p.measure - q.measure).slice(0, width);
  }
  const best = kept[0];
  const at: Spot[] = [];
  order.forEach((s, j) => (at[s] = { x: best.x[j], y: best.y[j] }));
  return at;
}

function clear(b: Board) {
  b.placed.fill(false);
  b.taken.clear();
}

/**
 * A seeded stream of numbers from 0 to 40, mulberry32's: the same seed
 * shakes a search's order the same way every time.
 */
function shaker(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 40;
  };
}

/**
 * A depth-first search that places next the state with the fewest spots
 * left, so a state shut in is found at once, not many states later, and
 * finishes a loop before it leaves it, so a loop drawn too tight is redrawn
 * without first trying every way to place what hangs off it. After its first
 * drawing it keeps looking, for `more` steps, for one the measure likes
 * better, dropping any branch that can't beat it. `null` if `steps` run out
 * before a first drawing.
 */
function search(
  b: Board,
  from: number,
  reach: number,
  steps: number,
  more: number,
  seed = 0,
): Spot[] | null {
  const jitter = seed === 0 ? () => 0 : shaker(seed);
  clear(b);
  put(b, from, 0, 0);
  let best: Spot[] | null = null;
  let bestMeasure = Infinity;
  let step = 0;
  let limit = steps;
  const go = (left: number) => {
    if (left === 0) {
      const m = measure(b);
      if (m < bestMeasure) {
        bestMeasure = m;
        best = b.x.map((x, s) => ({ x, y: b.y[s] }));
        if (limit === steps) limit = step + more;
      }
      return;
    }
    if (++step > limit) return;
    let next = -1;
    let options: [number, number][] = [];
    let inLoop = false;
    for (let v = 0; v < b.n; v++) {
      if (b.placed[v] || !b.adj[v].some((a) => b.placed[a])) continue;
      const found = spotsFor(b, v, reach);
      if (found.length === 0) return;
      // A state in a loop with a placed state comes first.
      const looped = [...b.looped[v]].some((t) => b.placed[t]);
      if (next < 0 || (looped && !inLoop) || (looped === inLoop && found.length < options.length)) {
        [next, options, inLoop] = [v, found, looped];
      }
    }
    const ranked = options
      .map(([x, y]) => {
        put(b, next, x, y);
        const m = measure(b);
        lift(b, next);
        return { x, y, m, order: m + jitter() };
      })
      .sort((p, q) => p.order - q.order);
    for (const { x, y, m } of ranked) {
      if (m >= bestMeasure || step > limit) break;
      put(b, next, x, y);
      if (roomForAll(b) && pinnedFit(b, reach)) go(left - 1);
      lift(b, next);
    }
  };
  go(b.n - 1);
  return best;
}

/** Does a whole drawing have no crossing, no edge through a state, and no edge along another? */
function clean(b: Board, at: Spot[]): boolean {
  clear(b);
  for (let s = 0; s < b.n; s++) {
    if (!fits(b, s, placedOf(b, s), at[s].x, at[s].y)) return false;
    put(b, s, at[s].x, at[s].y);
  }
  return true;
}

/** The measure of a whole drawing. */
function measureOf(b: Board, at: Spot[]): number {
  clear(b);
  at.forEach((s, v) => put(b, v, s.x, s.y));
  return measure(b);
}

/**
 * Tidies a clean drawing while it stays clean: closes up an empty column or
 * row, and moves a state, or swaps two, wherever the measure likes better.
 */
function tidy(b: Board, at: Spot[]): Spot[] {
  let best = measureOf(b, at);
  const better = (moved: Spot[]) => {
    const m = measureOf(b, moved);
    if (m >= best || !clean(b, moved)) return false;
    [at, best] = [moved, m];
    return true;
  };
  for (let pass = 0, again = true; again && pass < 30; pass++) {
    again = false;
    const [xs, ys] = [at.map((s) => s.x), at.map((s) => s.y)];
    for (let k = Math.min(...xs); k <= Math.max(...xs); k++) {
      again = better(at.map((s) => (s.x > k ? { x: s.x - 1, y: s.y } : s))) || again;
    }
    for (let k = Math.min(...ys); k <= Math.max(...ys); k++) {
      again = better(at.map((s) => (s.y > k ? { x: s.x, y: s.y - 1 } : s))) || again;
    }
    for (let v = 0; v < b.n; v++) {
      const [x1, x2] = [Math.min(...at.map((s) => s.x)) - 1, Math.max(...at.map((s) => s.x)) + 1];
      const [y1, y2] = [Math.min(...at.map((s) => s.y)) - 1, Math.max(...at.map((s) => s.y)) + 1];
      for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
          if (x === at[v].x && y === at[v].y) continue;
          const moved = [...at];
          const there = at.findIndex((s) => s.x === x && s.y === y);
          if (there >= 0) moved[there] = at[v];
          moved[v] = { x, y };
          again = better(moved) || again;
        }
      }
    }
  }
  return at;
}

/**
 * On the grid: a quick beam search, then, unless `quick`, depth-first
 * searches reaching further from each state's neighbors until one finds a
 * drawing; tidied, or `null` if none finds one, which no state graph in the
 * lists does.
 */
function onGrid(n: number, edges: readonly Edge[], quick = false): Spot[] | null {
  const b = boardOf(n, edges);
  const from = chainEnd(b.adj).end;
  let found = beam(b, outward(b, from), 2, 16);
  if (quick && (found === null || !clean(b, found))) return null;
  // Short searches at each reach first: a graph that needs a long edge needs it at once.
  for (let reach = 2; found === null && reach <= 6; reach++) {
    found = search(b, from, reach, 600, 1000);
  }
  // A few graphs keep a search drawing a dense piece tight, though what hangs off its inside
  // state can't fit: short searches, each in a shaken order, find them a drawing quicker.
  for (let seed = 1; found === null && seed <= 600; seed++) {
    found = search(b, from, 4 + (seed % 3), 300, 1000, seed);
  }
  if (found === null) return null;
  const tidied = tidy(b, found);
  const left = Math.min(...tidied.map((s) => s.x));
  const top = Math.min(...tidied.map((s) => s.y));
  return tidied.map((s) => ({ x: s.x - left, y: s.y - top }));
}
