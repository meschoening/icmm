"""The host engine: the engine bundle the desktop runs on its own computer, whatever the Active
platform, for the computation ADR-0013 keeps off a cluster's login node, such as Find custom
topology's match (#223).

`icmm host --serve` answers the desktop's calls as NDJSON on stdin and stdout with the agent's
serve loop, but needs no hello, Data folder or runs database: every call is pure, so the desktop
keeps one running while it's used and starts another when it's gone (ADR-0015). Import's read
and Export's write of a dataset file are its too (#147): they touch only the file the user
chose, which is on this computer. So are Submit's time estimate (#229), which scores a few dozen
evaluations in libicmm, loaded by the first call that needs it, and simulating a start for its
curves (#88).
"""

from __future__ import annotations

import errno
import importlib
import math
import os
import sys
import time
from collections.abc import Callable
from functools import cache, partial
from pathlib import Path
from typing import NoReturn

from icmm.agent.serve import AgentError, Route, serve
from icmm.bundle import own_bundle_key
from icmm.core import Core, Session, Topology, packaged_library
from icmm.dataset import (
    DatasetError,
    Protocol,
    archive,
    core_arrays,
    propose_split,
    regenerate,
    scoring_digest,
    validate_dataset,
)
from icmm.dataset.checks import VALIDATION_SHARE
from icmm.dataset.checks import Issue as DatasetIssue
from icmm.dataset.model import FORMAT, MAX_SHARE, MIN_SHARE, Dataset, Interpolation
from icmm.dataset.model import Point as EnginePoint
from icmm.dataset.templates import template_of
from icmm.durable import write_whole
from icmm.export import (
    fit_csv,
    is_csv,
    parameters_csv,
    parameters_document,
    parameters_json,
    traces_name,
    write_streamed,
    write_text,
    write_traces,
)
from icmm.parameters import MAX_RATE_BOUND, ParameterBounds, canonical, parameter_count, rates
from icmm.simulation import drifted, simulate
from icmm.topology import NUM_STATES, Lists, TopologyId
from icmm.topology_match import find
from icmm.wire import METHODS
from icmm.wire.config import Bounds
from icmm.wire.dataset import (
    DatasetContent,
    DatasetFile,
    DatasetFileProblem,
    Point,
    ProposeSplitParams,
    ReadDatasetFileParams,
    RegenerateDatasetParams,
    Template,
    WriteDatasetFileParams,
    WriteProblem,
    WrittenFile,
)
from icmm.wire.dataset import Protocol as WireProtocol
from icmm.wire.desktop import WriteExportFileParams, WriteFiguresParams
from icmm.wire.errors import InvalidData, InvalidError, Issue, Severity
from icmm.wire.export import WriteFitParams, WriteParametersParams, WrittenFit
from icmm.wire.parameters import (
    CanonicalParameters,
    CanonicalParametersParams,
    EdgeRate,
    EdgeRates,
    EdgeRatesParams,
    ParameterRange,
)
from icmm.wire.run import EvaluationTime, TimeEvaluationsParams
from icmm.wire.simulation import Drift, SimulateStartParams, StartFit, StartSimulation
from icmm.wire.topology import (
    FoundTopology,
    MatchTopologyParams,
    TopologyIssue,
    TopologyMatch,
    TypedState,
)

IDLE_TIMEOUT_S = 600.0
"""Long enough for a session in the Dataset wizard; a call after it starts the engine again,
which takes about 0.12 s on an M1 Pro (ADR-0015)."""

TIMED_TOPOLOGIES, TIMED_EACH = 3, 16
"""Submit's time estimate scores `TIMED_EACH` random parameter vectors on each of up to
`TIMED_TOPOLOGIES` state graphs: enough evaluations (48) to average over the cost of the graphs
a search draws from, and few enough to answer quickly (0.3 s for the lab's EINa data at 16
states, on an M1 Pro)."""


