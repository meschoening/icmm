"""The topology lists: every **State graph** with 3 to 16 states and each one's **Open states**
(ADR-0017, ADR-0018), read with a few seeks so that a login node can serve them.

An engine bundle carries them uncompressed in the package's `_lists/` folder, as `unpack` writes
them from the checked-in lists in engine/topology/ (scripts/topology_lists.py). For N states:

- `n{N}_c4.g6`: one state graph a line in graph6, in geng's order. Line i is `T{i}`, and every
  line has the same length, so `T{i}` is a seek.
- `n{N}_c4.orbits`: one record of ⌈N/2⌉ bytes a state graph, holding each state's orbit's lowest
  state in a nibble, low nibble first. A state is an open state iff its nibble is its own number.
- `n{N}_c4.digest`: one record of 2 bytes a state graph, `icmm.topology_match.record` of it, which
  Find custom topology scans for a typed topology's candidates (#223).
- `n{N}_c4.index`: a little-endian uint32 for each state graph, the topologies on the state
  graphs before it, and one more, the list's topology count. `unpack` writes it, so that nothing
  sums the open states at run time.
"""

from __future__ import annotations

import hashlib
import random
import sys
from array import array
from bisect import bisect_right
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import accumulate
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from icmm.core import Topology

NUM_STATES = range(3, 17)
"""The numbers of states a config may have (ADR-0017)."""

SUMS = "caches.sha256"


class TopologyError(ValueError):
    """An id that names no topology, or a number of states with no list; the message says which."""


@dataclass(frozen=True, order=True)
class TopologyId:
    """A **Topology id**: its state graph's number in the list for its number of states, and its
    **Open state**, which is the lowest of the states the graph's symmetry makes the same."""

    graph: int
    open_state: int

    def __str__(self) -> str:
        return f"T{self.graph}.{self.open_state}"


