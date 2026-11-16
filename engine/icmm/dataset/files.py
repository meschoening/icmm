"""Reading and writing one dataset revision folder, byte-stable (ADR-0003).

A revision is `dataset.json`, the manifest without its points, plus one `<protocol name>.csv`
per protocol. Files are UTF-8 with LF line ends; numbers are written shortest round-trip, with
integer values bare (`-100`, not `-100.0`); CSV rows are sorted by x. Publishing a revision
atomically, staged and flushed, is the caller's (ADR-0009).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from icmm.dataset.checks import UNKNOWN_FORMAT, DatasetError, Issue, IssuePath, validate_dataset
from icmm.dataset.model import FORMAT, MAX_POINTS, MAX_PROTOCOLS, PROTOCOL_NAME, Dataset, Point
from icmm.durable import fsync_folder

MANIFEST = "dataset.json"
CSV_HEADER = "x,value,sd,validation,interpolated"


class NewerFormatError(DatasetError):
    """A manifest with a newer integer format version, rather than a damaged format field."""

    def __init__(self) -> None:
        super().__init__([Issue(path=("format",), message=UNKNOWN_FORMAT)])


type Reader = Callable[[str], bytes]
"""Reads one of a revision's files by name; `OSError` when there's none, or it can't be read."""


def folder_reader(folder: Path) -> Reader:
    """Reads the files of the revision in `folder`."""
    return lambda name: (folder / name).read_bytes()


def read_revision(folder: Path, *, expected_digest: str | None = None) -> Dataset:
    """The revision in `folder`; `DatasetError` if its files are unreadable or fail the checks.

    With `expected_digest`, verify the exact bytes read, before parsing can normalize them.
    """
    files: dict[str, bytes] = {}
    raw, issues = load_revision(folder_reader(folder), files)
    issues = issues or validate_dataset(raw)
    if issues:
        raise DatasetError(issues)
    if expected_digest is not None and _files_digest(files) != expected_digest:
        raise DatasetError([_CHANGED])
    return Dataset.model_validate(raw)


def load_revision(read: Reader, files: dict[str, bytes]) -> tuple[dict[str, Any], list[Issue]]:
    """The revision's manifest with each protocol's `points` read from its CSV, and the issues
    reading the CSVs found; the checks are the caller's. Each file's bytes are kept in `files`.
    Oversized protocol lists stop before CSV reads; oversized CSV row counts stop before
    materializing points or row issues. Repeated file references reuse their stored bytes.

    `NewerFormatError` for a newer format, and `DatasetError` for a manifest that's missing,
    isn't JSON, or has a format this engine can't read.
    """
    raw = _manifest(read, files)
    if raw["format"] != FORMAT:
        raise DatasetError([Issue(path=("format",), message=UNKNOWN_FORMAT)])
    issues: list[Issue] = []
    protocols = raw.get("protocols")
    if isinstance(protocols, list) and len(protocols) > MAX_PROTOCOLS:
        return raw, [Issue(path=("protocols",), message="A dataset has 1 to 32 protocols.")]
    for i, protocol, name in _protocols(raw):
        at: IssuePath = ("protocols", i, "points")
        try:
            text = _csv_text(read, name, files)
        except (OSError, UnicodeDecodeError):
            issues.append(Issue(path=at, message=f"{name}.csv is missing or isn't UTF-8 text."))
            continue
        protocol["points"] = _points(text, name, at, issues)
    return raw, issues


@dataclass(frozen=True)
class Facts:
    """What a list shows of a revision beyond what its save recorded."""

    validation: int
    """How many of its points are validation points."""
    interpolated: int
    """How many of its points interpolation added."""
    steps: dict[str, int]
    """How many steps each protocol has, by name."""