def run(idle_timeout_s: float | None = None) -> NoReturn:
    if sys.platform == "win32":
        # The Windows bundle can stall loading NumPy's extension on a request thread.
        # Initialize it on the main thread before serve starts its lanes; other hosts
        # keep the lazy import for calls that never need numerical work.
        importlib.import_module("numpy")
    methods = {m.name: m for m in METHODS}
    handlers = {
        "regenerate_dataset": regenerate_dataset,
        "propose_split": redraw,
        "read_dataset_file": read_dataset_file,
        "write_dataset_file": write_dataset_file,
        "write_figures": write_figures,
        "write_parameters": partial(write_parameters, lists=Lists()),
        "write_fit": partial(write_fit, lists=Lists(), core=_packaged_core),
        "write_export_file": write_export_file,
        "match_topology": partial(match_topology, lists=Lists()),
        "time_evaluations": partial(time_evaluations, lists=Lists(), core=_packaged_core),
        "simulate_start": partial(
            simulate_start, lists=Lists(), core=_packaged_core, engine=own_bundle_key()
        ),
        "canonical_parameters": partial(canonical_parameters, lists=Lists()),
        "edge_rates": partial(edge_rates, lists=Lists()),
    }
    routes = {name: Route(methods[name], handler) for name, handler in handlers.items()}
    stdin = open(0, "rb", buffering=0, closefd=False)
    stdout = open(1, "wb", buffering=0, closefd=False)
    idle = IDLE_TIMEOUT_S if idle_timeout_s is None else idle_timeout_s
    serve(stdin, stdout, routes, log=sys.stderr, idle_timeout_s=idle, hello_first=False)
    sys.stderr.flush()
    os._exit(0)


def match_topology(params: MatchTopologyParams, *, lists: Lists) -> TopologyMatch:
    """Find custom topology's answer (#223): a scan of the records for the typed topology's
    number of states, and a search of the few state graphs they name."""
    pairs = [(a, b) for a, b in params.transitions]
    match = find(lists, pairs, params.open_state)
    found = None
    if (f := match.found) is not None:
        states = [TypedState(number=number, state=state) for number, state in f.states.items()]
        found = FoundTopology(
            num_states=f.num_states, graph=f.graph, open_state=f.open_state, states=states
        )
    issues = [
        TopologyIssue(
            rule=i.rule,
            states=list(i.states),
            transitions=list(i.transitions),
            loop=None if i.loop is None else list(i.loop),
        )
        for i in match.issues
    ]
    return TopologyMatch(found=found, issues=issues)


@cache
def _packaged_core() -> Core:
    """This engine's libicmm, loaded by the first estimate that needs it, so that `icmm host
    --serve` starts, and answers everything else, without it."""
    return Core(packaged_library())


def time_evaluations(
    params: TimeEvaluationsParams, *, lists: Lists, core: Callable[[], Core]
) -> EvaluationTime:
    """Submit's time estimate for a platform's first run (#229): how long one evaluation of the
    dataset takes at `num_states` states, on one thread of this computer.

    It scores `TIMED_EACH` random vectors in the search box on each of up to `TIMED_TOPOLOGIES`
    state graphs spread over the list, at each graph's first open state, and times the scoring
    alone. The draws are seeded, so two estimates differ only by the computer's noise.
    """
    issues = _timing_issues(params, lists)
    if issues:
        raise AgentError(_invalid("These can’t be timed yet.", issues))

    import numpy as np  # Not at import: the host engine starts without it.

    num_states = params.num_states
    dataset = Dataset.model_validate(_checked(params.dataset))
    arrays = [core_arrays(p) for p in dataset.protocols]
    bounds = ParameterBounds(**params.bounds.model_dump())
    library = core()
    rng = np.random.default_rng(0)
    seconds, evaluations = 0.0, 0
    for graph in _spread(lists.state_graphs(num_states)):
        topology = lists.topology(
            num_states, TopologyId(graph, lists.open_states(num_states, graph)[0])
        )
        low, high = np.array(bounds.box(topology)).T
        vectors = rng.uniform(low, high, size=(TIMED_EACH, len(low))).tolist()
        with Session(library, topology, arrays) as session:
            started = time.perf_counter()
            session.score_batch(vectors, threads=1)
            seconds += time.perf_counter() - started
        evaluations += TIMED_EACH
    return EvaluationTime(seconds_per_evaluation=seconds / evaluations, evaluations=evaluations)