class Lists:
    """The topology lists in one folder: this engine's own by default."""

    def __init__(self, folder: Path | None = None) -> None:
        self.folder = Path(__file__).parent / "_lists" if folder is None else folder
        self._records: dict[int, bytes] = {}

    def numbers_of_states(self) -> list[int]:
        """The numbers of states this folder has lists for."""
        return [n for n in NUM_STATES if all(p.is_file() for p in self._paths(n))]

    def state_graphs(self, num_states: int) -> int:
        """How many state graphs have `num_states` states: `T0` to one less than this."""
        return self._index(num_states).stat().st_size // 4 - 1

    def topologies(self, num_states: int) -> int:
        """How many topologies have `num_states` states: each state graph at each open state."""
        with self._index(num_states).open("rb") as f:
            f.seek(-4, 2)
            return int.from_bytes(f.read(4), "little")

    def topology(self, num_states: int, topology: TopologyId) -> Topology:
        """The topology's states and edges, its edges in the order of its edge parameters: by
        their lower state, then their higher, as the old engine read them."""
        # Imported here: the agent's start path imports this module, and icmm.core isn't light.
        from icmm.core import Topology

        graph, open_state = topology.graph, topology.open_state
        if (named := self.open_state_for(num_states, graph, open_state)) != open_state:
            same = "the graph's symmetry makes them the same topology"
            raise TopologyError(f"{topology} is T{graph}.{named}: {same}.")
        width = _g6_width(num_states)
        with self._paths(num_states)[0].open("rb") as f:
            f.seek(graph * width)
            line = f.read(width - 1)
        return Topology(num_states, _edges(line, num_states), open_state)

    def open_states(self, num_states: int, graph: int) -> list[int]:
        """State graph `graph`'s open states: one topology each."""
        orbits = self._orbits(num_states, graph)
        return [state for state, lowest in enumerate(orbits) if state == lowest]

    def open_state_for(self, num_states: int, graph: int, state: int) -> int:
        """The open state naming the topology on state graph `graph` with `state` open: the
        lowest of the states its symmetry makes the same as `state`."""
        orbits = self._orbits(num_states, graph)
        if not 0 <= state < num_states:
            last = num_states - 1
            raise TopologyError(f"T{graph} has no state {state}: its states are 0–{last}.")
        return orbits[state]

    def orbits(self, num_states: int, graphs: Iterable[int]) -> dict[int, list[int]]:
        """Each of `graphs`' states' orbit's lowest state, as `open_state_for` names them, read
        with one open file: a seek per state graph, however many there are."""
        wanted = self._listed(num_states, graphs)
        size = (num_states + 1) // 2
        found = {}
        with self._paths(num_states)[1].open("rb") as f:
            for graph in wanted:
                f.seek(graph * size)
                found[graph] = _nibbles(f.read(size), num_states)
        return found

    def edges(
        self, num_states: int, graphs: Iterable[int]
    ) -> dict[int, tuple[tuple[int, int], ...]]:
        """Each of `graphs`' edges, as `topology` gives them, read with one open file: a seek per
        state graph, however many there are."""
        wanted = self._listed(num_states, graphs)
        width = _g6_width(num_states)
        found = {}
        with self._paths(num_states)[0].open("rb") as f:
            for graph in wanted:
                f.seek(graph * width)
                found[graph] = _edges(f.read(width - 1), num_states)
        return found

    def sample(self, num_states: int, count: int, seed: int) -> list[TopologyId]:
        """`count` different topologies with `num_states` states, each topology as likely as any,
        in the order `seed` draws them. They're the first `count` of a Fisher–Yates shuffle of
        every topology that moves only what it draws, so a larger sample from the same seed
        starts with the smaller one, and 48 M topologies cost no more than the few drawn. A run
        records what it drew, so a later Python's `random` needn't draw the same."""
        total = self.topologies(num_states)
        if not 1 <= count <= total:
            have = f"{num_states} states have {total:,} topologies"
            raise TopologyError(f"A sample of {count} can't be drawn: {have}.")
        rng = random.Random(seed)
        moved: dict[int, int] = {}
        drawn = []
        for i in range(count):
            j = rng.randrange(i, total)
            drawn.append(moved.get(j, j))
            moved[j] = moved.get(i, i)
        return self._topologies_at(num_states, drawn)

    def _topologies_at(self, num_states: int, places: list[int]) -> list[TopologyId]:
        """The topologies at `places` in the list's order: by state graph, then open state."""
        index = array("I", self._index(num_states).read_bytes())
        if sys.byteorder == "big":
            index.byteswap()
        size = (num_states + 1) // 2
        found = []
        with self._paths(num_states)[1].open("rb") as f:
            for place in places:
                graph = bisect_right(index, place) - 1
                f.seek(graph * size)
                orbits = _nibbles(f.read(size), num_states)
                open_states = [state for state, lowest in enumerate(orbits) if state == lowest]
                found.append(TopologyId(graph, open_states[place - index[graph]]))
        return found

    def records(self, num_states: int) -> bytes:
        """Every state graph's record, in the list's order: `T{i}`'s at byte 2i (#223). Read once
        and kept, since the host engine scans them as each topology is typed: 10 MB in all."""
        if (kept := self._records.get(num_states)) is None:
            self._index(num_states)
            kept = self._records[num_states] = self._paths(num_states)[3].read_bytes()
        return kept

    def _listed(self, num_states: int, graphs: Iterable[int]) -> list[int]:
        """`graphs` once each, lowest first, once each is in the list for `num_states`."""
        count = self.state_graphs(num_states)
        wanted = sorted(set(graphs))
        for graph in wanted:
            if not 0 <= graph < count:
                have = f"{num_states} states have T0–T{count - 1}"
                raise TopologyError(f"T{graph} isn't one: {have}.")
        return wanted

    def _orbits(self, num_states: int, graph: int) -> list[int]:
        """Each state's orbit's lowest state, from the graph's record."""
        count = self.state_graphs(num_states)
        if not 0 <= graph < count:
            raise TopologyError(f"T{graph} isn't one: {num_states} states have T0–T{count - 1}.")
        size = (num_states + 1) // 2
        with self._paths(num_states)[1].open("rb") as f:
            f.seek(graph * size)
            return _nibbles(f.read(size), num_states)

    def _index(self, num_states: int) -> Path:
        paths = self._paths(num_states)
        if num_states not in NUM_STATES or not all(path.is_file() for path in paths):
            raise TopologyError(f"There's no topology list for {num_states} states.")
        return paths[2]

    def _paths(self, num_states: int) -> tuple[Path, Path, Path, Path]:
        stem = self.folder / f"n{num_states}_c4"
        suffixes = (".g6", ".orbits", ".index", ".digest")
        g6, orbits, index, digest = (stem.with_suffix(suffix) for suffix in suffixes)
        return (g6, orbits, index, digest)