def revision_facts(folder: Path, *, expected_digest: str) -> Facts:
    """The revision in `folder`'s facts, if its files are the bytes that were saved; else
    `DatasetError`, as `read_revision` raises it for them.

    A list checks every revision it shows with this: it reads the files, the manifest's JSON
    and the marks, but parses no point. Files damaged so that `read_revision`'s checks fail
    them are refused here only as changed since they were saved.
    """
    raw, files = _saved_files(folder, expected_digest=expected_digest, current=True)
    # The bytes are what `_render` wrote: CSVs of a header, then rows whose fourth and fifth
    # fields are the marks, and a manifest that passed the checks.
    marks = [
        line.split(",")[3:5]
        for name, data in files.items()
        if name != MANIFEST
        for line in data.decode("utf-8").split("\n")[1:-1]
    ]
    return Facts(
        validation=sum(v == "1" for v, _ in marks),
        interpolated=sum(i == "1" for _, i in marks),
        steps={name: len(p["steps"]) for _, p, name in _protocols(raw)},
    )


def revision_files(folder: Path, *, expected_digest: str) -> dict[str, bytes]:
    """The files of the revision in `folder` by name, byte for byte, if they're the bytes that
    were saved, in whatever format; else `DatasetError`, as `revision_facts` raises it.

    Export writes these: none is parsed, so nothing a reader would normalize can change.
    """
    return _saved_files(folder, expected_digest=expected_digest, current=False)[1]


def _saved_files(
    folder: Path, *, expected_digest: str, current: bool
) -> tuple[dict[str, Any], dict[str, bytes]]:
    """The manifest, and its bytes with those of the CSVs it names, if they're the bytes that
    were saved. With `current`, a format other than this engine's is refused first."""
    files: dict[str, bytes] = {}
    read = folder_reader(folder)
    raw = _manifest(read, files)
    if current and raw["format"] != FORMAT:
        raise DatasetError([Issue(path=("format",), message=UNKNOWN_FORMAT)])
    issues: list[Issue] = []
    for i, _, name in _protocols(raw):
        try:
            _csv_text(read, name, files)
        except (OSError, UnicodeDecodeError):
            at: IssuePath = ("protocols", i, "points")
            issues.append(Issue(path=at, message=f"{name}.csv is missing or isn't UTF-8 text."))
    if issues:
        raise DatasetError(issues)
    if _files_digest(files) != expected_digest:
        raise DatasetError([_CHANGED])
    return raw, files


_CHANGED = Issue(path=(), message="Its files changed since they were saved.")


def _manifest(read: Reader, files: dict[str, bytes]) -> dict[str, Any]:
    """The revision's manifest, its bytes kept in `files`; `NewerFormatError` for a newer
    format, and `DatasetError` if it's missing, isn't JSON or has no integer format."""
    try:
        files[MANIFEST] = read(MANIFEST)
        raw = json.loads(files[MANIFEST].decode("utf-8"))
    except (OSError, ValueError):
        raise DatasetError(
            [Issue(path=(), message=f"{MANIFEST} is missing or isn't JSON.")]
        ) from None
    version = raw.get("format") if isinstance(raw, dict) else None
    if type(version) is int and version > FORMAT:
        raise NewerFormatError
    if type(version) is not int:
        raise DatasetError([Issue(path=("format",), message=UNKNOWN_FORMAT)])
    return raw


def _protocols(raw: dict[str, Any]) -> list[tuple[int, dict[str, Any], str]]:
    """Each protocol in the manifest whose name can name its CSV, with its index; the checks
    report the rest."""
    protocols = raw.get("protocols")
    out = []
    for i, protocol in enumerate(protocols if isinstance(protocols, list) else []):
        name = protocol.get("name") if isinstance(protocol, dict) else None
        if isinstance(name, str) and _PROTOCOL_NAME.fullmatch(name):
            out.append((i, protocol, name))
    return out


def _csv_text(read: Reader, name: str, files: dict[str, bytes]) -> str:
    """Protocol `name`'s CSV as text, its bytes kept in `files`."""
    filename = f"{name}.csv"
    if filename not in files:
        files[filename] = read(filename)
    return files[filename].decode("utf-8")


_PROTOCOL_NAME = re.compile(PROTOCOL_NAME)
_NUMBER = re.compile(r"-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?")
_MARK = {"0": False, "1": True}


