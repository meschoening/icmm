"""Builds one target's **Engine bundle**: `<out>/<key>/` and its archive `<out>/<key>.tar.zst`.

The archive and its `.sha256` are also copied into the app's `engines` resources
(desktop/src-tauri/engines/), replacing the target's older ones: the app installs from there.

    uv run python scripts/engine_bundle.py --libicmm build/libicmm.dylib [--target <triple>]

A bundle is python-build-standalone's CPython (the PBS_ pins in scripts/ci/pins.env), pruned, with
the locked wheels and the `icmm` package in its site-packages, libicmm in `icmm/_native/`, the
topology lists unpacked in `icmm/_lists/` (`icmm.topology`), every module precompiled, and
`BUNDLE.json` beside it. It has no symlinks and no console scripts, and
runs anywhere it's unpacked as `python/bin/python3.12 -I -m icmm …` (`python\\python.exe` on
Windows). See docs/research/engine-bundle.md on `research/engine-bundle` and ADR-0002.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import zstandard
from icmm import __version__, topology
from icmm.bundle import MANIFEST, BundleManifest
from icmm.wire import PROTOCOL_VERSION

ROOT = Path(__file__).resolve().parent.parent
PINS = ROOT / "scripts" / "ci" / "pins.env"
APP_ENGINES = ROOT / "desktop" / "src-tauri" / "engines"
LISTS = ROOT / "engine" / "topology"


@dataclass(frozen=True)
class Target:
    triple: str
    name: str
    """`<os>-<arch>`, as the bundle's key spells it."""

    @property
    def os(self) -> str:
        return self.name.split("-")[0]

    @property
    def windows(self) -> bool:
        return self.os == "windows"

    @property
    def library(self) -> str:
        """libicmm's file name (`icmm.core.library_name` on the target)."""
        if self.windows:
            return "icmm.dll"
        return "libicmm.dylib" if self.os == "macos" else "libicmm.so"


TARGETS = {
    t.triple: t
    for t in (
        Target("aarch64-apple-darwin", "macos-arm64"),
        Target("x86_64-apple-darwin", "macos-x86_64"),
        Target("x86_64-pc-windows-msvc", "windows-x86_64"),
        Target("x86_64-unknown-linux-gnu", "linux-x86_64"),
    )
}


