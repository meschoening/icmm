"""The **Engine bundle** an interpreter runs from, read from its `BUNDLE.json` (ADR-0002).

A bundle is a folder named by its key: `BUNDLE.json` beside `python/`, the interpreter's prefix.
scripts/engine_bundle.py builds one; the desktop installs it into `<Data folder>/engine/<key>/`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import BaseModel, ConfigDict

MANIFEST = "BUNDLE.json"


class BundleManifest(BaseModel):
    """`BUNDLE.json`: what a bundle is, and what its files add up to."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        # Built on first use, not at import: hello reads it (see icmm.wire.base).
        defer_build=True,
        use_attribute_docstrings=True,
    )

    key: str
    """`<engine version>-<os>-<arch>-<content_sha256[:12]>`, the name of its folder."""
    engine_version: str
    protocol: str
    """The protocol its agent speaks, `major.minor`."""
    target: str
    """The target triple it was built for, such as `x86_64-unknown-linux-gnu`."""
    python: str
    content_sha256: str
    """A digest of every file but this one: each path, executable bit and contents."""
    files: int
    """How many files it holds, this one aside."""
    bytes: int
    """Their total size."""
    glibc: str | None = None
    """The newest glibc version (`2.28`) any of its files needs, on Linux; `None` elsewhere, and in
    bundles built before it was recorded."""


def own_bundle_key(prefix: str | Path = sys.prefix) -> str | None:
    """The key of the bundle whose interpreter has this prefix; `None` from a checkout.

    Read without validating the rest, and never fatal: `hello` reports it, and a connect must
    not fail on it (the install's selfcheck validates the whole manifest).
    """
    try:
        key = json.loads((Path(prefix).parent / MANIFEST).read_text(encoding="utf-8"))["key"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return key if isinstance(key, str) else None


def installed(data_folder: Path, key: str | None) -> bool:
    """Whether the engine `key` is installed in the Data folder, or is this engine's own: a key
    folder without its manifest isn't an install. `None`, an engine run from a checkout, always
    is."""
    if key is None or key == own_bundle_key():
        return True
    return (data_folder / "engine" / key / MANIFEST).is_file()


def interpreter(folder: Path) -> Path | None:
    """The interpreter of the bundle in `folder`: `python/python.exe` in one built for Windows,
    `python/bin/python3.12` in any other; `None` if it has neither."""
    for path in (folder / "python" / "python.exe", folder / "python" / "bin" / "python3.12"):
        if path.exists():
            return path
    return None


def own_bundle(prefix: str | Path = sys.prefix) -> BundleManifest | None:
    """The bundle whose interpreter has this prefix; `None` from a checkout."""
    path = Path(prefix).parent / MANIFEST
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return BundleManifest.model_validate_json(text)
