#!/usr/bin/env bash
# Persistent local fork of Robinhood Chain mainnet with the whole Plynth stack on it.
#
#   bash scripts/fork/up.sh      start anvil (state in app/.fork/state.json), deploy + fund on first start,
#                                prepare the plynth_fork database, start the services (logs in app/.fork/logs)
#   bash scripts/fork/down.sh    stop everything (anvil writes its state on the way down)
#   bash scripts/fork/reset.sh   stop, then wipe the fork state, deployment files and the database
#
# Hardfork cancun: Prague's EIP-2935 system call would read a new slot of the block-hash history contract from
# the fork source on every block. The fork runs under chain id 31337 ON PURPOSE: signatures made on it can never be replayed on mainnet (4663).
# It never broadcasts anywhere but 127.0.0.1. Env: RHC_MAINNET_RPC_URL (fork source, default the free public
# RPC), DATABASE_URL (Postgres server; the plynth_fork database is created on it), FORK_BLOCK (pin a block on
# the first start; default the latest), FORK_PORT (default 8545), PORT_OFFSET (a second fork beside services on the
# default ports: anvil 8545+offset, rpc-cache 8600+offset, services 87xx+offset, database plynth_fork2,
# directory app/.fork-<offset>; e.g. PORT_OFFSET=1000 next to the running testnet services).
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="$(pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
OFF="${PORT_OFFSET:-0}"
[[ "$OFF" =~ ^[0-9]+$ ]] || { echo "up: PORT_OFFSET must be a number" >&2; exit 64; }
export PORT_OFFSET="$OFF"
if [[ "$OFF" == 0 ]]; then FORK_DIR="${FORK_DIR:-$APP/.fork}"; else FORK_DIR="${FORK_DIR:-$APP/.fork-$OFF}"; fi
export FORK_DIR
PORT="${FORK_PORT:-$((8545 + OFF))}"
export FORK_RPC_URL="http://127.0.0.1:$PORT"
SOURCE="${RHC_MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
mkdir -p "$FORK_DIR"/{logs,pids,env,deployments,treasury}

for bin in anvil forge cast bun; do
  command -v "$bin" >/dev/null || { echo "up: $bin not found on PATH" >&2; exit 69; }
done

