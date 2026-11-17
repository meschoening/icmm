"""The release workflow's checks (`.github/workflows/release.yml`). Standard library only, so any
Python 3.11+ runs it on any runner:

    python .github/release_check.py tag vX.Y.Z[-rc.N]      # the tag matches every version file
    python .github/release_check.py secrets                # the six Apple secrets are set
    python .github/release_check.py deb-depends <bundle dir>  # the .deb names each package once
    python .github/release_check.py stage <bundle dir> <version> <arch> <os> <out dir>
    python .github/release_check.py selfcheck <archive>    # a built engine bundle imports and loads
    python .github/release_check.py assets <version> <name>... # exactly the four installers
    python .github/release_check.py launch <app executable> # the installed app installs its engine
    python .github/release_check.py pe-imports <dir>...    # no Visual C++ runtime it doesn't carry

It lives in the private repo icmm-dev under `release/overlay/`, whose tests cover it, and reaches
the public repo only through the mirror (ADR-0023).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
from collections.abc import Iterable, Mapping
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAG = re.compile(r"v(\d+\.\d+\.\d+(?:-rc\.\d+)?)")
IDENTIFIER = "org.meschoening.icmm"
APPLE_SECRETS = (
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
)
# Every installer a release carries, as (arch, os, extension).
INSTALLERS = (
    ("arm64", "macos", "dmg"),
    ("x64", "macos", "dmg"),
    ("x64", "windows", "exe"),
    ("x64", "linux", "deb"),
)
# How long an installed app may take to install its engine: unpack it and run its self-check.
LAUNCH_TIMEOUT = 600.0
# The Visual C++ runtime a clean Windows lacks unless something installed the redistributable.
# The Universal CRT (`api-ms-win-crt-*`, `ucrtbase.dll`) is part of Windows 10 and later.
VC_RUNTIME = re.compile(r"(vcruntime|msvcp|concrt|vccorlib|vcomp)\d.*\.dll|ucrtbased\.dll", re.I)
PE_SUFFIXES = (".exe", ".dll", ".pyd")


class Failed(Exception):
    pass


def asset_name(version: str, arch: str, os_name: str, ext: str) -> str:
    return f"icmm_{version}_{arch}-{os_name}.{ext}"


def expected_assets(version: str) -> set[str]:
    return {asset_name(version, *installer) for installer in INSTALLERS}


# --- tag -------------------------------------------------------------------------------------


def app_versions(root: Path) -> dict[str, str]:
    """The app's version in each file icmm-dev's tests/test_manifests.py keeps equal."""
    desktop = root / "desktop"
    lock = json.loads((desktop / "package-lock.json").read_text())
    cargo = tomllib.loads((desktop / "src-tauri" / "Cargo.toml").read_text())
    cargo_lock = tomllib.loads((desktop / "src-tauri" / "Cargo.lock").read_text())
    citation = re.search(r"^version:\s*(\S+)", (root / "CITATION.cff").read_text(), re.M)
    return {
        "desktop/package.json": json.loads((desktop / "package.json").read_text())["version"],
        "desktop/package-lock.json": lock["version"],
        'desktop/package-lock.json packages[""]': lock["packages"][""]["version"],
        "desktop/src-tauri/tauri.conf.json": json.loads(
            (desktop / "src-tauri" / "tauri.conf.json").read_text()
        )["version"],
        "desktop/src-tauri/Cargo.toml": cargo["package"]["version"],
        "desktop/src-tauri/Cargo.lock": next(
            (p["version"] for p in cargo_lock["package"] if p["name"] == cargo["package"]["name"]),
            "(none)",
        ),
        "CITATION.cff": citation.group(1).strip("\"'") if citation else "(none)",
    }


def check_tag(tag: str, root: Path) -> tuple[str, bool]:
    """The version a tag names and whether it's a candidate, once every version file agrees."""
    m = TAG.fullmatch(tag)
    if not m:
        raise Failed(f"{tag!r} is neither a release (vX.Y.Z) nor a candidate (vX.Y.Z-rc.N)")
    version = m.group(1)
    wrong = {f: v for f, v in app_versions(root).items() if v != version}
    if wrong:
        listed = "\n".join(f"  {f}: {v}" for f, v in wrong.items())
        raise Failed(f"the tag says {version}, but the app's version differs in:\n{listed}")
    return version, "-rc." in version


