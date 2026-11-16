"""The runs database's failures as the wire's errors, for every handler that opens it."""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from icmm.agent.serve import AgentError
from icmm.db import HandOverPendingError, NewerSchemaError
from icmm.platform_settings import UnreadableSettingsError
from icmm.wire.base import WireModel
from icmm.wire.errors import (
    DataFolderData,
    DataFolderError,
    DataFolderProblem,
    DbCorruptData,
    DbCorruptError,
    NoSpaceData,
    NoSpaceError,
    UnavailableData,
    UnavailableError,
    UnavailableSource,
)

RETRY_AFTER_MS = 1000
HAND_OVER_RETRY_AFTER_MS = 5000
"""How long a desktop waits before it asks again while older coordinators finish their sweeps."""
NEARLY_FULL_BYTES = 1_000_000


def guarded(
    handler: Callable[[Any], WireModel | None], *, data_folder: Path, written: str
) -> Callable[[Any], WireModel | None]:
    """`handler`, with the database's failures answered as errors. `written` is the Data
    folder as the user wrote it, for the sentences."""

    def run(params: Any) -> WireModel | None:
        database = _runs_db(written)
        try:
            return handler(params)
        except NewerSchemaError as e:
            raise AgentError(
                data_folder_error(
                    DataFolderProblem.NEWER,
                    f"A newer version of ICMM set up {written}. Update ICMM on this computer to "
                    "use it, or choose another Data folder.",
                    details=f"{written} · runs.db {e}",
                )
            ) from None
        except HandOverPendingError:
            raise AgentError(
                UnavailableError(
                    code="unavailable",
                    message="ICMM is handing the runs in flight to its new engine. Try again in "
                    "a moment.",
                    data=UnavailableData(
                        source=UnavailableSource.HAND_OVER,
                        retry_after_ms=HAND_OVER_RETRY_AFTER_MS,
                        details=None,
                    ),
                )
            ) from None
        except UnreadableSettingsError as e:
            raise AgentError(
                data_folder_error(
                    DataFolderProblem.SETTINGS,
                    f"This version of ICMM can’t read the Platform settings in {written}: a "
                    "newer version saved them, or they’re damaged. Update ICMM on this computer.",
                    details=f"{database} · {e}",
                )
            ) from None
        except sqlite3.OperationalError as e:
            text = str(e).lower()
            if "locked" in text or "busy" in text:
                raise AgentError(
                    UnavailableError(
                        code="unavailable",
                        message="The runs database is busy. Try again in a moment.",
                        data=UnavailableData(
                            source=UnavailableSource.DB, retry_after_ms=RETRY_AFTER_MS, details=None
                        ),
                    )
                ) from None
            # SQLite reports a full disk as SQLITE_FULL, but a full quota on NFS (EDQUOT) as
            # an I/O error, so that one is checked against the folder's space.
            io_error = (getattr(e, "sqlite_errorname", "") or "").startswith("SQLITE_IOERR")
            if "full" in text or (io_error and _out_of_space(data_folder)):
                raise AgentError(no_space(data_folder, written)) from None
            # Mask extended SQLite codes too (for example SQLITE_READONLY_DIRECTORY).
            code = getattr(e, "sqlite_errorcode", 0) & 0xFF
            if code in (sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_READONLY):
                raise AgentError(
                    data_folder_error(
                        DataFolderProblem.READ_ONLY,
                        f"ICMM can’t save run records in {written}: it isn’t allowed to change "
                        f"{database}. Check that the folder belongs to you, or choose another "
                        "Data folder.",
                        details=f"{database} · {e}",
                    )
                ) from None
            raise
        except sqlite3.DatabaseError as e:
            raise AgentError(
                DbCorruptError(
                    code="db_corrupt",
                    message=f"ICMM can’t read the run records in {written}: runs.db is damaged, "
                    "or isn’t ICMM’s. ICMM won’t change it.",
                    data=DbCorruptData(detail=str(e)),
                )
            ) from None

    return run


def _runs_db(written: str) -> str:
    """The runs database in the Data folder `written`, with the separator that folder is written
    with: `~/icmm/runs.db`, or `D:\\icmm\\runs.db` on Windows."""
    sep = "/" if "/" in written or os.sep == "/" else os.sep
    return f"{written.rstrip('/' + os.sep)}{sep}runs.db"


def data_folder_error(
    problem: DataFolderProblem,
    message: str,
    *,
    details: str,
    storage: str | None = None,
    suggestion: str | None = None,
) -> DataFolderError:
    return DataFolderError(
        code="data_folder",
        message=message,
        data=DataFolderData(
            problem=problem, storage=storage, details=details, suggestion=suggestion
        ),
    )


def _out_of_space(data_folder: Path) -> bool:
    from icmm.folders import folder_space

    free = folder_space(str(data_folder))
    return free is not None and free < NEARLY_FULL_BYTES


def no_space(data_folder: Path, written: str) -> NoSpaceError:
    """The Data folder `written` is full, with what it has left."""
    from icmm.folders import folder_space

    free = folder_space(str(data_folder))
    left = "" if free is None else f", with {_size(free)} free"
    return NoSpaceError(
        code="no_space",
        message=f"The Data folder {written} is full{left}. Free up some space there, then try "
        "again.",
        data=NoSpaceData(free_bytes=free),
    )


def _size(n: int) -> str:
    for unit in ("bytes", "kB", "MB", "GB"):
        if n < 1000:
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000  # type: ignore[assignment]
    return f"{n:.1f} TB"
