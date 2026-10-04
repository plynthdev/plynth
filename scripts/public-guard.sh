#!/usr/bin/env bash
# public-guard: this repo will be open-sourced. Fail on anything that must never be published.
# Scans every tracked or untracked-but-not-ignored file (git ls-files -co --exclude-standard).
# Prints one "file:line: reason" per hit and exits 1 if there is any hit.
#
# Markers (same line):
#   // test-key    a well-known anvil dev key, allowed in tests only
#   // not-a-key   a 32-byte hash (pool id, storage slot) that matches the key pattern
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "public-guard: not a git repo" >&2; exit 2; }
cd "$ROOT" || exit 2

DENYLIST="scripts/public-guard.denylist"
hits=0
hit() { echo "$1: $2"; hits=$((hits + 1)); }

# Denylist patterns without blank lines or comments (an empty pattern would match every line).
deny_patterns=""
if [ -f "$DENYLIST" ]; then
  deny_patterns="$(grep -vE '^[[:space:]]*(#|$)' "$DENYLIST" || true)"
fi

HEX_KEY='0x[0-9a-fA-F]{64}'
# 12+ lowercase dictionary-like words (BIP-39 words are 3-8 letters) separated by single spaces.
MNEMONIC='(^|[^a-z ])([a-z]{3,8} ){11,}[a-z]{3,8}([^a-z ]|$)'

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue              # skip submodule gitlinks and deleted files
  [ "$f" = "$DENYLIST" ] && continue
  base="${f##*/}"
  lower="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"

  # 1. Forbidden file types and private-material paths.
  case "$lower" in
    *.pdf|*.mp4|*.mov|*.docx|*.key|*.pem) hit "$f:0" "forbidden file type" ;;
  esac
  if printf '%s' "$f" | grep -qE '(^|/)(docs|plans|todos)/|RESUME'; then
    hit "$f:0" "forbidden path (docs/plans/todos/RESUME)"
  fi

  # 2. Env files: only .env.example may be in the repo.
  case "$base" in
    .env.example) ;;
    .env|.env.*) hit "$f:0" "env file must not be committed (only .env.example)" ;;
  esac

  # Content checks skip binary files (-I).
  # 3. Hex private keys.
  while IFS= read -r line; do
    [ -n "$line" ] && hit "${f}:${line%%:*}" "64-hex value looks like a private key (mark // test-key or // not-a-key)"
  done < <(grep -nIE "$HEX_KEY" -- "$f" 2>/dev/null | grep -vE '// (test-key|not-a-key)')

  # 4. Mnemonic-looking lines in env and json files.
  case "$base" in
    .env*|*.json)
      while IFS= read -r line; do
        [ -n "$line" ] && hit "${f}:${line%%:*}" "looks like a seed phrase"
      done < <(grep -nIE "$MNEMONIC" -- "$f" 2>/dev/null)
      ;;
  esac

  # 5. Private phrases.
  if [ -n "$deny_patterns" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && hit "${f}:${line%%:*}" "private phrase from $DENYLIST"
    done < <(printf '%s\n' "$deny_patterns" | grep -nIiE -f /dev/stdin -- "$f" 2>/dev/null)
  fi
done < <(git ls-files -z -co --exclude-standard)

if [ "$hits" -gt 0 ]; then
  echo "public-guard: $hits hit(s). Remove the material or add the right marker." >&2
  exit 1
fi
echo "public-guard: clean"