def simulate_start(
    params: SimulateStartParams, *, lists: Lists, core: Callable[[], Core], engine: str | None
) -> StartSimulation:
    """A start's curves (#88): each sweep of its run's revision simulated at its raw parameters,
    each point's value and each protocol's score, by this engine, `engine`; and the protocols
    whose scores drift from the ones its worker stored, naming both engines (ADR-0013)."""
    fit = params.fit
    issues = [
        DatasetIssue(path=("dataset", *i.path), message=i.message)
        for i in validate_dataset(_checked(params.dataset))
    ] + _fit_issues(params, lists)
    if issues:
        raise AgentError(_invalid("This start can’t be drawn by this engine.", issues))

    dataset = Dataset.model_validate(_checked(params.dataset))
    topology = lists.topology(fit.num_states, TopologyId(fit.graph, fit.open_state))
    protocols = simulate(core(), topology, dataset, fit.parameters)
    disagree = drifted(fit.scores, [p.score for p in protocols])
    drift = None
    if disagree:
        names = [protocols[i].name for i in disagree]
        drift = Drift(fit_engine=fit.engine, drawn_engine=engine, protocols=names)
    return StartSimulation(protocols=protocols, engine=engine, drift=drift)


def write_parameters(params: WriteParametersParams, *, lists: Lists) -> WrittenFile:
    """Export parameters… (#344): a start's parameters canonical and named, with its RMSEs and
    Cost as its worker stored them and what its run fit them with, as JSON, or CSV for a name
    ending `.csv`. A revision this ICMM can't read still exports them, its protocols named as
    its run recorded them (#387), without their weights."""
    fit = params.fit
    if params.dataset is None:
        issues = _start_issues(fit, lists)
        if issues:
            raise AgentError(_invalid("These parameters can’t be exported by this engine.", issues))
        dataset = None
        topology = lists.topology(fit.num_states, TopologyId(fit.graph, fit.open_state))
    else:
        dataset, topology = _exported(params.dataset, fit, lists, "These parameters")
    path = Path(params.path).expanduser()
    document = parameters_document(topology, dataset, fit, params.start, params.run)
    text = parameters_csv(document) if is_csv(path) else parameters_json(document)
    try:
        write_text(path, text)
    except OSError as e:
        return WrittenFile(problem=_problem(e), detail=_os_words(e))
    return WrittenFile(problem=None, detail=None)


def write_fit(params: WriteFitParams, *, lists: Lists, core: Callable[[], Core]) -> WrittenFit:
    """Export fit… (#344): the start simulated again by this engine, each point's data beside its
    value, and beside that file its traces at every moment each sweep records. The traces are
    written first, as the larger, so a full disk stops the export before the fit is replaced."""
    fit = params.fit
    dataset, topology = _exported(params.dataset, fit, lists, "This fit")
    path = Path(params.path).expanduser()
    traces = traces_name(path.name)
    library = core()
    try:
        write_streamed(
            path.with_name(traces),
            lambda out: write_traces(out, library, topology, dataset, fit.parameters),
        )
        write_text(path, fit_csv(library, topology, dataset, fit.parameters))
    except OSError as e:
        return WrittenFit(problem=_problem(e), detail=_os_words(e), traces=traces)
    return WrittenFit(problem=None, detail=None, traces=traces)


def write_export_file(params: WriteExportFileParams) -> WrittenFile:
    """The leaderboard's CSV or a run's config (#344), as the desktop wrote it."""
    try:
        write_text(Path(params.path).expanduser(), params.text)
    except OSError as e:
        return WrittenFile(problem=_problem(e), detail=_os_words(e))
    return WrittenFile(problem=None, detail=None)


def _exported(
    content: DatasetContent, fit: StartFit, lists: Lists, what: str
) -> tuple[Dataset, Topology]:
    """The start's revision and topology, once this engine can read both and the start's scores
    are one per protocol; else why it can't export it, at the input's own keys."""
    issues = [
        DatasetIssue(path=("dataset", *i.path), message=i.message)
        for i in validate_dataset(_checked(content))
    ] + _start_issues(fit, lists)
    if not issues and len(fit.scores) != len(content.protocols):
        said = f"There are {len(content.protocols)} protocols, so as many scores."
        issues.append(DatasetIssue(path=("fit", "scores"), message=said))
    if issues:
        raise AgentError(_invalid(f"{what} can’t be exported by this engine.", issues))
    dataset = Dataset.model_validate(_checked(content))
    return dataset, lists.topology(fit.num_states, TopologyId(fit.graph, fit.open_state))


