# Engine bundles the app carries

The app's `engines` resources (`tauri.conf.json`). It installs each platform's engine from the archives here: the host's for This computer and the desktop's own simulations, and `linux-x86_64`'s for SSH platforms (ADR-0002).

`scripts/engine_bundle.py` copies each `<key>.tar.zst` it builds, and its `.sha256`, into this folder, replacing that target's older ones. Everything here but this file is ignored by git. A build that should reach clusters needs the `linux-x86_64` bundle here too, built in the manylinux image: `uv run python scripts/ci_engine.py fetch` takes the one CI built from this checkout's engine sources, and `scripts/cluster_engine.sh` builds it offline under Docker. A release build refuses one whose `BUNDLE.json` records a newer glibc than manylinux_2_28's 2.28, or none.
