#!/usr/bin/env bash
# Registers the runner on the container's first start, then runs it. The
# registration lives in the container's writable layer, so restarts reuse it;
# provision-linux.ps1 recreates the container (and re-registers with --replace)
# when its image or settings change or it keeps restarting.
set -euo pipefail
cd /home/runner/actions-runner
if [[ ! -f .runner ]]; then
  : "${RUNNER_TOKEN:?the first start needs RUNNER_TOKEN}"
  ./config.sh --unattended --replace --url "$RUNNER_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work /home/runner/_work
fi
unset RUNNER_TOKEN # jobs inherit this environment
# Forward docker stop's SIGTERM to the listener, so it ends its GitHub session.
export RUNNER_MANUALLY_TRAP_SIG=1
exec ./run.sh