alive() { [[ -f "$FORK_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$FORK_DIR/pids/$1.pid")" 2>/dev/null; }

# ---- caching proxy in front of the public RPC (the public node keeps ~10-15 min of state; see rpc-cache.ts)
CACHE_PORT="${FORK_RPC_CACHE_PORT:-$((8600 + OFF))}"
if alive rpc-cache; then
  echo "up: rpc-cache already running"
else
  if lsof -iTCP:"$CACHE_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "up: port $CACHE_PORT (rpc-cache) is taken by another process; stop it or set FORK_RPC_CACHE_PORT" >&2
    exit 1
  fi
  (
    cd "$FORK_DIR"
    RHC_MAINNET_RPC_URL="$SOURCE" FORK_DIR="$FORK_DIR" FORK_RPC_CACHE_PORT="$CACHE_PORT" nohup bun "$APP/scripts/fork/rpc-cache.ts" >>"$FORK_DIR/logs/rpc-cache.log" 2>&1 &
    echo $! >"$FORK_DIR/pids/rpc-cache.pid"
  )
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$CACHE_PORT/health" 2>/dev/null | grep -q "\"pid\":$(cat "$FORK_DIR/pids/rpc-cache.pid")," && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$CACHE_PORT/health" 2>/dev/null | grep -q "\"pid\":$(cat "$FORK_DIR/pids/rpc-cache.pid")," || { echo "up: rpc-cache did not start; see $FORK_DIR/logs/rpc-cache.log" >&2; exit 1; }
fi

# ---- anvil
if alive anvil; then
  echo "up: anvil already running (pid $(cat "$FORK_DIR/pids/anvil.pid"))"
else
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "up: port $PORT is taken by another process; stop it or set FORK_PORT" >&2
    exit 1
  fi
  if [[ -f "$FORK_DIR/fork-block" ]]; then
    BLOCK="$(cat "$FORK_DIR/fork-block")"
  else
    BLOCK="${FORK_BLOCK:-$(cast block-number --rpc-url "$SOURCE")}"
    echo "$BLOCK" > "$FORK_DIR/fork-block"
  fi
  STATE_ARGS=(--state "$FORK_DIR/state.json" --state-interval 30)
  echo "up: anvil fork of $SOURCE at block $BLOCK, chain id 31337, port $PORT"
  nohup anvil --fork-url "http://127.0.0.1:$CACHE_PORT" --fork-block-number "$BLOCK" --chain-id 31337 --port "$PORT" \
    --block-time 1 --gas-limit 100000000 --hardfork cancun --fork-retry-backoff 1000 --retries 10 \
    "${STATE_ARGS[@]}" >"$FORK_DIR/logs/anvil.log" 2>&1 &
  echo $! >"$FORK_DIR/pids/anvil.pid"
  for i in $(seq 1 240); do
    if cast chain-id --rpc-url "$FORK_RPC_URL" >/dev/null 2>&1; then break; fi
    if ! alive anvil; then echo "up: anvil exited; see $FORK_DIR/logs/anvil.log" >&2; tail -20 "$FORK_DIR/logs/anvil.log" >&2; exit 1; fi
    sleep 0.5
  done
  [[ "$(cast chain-id --rpc-url "$FORK_RPC_URL")" == "31337" ]] || { echo "up: fork does not answer with chain id 31337" >&2; exit 1; }
fi

# ---- deploy (first start), fund, database, env files
(cd "$APP" && bun scripts/fork/setup.ts)

# ---- services
start() {
  local name="$1" entry="$2" health="$3"
  shift 3
  if alive "$name"; then echo "up: $name already running"; return; fi
  [[ -f "$FORK_DIR/env/$name.env" ]] || return 0
  (
    # Only the service's env file: run from the fork dir so Bun does not also load app/.env.
    cd "$FORK_DIR"
    set -a
    # shellcheck disable=SC1090
    source "$FORK_DIR/env/$name.env"
    set +a
    nohup bun "$APP/$entry" "$@" >>"$FORK_DIR/logs/$name.log" 2>&1 &
    echo $! >"$FORK_DIR/pids/$name.pid"
  )
  for i in $(seq 1 600); do
    if curl -fsS "$health" >/dev/null 2>&1; then echo "up: $name healthy ($health)"; return; fi
    if ! alive "$name"; then echo "up: $name exited; see $FORK_DIR/logs/$name.log" >&2; tail -20 "$FORK_DIR/logs/$name.log" >&2; exit 1; fi
    sleep 0.5
  done
  echo "up: $name not healthy at $health; see $FORK_DIR/logs/$name.log" >&2
  exit 1
}

start indexer src/bin/indexer.ts http://127.0.0.1:$((8787 + OFF))/health
start keeper src/bin/keeper.ts http://127.0.0.1:$((8788 + OFF))/health
start api src/bin/api.ts http://127.0.0.1:$((8789 + OFF))/v1/meta/health
start eligibility src/bin/eligibility.ts http://127.0.0.1:$((8790 + OFF))/health
start relayer src/bin/relayer.ts http://127.0.0.1:$((8791 + OFF))/health
start mcp src/bin/mcp.ts http://127.0.0.1:$((8792 + OFF))/health
start treasury-marks src/bin/treasury-marks.ts http://127.0.0.1:$((8797 + OFF))/health
start treasury-webhooks src/bin/treasury-webhooks.ts http://127.0.0.1:$((8799 + OFF))/health run
# Per-treasury services: only once exercise.ts (or you) created a treasury and wrote app/.fork/treasury/services.json.
start treasury-desks src/bin/treasury-desks.ts http://127.0.0.1:$((8793 + OFF))/health
start treasury-close src/bin/treasury-close.ts http://127.0.0.1:$((8794 + OFF))/health
start treasury-risk src/bin/treasury-risk.ts http://127.0.0.1:$((8795 + OFF))/health
start treasury-receipts src/bin/treasury-receipts.ts http://127.0.0.1:$((8796 + OFF))/health
start treasury-reconciler src/bin/treasury-reconciler.ts http://127.0.0.1:$((8798 + OFF))/health

echo "up: fork ready. RPC $FORK_RPC_URL (chain id 31337), API http://127.0.0.1:$((8789 + OFF))/v1, logs $FORK_DIR/logs"