def canonical_parameters(params: CanonicalParametersParams, *, lists: Lists) -> CanonicalParameters:
    """A topology's raw best vectors as the Parameters rows show them (#287): each relative to
    the open state, with b > 0, and the range each value can take in the run's box (ADR-0007)."""
    refused = "These parameters can’t be read by this engine."
    issues = _topology_issues(
        lists, params.num_states, params.graph, params.open_state, at=()
    ) + _bounds_issues(params.bounds)
    if issues:
        raise AgentError(_invalid(refused, issues))
    topology = lists.topology(params.num_states, TopologyId(params.graph, params.open_state))
    takes = parameter_count(topology)
    said = f"T{params.graph}.{params.open_state} takes {takes} parameters."
    issues = [
        DatasetIssue(path=("vectors", i), message=said)
        for i, vector in enumerate(params.vectors)
        if len(vector) != takes
    ]
    if issues:
        raise AgentError(_invalid(refused, issues))

    box = ParameterBounds(**params.bounds.model_dump()).canonical_box(topology)
    return CanonicalParameters(
        edges=[list(edge) for edge in topology.edges],
        vectors=[canonical(topology, v) for v in params.vectors],
        ranges=[ParameterRange(min=lo, max=hi) for lo, hi in box],
    )


def edge_rates(params: EdgeRatesParams, *, lists: Lists) -> EdgeRates:
    """The Start page's Rates (#239): each edge's two rates at the voltage asked, from a start's
    best vector (ADR-0007)."""
    refused = "These parameters can’t be read by this engine."
    issues = _topology_issues(lists, params.num_states, params.graph, params.open_state, at=())
    if issues:
        raise AgentError(_invalid(refused, issues))
    topology = lists.topology(params.num_states, TopologyId(params.graph, params.open_state))
    takes = parameter_count(topology)
    if len(params.vector) != takes:
        said = f"T{params.graph}.{params.open_state} takes {takes} parameters."
        raise AgentError(_invalid(refused, [DatasetIssue(path=("vector",), message=said)]))
    return EdgeRates(
        rates=[
            EdgeRate(i=r.i, j=r.j, i_to_j=_finite(r.i_to_j), j_to_i=_finite(r.j_to_i))
            for r in rates(topology, params.vector, params.voltage_mV)
        ]
    )


def _finite(rate: float) -> float | None:
    """A rate as the wire carries it: `None` for one past what a float holds."""
    return rate if math.isfinite(rate) else None


def _fit_issues(params: SimulateStartParams, lists: Lists) -> list[DatasetIssue]:
    return _start_issues(params.fit, lists)


def _start_issues(fit: StartFit, lists: Lists) -> list[DatasetIssue]:
    """Why this engine can't simulate the start as sent: its topology's, or a vector of another
    length."""
    issues = _topology_issues(lists, fit.num_states, fit.graph, fit.open_state, at=("fit",))
    if issues:
        return issues
    topology = lists.topology(fit.num_states, TopologyId(fit.graph, fit.open_state))
    expected = parameter_count(topology)
    if len(fit.parameters) != expected:
        said = f"T{fit.graph}.{fit.open_state} takes {expected} parameters."
        return [DatasetIssue(path=("fit", "parameters"), message=said)]
    return []


def _topology_issues(
    lists: Lists, num_states: int, graph: int, open_state: int, *, at: tuple[str, ...]
) -> list[DatasetIssue]:
    """Why this engine can't read the topology, at the input's keys under `at`: a number of
    states it has no list for, a state graph past the list, or an open state that isn't one."""
    if num_states not in lists.numbers_of_states():
        said = f"A topology has {NUM_STATES.start} to {NUM_STATES.stop - 1} states."
        return [DatasetIssue(path=(*at, "num_states"), message=said)]
    graphs = lists.state_graphs(num_states)
    if not 0 <= graph < graphs:
        said = f"{num_states} states have T0–T{graphs - 1}."
        return [DatasetIssue(path=(*at, "graph"), message=said)]
    if open_state not in lists.open_states(num_states, graph):
        written = f"T{graph}.{open_state}"
        said = f"{written} isn’t a topology with {num_states} states."
        if 0 <= open_state < num_states:
            named = lists.open_state_for(num_states, graph, open_state)
            said = f"{written} is T{graph}.{named}: the graph’s symmetry makes them one."
        return [DatasetIssue(path=(*at, "open_state"), message=said)]
    return []


