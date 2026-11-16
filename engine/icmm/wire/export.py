"""Exporting a start from its page (#344, #336 decision 7): its parameters, and its fit with its
traces, written by the desktop's **Host engine** where the user chose (ADR-0013, ADR-0015).

Both are computed from what simulating the start reads, `read_start_fit` and
`read_dataset_revision`: its raw best **Parameters**, shown canonical (ADR-0007), and its scores
as its worker stored them. The traces are simulated again on export at every recorded moment, so
the host engine writes them itself and no reply carries them.
"""

from __future__ import annotations

from icmm.wire.base import WireInt, WireModel
from icmm.wire.config import Config
from icmm.wire.dataset import DatasetContent, WrittenFile
from icmm.wire.simulation import StartFit


class ExportedRun(WireModel):
    """What a start's parameters name of its run, as Run detail read it."""

    config_name: str
    """Its config's name now: the run is written `#214 herg-wt-11state`."""
    dataset_name: str | None
    """Its dataset's name now; `null` when this platform never had it."""
    settings: Config | None
    """Its config's settings as they were saved when it was submitted; `null` for a run a newer
    ICMM submitted, in a format this one can't read."""
    search_seed: WireInt
    protocols: list[str]
    """Its revision's protocol names, in the order its starts' scores are stored, as Run detail
    read them: they name the protocols where the revision can't be read (#387)."""


class ExportedStart(WireModel):
    """What a start's parameters say of how well they fit, as its worker stored it and the
    Start page shows it."""

    seed: WireInt | None
    """Its own seed, from the run's **Search seed**."""
    train_rmse: float | None
    val_rmse: float | None
    cost: float | None


class WriteParametersParams(WireModel):
    path: str
    """Where to write them, as `choose_export_file` answered: JSON, or CSV where the name ends
    `.csv`. A leading `~/` is the home folder."""
    dataset: DatasetContent | None
    """The run's revision, as `read_dataset_revision` read it; `null` where this ICMM can't
    read it, which leaves its protocols without their weights, named by `run`."""
    fit: StartFit
    """As `read_start_fit` read it."""
    start: ExportedStart
    run: ExportedRun


class WriteFitParams(WireModel):
    path: str
    """Where to write the fit, as `choose_export_file` answered; its traces go beside it, named
    for it with `-traces` before `.csv`. A leading `~/` is the home folder."""
    dataset: DatasetContent
    """The run's revision, as `read_dataset_revision` read it."""
    fit: StartFit
    """As `read_start_fit` read it."""


class WrittenFit(WrittenFile):
    traces: str
    """The traces file's name, in the fit's folder."""
