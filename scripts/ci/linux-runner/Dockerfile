# Self-hosted GitHub Actions runners for icmm-dev, run in Docker by
# provision-linux.ps1. Each target is both a runner and the
# build environment its jobs run in, so jobs need no Docker access:
#   ubuntu-22.04    desktop builds: Rust, Node, Tauri on WebKitGTK 4.1, the .deb;
#                   xvfb gives the app's launch smoke a display
#   manylinux_2_28  engine builds: libicmm, the icmm wheel, the cluster bundle
# Build context: scripts/ci (for pins.env). System packages, including the
# runner's own .NET dependencies (ICU, Kerberos, LTTng, OpenSSL, zlib), come
# first so later layers never touch a package mirror; entrypoint.sh comes last
# so editing it rebuilds nothing.

FROM ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02 AS ubuntu-22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git jq pkg-config unzip xz-utils zstd \
      libayatana-appindicator3-dev libgtk-3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev \
      xauth xvfb \
      libicu70 libkrb5-3 liblttng-ust1 libssl3 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY pins.env linux-runner/install-tools.sh /opt/ci/
RUN /opt/ci/install-tools.sh desktop
ENV RUSTUP_HOME=/opt/ci/rustup CARGO_HOME=/home/runner/.cargo \
    UV_PYTHON_INSTALL_DIR=/opt/ci/tools/python UV_PYTHON_BIN_DIR=/opt/ci/tools/bin \
    UV_PYTHON_PREFERENCE=only-managed UV_CACHE_DIR=/home/runner/.cache/uv \
    npm_config_cache=/home/runner/.cache/npm ICMM_CI_CACHE=/home/runner/.cache \
    PATH=/opt/ci/cargo/bin:/opt/ci/tools/bin:/opt/ci/tools/cmake/bin:/opt/ci/tools/node/bin:$PATH
COPY linux-runner/entrypoint.sh linux-runner/test-permissions.sh /opt/ci/
USER runner
RUN /opt/ci/test-permissions.sh
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["/opt/ci/entrypoint.sh"]

FROM quay.io/pypa/manylinux_2_28_x86_64:2026.09.23-1@sha256:ae21cd1c8220f773f9b5934f3b845d677494d4cd4b8981c1e416f654e8afa74e AS manylinux_2_28
# AlmaLinux's mirrors can lag its repo metadata long enough to fail a build
# (404s on repodata for over an hour, 2026-09-25); the primary repo doesn't.
RUN sed -i -e 's|^mirrorlist=|#mirrorlist=|' -e 's|^# *baseurl=https://repo.almalinux.org|baseurl=https://repo.almalinux.org|' \
      /etc/yum.repos.d/almalinux*.repo \
    && dnf install -y jq unzip xz krb5-libs libicu lttng-ust openssl-libs zlib && dnf clean all
COPY pins.env linux-runner/install-tools.sh /opt/ci/
RUN /opt/ci/install-tools.sh engine
ENV UV_PYTHON_INSTALL_DIR=/opt/ci/tools/python UV_PYTHON_BIN_DIR=/opt/ci/tools/bin \
    UV_PYTHON_PREFERENCE=only-managed UV_CACHE_DIR=/home/runner/.cache/uv \
    ICMM_CI_CACHE=/home/runner/.cache \
    PATH=/opt/ci/tools/bin:/opt/ci/tools/cmake/bin:$PATH
COPY linux-runner/entrypoint.sh linux-runner/test-permissions.sh /opt/ci/
USER runner
RUN /opt/ci/test-permissions.sh
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["/opt/ci/entrypoint.sh"]
