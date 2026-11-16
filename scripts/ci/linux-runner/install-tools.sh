#!/usr/bin/env bash
# Image-build step for the Linux runners: installs the pinned toolchain from
# pins.env into /opt/ci and the Actions runner into /home/runner, as root.
#   install-tools.sh desktop   CMake, Ninja, uv + Python, Node, Rust
#   install-tools.sh engine    CMake, Ninja, uv + Python
set -euo pipefail
flavor="$1"
# shellcheck source=../pins.env
. /opt/ci/pins.env
tools=/opt/ci/tools
dl=/tmp/downloads
mkdir -p "$tools/bin" "$dl"

fetch() { # url sha256 -> $dl/<basename>, checked
  curl -fsSL --retry 3 -o "$dl/${1##*/}" "$1"
  echo "$2  $dl/${1##*/}" | sha256sum -c --quiet -
}

fetch "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" "$CMAKE_SHA256_LINUX"
mkdir -p "$tools/cmake"
tar -xzf "$dl/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" -C "$tools/cmake" --strip-components=1

fetch "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-linux.zip" "$NINJA_SHA256_LINUX"
unzip -q -o "$dl/ninja-linux.zip" -d "$tools/bin"

fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" "$UV_SHA256_LINUX"
tar -xzf "$dl/uv-x86_64-unknown-linux-gnu.tar.gz" -C "$tools/bin" --strip-components=1
UV_PYTHON_INSTALL_DIR="$tools/python" UV_PYTHON_BIN_DIR="$tools/bin" UV_CACHE_DIR="$dl/uv" \
  "$tools/bin/uv" python install "$PYTHON_VERSION"

if [[ $flavor == desktop ]]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256_LINUX"
  mkdir -p "$tools/node"
  tar -xJf "$dl/node-v$NODE_VERSION-linux-x64.tar.xz" -C "$tools/node" --strip-components=1

  fetch "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init" "$RUSTUP_SHA256_LINUX"
  chmod +x "$dl/rustup-init"
  RUSTUP_HOME=/opt/ci/rustup CARGO_HOME=/opt/ci/cargo "$dl/rustup-init" -y --no-modify-path \
    --profile minimal --default-toolchain "$RUST_VERSION" -c clippy -c rustfmt
  RUSTUP_HOME=/opt/ci/rustup CARGO_HOME=/opt/ci/cargo /opt/ci/cargo/bin/rustup set auto-self-update disable
fi

# The runner starts at RUNNER_VERSION and updates itself (see pins.env).
useradd -m -s /bin/bash runner
runner=/home/runner/actions-runner
fetch "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" "$RUNNER_SHA256_LINUX"
mkdir -p "$runner"
tar -xzf "$dl/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" -C "$runner"
# Its bin/installdependencies.sh is skipped: the Dockerfile installs the same
# packages in its first layer, without a second trip to the package mirrors.

# Mount points for the named volumes: an empty volume takes the image
# directory's owner, so these must exist here, owned by the runner.
mkdir -p /home/runner/_work /home/runner/.cache
# Cargo writes locks, registry metadata and git checkouts to its home. Keep
# that state separate from the root-owned rustup proxies in /opt/ci/cargo/bin.
[[ -d /opt/ci/cargo ]] && mkdir -p /home/runner/.cargo/registry
# Archives can carry other owners or writable modes; normalize both. Jobs
# must not replace tools, rustup settings, or their parent directories.
chown -R root:root /opt/ci
chmod -R a+rX,go-w /opt/ci
chown -R runner:runner /home/runner
rm -rf "$dl"
