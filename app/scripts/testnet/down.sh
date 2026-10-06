#!/usr/bin/env bash
# Stops the testnet services started by scripts/testnet/up.sh. Nothing on the chain changes; up.sh starts them
# again against the same deployment (app/deployments/46630.json) and database (plynth_testnet).
set -uo pipefail
cd "$(dirname "$0")/../.."
TESTNET_DIR="${TESTNET_DIR:-$(pwd)/.testnet}"
[[ -d "$TESTNET_DIR/pids" ]] || { echo "down: nothing running"; exit 0; }

for f in "$TESTNET_DIR"/pids/*.pid; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f" .pid)"
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "down: stopped $name ($pid)"
  fi
  rm -f "$f"
done
exit 0
