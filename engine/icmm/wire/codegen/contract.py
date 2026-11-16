"""The contract: the registry exported as a JSON Schema bundle and a method manifest.

`build_contract` lints what it exports: every model must sit inside the subset that typify (Rust)
and json-schema-to-typescript (TS) were shown to translate faithfully (docs/research), so a
model outside it fails here, naming the field, rather than as odd code in another language.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

from pydantic import TypeAdapter

from icmm.dataset.templates import TEMPLATES
from icmm.wire.base import MAX_WIRE_INT
from icmm.wire.envelope import MAX_LINE_BYTES
from icmm.wire.errors import WireError
from icmm.wire.methods import Method
from icmm.wire.version import PROTOCOL_VERSION

type Schema = dict[str, Any]

_DEF = "#/$defs/"
_NAME = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
_TAGS = ("type", "kind", "code")
"""The tags a union may be discriminated on: `type`, `kind` for a dataset's measure as ADR-0003's
manifest writes it, and `code` for errors."""


class WireLintError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("the wire schema is outside the supported subset:\n" + "\n".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class Contract:
    schema: Schema
    """The JSON Schema 2020-12 bundle: every type under `$defs`."""
    methods: Schema
    """`{protocol, schema_hash, max_line_bytes, methods: [...], templates: {...}}`: one entry per
    registry method, and each template's preset, which the desktop starts a protocol from."""
    schema_hash: str


def build_contract(methods: Iterable[Method]) -> Contract:
    methods = tuple(methods)
    problems = list(_registry_problems(methods))
    schema = _bundle(methods)
    problems += _schema_problems(schema, methods)
    if problems:
        raise WireLintError(problems)
    entries = [_entry(m) for m in methods]
    templates = {
        name: preset.model_dump(mode="json", by_alias=True) for name, preset in TEMPLATES.items()
    }
    schema_hash = _hash(schema, entries, templates)
    manifest = {
        "protocol": PROTOCOL_VERSION,
        "schema_hash": schema_hash,
        "max_line_bytes": MAX_LINE_BYTES,
        "methods": entries,
        "templates": templates,
    }
    return Contract(schema, manifest, schema_hash)


def lock_problem(base: dict[str, str] | None, protocol: str, schema_hash: str) -> str | None:
    """Why `protocol` with `schema_hash` can't follow the `base` lock, or `None` if it can.

    `base` is the lock this branch started from. A schema change needs a newer protocol; a newer
    protocol may keep its schema, since a change in meaning alone is still a change.
    """
    if base is None:
        return None
    if _version(protocol) < _version(base["protocol"]):
        return f"PROTOCOL_VERSION {protocol} is older than {base['protocol']}"
    if protocol == base["protocol"] and schema_hash != base["schema_hash"]:
        return (
            f"the wire schema changed since protocol {protocol}: bump PROTOCOL_VERSION "
            "in engine/icmm/wire/version.py"
        )
    return None


def _version(protocol: str) -> tuple[int, int]:
    major, minor = protocol.split(".")
    return int(major), int(minor)


# --- export ------------------------------------------------------------------------------------


def _bundle(methods: tuple[Method, ...]) -> Schema:
    models = [t for m in methods for t in (m.params, m.result, m.event) if t is not None]
    adapters = [TypeAdapter(WireError), *(TypeAdapter(t) for t in dict.fromkeys(models))]
    _, top = TypeAdapter.json_schemas(
        [(i, "validation", a) for i, a in enumerate(adapters)], ref_template=_DEF + "{model}"
    )
    defs = {name: _strip_property_titles(s) for name, s in top.get("$defs", {}).items()}
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": defs}


def _strip_property_titles(node: Schema) -> Schema:
    """Drops each property's title (`"Engine Version"`), which json2ts turns into alias noise.

    A model keeps its own title.
    """
    out = dict(node)
    if "properties" in out:
        out["properties"] = {
            name: _without(_strip_property_titles(p), "title")
            for name, p in out["properties"].items()
        }
    for key in ("items", "additionalProperties"):
        if isinstance(out.get(key), dict):
            out[key] = _without(_strip_property_titles(out[key]), "title")
    for key in ("anyOf", "oneOf"):
        if key in out:
            out[key] = [_strip_property_titles(s) for s in out[key]]
    return out


def _without(node: Schema, *keys: str) -> Schema:
    return {k: v for k, v in node.items() if k not in keys}


def _entry(m: Method) -> Schema:
    return {
        "name": m.name,
        "kind": m.kind,
        "command": m.command,
        "params": m.params.__name__ if m.params else None,
        "result": m.result.__name__ if m.result else None,
        "event": m.event.__name__ if m.event else None,
        "errors": list(m.errors),
        "timeout_ms": m.timeout_ms,
        "async": m.is_async,
        "doc": m.doc,
    }


