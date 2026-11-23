"""Configs (ADR-0016): the limits of the format 1 model, `validate_config`'s checks, notes and
counts, and the reader chain for saved configs.

Every check is parsing and arithmetic over the config and a few seeks into the topology lists, so
the agent runs it on a login node (ADR-0013). Nothing here computes a graph's symmetry or draws a
sample: the lists name each open state, and a run draws its sample at submit (ADR-0017, ADR-0018).
"""

from __future__ import annotations

import copy
import re
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from icmm import names
from icmm.parameters import MAX_RATE_BOUND, ParameterBounds
from icmm.topology import NUM_STATES, Lists, TopologyError
from icmm.wire.base import MAX_WIRE_INT
from icmm.wire.config import (
    AllTopologies,
    Bounds,
    Config,
    ConfigCheck,
    SearchSettings,
    SpecificId,
    SpecificIds,
    TopologyCounts,
    TopologySample,
    TopologySpace,
    WhichTopologies,
    Work,
)
from icmm.wire.errors import Issue, Severity, UnreadableProblem

FORMAT = 1
"""The format this engine writes. Until 1.0, a format change deletes existing configs; from 1.0,
it adds a step to `UPGRADES` (ADR-0016)."""

type Step = Callable[[dict[str, Any]], dict[str, Any]]
UPGRADES: Mapping[int, Step] = {}
"""Each older format's step to the next, by the format it reads."""

NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")
"""A config's name: as a dataset's (#178)."""
DATASET_ID = re.compile(r"[a-z0-9]{10}")
MAX_RUN_STARTS = 100_000
"""The most starts a run holds: topologies × starts per topology (ADR-0017)."""
MAX_POPULATION = 2**31 - 1
"""The core scores a generation's candidates in one call, which counts them in an int32
(`icmm_score`); pycma takes no fewer than 2."""
MAX_SEARCH_SEED = 2**32 - 1
"""A Search seed is a uint32, so a drawn one reads on Run detail and types back (#45)."""

LOG_NOTE_BYTES = 10**9
"""A run whose **Start logs** would pass this gets a note (#46). McKelvey's home quota is 30 GiB,
with 4.6 GiB free when measured, and the Output folder defaults to `<Data folder>/output` (#32)."""
LINE_BYTES, PROTOCOL_LINE_BYTES = 270, 42
"""A Start log line's size late in a 1,000,000-evaluation start, as `StartLogPoint` writes it: 270
bytes, and 42 more for each of the dataset's protocols."""

DATASET_ID_RULE = "The dataset id must be 10 lowercase letters or digits."
STATES_RULE = "Choose a number of states from 3 to 16."
BELOW = "The lower bound must be below the upper bound."

ID_EXAMPLES: Mapping[int, SpecificId] = {
    n: SpecificId(graph=graph, open_state=open_state)
    for n, graph, open_state in [
        (3, 0, 2),
        (4, 2, 3),
        (5, 6, 3),
        (6, 15, 5),
        (7, 41, 6),
        (8, 121, 7),
        (9, 366, 8),
        (10, 1158, 9),
        (11, 1991, 6),
        (12, 12502, 10),
        (13, 42372, 11),
        (14, 146012, 13),
        (15, 509639, 14),
        (16, 1799622, 15),
    ]
}
"""Each number of states' Specific IDs example (CF10): a state graph with more than one open state,
and one of them other than 0. Each is the state graph nearest the middle of its list, at its highest
open state, but 11 states' T1991.6, #180's. The desktop has a copy, `idExamples.json`, which the
tests check against this and the lists."""


def empty_ids(num_states: int | None) -> str:
    """What an empty Specific IDs says, its examples from the number of states' list: #180's
    11-state ones without a number of states."""
    example = ID_EXAMPLES.get(num_states or 11, ID_EXAMPLES[11])
    return f"Write at least one id: {example.graph}, T{example.graph} or {_written(example)}."


_WHICH = ("topology", "which")
_IDS = (*_WHICH, "ids")
# How a choice over the run's cap holds fewer topologies.
_FEWER = {
    "all": "Choose a Random sample",
    "sample": "Choose a smaller sample",
    "ids": "Choose fewer ids",
}


