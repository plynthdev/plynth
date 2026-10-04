#!/usr/bin/env bash
# Tests for .githooks/public-guard.sh. Each case builds a fresh temp git repo holding a copy of the guard
# and its denylist, plants ONE thing, and asserts the guard's exit code.
# Forbidden values are assembled at runtime so this file itself passes the guard.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/public-guard.sh"
DENY="$HERE/public-guard.denylist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
HEX64="0x$(printf 'ab%.0s' $(seq 1 32))"
MARK_TEST="// test""-key"
MARK_HASH="// not""-a-key"
WORDS="$(printf 'abandon %.0s' $(seq 1 11))about"

fresh() {
  local d="$WORK/r$((pass + fail))"
  mkdir -p "$d/.githooks"
  git -C "$d" init -q
  cp "$GUARD" "$DENY" "$d/.githooks/"
  printf 'export const ok = 1;\n' > "$d/clean.ts"
  echo "$d"
}

# expect <name> <0|1> <shell snippet run inside the repo>
expect() {
  local name="$1" want="$2" plant="$3" d out code
  d="$(fresh)"
  (cd "$d" && eval "$plant")
  out="$(cd "$d" && ./.githooks/public-guard.sh 2>&1)"; code=$?
  [ "$code" -ne 0 ] && code=1
  if [ "$code" = "$want" ]; then
    pass=$((pass + 1)); echo "ok   $name"
  else
    fail=$((fail + 1)); echo "FAIL $name (want exit $want, got $code)"; echo "$out" | sed 's/^/     /'
  fi
}

expect "clean repo passes"                  0 ':'
expect "clean staged file passes"           0 'printf "a\n" > b.ts && git add b.ts'
for ext in pdf mp4 mov docx key pem; do
  expect "rejects .$ext"                    1 "printf x > spec.$ext"
done
expect "rejects upper-case .PDF"            1 'printf x > Spec.PDF'
expect "rejects nested docs/ path"          1 'mkdir -p a/docs && printf x > a/docs/n.md'
expect "rejects top-level docs/ path"       1 'mkdir -p docs && printf x > docs/n.md'
expect "rejects plans/ path"                1 'mkdir -p plans && printf x > plans/p.md'
expect "rejects todos/ path"                1 'mkdir -p todos && printf x > todos/t.md'
expect "rejects RESUME path"                1 'printf x > RESUME-2026.md'
expect "rejects tracked .env"               1 'printf "A=1\n" > .env && git add -f .env'
expect "rejects tracked .env.local"         1 'printf "A=1\n" > .env.local && git add -f .env.local'
expect "allows .env.example"                0 'printf "A=\n" > .env.example && git add .env.example'
expect "ignored untracked .env not scanned" 0 'printf ".env\n" > .gitignore && printf "A=1\n" > .env'
expect "rejects hex private key"            1 "printf 'const k = \"%s\";\n' '$HEX64' > k.ts"
expect "rejects hex key in staged file"     1 "printf 'k=%s\n' '$HEX64' > k.txt && git add k.txt"
expect "allows key marked test-key"         0 "printf 'k = \"%s\"; %s\n' '$HEX64' '$MARK_TEST' > k.t.sol"
expect "allows hash marked not-a-key"       0 "printf 'id: \"%s\", %s\n' '$HEX64' '$MARK_HASH' > ids.ts"
expect "vendored contracts/lib is skipped"   0 "mkdir -p contracts/lib/oz && printf 'bytes32 s = %s;\n' '$HEX64' > contracts/lib/oz/S.sol"
expect "contracts/src is still scanned"     1 "mkdir -p contracts/src && printf 'bytes32 s = %s;\n' '$HEX64' > contracts/src/S.sol"
expect "address (40 hex) is fine"           0 'printf "a = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168\n" > a.ts'
expect "rejects mnemonic in .env.example"   1 "printf 'MNEMONIC=%s\n' '$WORDS' > .env.example"
expect "rejects mnemonic in .json"          1 "printf '{\"m\": \"%s\"}\n' '$WORDS' > w.json"
expect "short phrase in .json is fine"      0 'printf "{\"d\": \"one two three four\"}\n" > w.json'
expect "mnemonic rule scoped to env/json"   0 "printf '// %s\n' '$WORDS' > n.ts"
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  phrase="$(printf '%s' "$pat" | sed 's/\\b//g')"
  expect "rejects denylisted: $pat"         1 "printf 'note: %s here\n' '$(printf '%s' "$phrase" | tr '[:lower:]' '[:upper:]')' > n.md"
done < "$DENY"
expect "denylist file itself is excluded"   0 ':'
expect "public token names are allowed"     0 'printf "PLTH staking and buyback\n" > t.md'
expect "whole-word denylist: koala passes"  0 'printf "koala\n" > t.md'

echo "public-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
