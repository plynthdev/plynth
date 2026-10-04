#!/usr/bin/env bash
# End-to-end scenarios on local anvil forks. Never broadcasts to a real network.
#
#   bun run e2e consumer        fork of testnet: kit + consumer stack, api/relayer/indexer/keeper, three users
#                               through Open, Quiet and Hidden; API overview checked against the chain.
#   bun run e2e treasury        fork of mainnet (real Stock Tokens, real USDG, real steakUSDG): factory treasury
#                               from the balanced template, desks over a simulated week, period close, CFO pack.
#
# Env: RHC_TESTNET_RPC_URL / RHC_MAINNET_RPC_URL (fork sources; default the free public RPCs), DATABASE_URL
# (Postgres; a throwaway plynth_e2e_* database is created and dropped). Needs anvil, forge and bun on PATH.
# Exits non-zero on any mismatch; prints the total runtime either way.
set -uo pipefail

cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

scenario="${1:-}"
case "$scenario" in
  consumer | treasury) ;;
  *)
    echo "usage: $0 consumer|treasury" >&2
    exit 64
    ;;
esac

for bin in anvil forge bun; do
  command -v "$bin" >/dev/null || { echo "e2e: $bin not found on PATH" >&2; exit 69; }
done

start=$(date +%s)
child=""
cleanup() {
  # The scenario stops its own anvil and services; this catches anything left if it was killed mid-run.
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
}
trap cleanup INT TERM

forge build --root contracts >/dev/null 2>&1 || { echo "e2e: forge build failed" >&2; exit 1; }

bun "app/scripts/e2e/${scenario}.ts" &
child=$!
wait "$child"
code=$?
child=""

echo "e2e ${scenario}: $([[ $code -eq 0 ]] && echo PASS || echo "FAIL (exit $code)") in $(( $(date +%s) - start ))s total"
exit "$code"