def new_config(name: str, dataset_id: str) -> Config:
    """A new config's settings: no number of states yet, a Random sample of 5, the lab's search
    (#178, #45) and the default bounds (ADR-0007)."""
    return Config(
        format=FORMAT,
        name=name,
        dataset_id=dataset_id,
        topology=TopologySpace(num_states=None, which=TopologySample(kind="sample", count=5)),
        search=SearchSettings(
            starts_per_topology=100,
            population=50,
            evaluation_budget=1_000_000,
            log_every_generations=200,
            search_seed=None,
            sobol_start_points=False,
        ),
        bounds=Bounds.model_validate(ParameterBounds().model_dump()),
    )


class UnreadableConfig(ValueError):
    """A saved config this engine can't read: in a newer format, or not a config at all."""

    def __init__(self, problem: UnreadableProblem, details: str) -> None:
        super().__init__(details)
        self.problem = problem
        self.details = details


def read_config(saved: Any) -> Config:
    """A saved config as this engine's format: an older one read through each step in memory,
    and rewritten only by its next save (ADR-0016). `UnreadableConfig` for anything else."""
    try:
        return Config.model_validate(upgrade(saved))
    except ValidationError as e:
        first = e.errors()[0]
        at = ".".join(str(key) for key in first["loc"])
        raise UnreadableConfig(UnreadableProblem.DAMAGED, f"{at}: {first['msg']}") from None


def upgrade(
    saved: Any, *, current: int = FORMAT, steps: Mapping[int, Step] = UPGRADES
) -> dict[str, Any]:
    """`saved` in format `current`, through each older format's step; `saved` is unchanged."""
    format = saved.get("format") if isinstance(saved, dict) else None
    if type(format) is not int or format < 1:
        raise UnreadableConfig(UnreadableProblem.DAMAGED, f"Format {format!r} isn't one.")
    if format > current:
        reads = f"Saved in format {format}; this ICMM reads up to format {current}."
        raise UnreadableConfig(UnreadableProblem.NEWER, reads)
    raw = copy.deepcopy(saved)
    for older in range(format, current):
        raw = {**steps[older](raw), "format": older + 1}
    return raw


class _Issues:
    """The issues found so far, each at its path under the config."""

    def __init__(self) -> None:
        self.issues: list[Issue] = []

    def error(self, *path: str | int, message: str) -> None:
        self.add(path, message, Severity.ERROR)

    def note(self, *path: str | int, message: str) -> None:
        self.add(path, message, Severity.NOTE)

    def add(self, path: tuple[str | int, ...], message: str, severity: Severity) -> None:
        self.issues.append(Issue(path=[str(p) for p in path], message=message, severity=severity))


