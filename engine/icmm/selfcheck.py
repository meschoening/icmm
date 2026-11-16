"""`icmm selfcheck`: an installed engine proves it runs, in one JSON line on stdout.

It imports every module of the engine but the worker, so each dependency must be there, loads
libicmm from inside the package, finds every topology list there, and checks that `BUNDLE.json`
describes this engine in its own folder. An install runs it in the unpacked **Engine bundle**
before committing it (ADR-0002). It prints the versions and the bundle's key, or `{"error": …}`
and exits 1.

The worker (`icmm.start`) loads numpy and pycma, which belong in a start's job: on a login
node loading them is computation (ADR-0013), and macOS checks each new native library as it first
loads, about 4 s for a fresh bundle's. A bundle's build proves they load by running a start
(`tests/test_engine_bundle_smoke.py`).
"""

from __future__ import annotations

import importlib
import json
import pkgutil
import sys
from pathlib import Path
from typing import Any

import icmm

JOB_ONLY = frozenset({"icmm.start", "icmm.sobol"})
"""Modules that load the search's numeric stack, which only a start's job imports."""


def selfcheck() -> dict[str, Any]:
    for module in pkgutil.walk_packages(icmm.__path__, "icmm."):
        if module.name != "icmm.__main__" and module.name not in JOB_ONLY:
            importlib.import_module(module.name)

    from icmm.bundle import own_bundle
    from icmm.core import Core, packaged_library
    from icmm.topology import NUM_STATES, Lists
    from icmm.wire import PROTOCOL_VERSION

    library = packaged_library()
    if not library.is_file():
        raise FileNotFoundError(f"There's no libicmm in this engine: {library} is missing.")
    bundle = own_bundle()
    if bundle is not None:
        folder = Path(sys.prefix).parent.name
        if bundle.protocol != PROTOCOL_VERSION:
            raise ValueError(
                f"BUNDLE.json says protocol {bundle.protocol}; this engine speaks "
                f"{PROTOCOL_VERSION}."
            )
        if bundle.engine_version != icmm.__version__:
            raise ValueError(
                f"BUNDLE.json says engine {bundle.engine_version}; this is {icmm.__version__}."
            )
        if bundle.key != folder:
            raise ValueError(f"BUNDLE.json is for {bundle.key}, which is in {folder}.")
    core_version = Core(library).version
    if core_version != icmm.__version__:
        raise ValueError(f"libicmm says engine {core_version}; this is {icmm.__version__}.")
    lists = Lists()
    if missing := [n for n in NUM_STATES if n not in lists.numbers_of_states()]:
        states = ", ".join(map(str, missing))
        raise FileNotFoundError(
            f"This engine has no topology lists for {states} states: {lists.folder} lacks them."
        )
    return {
        "engine_version": icmm.__version__,
        "protocol": PROTOCOL_VERSION,
        "core_version": core_version,
        "bundle_key": bundle.key if bundle else None,
    }


def main() -> int:
    try:
        report = selfcheck()
    except Exception as e:  # any failure is the report
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
        return 1
    print(json.dumps(report), flush=True)
    return 0
