"""`icmm-wire gen`: regenerates every file the wire registry drives.

1. `wire/`: the schema bundle, the method manifest and the protocol lock.
2. Rust: the types (typify, through the `wire-gen` crate), the Tauri command proxies, the command
   list `build.rs` reads, and the capability that allows each command.
3. TS: the types (json-schema-to-typescript), the typed command wrappers, and the fixtures and
   the templates' presets as type-checked constants.

It refuses to run when the schema changed since the branch's base without a protocol bump.
Needs uv, cargo and npm; the cluster never runs it, since the engine is the source.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from icmm.wire import METHODS, PROTOCOL_VERSION
from icmm.wire.codegen import rust, ts
from icmm.wire.codegen.contract import Contract, build_contract, lock_problem

ROOT = Path(__file__).resolve().parents[4]
WIRE = ROOT / "wire"
LOCK = WIRE / "wire.lock.json"
FIXTURES = WIRE / "fixtures"
DESKTOP = ROOT / "desktop"
TAURI = DESKTOP / "src-tauri"
RUST_WIRE = TAURI / "src" / "wire"
TS_WIRE = DESKTOP / "src" / "wire"

_JSON2TS = """
const { compile } = require("json-schema-to-typescript");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () =>
  compile(JSON.parse(input), "Wire", {
    bannerComment: "",
    unreachableDefinitions: true,
    additionalProperties: false,
  })
    .then((out) => process.stdout.write(out))
    .catch((e) => { console.error(e); process.exit(1); }),
);
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="icmm-wire", description="Regenerates every file the wire registry drives."
    )
    parser.add_argument("command", choices=["gen"])
    parser.parse_args(argv)

    contract = build_contract(METHODS)
    problem = lock_problem(_base_lock(), PROTOCOL_VERSION, contract.schema_hash)
    if problem:
        print(f"icmm-wire: {problem}", file=sys.stderr)
        return 1
    _write_wire(contract)
    _write_rust(contract)
    _write_ts(contract)
    return 0


def _write_wire(contract: Contract) -> None:
    write_json(WIRE / "wire.schema.json", contract.schema)
    write_json(WIRE / "wire.methods.json", contract.methods)
    write_json(LOCK, {"protocol": PROTOCOL_VERSION, "schema_hash": contract.schema_hash})


def _write_rust(contract: Contract) -> None:
    manifest = contract.methods
    types = _run(
        ["cargo", "run", "--quiet", "--locked", "-p", "wire-gen"],
        cwd=TAURI,
        stdin=json.dumps(rust.typify_schema(contract.schema)),
    )
    write_text(RUST_WIRE / "types.rs", _rustfmt(rust.HEADER + "\n" + types))
    write_text(RUST_WIRE / "commands.rs", _rustfmt(rust.commands_rs(manifest)))
    write_text(RUST_WIRE / "command_names.rs", _rustfmt(rust.command_names_rs(manifest)))
    write_json(TAURI / "capabilities" / "wire.json", rust.capability_json(manifest))
    dispatch = TAURI / "tests" / "wire_fixtures" / "dispatch.rs"
    write_text(dispatch, _rustfmt(rust.fixture_dispatch_rs(manifest)))


def _write_ts(contract: Contract) -> None:
    schema = json.dumps(ts.json2ts_schema(contract.schema))
    types = _run(["node", "-e", _JSON2TS], cwd=DESKTOP, stdin=schema)
    write_text(TS_WIRE / "types.gen.ts", ts.tidy_types(types))
    write_text(TS_WIRE / "api.gen.ts", ts.api_ts(contract.methods))
    write_text(TS_WIRE / "fixtures.gen.ts", ts.fixtures_ts(contract.methods, FIXTURES))
    write_text(TS_WIRE / "templates.gen.ts", ts.templates_ts(contract.methods))


def _rustfmt(code: str) -> str:
    return _run(["rustfmt", "--edition", "2024"], cwd=TAURI, stdin=code)


def _run(argv: list[str], *, cwd: Path, stdin: str) -> str:
    exe = shutil.which(argv[0])
    if exe is None:
        raise SystemExit(f"icmm-wire: `{argv[0]}` isn't on PATH")
    done = subprocess.run(
        [exe, *argv[1:]], cwd=cwd, input=stdin, capture_output=True, text=True, encoding="utf-8"
    )
    if done.returncode != 0:
        raise SystemExit(f"icmm-wire: `{' '.join(argv[:3])}` failed:\n{done.stderr}")
    return done.stdout.replace("\r\n", "\n")


def _base_lock() -> dict[str, str] | None:
    """The lock on `main` that this tree must follow, or `None` when `main` has none yet.

    Locally that is the lock where this branch forked from `main`. CI checks out a shallow
    merge of the PR into `main` and fetches `main`'s tip, which has no merge base with it, so
    there the tip's lock is the base. CI never skips the check.
    """
    rel = LOCK.relative_to(ROOT).as_posix()
    for main in ("main", "origin/main"):
        base = _git("merge-base", "HEAD", main) or _git("rev-parse", "--verify", "--quiet", main)
        if base is not None:
            text = _git("show", f"{base}:{rel}")
            return json.loads(text) if text is not None else None
    if os.environ.get("CI"):
        raise SystemExit("icmm-wire: no `main` to check the protocol lock against; fetch it")
    print("icmm-wire: no `main` to compare the protocol lock with; skipping", file=sys.stderr)
    return None


def _git(*args: str) -> str | None:
    done = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
    )
    return done.stdout.strip() or None if done.returncode == 0 else None


def write_json(path: Path, value: Any) -> None:
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def write_text(path: Path, text: str) -> None:
    """Writes LF on every OS, and leaves an unchanged file alone so its mtime doesn't move."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == text.encode():
        return
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)


if __name__ == "__main__":
    sys.exit(main())
