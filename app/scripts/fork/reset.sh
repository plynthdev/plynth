#!/usr/bin/env bash
# Stops everything, then wipes the fork: anvil state, recorded fork block, deployment files, treasury config,
# exercise results and the plynth_fork database. The next up.sh forks the latest block and deploys again.
set -uo pipefail
cd "$(dirname "$0")/../.."
APP="$(pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
FORK_DIR="${FORK_DIR:-$APP/.fork}"
bash scripts/fork/down.sh
rm -rf "$FORK_DIR/state.json" "$FORK_DIR/fork-block" "$FORK_DIR/deployments" "$FORK_DIR/env" "$FORK_DIR/treasury" \
  "$FORK_DIR/results.json" "$FORK_DIR/exercised" "$FORK_DIR/secrets.json" "$FORK_DIR/rpc-cache.jsonl" "$APP/deployments/fork.json"
mkdir -p "$FORK_DIR/logs"
for f in "$FORK_DIR"/logs/*.log; do [[ -e "$f" ]] && : >"$f"; done
bun -e 'import { databaseUrl, dropDatabase, withDatabase } from "@/db"; await dropDatabase(withDatabase(databaseUrl(), "plynth_fork")); console.log("reset: dropped database plynth_fork");'
echo "reset: fork wiped"
