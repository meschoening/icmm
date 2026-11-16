"""Find custom topology (#222): a topology typed as transitions between states numbered however
the user likes, found in the topology lists (#223, ADR-0017, ADR-0018).

`find` names the topology in five steps (#223), none of which runs nauty:

1. compute the typed state graph's certificate;
2. scan `n{N}_c4.digest` for its record;
3. recompute the certificate of each state graph there (about 55 at 16 states);
4. confirm the one whose certificate agrees by an exact isomorphism search, which gives the map;
5. name the open state by its orbit's lowest state, from `n{N}_c4.orbits`, searching again with
   the typed open state pinned on it.

A state graph is a list of neighbor bitmasks: `adj[v]` has bit u set iff states u and v are joined.

- `certificate(adj)`: color refinement (1-WL) seeded with each state's degree and triangle count
  and refined until it stops splitting, every round's signatures sorted and written as bytes. Its
  value doesn't depend on how the states are numbered. Frozen: `record`, its first 2 bytes of
  BLAKE2b, is what `n{N}_c4.digest` holds for each state graph (scripts/topology_lists.py).
- `isomorphism(a, b)`: a map of a's states onto b's that carries every edge onto an edge, by
  individualization-refinement over both graphs at once (McKay & Piperno 2014, §2.3–2.4), or None.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Literal

from icmm.topology import NUM_STATES, Lists

RECORD_SIZE = 2
"""Bytes of BLAKE2b a state graph's record keeps: about 55 candidates at 16 states (#223)."""

MAX_NEIGHBORS = 4
MAX_LOOP = 4
"""A state has at most 4 neighbors, and no loop passes through more than 4 states (ADR-0017)."""

LOOP_SEARCH_BUDGET = 20_000
"""Steps the search for a loop to show may take in each block that breaks the loop rule before it
gives up and shows the block. A topology within 16 states needs far fewer (#223)."""

type Rule = Literal[
    "open_state",
    "self_transition",
    "repeated_transition",
    "num_states",
    "neighbors",
    "connected",
    "loop",
]


def adjacency(num_states: int, edges: Iterable[Sequence[int]]) -> list[int]:
    """The neighbor bitmasks of a state graph with `num_states` states and `edges`."""
    adj = [0] * num_states
    for a, b in edges:
        adj[a] |= 1 << b
        adj[b] |= 1 << a
    return adj


