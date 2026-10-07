#!/usr/bin/env bash
# Stops the fork's services, then anvil (SIGTERM: anvil writes app/.fork/state.json before it exits).
set -uo pipefail
cd "$(dirname "$0")/../.."
OFF="${PORT_OFFSET:-0}"
if [[ "$OFF" == 0 ]]; then FORK_DIR="${FORK_DIR:-$(pwd)/.fork}"; else FORK_DIR="${FORK_DIR:-$(pwd)/.fork-$OFF}"; fi
[[ -d "$FORK_DIR/pids" ]] || { echo "down: nothing running"; exit 0; }

stop() {
  local f="$FORK_DIR/pids/$1.pid"
  [[ -f "$f" ]] || return 0
  local pid
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "down: stopped $1 ($pid)"
  fi
  rm -f "$f"
}

for f in "$FORK_DIR"/pids/*.pid; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f" .pid)"
  [[ "$name" == "anvil" || "$name" == "rpc-cache" ]] || stop "$name"
done
stop anvil
stop rpc-cache
exit 0
