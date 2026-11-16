#!/usr/bin/env bash
# Run during each image build, as the same unprivileged user as CI jobs.
set -euo pipefail
[[ $(id -un) == runner ]]
writable=$(find /opt/ci -writable -print -quit)
if [[ -n $writable ]]; then
  echo "Pinned toolchain is writable by runner: $writable" >&2
  exit 1
fi
for dir in /home/runner/actions-runner /home/runner/_work /home/runner/.cache; do
  probe=$(mktemp "$dir/permissions.XXXXXX")
  rm "$probe"
done
cmake --version
ninja --version
uv --version
python3.12 -c 'import ssl, sqlite3'
if [[ -n ${CARGO_HOME:-} ]]; then
  # Exercise rustup's root-owned settings/proxies and Cargo's writable locks.
  probe=$(mktemp "$CARGO_HOME/registry/permissions.XXXXXX")
  rm "$probe"
  project=$(mktemp -d)
  trap 'rm -rf "$project"' EXIT
  cargo new --vcs none --name permissions "$project/app"
  cargo run --offline --manifest-path "$project/app/Cargo.toml"
fi