def check(config: Config, lists: Lists, *, protocols: int | None = None) -> ConfigCheck:
    """Every issue with `config`, the config a save would keep, and its counts. With its
    dataset's number of `protocols`, the note for large Start logs too."""
    found = _Issues()
    if not NAME.fullmatch(config.name):
        found.error("name", message=names.CONFIG.problem(config.name) or names.EMPTY)
    if not DATASET_ID.fullmatch(config.dataset_id):
        found.error("dataset_id", message=DATASET_ID_RULE)
    search = config.search
    counts = _counts(config.topology.num_states, lists, found)
    choice = _choose(config.topology, counts, lists, found)
    per_topology = _starts_per_topology(search, found)
    starts = (
        None
        if choice.topologies is None or per_topology is None
        else choice.topologies * per_topology
    )
    over = (
        f"{starts:,}"
        if starts is not None and starts > MAX_RUN_STARTS
        else None
        if choice.at_least is None
        else f"At least {choice.at_least * (per_topology or 1):,}"
    )
    if over is not None:
        fewer = _FEWER[choice.which.kind]
        # Fewer starts can help only while the topologies fit at one start each (CF08).
        if choice.topologies is not None and choice.topologies <= MAX_RUN_STARTS:
            fewer += ", or fewer starts per topology"
        found.error(
            *choice.at,
            message=f"{over} starts is more than a run holds ({MAX_RUN_STARTS:,}). {fewer}.",
        )
    evaluations = _evaluations_per_start(search, found)
    _check_search(search, found)
    if evaluations is not None and starts is not None and protocols is not None:
        _log_volume(search, evaluations // search.population, starts, protocols, found)
    _check_bounds(config.bounds, found)
    return ConfigCheck(
        issues=found.issues,
        config=config.model_copy(
            update={"topology": config.topology.model_copy(update={"which": choice.which})}
        ),
        counts=counts,
        work=Work(
            topologies=choice.topologies,
            per_id=choice.per_id,
            starts=starts,
            evaluations_per_start=evaluations,
            bytes_per_start=_start_bytes(config, protocols, evaluations),
        ),
    )


def _start_bytes(config: Config, protocols: int | None, evaluations: int | None) -> int | None:
    """The coordinator's file estimate, without loading a core or reading a dataset's points."""
    from icmm.coordinator.files import start_bytes

    states, search = config.topology.num_states, config.search
    if states is None or states not in NUM_STATES or protocols is None or evaluations is None:
        return None
    if search.log_every_generations < 1:
        return None
    size = start_bytes(
        num_states=states,
        protocols=protocols,
        evaluation_budget=search.evaluation_budget,
        population=search.population,
        log_every_generations=search.log_every_generations,
    )
    return size if size <= MAX_WIRE_INT else None


def _starts_per_topology(search: SearchSettings, found: _Issues) -> int | None:
    """Starts per topology, if a run can hold that many."""
    starts = search.starts_per_topology
    if not 1 <= starts <= MAX_RUN_STARTS:
        found.error(
            "search",
            "starts_per_topology",
            message=f"Starts per topology must be from 1 to {MAX_RUN_STARTS:,}.",
        )
        return None
    if search.sobol_start_points and starts & (starts - 1):
        found.note(
            "search",
            "sobol_start_points",
            message="Sobol start points work best when starts per topology is a power of two, "
            f"such as 64 or 128. This config has {starts:,}.",
        )
    return starts


def _evaluations_per_start(search: SearchSettings, found: _Issues) -> int | None:
    """What each start runs: its budget, rounded up to a whole generation (ADR-0008), which the
    wire carries up to 2⁵³ − 1; `None` when that can't be counted."""
    budget, population = search.evaluation_budget, search.population
    if population < 2:
        found.error("search", "population", message="Population size must be at least 2.")
    elif population > MAX_POPULATION:
        found.error(
            "search",
            "population",
            message=f"Population size must be at most {MAX_POPULATION:,}.",
        )
    if budget < 1:
        found.error(
            "search", "evaluation_budget", message="Evaluations per start must be at least 1."
        )
    if budget < 1 or not 2 <= population <= MAX_POPULATION:
        return None
    runs = -(-budget // population) * population
    if budget < population:
        found.note(
            "search",
            "evaluation_budget",
            message=f"{budget:,} is under one generation of {population:,}, so each start runs "
            f"{runs:,}.",
        )
    if runs > MAX_WIRE_INT:
        found.error(
            "search",
            "evaluation_budget",
            message=f"Evaluations per start must be at most {MAX_WIRE_INT:,}, rounded up to a "
            "whole generation.",
        )
        return None
    return runs


def _check_search(search: SearchSettings, found: _Issues) -> None:
    if search.log_every_generations < 1:
        found.error(
            "search", "log_every_generations", message="Log every must be at least 1 generation."
        )
    seed = search.search_seed
    if seed is not None and not 0 <= seed <= MAX_SEARCH_SEED:
        found.error(
            "search",
            "search_seed",
            message=f"A search seed is a whole number from 0 to {MAX_SEARCH_SEED:,}.",
        )


def log_points(generations: int, every: int) -> int:
    """How many lines a start's log has: its first generation, every `every`-th, and its last."""
    multiples = generations // every
    first = every > 1  # generation 1 isn't a multiple
    last = generations > 1 and generations % every != 0
    return multiples + first + last


def _log_volume(
    search: SearchSettings, generations: int, starts: int, protocols: int, found: _Issues
) -> None:
    every = search.log_every_generations
    if every < 1:
        return
    lines = log_points(generations, every)
    per_start = lines * (LINE_BYTES + PROTOCOL_LINE_BYTES * protocols)
    if per_start * starts <= LOG_NOTE_BYTES:
        return
    cadence = "Every generation" if every == 1 else f"Logging every {every:,} generations"
    found.note(
        "search",
        "log_every_generations",
        message=f"{cadence} writes about {_size(per_start)} of log a start: "
        f"{_size(per_start * starts)} for these {starts:,} starts.",
    )


def _size(n: int) -> str:
    """`n` bytes in decimal units, to two figures below 10 and whole above: 6.2 MB, 960 KB.
    Halves round up, in whole numbers, as the proto harness rounds them."""
    for unit, scale in (("TB", 10**12), ("GB", 10**9), ("MB", 10**6), ("KB", 10**3)):
        if n >= scale:
            tenths = (10 * n + scale // 2) // scale
            if tenths < 100:
                whole, tenth = divmod(tenths, 10)
                return f"{whole}.{tenth} {unit}" if tenth else f"{whole} {unit}"
            return f"{(n + scale // 2) // scale:,} {unit}"
    return f"{n} bytes"


def _check_bounds(bounds: Bounds, found: _Issues) -> None:
    rail = f"Parameter bounds must be from −{MAX_RATE_BOUND} to {MAX_RATE_BOUND} ln units."
    rates_in_rail = True
    for field in ("rate_min", "rate_max"):
        if not -MAX_RATE_BOUND <= getattr(bounds, field) <= MAX_RATE_BOUND:
            found.error("bounds", field, message=rail)
            rates_in_rail = False
    if rates_in_rail and bounds.rate_min >= bounds.rate_max:
        found.error("bounds", "rate_min", message=BELOW)
    if bounds.sigmoid_min_mV >= bounds.sigmoid_max_mV:
        found.error("bounds", "sigmoid_min_mV", message=BELOW)


@dataclass(frozen=True)
class _Choice:
    """Which topologies a config fits, as a save keeps the choice."""

    which: WhichTopologies
    topologies: int | None
    """How many it fits; `None` until that can be counted."""
    per_id: list[int]
    at: tuple[str, ...]
    """The field a run over its cap is said under."""
    at_least: int | None = None
    """Without a count, the fewest topologies it fits, when that's already more than a run
    holds."""


def _choose(
    space: TopologySpace, counts: TopologyCounts | None, lists: Lists, found: _Issues
) -> _Choice:
    which = space.which
    if isinstance(which, AllTopologies):
        return _Choice(which, None if counts is None else counts.topologies, [], _WHICH)
    if isinstance(which, TopologySample):
        at = (*_WHICH, "count")
        return _Choice(which, _sample(which.count, space.num_states, counts, at, found), [], at)
    return _specific_ids(which, space.num_states, counts, lists, found)


def _specific_ids(
    which: SpecificIds,
    num_states: int | None,
    counts: TopologyCounts | None,
    lists: Lists,
    found: _Issues,
) -> _Choice:
    """Specific IDs as a save keeps them: each open state named by its orbit's lowest, a repeat
    once, and an id with an open state inside the same graph's bare id, each with a note (#180).
    An id that names nothing is an error, and stays where it was written.

    The work is a check per id and one read of every graph's orbits, a seek each. A list naming
    more state graphs than a run holds starts can't be run at any starts per topology, since each
    graph fits at least one topology, so its orbits aren't read at all."""
    if not which.ids:
        found.error(*_IDS, message=empty_ids(num_states))
        return _Choice(which, None, [], _IDS)
    if num_states is None or counts is None:
        return _Choice(which, None, [], _IDS)
    # Each sentence with the id it's about, so they're said in the order the ids were written.
    said: list[tuple[int, Severity, tuple[str, ...], str]] = []
    in_range: list[bool] = []  # whether each id names a state graph and one of its states
    for i, sent in enumerate(which.ids):
        graph, state = sent.graph, sent.open_state
        ok = False
        if not 0 <= graph < counts.state_graphs:
            have = f"{num_states} states have T0–T{counts.state_graphs - 1}"
            said.append((i, Severity.ERROR, ("graph",), f"T{graph} isn't one: {have}."))
        elif state is not None and not 0 <= state < num_states:
            numbered = f"{num_states} states are numbered 0–{num_states - 1}"
            said.append(
                (i, Severity.ERROR, ("open_state",), f"{_written(sent)} isn't one: {numbered}.")
            )
        else:
            ok = True
        in_range.append(ok)
    graphs = {sent.graph for sent, ok in zip(which.ids, in_range, strict=True) if ok}
    if len(graphs) > MAX_RUN_STARTS:
        _say(said, found)
        return _Choice(which, None, [], _IDS, at_least=len(graphs))

    orbits = lists.orbits(num_states, graphs)
    named: list[SpecificId | None] = []  # each id, its open state renamed; `None` if it names none
    for i, (sent, ok) in enumerate(zip(which.ids, in_range, strict=True)):
        if not ok:
            named.append(None)
            continue
        state = sent.open_state
        id = SpecificId(
            graph=sent.graph, open_state=None if state is None else orbits[sent.graph][state]
        )
        if id.open_state != state:
            same = "the graph's symmetry makes them the same topology"
            said.append((i, Severity.NOTE, (), f"{_written(sent)} became {_written(id)}: {same}."))
        named.append(id)

    bare = {id.graph for id in named if id is not None and id.open_state is None}

    def merged(id: SpecificId) -> bool:
        return id.open_state is not None and id.graph in bare

    times = Counter(_written(id) for id in named if id is not None and not merged(id))
    seen: Counter[str] = Counter()
    saved: list[SpecificId] = []
    for i, (sent, id) in enumerate(zip(which.ids, named, strict=True)):
        if id is None:
            saved.append(sent)
            continue
        written = _written(id)
        seen[written] += 1
        if merged(id):
            if seen[written] == 1:
                merge = f"T{id.graph} already fits {written}, so the two are merged."
                said.append((i, Severity.NOTE, (), merge))
        elif seen[written] == 1:
            saved.append(id)
        elif seen[written] == 2:
            count = "twice" if times[written] == 2 else f"{times[written]} times"
            said.append(
                (i, Severity.NOTE, (), f"{written} was in the list {count}. It's fit once.")
            )

    _say(said, found)
    if None in named:
        # Nothing is counted, but the good ids are kept as the notes say, for the drawings (#216).
        return _Choice(SpecificIds(kind="ids", ids=saved), None, [], _IDS)
    per_id = [1 if id.open_state is not None else _open_states(orbits[id.graph]) for id in saved]
    return _Choice(SpecificIds(kind="ids", ids=saved), sum(per_id), per_id, _IDS)


def _say(said: list[tuple[int, Severity, tuple[str, ...], str]], found: _Issues) -> None:
    """Each id's sentences, in the order the ids were written."""
    for i, severity, field, sentence in sorted(said, key=lambda s: s[0]):
        found.add((*_IDS, i, *field), sentence, severity)


def _open_states(orbits: list[int]) -> int:
    """How many topologies a state graph gives: one per orbit."""
    return sum(state == lowest for state, lowest in enumerate(orbits))


def _written(id: SpecificId) -> str:
    """The id as #180 writes it: `T1991`, or `T1991.6` with its open state."""
    return f"T{id.graph}" if id.open_state is None else f"T{id.graph}.{id.open_state}"


def _sample(
    count: int,
    num_states: int | None,
    counts: TopologyCounts | None,
    at: tuple[str, ...],
    found: _Issues,
) -> int | None:
    """A sample's size, if a run can draw it."""
    if count < 1:
        found.error(*at, message="A sample needs at least 1 topology.")
        return None
    if counts is None:
        return None
    total = counts.topologies
    if count >= total:
        size = "all" if count == total else "more than the"
        found.error(
            *at,
            message=f"A sample of {count:,} is {size} {total:,} topologies with {num_states} "
            "states. Choose All instead.",
        )
        return None
    return count


def _counts(num_states: int | None, lists: Lists, found: _Issues) -> TopologyCounts | None:
    """The list's counts for `num_states`; `None`, with its error, without one."""
    if num_states is None or num_states not in NUM_STATES:
        found.error("topology", "num_states", message=STATES_RULE)
        return None
    try:
        return TopologyCounts(
            state_graphs=lists.state_graphs(num_states), topologies=lists.topologies(num_states)
        )
    except TopologyError as e:
        found.error("topology", "num_states", message=str(e))
        return None
