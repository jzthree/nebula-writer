#!/usr/bin/env bash
# Restart the launchd Writer sidecar only when no AI request is running.
# Requests in flight live in the sidecar's memory: a restart mid-run loses
# them. Waits (polling /api/ai/progress) until nothing runs, then restarts and
# checks that the sidecar answers again.
#
#   npm run sidecar:restart            # wait as long as it takes
#   WAIT_SECONDS=600 npm run sidecar:restart
set -euo pipefail

LABEL="${WRITER_LAUNCHD_LABEL:-io.nebula.writer-sidecar}"
PORT="${WRITER_SIDECAR_PORT:-8787}"
WAIT_SECONDS="${WAIT_SECONDS:-0}"   # 0 = no limit
URL="http://127.0.0.1:${PORT}"

idle() {
  local body
  body="$(curl -fsS --max-time 5 "${URL}/api/ai/progress" 2>/dev/null)" || return 0  # not answering: nothing to lose
  [[ "$body" == *'"runs":[]'* ]]
}

waited=0
until idle; do
  if (( waited == 0 )); then echo "Writer is running an AI request; waiting for it to finish before restarting…"; fi
  if (( WAIT_SECONDS > 0 && waited >= WAIT_SECONDS )); then
    echo "Still busy after ${WAIT_SECONDS}s; not restarting." >&2
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

launchctl kickstart -k "gui/$(id -u)/${LABEL}"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "${URL}/api/health" >/dev/null 2>&1; then
    echo "Writer sidecar restarted (${LABEL}) and answering on ${URL}."
    exit 0
  fi
  sleep 1
done
echo "The sidecar did not answer on ${URL} within 30 s after the restart." >&2
exit 1