def certificate(adj: Sequence[int]) -> bytes:
    """The state graph's color-refinement certificate: the same for every numbering of its states.

    It holds N, the (degree, triangles) seeds sorted, then each round's signatures sorted, each as
    its color, its neighbor count and its neighbors' colors. Colors are the ranks of the sorted
    distinct signatures, so no number a state carries reaches them. With triangles in the seed,
    no two of the lists' 5,031,235 state graphs share one (#223), which the build checks.
    """
    nbrs = _neighbors(adj)
    seeds = [
        (len(nv), sum((adj[v] & adj[u]).bit_count() for u in nv) // 2) for v, nv in enumerate(nbrs)
    ]
    out = bytearray([len(adj)])
    for degree, triangles in sorted(seeds):
        out += bytes((degree, triangles))
    rank = {seed: r for r, seed in enumerate(sorted(set(seeds)))}
    colors = [rank[seed] for seed in seeds]
    kinds = len(rank)
    while True:
        sigs = [(colors[v], tuple(sorted(colors[u] for u in nv))) for v, nv in enumerate(nbrs)]
        for color, around in sorted(sigs):
            out += bytes((color, len(around), *around))
        distinct = sorted(set(sigs))
        if len(distinct) == kinds:
            return bytes(out)
        rank = {sig: r for r, sig in enumerate(distinct)}
        colors = [rank[sig] for sig in sigs]
        kinds = len(distinct)


def record(adj: Sequence[int]) -> bytes:
    """The state graph's record, as `n{N}_c4.digest` holds it."""
    return hashlib.blake2b(certificate(adj), digest_size=RECORD_SIZE).digest()


def _neighbors(adj: Sequence[int]) -> list[list[int]]:
    """Each state's neighbors, lowest first."""
    return [[u for u in range(len(adj)) if mask >> u & 1] for mask in adj]


@dataclass(frozen=True)
class Issue:
    """A rule the typed topology breaks, and what breaks it, by typed number."""

    rule: Rule
    states: tuple[int, ...]
    """The states the rule names: around the loop, from its lowest state, for `loop`; else lowest
    first. For `loop` without a loop, every state of its block."""
    transitions: tuple[int, ...]
    """The transitions that break it, as places in the typed list."""
    loop: tuple[int, ...] | None = None
    """For `loop`, the shortest loop through more than 4 states in its block, around it from its
    lowest state; None when the search for one gave up."""


@dataclass(frozen=True)
class Found:
    """A typed topology's id, and each typed number's state in it."""

    num_states: int
    graph: int
    open_state: int | None
    """The topology's open state, named by its orbit's lowest state; None when none was typed,
    for every topology of the state graph."""
    states: dict[int, int]
    """Each typed number, lowest first, and ICMM's number for that state."""


@dataclass(frozen=True)
class Match:
    found: Found | None
    issues: tuple[Issue, ...]


class NotInTheLists(LookupError):
    """A topology that keeps every rule but has no line: the lists or their records are damaged,
    since by construction they hold every such state graph (ADR-0017)."""


def find(lists: Lists, transitions: Sequence[tuple[int, int]], open_state: int | None) -> Match:
    """The topology the transitions make, each a pair of typed state numbers, with `open_state`
    open: its id and ICMM's number for each typed number, or every rule it breaks."""
    if issues := tuple(check(transitions, open_state)):
        return Match(found=None, issues=issues)
    numbers = sorted({number for pair in transitions for number in pair})
    index = {number: i for i, number in enumerate(numbers)}
    n = len(numbers)
    typed = adjacency(n, ((index[a], index[b]) for a, b in transitions))
    own = certificate(typed)
    for graph, edges in lists.edges(n, _candidates(lists.records(n), own)).items():
        listed = adjacency(n, edges)
        if certificate(listed) != own:
            continue
        phi = isomorphism(typed, listed)
        if phi is None:
            continue
        named = None
        if open_state is not None:
            s = index[open_state]
            named = lists.open_state_for(n, graph, phi[s])
            if named != phi[s]:
                # The orbit's lowest state is the same state up to symmetry, so this finds a map.
                phi = isomorphism(typed, listed, pin=(s, named))
                assert phi is not None
        states = {number: phi[i] for i, number in enumerate(numbers)}
        return Match(found=Found(n, graph, named, states), issues=())
    raise NotInTheLists(f"No state graph with {n} states has this one's certificate.")


def check(transitions: Sequence[tuple[int, int]], open_state: int | None) -> Iterator[Issue]:
    """Every rule the typed topology breaks, each checked with self-transitions and repeats set
    aside, so that one answer names them all. Linear in its size, but for the search for a loop
    to show, which has a budget."""
    numbers = sorted({number for pair in transitions for number in pair})
    if open_state is not None and open_state not in numbers:
        yield Issue("open_state", (open_state,), ())
    index = {number: i for i, number in enumerate(numbers)}
    n = len(numbers)
    adj: list[set[int]] = [set() for _ in range(n)]
    where: dict[tuple[int, int], int] = {}
    selves, repeats = [], []
    for k, (a, b) in enumerate(transitions):
        if a == b:
            selves.append(k)
            continue
        pair = (min(a, b), max(a, b))
        if pair in where:
            repeats += [where[pair], k]
            continue
        where[pair] = k
        adj[index[a]].add(index[b])
        adj[index[b]].add(index[a])
    if selves:
        states = sorted({transitions[k][0] for k in selves})
        yield Issue("self_transition", tuple(states), tuple(selves))
    if repeats:
        states = sorted({number for k in repeats for number in transitions[k]})
        yield Issue("repeated_transition", tuple(states), tuple(sorted(set(repeats))))
    if n not in NUM_STATES:
        yield Issue("num_states", (), ())

    def edges_within(states: set[int]) -> tuple[int, ...]:
        return tuple(sorted(k for (a, b), k in where.items() if {index[a], index[b]} <= states))

    crowded = [v for v in range(n) if len(adj[v]) > MAX_NEIGHBORS]
    if crowded:
        touching = sorted(k for (a, b), k in where.items() if {index[a], index[b]} & set(crowded))
        yield Issue("neighbors", tuple(numbers[v] for v in crowded), tuple(touching))
    pieces = _pieces(adj)
    if len(pieces) > 1:
        home = max(pieces, key=len)
        if open_state in index:
            home = next(p for p in pieces if index[open_state] in p)
        apart = set().union(*(p for p in pieces if p is not home))
        yield Issue("connected", tuple(numbers[v] for v in sorted(apart)), edges_within(apart))
    for block, loop in _long_loops(adj):
        if loop is None:
            yield Issue("loop", tuple(numbers[v] for v in sorted(block)), edges_within(block))
        else:
            around = tuple(numbers[v] for v in loop)
            steps = {
                (min(a, b), max(a, b)) for a, b in zip(around, around[1:] + around[:1], strict=True)
            }
            yield Issue("loop", around, tuple(sorted(where[pair] for pair in steps)), loop=around)


def _pieces(adj: list[set[int]]) -> list[set[int]]:
    """The graph's connected pieces, in the order of their lowest states."""
    seen: set[int] = set()
    pieces = []
    for s in range(len(adj)):
        if s in seen:
            continue
        piece, stack = {s}, [s]
        while stack:
            for t in adj[stack.pop()] - piece:
                piece.add(t)
                stack.append(t)
        seen |= piece
        pieces.append(piece)
    return pieces


def _blocks(adj: list[set[int]]) -> list[set[int]]:
    """Each block's states (its biconnected components, Hopcroft & Tarjan 1973), found without
    recursion. Every loop lies within one block (Tarjan 1972, Lemma 3)."""
    n = len(adj)
    num, low = [0] * n, [0] * n
    counter = 0
    blocks: list[set[int]] = []
    for root in range(n):
        if num[root]:
            continue
        counter += 1
        num[root] = low[root] = counter
        edges: list[tuple[int, int]] = []
        stack = [(root, -1, iter(sorted(adj[root])))]
        while stack:
            v, parent, rest = stack[-1]
            w = next(rest, None)
            if w is None:
                stack.pop()
                if stack:
                    u = stack[-1][0]
                    low[u] = min(low[u], low[v])
                    if low[v] >= num[u]:
                        block: set[int] = set()
                        while True:
                            a, b = edges.pop()
                            block |= {a, b}
                            if (a, b) == (u, v):
                                break
                        blocks.append(block)
                continue
            if not num[w]:
                counter += 1
                num[w] = low[w] = counter
                edges.append((v, w))
                stack.append((w, v, iter(sorted(adj[w]))))
            elif w != parent and num[w] < num[v]:
                edges.append((v, w))
                low[v] = min(low[v], num[w])
    return blocks


def _long_loops(adj: list[set[int]]) -> Iterator[tuple[set[int], list[int] | None]]:
    """Each block with a loop through more than 4 states, and its shortest such loop around from
    its lowest state, or None if the search gave up.

    A block of 5 or more states keeps every loop within 4 states iff it is K2,m, with or without
    the edge between its two hubs (ADR-0017's c4prune; the proof is on research/topology-
    enumeration)."""
    for block in sorted(_blocks(adj), key=min):
        if len(block) <= MAX_LOOP:
            continue
        hubs = {v for v in block if len(adj[v] & block) != 2}
        if len(hubs) == 2 and all(adj[v] & block == hubs for v in block - hubs):
            continue
        yield block, _shortest_long_loop(adj, block)


def _shortest_long_loop(adj: list[set[int]], block: set[int]) -> list[int] | None:
    """The shortest loop through more than 4 of the block's states, from its lowest state, each
    step to the lowest state that still closes one; None past `LOOP_SEARCH_BUDGET` steps."""
    inside = {v: sorted(adj[v] & block) for v in block}
    budget = [LOOP_SEARCH_BUDGET]
    try:
        for length in range(MAX_LOOP + 1, len(block) + 1):
            for start in sorted(block):
                # Loops through `start` as their lowest state, so each is looked for once.
                if found := _loop_from(inside, [start], length, budget):
                    return found
    except TimeoutError:
        return None
    return None


def _loop_from(
    inside: dict[int, list[int]], path: list[int], length: int, budget: list[int]
) -> list[int] | None:
    """A loop of `length` states that starts with `path` and passes no state lower than its
    first; `budget[0]` counts down the steps left."""
    budget[0] -= 1
    if budget[0] < 0:
        raise TimeoutError
    start, v = path[0], path[-1]
    if len(path) == length:
        return list(path) if start in inside[v] else None
    for w in inside[v]:
        if w > start and w not in path:
            if found := _loop_from(inside, [*path, w], length, budget):
                return found
    return None


def _candidates(records: bytes, own: bytes) -> list[int]:
    """The state graphs whose record is `own`'s: every place its 2 bytes start a record."""
    key = hashlib.blake2b(own, digest_size=RECORD_SIZE).digest()
    found = []
    # The scan doesn't overlap its finds, which only a key of two equal bytes can: then a record
    # that starts inside a find at an odd place starts one byte after it.
    for at in re.finditer(re.escape(key), records):
        place = at.start()
        if place % 2 == 1 and records[place + 1 : place + 3] == key:
            place += 1
        if place % 2 == 0:
            found.append(place // RECORD_SIZE)
    return found


def isomorphism(
    a: Sequence[int], b: Sequence[int], pin: tuple[int, int] | None = None
) -> list[int] | None:
    """A map of a's states onto b's carrying every edge onto an edge, with `pin`'s state of a on
    its state of b; None if there's none.

    Both graphs are refined in step, from their degrees, giving up as soon as their signatures
    differ. Then the first state of b's first cell of more than one state is individualized
    against each state of a's cell with the same color in turn, until both colorings are
    discrete, which leaves one candidate map to check. Every map is reachable this way, so the
    search finds one whenever one exists.
    """
    n = len(a)
    if len(b) != n:
        return None
    na, nb = _neighbors(a), _neighbors(b)
    ca, cb = [len(x) for x in na], [len(x) for x in nb]
    if pin is not None:
        ca[pin[0]] = cb[pin[1]] = n + 1

    def search(ca: list[int], cb: list[int], depth: int) -> list[int] | None:
        refined = _refine_both(na, nb, ca, cb)
        if refined is None:
            return None
        ca, cb = refined
        cells: dict[int, list[int]] = {}
        for v, color in enumerate(cb):
            cells.setdefault(color, []).append(v)
        target = next((c for c in sorted(cells) if len(cells[c]) > 1), None)
        if target is None:
            where = {color: v for v, color in enumerate(cb)}
            phi = [where[color] for color in ca]
            return phi if all(_image(a[v], phi) == b[phi[v]] for v in range(n)) else None
        t = cells[target][0]
        fresh = 2 * n + 2 + depth
        for u in (v for v, color in enumerate(ca) if color == target):
            ca2, cb2 = list(ca), list(cb)
            ca2[u] = cb2[t] = fresh
            phi = search(ca2, cb2, depth + 1)
            if phi is not None:
                return phi
        return None

    return search(ca, cb, 0)


def _refine_both(
    na: list[list[int]], nb: list[list[int]], ca: list[int], cb: list[int]
) -> tuple[list[int], list[int]] | None:
    """Both colorings refined in step until stable; None once their signatures differ."""
    kinds = len(set(ca))
    while True:
        sa = [(ca[v], tuple(sorted(ca[u] for u in nv))) for v, nv in enumerate(na)]
        sb = [(cb[v], tuple(sorted(cb[u] for u in nv))) for v, nv in enumerate(nb)]
        if sorted(sa) != sorted(sb):
            return None
        distinct = sorted(set(sa))
        if len(distinct) == kinds:
            return ca, cb
        rank = {sig: r for r, sig in enumerate(distinct)}
        ca, cb = [rank[sig] for sig in sa], [rank[sig] for sig in sb]
        kinds = len(distinct)


def _image(mask: int, phi: Sequence[int]) -> int:
    """The set `mask` under the map `phi`."""
    out = 0
    for v in range(len(phi)):
        if mask >> v & 1:
            out |= 1 << phi[v]
    return out
