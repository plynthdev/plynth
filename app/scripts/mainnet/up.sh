#!/usr/bin/env bash
# The Plynth services against Robinhood Chain MAINNET (4663), mirroring scripts/testnet/up.sh, for the closed beta.
#
#   bash scripts/mainnet/up.sh      check the chain id, turn the deploy output into deployments/4663.json, check that
#                                   OWNER accepted every ownership, prepare plynth_mainnet, start the services
#   bash scripts/mainnet/down.sh    stop the services (the chain and the deployment stay)
#
# Release gate (review v2 L-20): before inviting users, `bun run release:gate` (forge verifyDeploymentStrict + verify:deployment
# --strict, scripts/mainnet/release-gate.ts) must pass; setup.ts below already refuses while an acceptOwnership is missing.
# It never deploys and never funds anything: the deploy is the manual MainnetBeta.s.sol command in the runbook,
# run only after an explicit go, and the bots are funded by hand. Refuses unless the RPC answers chain id 4663.
# Keys: plynth-main-* keystores (~/.foundry/keystores), passwords in ~/.plynth-mainnet; each service unlocks its own.
# Env: RHC_MAINNET_RPC_URL (default the free public RPC), DATABASE_URL (plynth_mainnet is created on it),
# KEEPER_CONFIRMATIONS / INDEXER_CONFIRMATIONS are fixed at 2 in the env files (setup.ts refuses less).
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="$(pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
MAINNET_DIR="${MAINNET_DIR:-$APP/.mainnet}"
export MAINNET_DIR
RPC="${RHC_MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
mkdir -p "$MAINNET_DIR"/{logs,pids,env}

for bin in cast bun; do
  command -v "$bin" >/dev/null || { echo "up: $bin not found on PATH" >&2; exit 69; }
done

CHAIN="$(cast chain-id --rpc-url "$RPC")"
if [[ "$CHAIN" != "4663" ]]; then
  echo "up: $RPC answered chain id $CHAIN, not Robinhood Chain mainnet 4663: refusing" >&2
  exit 1
fi

# The fork and testnet stacks use the same default ports: never start next to them.
for p in 8787 8788 8789 8790 8791 8792 8797 8799; do
  if lsof -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1 && ! grep -qs "$(lsof -iTCP:"$p" -sTCP:LISTEN -t | head -1)" "$MAINNET_DIR"/pids/*.pid; then
    echo "up: port $p is taken by another stack (testnet or fork?): stop it first" >&2
    exit 1
  fi
done

alive() { [[ -f "$MAINNET_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$MAINNET_DIR/pids/$1.pid")" 2>/dev/null; }

(cd "$APP" && bun scripts/mainnet/setup.ts)

start() {
  local name="$1" entry="$2" health="$3"
  shift 3
  if alive "$name"; then echo "up: $name already running"; return; fi
  [[ -f "$MAINNET_DIR/env/$name.env" ]] || return 0
  (
    # Only the service's env file: run from the mainnet dir so Bun does not also load app/.env.
    cd "$MAINNET_DIR"
    set -a
    # shellcheck disable=SC1090
    source "$MAINNET_DIR/env/$name.env"
    set +a
    nohup bun "$APP/$entry" "$@" >>"$MAINNET_DIR/logs/$name.log" 2>&1 &
    echo $! >"$MAINNET_DIR/pids/$name.pid"
  )
  for i in $(seq 1 600); do
    if curl -fsS "$health" >/dev/null 2>&1; then echo "up: $name healthy ($health)"; return; fi
    if ! alive "$name"; then echo "up: $name exited; see $MAINNET_DIR/logs/$name.log" >&2; tail -20 "$MAINNET_DIR/logs/$name.log" >&2; exit 1; fi
    sleep 0.5
  done
  echo "up: $name not healthy at $health; see $MAINNET_DIR/logs/$name.log" >&2
  exit 1
}

start indexer src/bin/indexer.ts http://127.0.0.1:8787/health
start keeper src/bin/keeper.ts http://127.0.0.1:8788/health
start api src/bin/api.ts http://127.0.0.1:8789/v1/meta/health
start eligibility src/bin/eligibility.ts http://127.0.0.1:8790/health
start relayer src/bin/relayer.ts http://127.0.0.1:8791/health
start mcp src/bin/mcp.ts http://127.0.0.1:8792/health
start treasury-marks src/bin/treasury-marks.ts http://127.0.0.1:8797/health
start treasury-webhooks src/bin/treasury-webhooks.ts http://127.0.0.1:8799/health run

echo "up: mainnet stack ready. Chain 4663 ($RPC), API http://127.0.0.1:8789/v1, logs $MAINNET_DIR/logs"
