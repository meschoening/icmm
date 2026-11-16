#!/usr/bin/env bash
# Builds the linux-x86_64 Engine bundle that clusters run, in the manylinux_2_28
# image CI uses (glibc 2.28, plain x86_64), and puts its archive in
# desktop/src-tauri/engines/ for the app to carry. A release build refuses to
# build without it (desktop/src-tauri/build.rs). This is the offline fallback:
# `uv run python scripts/ci_engine.py fetch` takes the one CI built. Needs
# Docker; on an arm64 Mac it runs under amd64 emulation and takes about five
# minutes.
#   scripts/cluster_engine.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
image=icmm-manylinux

docker build --platform=linux/amd64 --target manylinux_2_28 -t "$image" \
  -f scripts/ci/linux-runner/Dockerfile scripts/ci >&2

# The tree (tracked files and new ones git doesn't ignore) is listed on the host,
# where git also works in a worktree, and streamed in; it's built in the
# container, and only the archive comes back. macOS's tar would add AppleDouble
# `._*` files, which compileall dies on.
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-mac-metadata --no-xattrs); fi
git ls-files -co --exclude-standard -z |
  COPYFILE_DISABLE=1 tar ${tar_flags[@]+"${tar_flags[@]}"} --null -T - -cf - |
  docker run --platform=linux/amd64 --rm -i \
  -v "$root/desktop/src-tauri/engines:/engines" \
  --entrypoint /bin/bash "$image" -c '
    set -euo pipefail
    mkdir -p /tmp/w && cd /tmp/w
    tar -xf -
    cmake -G Ninja -S engine/cpp -B build -DCMAKE_BUILD_TYPE=Release >&2
    cmake --build build -j >&2
    uv sync --locked -q
    uv run --locked python scripts/engine_bundle.py --libicmm build/libicmm.so \
      --out /tmp/out --app /engines
  '