def host_target() -> Target:
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}
    system = {"darwin": "apple-darwin", "win32": "pc-windows-msvc", "linux": "unknown-linux-gnu"}
    return TARGETS[f"{arch[machine]}-{system[sys.platform]}"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Builds the engine bundle for one target.")
    parser.add_argument("--libicmm", type=Path, required=True, help="the built core for the target")
    parser.add_argument(
        "--target",
        choices=sorted(TARGETS),
        help="this machine's OS, any arch it runs (Rosetta); default: this machine's",
    )
    parser.add_argument("--out", type=Path, default=ROOT / "build" / "engine-bundle")
    parser.add_argument(
        "--cache", type=Path, default=ROOT / ".cache" / "pbs", help="where downloads are kept"
    )
    parser.add_argument(
        "--app", type=Path, default=APP_ENGINES, help="the app's engines resources, to copy into"
    )
    parser.add_argument(
        "--fast", action="store_true", help="pack a PR/test bundle quickly with one zstd worker"
    )
    parser.add_argument(
        "--artifact-cache", type=Path, help="reuse a verified bundle for identical inputs"
    )
    parser.add_argument("--rebuild", action="store_true", help="ignore the completed-bundle cache")
    args = parser.parse_args(argv)
    target = TARGETS[args.target] if args.target else host_target()
    if target.os != host_target().os:
        # The build runs the target's interpreter and inspects libicmm with the host's tools.
        parser.error(f"a {target.os} bundle is built on {target.os}")
    manifest, archive = cached_build(
        target,
        libicmm=args.libicmm,
        out=args.out,
        cache=args.cache,
        fast=args.fast,
        artifact_cache=args.artifact_cache,
        rebuild=args.rebuild,
    )
    give_to_app(archive, target, args.app)
    log(
        f"{manifest.key}: {manifest.files} files, {manifest.bytes / 1e6:.1f} MB unpacked, "
        f"{archive.stat().st_size / 1e6:.1f} MB as {archive.name}"
    )
    print(archive)  # the one line on stdout, for the gate
    return 0


def input_digest(target: Target, libicmm: Path, fast: bool, *, root: Path = ROOT) -> str:
    """Content-based inputs, including every packaged source/asset and the tool itself.

    Caches are local to each runner/toolchain. Checkout timestamps never participate.
    """
    sha = hashlib.sha256(
        f"engine-cache-v1:{target.triple}:{fast}:{platform.platform()}:{platform.libc_ver()}".encode()
    )
    inputs = [
        root / p
        for p in (
            "pyproject.toml",
            "uv.lock",
            "LICENSE",
            "scripts/engine_bundle.py",
            "scripts/ci/pins.env",
        )
    ]
    for folder in (root / "engine/icmm", root / "engine/topology"):
        inputs.extend(
            p
            for p in folder.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
        )
    for path in sorted(inputs):
        sha.update(str(path.relative_to(root)).encode() + b"\0")
        sha.update(bytes.fromhex(_sha256(path)))
        sha.update(bytes([bool(path.stat().st_mode & 0o111)]))
    sha.update(bytes.fromhex(_sha256(libicmm)))
    sha.update(bytes([bool(libicmm.stat().st_mode & 0o111)]))
    return sha.hexdigest()


def cached_build(
    target: Target,
    *,
    libicmm: Path,
    out: Path,
    cache: Path,
    fast: bool = False,
    artifact_cache: Path | None = None,
    rebuild: bool = False,
) -> tuple[BundleManifest, Path]:
    if artifact_cache is None:
        return build(target, libicmm=libicmm, out=out, cache=cache, fast=fast)
    digest = input_digest(target, libicmm, fast)
    entry = artifact_cache / digest
    if not rebuild:
        try:
            receipt = json.loads((entry / "receipt.json").read_text())
            manifest = BundleManifest.model_validate(receipt["manifest"])
            name = f"{manifest.key}.tar.zst"
            if Path(name).name != name or "\\" in name:
                raise ValueError("invalid cached key")
            source = entry / name
            sha = _sha256(source)
            if sha != receipt["sha256"] or receipt["inputs"] != digest:
                raise ValueError("cached archive checksum or input mismatch")
            out.mkdir(parents=True, exist_ok=True)
            for old in out.glob(f"*-{target.name}-*"):
                _remove(old)
            archive = out / name
            shutil.copy2(source, archive)
            Path(f"{archive}.sha256").write_text(f"{sha}  {name}\n", encoding="utf-8")
            log(f"verified artifact cache hit {digest[:12]}")
            return manifest, archive
        except (OSError, ValueError, KeyError, TypeError):
            log(f"artifact cache miss {digest[:12]}")
    manifest, archive = build(target, libicmm=libicmm, out=out, cache=cache, fast=fast)
    artifact_cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=artifact_cache, prefix=".staging-") as tmp:
        staged = Path(tmp)
        shutil.copy2(archive, staged / archive.name)
        (staged / "receipt.json").write_text(
            json.dumps(
                {
                    "inputs": digest,
                    "sha256": _sha256(archive),
                    "manifest": manifest.model_dump(),
                }
            )
        )
        _remove(entry)
        staged.rename(entry)
    # Bound storage on the shared host. Restored archives live in their job's own output tree.
    entries = sorted(
        (p for p in artifact_cache.iterdir() if p.is_dir() and not p.name.startswith(".")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in entries[3:]:
        _remove(old)
    return manifest, archive


def build(
    target: Target, *, libicmm: Path, out: Path, cache: Path, fast: bool = False
) -> tuple[BundleManifest, Path]:
    """Builds `<out>/<key>/` and `<out>/<key>.tar.zst`, with its `sha256sum` line beside it."""
    pins = read_pins()
    pbs = fetch_python(target, pins, cache)
    out.mkdir(parents=True, exist_ok=True)
    staging = out / f".staging-{target.name}"
    _remove(staging)
    staging.mkdir()
    log(f"unpacking {pbs.name}")
    with tarfile.open(pbs, "r:gz") as tar:
        tar.extractall(staging, filter="data")
    python = staging / "python"
    install_packages(python, target, pins["PBS_PYTHON"])
    package = site_packages(python, target) / "icmm"
    (package / "_native").mkdir()
    shutil.copy2(libicmm, package / "_native" / target.library)
    log("unpacking the topology lists")
    topology.unpack(LISTS, package / "_lists")
    if foreign := foreign_libraries(target, list_libraries(target, libicmm)):
        raise SystemExit(f"{libicmm} links libraries outside the system: {', '.join(foreign)}")
    prune(python, target)
    compile_bytecode(python, target)
    check_engine(python, target)
    manifest = write_manifest(
        staging,
        engine_version=__version__,
        protocol=PROTOCOL_VERSION,
        target=target.triple,
        python=pins["PBS_PYTHON"],
        glibc=glibc_floor(read_versions(staging)) if target.os == "linux" else None,
    )
    for old in out.glob(f"*-{target.name}-*"):
        _remove(old)
    bundle = out / manifest.key
    staging.rename(bundle)
    archive = out / f"{manifest.key}.tar.zst"
    log(f"packing {archive.name}")
    sha = write_archive(bundle, archive, fast=fast)
    Path(f"{archive}.sha256").write_text(f"{sha}  {archive.name}\n", encoding="utf-8")
    return manifest, archive


def give_to_app(archive: Path, target: Target, app: Path) -> None:
    """Copies `archive` and its `.sha256` into the app's `engines` resources, in place of the
    target's older ones."""
    app.mkdir(parents=True, exist_ok=True)
    for old in app.glob(f"*-{target.name}-*.tar.zst*"):
        old.unlink()
    for path in (archive, Path(f"{archive}.sha256")):
        shutil.copy2(path, app / path.name)


def log(message: str) -> None:
    print(f"engine_bundle: {message}", file=sys.stderr, flush=True)


def check_engine(python: Path, target: Target) -> None:
    """Load the packaged core with the target interpreter before publishing any artifacts.

    This catches a core for the wrong architecture (including under Rosetta), a stale core,
    and missing runtime dependencies. The staging tree has no manifest yet.
    """
    log("checking the staged engine")
    subprocess.run(
        [interpreter(python, target), "-I", "-B", "-m", "icmm", "selfcheck"],
        check=True,
        stdout=sys.stderr,
    )


def read_pins() -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in PINS.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            key, _, value = line.partition("=")
            pins[key.strip()] = value.strip()
    return pins


def fetch_python(target: Target, pins: dict[str, str], cache: Path) -> Path:
    """The pinned python-build-standalone archive for `target`, downloaded once and checked."""
    release, version = pins["PBS_RELEASE"], pins["PBS_PYTHON"]
    expected = pins[f"PBS_SHA256_{target.triple.upper().replace('-', '_')}"]
    name = f"cpython-{version}+{release}-{target.triple}-install_only_stripped.tar.gz"
    path = cache / name
    if path.is_file() and _sha256(path) == expected:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{release}/{name}"
    log(f"downloading {name}")
    partial = path.with_name(name + ".part")
    subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", partial, url], check=True)
    if (got := _sha256(partial)) != expected:
        partial.unlink()
        raise SystemExit(f"{name} has sha256 {got}; pins.env says {expected}")
    partial.replace(path)
    return path


def install_packages(python: Path, target: Target, version: str) -> None:
    """Installs the locked runtime wheels and the `icmm` package into the interpreter's site."""
    uv = os.environ.get("UV", "uv")
    site = site_packages(python, target)
    into = ["--target", site, "--python-platform", target.triple, "--python-version", version]
    into += ["--only-binary", ":all:"]
    # The app's minimum macOS (tauri.conf.json); uv would otherwise assume 13.0.
    env = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": "13.3"}
    with tempfile.TemporaryDirectory() as tmp:
        requirements = Path(tmp) / "requirements.txt"
        log("installing the locked wheels")
        subprocess.run(
            [uv, "export", "--frozen", "--no-dev", "--no-emit-project", "--no-header"]
            + ["--format", "requirements.txt", "--output-file", requirements],
            check=True,
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
        )
        subprocess.run(
            [uv, "pip", "install", *into, "--require-hashes", "-r", requirements],
            check=True,
            env=env,
        )
        log("installing icmm")
        subprocess.run([uv, "build", "--wheel", "--out-dir", tmp, ROOT], check=True, cwd=ROOT)
        wheel = next(Path(tmp).glob("icmm-*.whl"))
        subprocess.run([uv, "pip", "install", *into, "--no-deps", wheel], check=True, env=env)


# What libicmm may link besides itself: the C and C++ runtimes every target system has. MSVC's
# runtime is linked statically (/MT), so on Windows that's the kernel alone.
_SYSTEM_DYLIB_FOLDERS = ("/usr/lib/", "/System/Library/")
_SYSTEM_DLLS = {"kernel32.dll"}
_SYSTEM_SONAMES = {
    "ld-linux-x86-64.so.2",
    "libc.so.6",
    "libdl.so.2",
    "libgcc_s.so.1",
    "libm.so.6",
    "libpthread.so.0",
    "librt.so.1",
    "libstdc++.so.6",
}


def list_libraries(target: Target, library: Path) -> str:
    """`otool -L`, `readelf -d` or `dumpbin /dependents` of the library.

    dumpbin needs the MSVC environment (scripts/ci/msvc.sh).
    """
    tool = {
        "macos": ["otool", "-L"],
        "linux": ["readelf", "-d"],
        "windows": ["dumpbin", "/nologo", "/dependents"],
    }[target.os]
    return subprocess.run([*tool, library], check=True, capture_output=True, text=True).stdout


def foreign_libraries(target: Target, listing: str) -> list[str]:
    """The libraries in `list_libraries`'s output that aren't the system's (ADR-0004)."""
    if target.os == "macos":
        # Dependencies are the indented lines; a universal library also has a header per arch.
        linked = [line.split(" (")[0].strip() for line in listing.splitlines() if line[:1] == "\t"]
        own = "@rpath/libicmm.dylib"
        return [p for p in linked if p != own and not p.startswith(_SYSTEM_DYLIB_FOLDERS)]
    if target.os == "windows":
        block = listing.partition("following dependencies:")[2].partition("Summary")[0]
        return [name for name in block.split() if name.lower() not in _SYSTEM_DLLS]
    needed = re.findall(r"\(NEEDED\)\s+Shared library: \[(.+?)\]", listing)
    return [name for name in needed if name not in _SYSTEM_SONAMES]


def read_versions(tree: Path) -> str:
    """`readelf -V --wide` of every ELF file in `tree`, a few hundred to a call."""
    elf = []
    for path in sorted(tree.rglob("*")):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as f:
                if f.read(4) == b"\x7fELF":
                    elf.append(path)
    listings = []
    for start in range(0, len(elf), 200):
        listings.append(
            subprocess.run(
                ["readelf", "-V", "--wide", *elf[start : start + 200]],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
    return "".join(listings)


def glibc_floor(listing: str) -> str | None:
    """The newest `GLIBC_x.y` that `readelf -V --wide`'s files need, or `None` if none needs one.

    Only version needs count: a definition section names versions a file provides, not uses.
    """
    newest: tuple[int, ...] | None = None
    needs = False
    for line in listing.splitlines():
        if line.startswith(("File:", "Version ")):
            needs = line.startswith("Version needs section")
        elif needs and (m := re.search(r"\bName: GLIBC_(\d+(?:\.\d+)+)\b", line)):
            version = tuple(int(part) for part in m[1].split("."))
            newest = max(newest or version, version)
    return ".".join(map(str, newest)) if newest else None


def compile_bytecode(python: Path, target: Target) -> None:
    """Precompiles every module with the bundle's own interpreter.

    Unchecked-hash bytecode is never compared with its source, so it stays valid whatever times
    an unpacking leaves, and nothing compiles on a login node capped at 7 % of a core. One process
    with a fixed hash seed writes the same bytes every time: marshal's output varies with set
    order and with what else the compiling process holds. `-B` keeps the compiler's own imports
    from leaving timestamped bytecode, which `-f` would rewrite anyway.
    """
    log("compiling bytecode")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    subprocess.run(
        [interpreter(python, target), "-B", "-m", "compileall", "-q", "-f"]
        + ["--invalidation-mode", "unchecked-hash", "-s", python, "-p", "/", python],
        check=True,
        env={**env, "PYTHONHASHSEED": "0"},
    )


# Stdlib packages a headless engine never imports, and pip's bootstrap.
_STDLIB_UNUSED = ("ensurepip", "idlelib", "lib2to3", "pydoc_data", "tkinter", "turtledemo")

# Relative to the interpreter folder: headers, docs, Tcl/Tk, and what only builds extensions.
_PRUNED_POSIX = (
    "include",
    "share",
    "lib/pkgconfig",
    "lib/libtcl*",
    "lib/libtk*",
    "lib/tcl*",
    "lib/tk*",
    "lib/itcl*",
    "lib/thread*",
    "lib/python3.12/config-3.12-*",
    "lib/python3.12/lib-dynload/_tkinter.*",
    *(f"lib/python3.12/{name}" for name in _STDLIB_UNUSED),
    # PBS's POSIX python3.12 is linked statically, and extensions don't link libpython.
    "lib/libpython3*",
)
_PRUNED_WINDOWS = (
    "Scripts",
    "include",
    "libs",
    "tcl",
    "DLLs/_tkinter.pyd",
    "DLLs/tcl*.dll",
    "DLLs/tk*.dll",
    "DLLs/_test*.pyd",
    "DLLs/_ctypes_test.pyd",
    *(f"Lib/{name}" for name in _STDLIB_UNUSED),
)
# Relative to site-packages: pip, the console scripts `uv pip install --target` writes, and the
# wire's code generator, a tool for the repo.
_PRUNED_SITE = ("pip", "pip-*.dist-info", "bin", "icmm/wire/codegen")


def interpreter(python: Path, target: Target) -> Path:
    """The interpreter's executable in its folder."""
    return python / "python.exe" if target.windows else python / "bin" / "python3.12"


def site_packages(python: Path, target: Target) -> Path:
    return python / ("Lib" if target.windows else "lib/python3.12") / "site-packages"


def prune(python: Path, target: Target) -> None:
    """Removes from an interpreter folder what a headless engine never uses.

    Every console script goes (their shebangs are absolute paths), and so does all bytecode:
    the build compiles it afresh, after pruning.
    """
    patterns = _PRUNED_WINDOWS if target.windows else _PRUNED_POSIX
    site = site_packages(python, target)
    doomed = [path for pattern in patterns for path in python.glob(pattern)]
    doomed += [p for p in python.glob("bin/*") if p.name != "python3.12"]
    doomed += [path for pattern in _PRUNED_SITE for path in site.glob(pattern)]
    doomed += [p for p in site.rglob("*") if p.is_dir() and p.name in ("test", "tests")]
    doomed += site.rglob("*.pyi")
    # Install records that name the build's temporary folder or time.
    doomed += site.glob("*.dist-info/direct_url.json")
    doomed += site.glob("*.dist-info/uv_cache.json")
    doomed += python.rglob("__pycache__")
    for path in doomed:
        _remove(path)
    for record in site.glob("*.dist-info/RECORD"):
        lines = record.read_text(encoding="utf-8").splitlines(keepends=True)
        kept = [line for line in lines if (site / next(csv.reader([line]))[0]).is_file()]
        record.write_text("".join(kept), encoding="utf-8")


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def write_manifest(
    bundle: Path,
    *,
    engine_version: str,
    protocol: str,
    target: str,
    python: str,
    glibc: str | None = None,
) -> BundleManifest:
    """Writes `BUNDLE.json` for the tree in `bundle`, naming it by a digest of its files."""
    content, files, size = digest(bundle)
    manifest = BundleManifest(
        key=f"{engine_version}-{TARGETS[target].name}-{content[:12]}",
        engine_version=engine_version,
        protocol=protocol,
        target=target,
        python=python,
        content_sha256=content,
        files=files,
        bytes=size,
        glibc=glibc,
    )
    (bundle / MANIFEST).write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return manifest


def digest(bundle: Path) -> tuple[str, int, int]:
    """The bundle's content digest, file count and size, `BUNDLE.json` aside.

    The digest covers each file's path, executable bit and contents, not its times.
    """
    return content_digest(
        (relative, _sha256(bundle / relative), bool(stat.S_IMODE(st.st_mode) & 0o111), st.st_size)
        for relative, st in bundle_files(bundle)
    )


def content_digest(files: Iterable[tuple[str, str, bool, int]]) -> tuple[str, int, int]:
    """`digest` of files given as (path, sha256, executable, size), in byte order of path."""
    sha = hashlib.sha256()
    count = size = 0
    for relative, file_sha, executable, file_size in files:
        sha.update(f"{file_sha} {'x' if executable else '-'} {relative}\n".encode())
        count += 1
        size += file_size
    return sha.hexdigest(), count, size


def bundle_files(bundle: Path) -> list[tuple[str, os.stat_result]]:
    """Every file in the bundle but its manifest, by `/`-separated path in byte order.

    A bundle holds no symlinks, which an archive, an SFTP upload or a Windows copy can each break.
    """
    found: list[tuple[str, os.stat_result]] = []
    for folder, dirs, names in os.walk(bundle):
        for name in dirs + names:
            if Path(folder, name).is_symlink():
                relative = _relative(bundle, Path(folder, name))
                raise ValueError(f"{relative} is a symlink; a bundle holds none.")
        for name in names:
            path = Path(folder, name)
            if (relative := _relative(bundle, path)) != MANIFEST:
                found.append((relative, path.stat()))
    return sorted(found, key=lambda item: item[0].encode())


def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _sha256(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


# Every entry's time in the archive: unpacked times don't matter (the bytecode is unchecked-hash),
# and a fixed one keeps the archive's bytes, and so its sha256, a function of the tree.
ARCHIVE_MTIME = 1704067200  # 2024-01-01T00:00:00Z; GNU tar warns on times near 1970.


def compressor(*, fast: bool = False) -> zstandard.ZstdCompressor:
    """How `write_archive` compresses: see there."""
    params = zstandard.ZstdCompressionParameters.from_level(
        6 if fast else 19, window_log=26, enable_ldm=True, threads=1 if fast else -1
    )
    return zstandard.ZstdCompressor(compression_params=params)


def write_archive(tree: Path, archive: Path, *, fast: bool = False) -> str:
    """Packs `tree`'s contents (not the folder itself) as `archive`, and returns its sha256.

    Releases use level 19 for a smaller upload to a throttled login node. PR/test builds use
    level 6 and one worker to avoid spending minutes compressing on the shared CI host. Both
    keep a 64 MiB window, which zstd ≥ 1.3.7 and the desktop's ruzstd (at most 100 MiB) unpack.
    """
    entries = sorted(tree.rglob("*"), key=lambda p: p.relative_to(tree).as_posix().encode())
    with archive.open("wb") as raw, compressor(fast=fast).stream_writer(raw) as stream:
        with tarfile.open(fileobj=stream, mode="w|", format=tarfile.GNU_FORMAT) as tar:
            for path in entries:
                info = tarfile.TarInfo(path.relative_to(tree).as_posix())
                info.mtime = ARCHIVE_MTIME
                if path.is_dir():
                    info.type, info.mode = tarfile.DIRTYPE, 0o755
                    tar.addfile(info)
                    continue
                st = path.stat()
                info.size = st.st_size
                info.mode = 0o755 if stat.S_IMODE(st.st_mode) & 0o111 else 0o644
                with path.open("rb") as f:
                    tar.addfile(info, f)
    return _sha256(archive)


if __name__ == "__main__":
    sys.exit(main())