def unpack(source: Path, dest: Path) -> Path:
    """Writes the checked-in lists in `source` into a new folder `dest` as `Lists` reads them, and
    returns `dest`. Every file must match its line in `source`'s `caches.sha256`."""
    import lzma  # Imported here: only a build unpacks, and the agent's start path imports this.

    dest.mkdir(parents=True)
    for name, expected in _sums(source / SUMS).items():
        data = lzma.decompress((source / f"{name}.xz").read_bytes())
        if (got := hashlib.sha256(data).hexdigest()) != expected:
            raise ValueError(f"{name} has sha256 {got}; {SUMS} says {expected}.")
        (dest / name).write_bytes(data)
        if name.endswith(".orbits"):
            num_states = int(name.removeprefix("n").partition("_")[0])
            index = array("I", accumulate(_open_state_counts(data, num_states), initial=0))
            if sys.byteorder == "big":
                index.byteswap()
            (dest / name).with_suffix(".index").write_bytes(index.tobytes())
    return dest


def _nibbles(record: bytes, num_states: int) -> list[int]:
    """An orbit record's states: each one's orbit's lowest state."""
    return [(record[v // 2] >> 4 * (v % 2)) & 15 for v in range(num_states)]


def _g6_width(num_states: int) -> int:
    """A graph6 line's length with its newline: one byte for N, and six bits a byte for the
    upper triangle of the adjacency matrix."""
    return 2 + (num_states * (num_states - 1) // 2 + 5) // 6


def _edges(line: bytes, num_states: int) -> tuple[tuple[int, int], ...]:
    """A graph6 line's edges, each lower state first, sorted. graph6 lists the upper triangle a
    column at a time, (0,1), (0,2), (1,2), (0,3) …, six bits to a byte, each byte 63 more."""
    bits = (((byte - 63) >> (5 - i)) & 1 for byte in line[1:] for i in range(6))
    pairs = ((i, j) for j in range(1, num_states) for i in range(j))
    return tuple(sorted(pair for pair, bit in zip(pairs, bits, strict=False) if bit))


def _sums(path: Path) -> dict[str, str]:
    """`sha256sum` lines: each file's name and its digest."""
    lines = path.read_text(encoding="utf-8").splitlines()
    return {name: digest for digest, _, name in (line.partition("  ") for line in lines)}


def _open_state_counts(orbits: bytes, num_states: int) -> bytes:
    """Each state graph's number of open states, a byte each, from its orbit records.

    Byte k of a record holds states 2k and 2k+1. Translating every record's byte k at once gives
    each record's open states among those two (0 to 2), and summing the translations as big
    integers adds them record by record: no record has more than 16, so no sum carries into the
    next record's byte. It's what makes unpacking 3.6 M records at 16 states quick.
    """
    size = (num_states + 1) // 2
    total = 0
    for k in range(size):
        low, high = 2 * k, 2 * k + 1
        table = bytes(
            ((b & 15) == low) + (high < num_states and (b >> 4) == high) for b in range(256)
        )
        total += int.from_bytes(orbits[k::size].translate(table), "big")
    return total.to_bytes(len(orbits) // size, "big")
