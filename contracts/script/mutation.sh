#!/usr/bin/env bash
# Mutation testing for CrowdBuy, ShieldedPool and PerpMarket with slither-mutate
# (Trail of Bits, part of slither-analyzer). See contracts/mutation/REPORT.md.
#
# Usage (from anywhere):
#   contracts/script/mutation.sh                  # all three contracts
#   contracts/script/mutation.sh CrowdBuy         # one contract
#   MUTATORS=ROR,LOR contracts/script/mutation.sh # override the mutator set
#   TIMEOUT=300 contracts/script/mutation.sh      # per-mutant test timeout (seconds)
#
# Requirements: forge, slither-mutate (`uv tool install slither-analyzer`) and solc
# 0.8.28 (forge's svm cache or `solc-select install 0.8.28`).
#
# How it works: slither-mutate edits the source file in place, recompiles it, runs the
# scoped test command and restores the file. Output (logs, surviving mutant sources,
# uncaught diffs) goes to contracts/mutation/out/<Contract>/ (gitignored). The forge
# build for mutants uses [profile.mutation] in foundry.toml (optimizer off, small
# fuzz/invariant budgets) with its own out/cache dirs.
#
# Safety: refuses to start if contracts/src has uncommitted changes, and on any exit
# (including Ctrl-C or kill) restores contracts/src from git so no mutant can leak.
set -euo pipefail

CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACTS_DIR"

export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
export FOUNDRY_PROFILE=mutation

# High-value subset (see REPORT.md for why the full set is not run by default):
#   RR  statement -> revert()            (finds statements no test executes)
#   ROR relational operator replacement  (<, <=, ==, != ... boundary guards)
#   LOR logical operator replacement     (&& <-> ||)
#   MIA if-condition -> true / false / !cond  (condition removal)
#   UOR unary operator replacement
#   LIR literal integer replacement
#   AOR arithmetic operator replacement
MUTATORS="${MUTATORS:-RR,ROR,LOR,MIA,UOR,LIR,AOR}"
TIMEOUT="${TIMEOUT:-240}"
THREADS="${THREADS:-4}"
OUT_ROOT="$CONTRACTS_DIR/mutation/out"
REMAPS="@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/ forge-std/=lib/forge-std/src/"

command -v forge >/dev/null || { echo "forge not found" >&2; exit 1; }
command -v slither-mutate >/dev/null || { echo "slither-mutate not found (uv tool install slither-analyzer)" >&2; exit 1; }

# Mutants compile through forge (crytic-compile's foundry platform); a bare `solc` on PATH is
# still pinned to 0.8.28 (via a shim dir, without touching global solc-select state) in case
# crytic-compile falls back to it.
SHIM="$OUT_ROOT/bin"
mkdir -p "$SHIM"
for cand in "$HOME/Library/Application Support/svm/0.8.28/solc-0.8.28" "$HOME/.svm/0.8.28/solc-0.8.28"; do
  if [[ -x "$cand" ]]; then ln -sf "$cand" "$SHIM/solc"; break; fi
done
if [[ ! -e "$SHIM/solc" ]]; then
  solc-select install 0.8.28 >/dev/null
  export SOLC_VERSION=0.8.28
fi
export PATH="$SHIM:$PATH"

if ! git diff --quiet -- src || ! git diff --cached --quiet -- src; then
  echo "contracts/src has uncommitted changes; commit or stash them first" >&2
  exit 1
fi
restore_src() { git checkout -- src 2>/dev/null || true; }
trap restore_src EXIT
trap 'restore_src; exit 130' INT TERM

# name | source file | scoped test glob (forge --match-path)
TARGETS=(
  "CrowdBuy|src/consumer/CrowdBuy.sol|test/consumer/{CrowdBuy*,EligibilityGate*}"
  "ShieldedPool|src/consumer/ShieldedPool.sol|test/consumer/{ShieldedPool*,ShieldedTrade*,CrowdBuyHidden*}"
  "PerpMarket|src/perps/PerpMarket.sol|test/perps/*"
)

want="${1:-all}"
for t in "${TARGETS[@]}"; do
  IFS='|' read -r name file tests <<<"$t"
  [[ "$want" == "all" || "$want" == "$name" ]] || continue
  out="$OUT_ROOT/$name"
  log="$OUT_ROOT/$name.log"
  mkdir -p "$OUT_ROOT"
  echo "== $name: mutators=$MUTATORS timeout=${TIMEOUT}s tests=$tests"
  start=$(date +%s)
  slither-mutate "$file" \
    --test-cmd "forge test --threads $THREADS --match-path '$tests'" \
    --timeout "$TIMEOUT" \
    --mutators-to-run "$MUTATORS" \
    --contract-names "$name" \
    --compile-force-framework foundry \
    --solc-remaps "$REMAPS" \
    --output-dir "$out" \
    -v >"$log" 2>&1 || echo "slither-mutate exited non-zero for $name (see $log)" >&2
  restore_src
  echo "== $name done in $(( $(date +%s) - start ))s; log: mutation/out/$name.log"
done

# Summary from the verbose logs (one line per mutant).
for log in "$OUT_ROOT"/*.log; do
  [[ -e "$log" ]] || continue
  n=$(basename "$log" .log)
  caught=$(grep -c -- '--> CAUGHT' "$log" || true)
  uncaught=$(grep -c -- '--> UNCAUGHT' "$log" || true)
  nocompile=$(grep -c -- '--> COMPILATION FAILURE' "$log" || true)
  timeouts=$(grep -c 'Tests took too long' "$log" || true)
  total=$((caught + uncaught))
  score="n/a"
  if (( total > 0 )); then score=$(awk -v k="$caught" -v t="$total" 'BEGIN{printf "%.1f%%", 100*k/t}'); fi
  echo "$n: killed=$caught (of which timeouts=$timeouts) survived=$uncaught uncompilable=$nocompile score=$score"
done