def check_secrets(env: Mapping[str, str]) -> None:
    missing = [name for name in APPLE_SECRETS if not env.get(name)]
    if missing:
        raise Failed(
            f"the Apple secrets {', '.join(missing)} aren't set: a DMG is never published "
            "unsigned. scripts/release_apple_secrets.sh sets all six."
        )


# --- the installers ---------------------------------------------------------------------------


def _one_built(bundle_dir: Path, ext: str) -> Path:
    found = sorted(bundle_dir.glob(f"*.{ext}"))
    if len(found) != 1:
        names = ", ".join(p.name for p in found) or "none"
        raise Failed(f"expected one .{ext} in {bundle_dir}, found {names}")
    return found[0]


def stage(bundle_dir: Path, version: str, arch: str, os_name: str, out: Path) -> Path:
    """Copies the one installer Tauri built in `bundle_dir` to `out` under its asset name."""
    ext = next((e for a, o, e in INSTALLERS if (a, o) == (arch, os_name)), None)
    if ext is None:
        raise Failed(f"no installer is {arch}-{os_name}")
    built = _one_built(bundle_dir, ext)
    out.mkdir(parents=True, exist_ok=True)
    dest = out / asset_name(version, arch, os_name, ext)
    shutil.copy2(built, dest)
    return dest


def one_depends(depends: str) -> str:
    """A `Depends` value with each package named once, by its first entry.

    Tauri's deb bundler appends `libwebkit2gtk-4.1-0` and `libgtk-3-0` after the config's own
    `depends`, unversioned and whatever the config says, so the config's `(>= 2.50)` came out
    beside a bare duplicate. An entry with alternatives (`a | b`) counts as its own.
    """
    kept: dict[str, str] = {}
    for entry in (e.strip() for e in depends.split(",")):
        name = entry if "|" in entry else re.split(r"[\s(:]", entry, maxsplit=1)[0]
        kept.setdefault(name, entry)
    return ", ".join(kept.values())


def deb_control(control: str) -> str:
    """DEBIAN/control with its `Depends` through `one_depends`, every other line as it was."""
    line = re.search(r"^Depends: (.*)$", control, re.M)
    if line is None:
        raise Failed("the .deb's control file has no Depends")
    return control[: line.start(1)] + one_depends(line.group(1)) + control[line.end(1) :]


def deb_depends(bundle_dir: Path) -> str:
    """Rewrites the one .deb in `bundle_dir` with each package in its Depends once (Linux), and
    answers its Depends line."""
    deb = _one_built(bundle_dir, "deb")
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / "tree"
        subprocess.run(["dpkg-deb", "--raw-extract", str(deb), str(tree)], check=True)
        control = tree / "DEBIAN" / "control"
        written = deb_control(control.read_text(encoding="utf-8"))
        control.write_text(written, encoding="utf-8")
        # Its files belong to root, as Tauri built them, not to the runner's user.
        build = ["dpkg-deb", "--root-owner-group", "-Zxz", "--build", str(tree), str(deb)]
        subprocess.run(build, check=True)
    return next(line for line in written.splitlines() if line.startswith("Depends: "))


def bundle_python(unpacked: Path, platform: str) -> Path:
    if platform == "win32":
        return unpacked / "python" / "python.exe"
    return unpacked / "python" / "bin" / "python3.12"


def selfcheck(archive: Path) -> None:
    """Runs `icmm selfcheck` in the folder scripts/engine_bundle.py unpacked beside `archive`,
    as the app does after installing it: every module and the core load."""
    key = archive.name.removesuffix(".tar.zst")
    python = bundle_python(archive.parent / key, sys.platform)
    done = subprocess.run([str(python), "-I", "-m", "icmm", "selfcheck"], text=True)
    if done.returncode != 0:
        raise Failed(f"{key}'s selfcheck failed ({done.returncode})")


