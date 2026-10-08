#!/usr/bin/env bash
# Stops the mainnet services started by scripts/mainnet/up.sh. Nothing on the chain changes.
set -uo pipefail
cd "$(dirname "$0")/../.."
MAINNET_DIR="${MAINNET_DIR:-$(pwd)/.mainnet}"
[[ -d "$MAINNET_DIR/pids" ]] || { echo "down: nothing running"; exit 0; }

for f in "$MAINNET_DIR"/pids/*.pid; do
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