def _points(text: str, name: str, at: IssuePath, issues: list[Issue]) -> list[dict[str, Any]]:
    if not text.startswith(CSV_HEADER + "\n") or not text.endswith("\n") or "\r" in text:
        issues.append(
            Issue(
                path=at,
                message=f"{name}.csv must start with the line {CSV_HEADER} and use LF line ends.",
            )
        )
        return []
    # Count LF-delimited rows without splitting or building points (or one issue per row).
    # The header and final LF were checked above; even malformed rows count toward the cap.
    if text.count("\n") - 1 > MAX_POINTS:
        issues.append(
            Issue(
                path=at,
                message="A protocol has 1 to 1,000 points, interpolated points included.",
            )
        )
        return []
    points = []
    for k, line in enumerate(text.split("\n")[1:-1]):
        fields = line.split(",")
        if (
            len(fields) != 5
            or not all(_NUMBER.fullmatch(f) for f in fields[:2])
            or not (fields[2] == "" or _NUMBER.fullmatch(fields[2]))
            or not all(f in _MARK for f in fields[3:])
        ):
            issues.append(
                Issue(
                    path=(*at, k),
                    message=f"Line {k + 2} of {name}.csv isn't x,value,sd,validation,interpolated "
                    "as numbers, with the marks 0 or 1.",
                )
            )
            continue
        x, value, sd, validation, interpolated = fields
        points.append(
            {
                "x": float(x),
                "value": float(value),
                "sd": float(sd) if sd else None,
                "validation": _MARK[validation],
                "interpolated": _MARK[interpolated],
            }
        )
    return points


def write_revision(folder: Path, dataset: Dataset, *, flush: bool = False) -> None:
    """Write `dataset` into a new `folder`; `DatasetError` if it fails the checks.

    With `flush`, each file and the folder are on disk before it returns, so the folder can be
    renamed into place and published (ADR-0009).
    """
    issues = validate_dataset(dataset)
    if issues:
        raise DatasetError(issues)
    folder.mkdir(parents=True)
    for name, text in _render(dataset).items():
        with open(folder / name, "wb") as f:
            f.write(text.encode())
            if flush:
                f.flush()
                os.fsync(f.fileno())
    if flush:
        fsync_folder(folder)


def files_digest(dataset: Dataset) -> str:
    """A sha256 in hex of the files `write_revision` writes for `dataset`, names and bytes.

    To verify stored bytes, use `read_revision` with `expected_digest`: rendering a parsed
    dataset normalizes representations and cannot detect every file edit.
    """
    return _files_digest({name: text.encode() for name, text in _render(dataset).items()})


def bytes_digest(files: Mapping[str, bytes]) -> str:
    """A sha256 in hex of `files`, names and bytes: what `files_digest` is of a rendering, and
    the runs database keeps of each revision's stored files."""
    return _files_digest(files)


def _files_digest(files: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name, data in sorted(files.items()):
        digest.update(f"{name}\0{len(data)}\0".encode())
        digest.update(data)
    return digest.hexdigest()


def _render(dataset: Dataset) -> dict[str, str]:
    manifest = dataset.model_dump(mode="json", by_alias=True, exclude_none=True)
    for protocol in manifest["protocols"]:
        del protocol["points"]
    files = {MANIFEST: json.dumps(_bare_integers(manifest), indent=2, ensure_ascii=False) + "\n"}
    for protocol in dataset.protocols:
        files[f"{protocol.name}.csv"] = _csv(protocol.points)
    return files


def _csv(points: list[Point]) -> str:
    lines = [CSV_HEADER]
    for p in sorted(points, key=lambda p: p.x):
        sd = "" if p.sd is None else _as_text(p.sd)
        marks = f"{int(p.validation)},{int(p.interpolated)}"
        lines.append(f"{_as_text(p.x)},{_as_text(p.value)},{sd},{marks}")
    return "\n".join(lines) + "\n"


def _as_text(value: float) -> str:
    if value.is_integer() and abs(value) < 2**53:
        return str(int(value))
    return repr(value)


def _bare_integers(node: Any) -> Any:
    if isinstance(node, float) and node.is_integer() and abs(node) < 2**53:
        return int(node)
    if isinstance(node, dict):
        return {key: _bare_integers(value) for key, value in node.items()}
    if isinstance(node, list):
        return [_bare_integers(value) for value in node]
    return node