def _spread(graphs: int) -> list[int]:
    """The state graphs to time of `graphs`: `TIMED_TOPOLOGIES` spread evenly from the first to
    the last (the middle one between them, for three), once each: fewer where there are fewer."""
    steps = max(1, TIMED_TOPOLOGIES - 1)
    return sorted({min(i * graphs // steps, graphs - 1) for i in range(TIMED_TOPOLOGIES)})


_TIMED_ID = "0000000000"
"""A dataset is checked as saved, with an id; the content sent has none."""


def _checked(content: DatasetContent) -> dict[str, object]:
    return {"format": FORMAT, "id": _TIMED_ID, **content.model_dump(mode="json")}


def _timing_issues(params: TimeEvaluationsParams, lists: Lists) -> list[DatasetIssue]:
    """Every reason `params` can't be timed, at the input's own keys: the dataset's checks, a
    number of states with no list, and bounds the core's rates would overflow."""
    issues = [
        DatasetIssue(path=("dataset", *i.path), message=i.message)
        for i in validate_dataset(_checked(params.dataset))
    ]
    if params.num_states not in lists.numbers_of_states():
        said = f"A topology has {NUM_STATES.start} to {NUM_STATES.stop - 1} states."
        issues.append(DatasetIssue(path=("num_states",), message=said))
    return issues + _bounds_issues(params.bounds)


def _bounds_issues(bounds: Bounds) -> list[DatasetIssue]:
    """Rate bounds the core's rates would overflow, which `ParameterBounds` refuses."""
    rail = f"Parameter bounds must be from −{MAX_RATE_BOUND} to {MAX_RATE_BOUND} ln units."
    return [
        DatasetIssue(path=("bounds", field), message=rail)
        for field in ("rate_min", "rate_max")
        if not -MAX_RATE_BOUND <= getattr(bounds, field) <= MAX_RATE_BOUND
    ]


def redraw(params: ProposeSplitParams) -> WireProtocol:
    _check_shares([(("protocol",), params.protocol)])
    proposed = propose_split(_protocol(params.protocol))
    return _with_points(params.protocol, proposed)


def regenerate_dataset(params: RegenerateDatasetParams) -> DatasetContent:
    _check_shares([(("protocols", i), p) for i, p in enumerate(params.after.protocols)])
    before = _dataset(params.before) if params.before is not None else None
    try:
        made = regenerate(before, _dataset(params.after))
    except DatasetError as error:
        raise AgentError(
            _invalid("These points can’t be interpolated yet.", error.issues)
        ) from None
    protocols = [
        _with_points(sent, protocol)
        for sent, protocol in zip(params.after.protocols, made.protocols, strict=True)
    ]
    return params.after.model_copy(update={"protocols": protocols})


def read_dataset_file(params: ReadDatasetFileParams) -> DatasetFile:
    path = Path(params.path).expanduser()
    shown = path.name
    try:
        imported = archive.read_file(path)
    except archive.FileProblem as p:
        return DatasetFile(
            file=shown,
            problem=DatasetFileProblem(p.problem),
            detail=p.detail,
            issues=_wire_issues(p.issues),
            protocol_names=p.protocol_names,
            format=p.format,
            name=p.name,
            content=None,
            templates=[],
            scoring_digest=None,
        )
    except OSError as e:
        return _no_file(shown, f"{shown} · {_os_words(e)}")
    dataset = imported.dataset
    manifest = dataset.model_dump(mode="json", by_alias=True)
    content = DatasetContent.model_validate(
        {"name": imported.name or "", "protocols": manifest["protocols"]}
    )
    return DatasetFile(
        file=shown,
        problem=None,
        detail=None,
        issues=[],
        protocol_names=[p.name for p in dataset.protocols],
        format=imported.format,
        name=imported.name,
        content=content,
        templates=[Template(template_of(p)) for p in dataset.protocols],
        scoring_digest=scoring_digest(dataset),
    )


def _no_file(shown: str, detail: str) -> DatasetFile:
    """A file that can't be opened at all: gone, a folder, or not allowed."""
    return DatasetFile(
        file=shown,
        problem=DatasetFileProblem.DAMAGED,
        detail=detail,
        issues=[],
        protocol_names=[],
        format=None,
        name=None,
        content=None,
        templates=[],
        scoring_digest=None,
    )


def write_dataset_file(params: WriteDatasetFileParams) -> WrittenFile:
    files = {f.name: f.text.encode("utf-8") for f in params.files}
    try:
        archive.write_file(
            Path(params.path).expanduser(), files, expected_digest=params.files_digest
        )
    except ValueError as e:
        raise AgentError(
            _invalid(str(e), [DatasetIssue(path=("files",), message=str(e))])
        ) from None
    except OSError as e:
        return WrittenFile(problem=_problem(e), detail=_os_words(e))
    return WrittenFile(problem=None, detail=None)


def write_figures(params: WriteFiguresParams) -> WrittenFile:
    """Each figure whole in the folder, which is made if it isn't there; nothing is written
    unless every figure is named as an SVG in it, once."""
    issues = [
        DatasetIssue(path=("figures", i, "name"), message=f"{f.name!r} isn't an SVG's name.")
        for i, f in enumerate(params.figures)
        if not _svg_name(f.name)
    ]
    names = [f.name for f in params.figures]
    issues += [
        DatasetIssue(path=("figures", i, "name"), message=f"{name!r} is named twice.")
        for i, name in enumerate(names)
        if name in names[:i]
    ]
    if issues:
        raise AgentError(_invalid("Figures are named as SVGs in one folder.", issues))
    folder = Path(params.folder).expanduser()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        for f in params.figures:
            write_whole(folder / f.name, f.svg.encode("utf-8"))
    except OSError as e:
        return WrittenFile(problem=_problem(e), detail=_os_words(e))
    return WrittenFile(problem=None, detail=None)


def _svg_name(name: str) -> bool:
    """A plain file's name ending `.svg`: no folder in it, and something before the `.svg`."""
    stem = name.removesuffix(".svg")
    return (
        name.endswith(".svg")
        and stem.strip(".") != ""
        and not any(c in name for c in "/\\:\0")
        and len(name.encode("utf-8")) <= 255
    )


def _problem(e: OSError) -> WriteProblem:
    if e.errno in _NO_SPACE:
        return WriteProblem.NO_SPACE
    if e.errno in _DENIED:
        return WriteProblem.DENIED
    return WriteProblem.FAILED


_NO_SPACE = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}
# No permission, or a read-only disk: another folder is the way round it.
_DENIED = {errno.EACCES, errno.EPERM, errno.EROFS}


def _os_words(e: OSError) -> str:
    """The OS's words for `e`, as Rust writes them: "No space left on device (os error 28)"."""
    return f"{e.strerror or e}" + (f" (os error {e.errno})" if e.errno is not None else "")


def _wire_issues(issues: list[DatasetIssue]) -> list[Issue]:
    return [
        Issue(path=[str(key) for key in i.path], message=i.message, severity=Severity.ERROR)
        for i in issues
    ]


def _protocol(sent: WireProtocol) -> Protocol:
    """What the dataset functions read of a draft: its points, its interpolation settings, its
    validation share and whether it's normalized. Its other fields may break their limits while
    the user edits, so they aren't read here; `validate_dataset` says where."""
    return Protocol.model_construct(
        normalized=sent.normalized,
        validation_share=sent.validation_share,
        interpolation=Interpolation.model_construct(**sent.interpolation.model_dump()),
        points=[EnginePoint.model_construct(**p.model_dump()) for p in sent.points],
    )


def _dataset(content: DatasetContent) -> Dataset:
    return Dataset.model_construct(protocols=[_protocol(p) for p in content.protocols])


def _with_points(sent: WireProtocol, made: Protocol) -> WireProtocol:
    """`sent` with `made`'s points: the only thing the engine changes."""
    points = [Point.model_validate(p.model_dump()) for p in made.points]
    return sent.model_copy(update={"points": points})


def _check_shares(protocols: list[tuple[tuple[str | int, ...], WireProtocol]]) -> None:
    """A proposal is drawn only at a share the checks allow, which the desktop keeps to."""
    issues = [
        DatasetIssue(path=(*at, "validation_share"), message=VALIDATION_SHARE)
        for at, p in protocols
        if not MIN_SHARE <= p.validation_share <= MAX_SHARE
    ]
    if issues:
        raise AgentError(_invalid(VALIDATION_SHARE, issues))


def _invalid(message: str, issues: list[DatasetIssue]) -> InvalidError:
    """The issues as the wire writes them: list indices as decimals."""
    return InvalidError(
        code="invalid", message=message, data=InvalidData(issues=_wire_issues(issues))
    )
