#!/usr/bin/env bash
# The Plynth services on this Mac against Robinhood Chain TESTNET (46630), mirroring scripts/fork/up.sh.
#
#   bash scripts/testnet/up.sh      check the chain id, deploy + fund on the first start (scripts/testnet/setup.ts),
#                                   prepare the plynth_testnet database, start the services (logs in app/.testnet/logs)
#   bash scripts/testnet/down.sh    stop the services (the chain and the deployment stay, of course)
#
# Sends real testnet transactions from the plynth-* keystores (~/.foundry/keystores, passwords in ~/.plynth-testnet).
# Refuses to do anything unless the RPC answers chain id 46630; mainnet (4663) is never used for sending.
# Env: RHC_TESTNET_RPC_URL (default the free public RPC), DATABASE_URL (Postgres server; plynth_testnet is created on it).
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="$(pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
TESTNET_DIR="${TESTNET_DIR:-$APP/.testnet}"
export TESTNET_DIR
RPC="${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
mkdir -p "$TESTNET_DIR"/{logs,pids,env,treasury}

for bin in forge cast bun; do
  command -v "$bin" >/dev/null || { echo "up: $bin not found on PATH" >&2; exit 69; }
done

CHAIN="$(cast chain-id --rpc-url "$RPC")"
if [[ "$CHAIN" != "46630" ]]; then
  echo "up: $RPC answered chain id $CHAIN, not Robinhood Chain testnet 46630: refusing" >&2
  exit 1
fi

if [[ -f "$APP/.fork/pids/anvil.pid" ]] && kill -0 "$(cat "$APP/.fork/pids/anvil.pid")" 2>/dev/null; then
  echo "up: the local fork stack is running on the same ports: bash scripts/fork/down.sh first" >&2
  exit 1
fi

alive() { [[ -f "$TESTNET_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$TESTNET_DIR/pids/$1.pid")" 2>/dev/null; }

# ---- deploy (first start), fund, database, env files
(cd "$APP" && bun scripts/testnet/setup.ts)

# ---- services
start() {
  local name="$1" entry="$2" health="$3"
  shift 3
  if alive "$name"; then echo "up: $name already running"; return; fi
  [[ -f "$TESTNET_DIR/env/$name.env" ]] || return 0
  (
    # Only the service's env file: run from the testnet dir so Bun does not also load app/.env.
    cd "$TESTNET_DIR"
    set -a
    # shellcheck disable=SC1090
    source "$TESTNET_DIR/env/$name.env"
    set +a
    nohup bun "$APP/$entry" "$@" >>"$TESTNET_DIR/logs/$name.log" 2>&1 &
    echo $! >"$TESTNET_DIR/pids/$name.pid"
  )
  for i in $(seq 1 600); do
    if curl -fsS "$health" >/dev/null 2>&1; then echo "up: $name healthy ($health)"; return; fi
    if ! alive "$name"; then echo "up: $name exited; see $TESTNET_DIR/logs/$name.log" >&2; tail -20 "$TESTNET_DIR/logs/$name.log" >&2; exit 1; fi
    sleep 0.5
  done
  echo "up: $name not healthy at $health; see $TESTNET_DIR/logs/$name.log" >&2
  exit 1
}

start indexer src/bin/indexer.ts http://127.0.0.1:8787/health
start keeper src/bin/keeper.ts http://127.0.0.1:8788/health
start api src/bin/api.ts http://127.0.0.1:8789/v1/meta/health
start eligibility src/bin/eligibility.ts http://127.0.0.1:8790/health
export RELAYER_TICKET_STORE="${RELAYER_TICKET_STORE:-$TESTNET_DIR/settle-tickets-used}" # burnt settle tickets survive restarts (R3-SVC-3)
start relayer src/bin/relayer.ts http://127.0.0.1:8791/health
start mcp src/bin/mcp.ts http://127.0.0.1:8792/health
start treasury-marks src/bin/treasury-marks.ts http://127.0.0.1:8797/health
start treasury-webhooks src/bin/treasury-webhooks.ts http://127.0.0.1:8799/health run
# Per-treasury services: only once exercise.ts created a treasury and wrote app/.testnet/treasury/services.json.
start treasury-desks src/bin/treasury-desks.ts http://127.0.0.1:8793/health
start treasury-close src/bin/treasury-close.ts http://127.0.0.1:8794/health
start treasury-risk src/bin/treasury-risk.ts http://127.0.0.1:8795/health
start treasury-receipts src/bin/treasury-receipts.ts http://127.0.0.1:8796/health

echo "up: testnet stack ready. Chain 46630 ($RPC), API http://127.0.0.1:8789/v1, logs $TESTNET_DIR/logs"