def check_assets(names: Iterable[str], version: str) -> None:
    got = set(names)
    want = expected_assets(version)
    if got != want:
        problems = []
        if missing := sorted(want - got):
            problems.append("missing " + ", ".join(missing))
        if extra := sorted(got - want):
            problems.append("unexpected " + ", ".join(extra))
        raise Failed(f"the release must carry exactly the four installers: {'; '.join(problems)}")


# --- launch -----------------------------------------------------------------------------------


def app_folders(home: Path, env: Mapping[str, str], platform: str) -> tuple[Path, Path]:
    """The installed app's local data folder and log folder, where Tauri puts them for
    `IDENTIFIER` under the scratch `home` (Windows keeps them in the real %LOCALAPPDATA%)."""
    if platform == "darwin":
        return (
            home / "Library" / "Application Support" / IDENTIFIER,
            home / "Library" / "Logs" / IDENTIFIER,
        )
    if platform == "win32":
        data = Path(env["LOCALAPPDATA"]) / IDENTIFIER
    else:
        data = home / ".local" / "share" / IDENTIFIER
    return data, data / "logs"


def installed_engine(data: Path) -> Path | None:
    """The engine the app installed, once its self-check passed and it was moved into place."""
    engines = data / "engine"
    if not engines.is_dir():
        return None
    for folder in sorted(engines.iterdir()):
        if not folder.name.startswith(".") and (folder / "BUNDLE.json").is_file():
            return folder
    return None


def launch_env(base: Mapping[str, str], home: Path) -> dict[str, str]:
    env = {k: v for k, v in base.items() if not k.startswith(("SSH_", "ICMM_"))}
    for sub in ("tmp", ".config", ".local/share", ".cache", ".local/state"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    return env | {
        "HOME": str(home),
        "CFFIXED_USER_HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "TMPDIR": str(home / "tmp"),
    }


def launch_command(executable: Path, platform: str) -> list[str]:
    if platform == "darwin":
        return [str(executable), "-ApplePersistenceIgnoreState", "YES"]
    if platform.startswith("linux"):
        return ["xvfb-run", "-a", str(executable)]
    return [str(executable)]


def _stop(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait()


def _tail(path: Path, lines: int = 60) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])
    except OSError as e:
        return f"(couldn't read it: {e})"


def launch(executable: Path, timeout: float = LAUNCH_TIMEOUT) -> Path:
    """Launches the installed production app once, as a user would, and waits for it to install
    its host engine: unpack the archive from its own resources and pass the engine's
    `icmm selfcheck`. That runs the bundled interpreter the signed app carries, which Library
    Validation would kill if it were wrong. The app must still be running then; it's killed.

    Only on a disposable runner: the production app keeps its settings and engine under its
    identifier, which a test identity exists to keep off a real machine."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or (
        os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
    ):
        raise Failed("launch runs the production app: only on a GitHub-hosted runner")
    home = Path(tempfile.mkdtemp(prefix="icmm-launch-"))
    data, logs = app_folders(home, os.environ, sys.platform)
    log = home / "app-output.log"
    with log.open("wb") as out:
        proc = subprocess.Popen(
            launch_command(executable, sys.platform),
            env=launch_env(os.environ, home),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=sys.platform != "win32",
        )
        started = time.monotonic()
        try:
            while True:
                engine = installed_engine(data)
                if engine is not None:
                    if proc.poll() is not None:
                        raise Failed(f"the app exited ({proc.returncode}) after installing")
                    print(f"installed {engine.name} in {time.monotonic() - started:.0f} s")
                    return engine
                if proc.poll() is not None:
                    raise Failed(f"the app exited ({proc.returncode}) before installing its engine")
                if time.monotonic() - started > timeout:
                    raise Failed(f"the app installed no engine within {timeout:.0f} s")
                time.sleep(1)
        except Failed:
            _stop(proc)
            print(f"--- the app's output ---\n{_tail(log)}")
            for path in sorted(logs.glob("*.log")) if logs.is_dir() else []:
                print(f"--- {path.name} ---\n{_tail(path)}")
            raise
        finally:
            _stop(proc)


# --- pe-imports -------------------------------------------------------------------------------


def parse_dependents(dumpbin_output: str) -> list[str]:
    """The DLL names `dumpbin /dependents` lists, delay-loaded ones included."""
    names: list[str] = []
    listing = False
    for line in dumpbin_output.splitlines():
        stripped = line.strip()
        if stripped.startswith("Image has the following") and "dependencies" in stripped:
            listing = True
            continue
        if stripped.startswith("Summary"):
            break
        if listing and stripped.lower().endswith(".dll"):
            names.append(stripped)
    return names


def vc_runtime_gaps(imports: Mapping[str, Iterable[str]], carried: Iterable[str]) -> list[str]:
    """Each Visual C++ runtime DLL a file imports that the scanned trees don't carry."""
    have = {name.lower() for name in carried}
    gaps = []
    for path, dlls in sorted(imports.items()):
        for dll in dlls:
            if VC_RUNTIME.fullmatch(dll) and dll.lower() not in have:
                gaps.append(f"{path} imports {dll}")
    return gaps