def _hash(schema: Schema, entries: list[Schema], templates: Schema) -> str:
    """Hashes the shapes only: rewording a description or a doc isn't a protocol change. The
    templates' presets count too: the engine derives a protocol's template from the structure
    the desktop gave it from a preset (ADR-0003)."""
    shapes = {
        "schema": _shape(schema),
        "methods": [_without(e, "doc") for e in entries],
        "max_line_bytes": MAX_LINE_BYTES,
        "templates": templates,
    }
    canonical = json.dumps(shapes, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _shape(node: Any) -> Any:
    if isinstance(node, list):
        return [_shape(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key in ("description", "title"):
            continue
        if key in ("properties", "$defs"):
            out[key] = {name: _shape(s) for name, s in value.items()}
        else:
            out[key] = _shape(value)
    return out


# --- lint --------------------------------------------------------------------------------------


def _registry_problems(methods: tuple[Method, ...]) -> Iterator[str]:
    seen: set[str] = set()
    for m in methods:
        if m.name in seen:
            yield f"{m.name}: named twice"
        elif not _NAME.match(m.name):
            yield f"{m.name}: not a snake_case name"
        seen.add(m.name)
        if m.kind == "write":
            key = m.params.model_fields.get("request_key") if m.params else None
            if key is None or key.annotation is not str:
                yield f"{m.name}: a write's params need a `request_key: str`"


def _schema_problems(schema: Schema, methods: tuple[Method, ...]) -> list[str]:
    defs = schema["$defs"]
    problems: list[str] = []
    for name, node in defs.items():
        if node.get("type") != "object":
            problems += _node_problems(node, name)
            continue
        if node.get("additionalProperties") is not False:
            problems.append(f"{name}: open to unknown keys; derive it from WireModel")
            continue
        for field, prop in node.get("properties", {}).items():
            problems += _node_problems(prop, f"{name}.{field}")
    results = [t.__name__ for m in methods for t in (m.result, m.event) if t is not None]
    for name in sorted(_reachable(defs, results)):
        for field, prop in defs[name].get("properties", {}).items():
            if "default" in prop:
                problems.append(
                    f"{name}.{field}: a default in a result; "
                    "results carry every field, null when empty"
                )
    return problems


def _node_problems(node: Schema, where: str) -> list[str]:
    if node.get("type") == "integer":
        return _integer_problems(node, where)
    if "$ref" in node or "const" in node or "enum" in node:
        return []
    if "anyOf" in node:
        branches = [b for b in node["anyOf"] if b.get("type") != "null"]
        if _number_or_word(branches):
            return []
        if len(branches) != 1:
            return [f"{where}: a union of types other than one type and null"]
        return _node_problems(branches[0], where)
    if "oneOf" in node:
        tag = node.get("discriminator", {}).get("propertyName")
        if tag not in _TAGS:
            return [
                f"{where}: a union tagged on `{tag}`; tag unions on `type`, `kind` (a dataset's "
                "measure) or `code` (errors)"
            ]
        return []
    kind = node.get("type")
    if kind is None:
        return [f"{where}: has no type (Any)"]
    if kind == "array":
        if "prefixItems" in node:
            return [f"{where}: a tuple; use a list or a model"]
        if node.get("uniqueItems"):
            return [f"{where}: a set; use a list"]
        return _node_problems(node.get("items", {}), f"{where}[]")
    if kind == "object":
        values = node.get("additionalProperties")
        if not isinstance(values, dict):
            return [f"{where}: has no type (Any)"]
        return _node_problems(values, f"{where}{{}}")
    return []


def _number_or_word(branches: list[Schema]) -> bool:
    """A number or one fixed string, as a dataset step's `"swept"` voltage or duration: TS reads
    it as `number | "swept"`, and Rust as an untagged enum of an `f64` and a one-word enum."""
    kinds = sorted(b.get("type", "") for b in branches)
    word = next((b for b in branches if b.get("type") == "string"), {})
    return kinds == ["number", "string"] and isinstance(word.get("const"), str)


def _integer_problems(node: Schema, where: str) -> list[str]:
    if "const" in node or "enum" in node:
        values = [node["const"]] if "const" in node else node["enum"]
        lower, upper = min(values), max(values)
    else:
        lowers = [-math.inf]
        uppers = [math.inf]
        if "minimum" in node:
            lowers.append(math.ceil(node["minimum"]))
        if "exclusiveMinimum" in node:
            lowers.append(math.floor(node["exclusiveMinimum"]) + 1)
        if "maximum" in node:
            uppers.append(math.floor(node["maximum"]))
        if "exclusiveMaximum" in node:
            uppers.append(math.ceil(node["exclusiveMaximum"]) - 1)
        lower, upper = max(lowers), min(uppers)
    if lower < -MAX_WIRE_INT or upper > MAX_WIRE_INT:
        return [
            f"{where}: an integer outside the shared safe range "
            f"[-{MAX_WIRE_INT}, {MAX_WIRE_INT}]; use WireInt or tighter bounds"
        ]
    return []


def _reachable(defs: Schema, roots: list[str]) -> set[str]:
    seen: set[str] = set()
    stack = list(roots)
    while stack:
        name = stack.pop()
        if name not in seen:
            seen.add(name)
            stack += [ref for ref in _refs(defs[name]) if ref not in seen]
    return seen


def _refs(node: Any) -> Iterator[str]:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith(_DEF):
            yield ref.removeprefix(_DEF)
        for value in node.values():
            yield from _refs(value)
    elif isinstance(node, list):
        for value in node:
            yield from _refs(value)