def pe_imports(roots: list[Path]) -> None:
    files = [p for root in roots for p in root.rglob("*") if p.suffix.lower() in PE_SUFFIXES]
    if not files:
        raise Failed(f"no .exe, .dll or .pyd under {', '.join(map(str, roots))}")
    imports = {}
    for path in files:
        done = subprocess.run(
            ["dumpbin", "/nologo", "/dependents", str(path)], capture_output=True, text=True
        )
        if done.returncode != 0:
            raise Failed(f"dumpbin failed on {path}:\n{done.stdout}{done.stderr}")
        imports[str(path)] = parse_dependents(done.stdout)
    gaps = vc_runtime_gaps(imports, (p.name for p in files))
    print(f"checked {len(files)} files")
    if gaps:
        raise Failed(
            "these need the Visual C++ Redistributable, which a clean Windows lacks:\n"
            + "\n".join(f"  {g}" for g in gaps)
        )


# --- main -------------------------------------------------------------------------------------


def _output(**values: str) -> None:
    lines = "".join(f"{k}={v}\n" for k, v in values.items())
    print(lines, end="")
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The release workflow's checks.")
    commands = parser.add_subparsers(dest="command", required=True)
    tag = commands.add_parser("tag")
    tag.add_argument("tag")
    commands.add_parser("secrets")
    dd = commands.add_parser("deb-depends")
    dd.add_argument("bundle_dir", type=Path)
    st = commands.add_parser("stage")
    for name in ("bundle_dir", "version", "arch", "os", "out"):
        st.add_argument(name)
    sc = commands.add_parser("selfcheck")
    sc.add_argument("archive", type=Path)
    assets = commands.add_parser("assets")
    assets.add_argument("version")
    assets.add_argument("names", nargs="*")
    la = commands.add_parser("launch")
    la.add_argument("executable", type=Path)
    pe = commands.add_parser("pe-imports")
    pe.add_argument("dirs", type=Path, nargs="+")
    args = parser.parse_args(argv)
    try:
        if args.command == "tag":
            version, prerelease = check_tag(args.tag, ROOT)
            _output(version=version, prerelease=str(prerelease).lower())
        elif args.command == "secrets":
            check_secrets(os.environ)
            print(f"all {len(APPLE_SECRETS)} Apple secrets are set")
        elif args.command == "deb-depends":
            print(deb_depends(args.bundle_dir))
        elif args.command == "stage":
            dest = stage(Path(args.bundle_dir), args.version, args.arch, args.os, Path(args.out))
            _output(asset=dest.name, path=str(dest))
        elif args.command == "selfcheck":
            selfcheck(args.archive)
        elif args.command == "assets":
            check_assets(args.names, args.version)
            print("all four installers are there")
        elif args.command == "launch":
            launch(args.executable)
        else:
            pe_imports(args.dirs)
    except Failed as e:
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error::" + str(e).replace("%", "%25").replace("\n", "%0A"), file=sys.stderr)
        else:
            print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
