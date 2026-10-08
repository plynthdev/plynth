#!/usr/bin/env bash
# Deploys the Plynth backend from the owner's machine to a server prepared by provision.sh, over SSH as root.
#
#   app/scripts/server/deploy.sh <host>                  deploy the committed HEAD
#   app/scripts/server/deploy.sh --ref <ref> <host>      deploy a commit, tag or branch
#   app/scripts/server/deploy.sh --provision <host>      first time: copy app/scripts/server up and run provision.sh
#   app/scripts/server/deploy.sh --check <host>          health-check every service, change nothing
#
# <host> is a host name, an ~/.ssh/config alias or user@host (without "user@" the user is root). Nothing about the
# server (address, SSH key, password) is stored here: the host comes from the command line and the key from
# ssh-agent or ~/.ssh/config.
#
# A deploy:
#   1. ships the committed tree at <ref> (git archive of app/ and sdk/: uncommitted changes are never shipped) plus
#      the gitignored mainnet deployment files app/deployments/4663.json, 4663-treasury.json and 4663-beta.json to
#      a new /opt/plynth/releases/<time>-<sha>;
#   2. checks /etc/plynth/plynth.env: no CHANGE_ME left, every *_CHAIN is mainnet, the RPC answers chain id 4663,
#      the registry and factory addresses match 4663.json, and every keystore / password file it names is readable
#      by the plynth user (only tested for access, never read);
#   3. refreshes the systemd units, runs bun install --frozen-lockfile as plynth;
#   4. points /opt/plynth/current at the release and runs the migrations (plynth-migrate.service); if they fail, the
#      link goes back to the previous release and nothing is restarted;
#   5. restarts plynth.target;
#   6. checks every enabled service's /health, printing the keeper's last pass (each job's result), the indexer's
#      lag and the API's view of the chain and database. Exits 1 if any service is unhealthy.
# The last 5 releases are kept; README.md says how to roll back.
#
# Env (all optional):
#   SSH_OPTS                 extra ssh options, e.g. "-i ~/.ssh/plynth_ed25519 -p 22"
#   PLYNTH_DEPLOYMENTS_SRC   folder holding the 4663*.json files (default: app/deployments of this checkout)
#   PLYNTH_PUBLIC_API_URL    e.g. https://api.plynthnetwork.com: also checked from this machine after the deploy
#   PLYNTH_PUBLIC_RELAYER_URL  e.g. https://relayer.plynthnetwork.com: same
#   API_DOMAIN, RELAYER_DOMAIN, ACME_EMAIL, DB_NAME, SWAP_SIZE: passed to provision.sh by --provision
set -euo pipefail

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

MODE=deploy
REF=HEAD
HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --provision) MODE=provision; shift ;;
    --check) MODE=check; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$HOST" ]] || die "one host only"; HOST="$1"; shift ;;
  esac
done
[[ -n "$HOST" ]] || { usage >&2; exit 2; }
[[ "$HOST" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$ ]] || die "'$HOST' does not look like a host or user@host"

for bin in git ssh gzip curl; do
  command -v "$bin" >/dev/null || die "$bin not found"
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
APP="$ROOT/app"

# ---------------------------------------------------------------- ssh (one shared connection)
SSH_EXTRA=()
if [[ -n "${SSH_OPTS:-}" ]]; then read -r -a SSH_EXTRA <<<"$SSH_OPTS"; fi
[[ "$HOST" == *@* ]] || SSH_EXTRA+=(-l root)
CTL_DIR="$(mktemp -d)"
cleanup() {
  ssh -o ControlPath="$CTL_DIR/c" -O exit "$HOST" >/dev/null 2>&1 || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT
ssh_() {
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath="$CTL_DIR/c" -o ControlPersist=300 \
    -o ServerAliveInterval=30 ${SSH_EXTRA[@]+"${SSH_EXTRA[@]}"} "$HOST" "$@"
}

# ---------------------------------------------------------------- the script that runs on the server (as root)
# Wrapped in main() and called with stdin from /dev/null, so no command inside can swallow the rest of the script
# that bash -s is still reading from stdin.
remote_script() {
  cat <<'REMOTE'
main() {
  set -euo pipefail
  local mode="$1" rel="${2:-}" sha="${3:-}"
  local BASE=/opt/plynth ENVF=/etc/plynth/plynth.env
  local CORE=(indexer keeper api eligibility relayer mcp treasury-marks treasury-webhooks)
  local OPTIONAL=(treasury-desks treasury-close treasury-risk treasury-receipts treasury-reconciler)
  log() { printf '[server %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
  die() { printf 'deploy (server): %s\n' "$*" >&2; exit 1; }
  # Last assignment wins, as in systemd's EnvironmentFile.
  envval() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

  [[ "$(id -u)" == 0 ]] || die "connect as root"
  id plynth >/dev/null 2>&1 && [[ -x /usr/local/bin/bun && -f /etc/plynth/db.env && -f "$ENVF" ]] \
    || die "server not provisioned: run deploy.sh --provision <host> first"
  command -v jq >/dev/null || die "jq missing: re-run provision.sh"

  health() {
    local name="$1" url="$2" timeout="$3" summary="$4" deadline body code
    deadline=$((SECONDS + timeout))
    while :; do
      body="$(curl -sS -m 15 -w '\n%{http_code}' "$url" 2>/dev/null)" || body=$'\n000'
      code="${body##*$'\n'}"
      body="${body%$'\n'*}"
      if [[ "$code" == 200 ]] && jq -e '.ok == true and ((.chainId // 4663) == 4663)' >/dev/null 2>&1 <<<"$body"; then
        printf '  ok    %-20s %s\n' "$name" "$(jq -r "$summary" 2>/dev/null <<<"$body")"
        return 0
      fi
      if ((SECONDS >= deadline)); then
        printf '  FAIL  %-20s HTTP %s %s\n' "$name" "$code" "$(systemctl is-active "plynth-$name.service" 2>/dev/null || true)"
        if [[ "$name" == keeper ]] && jq -e '.last.jobs' >/dev/null 2>&1 <<<"$body"; then
          jq -r '.last.jobs[] | select(.ok | not) | "        job \(.job) failed: \(.error // "no error text")"' <<<"$body"
        elif [[ -n "$body" ]]; then
          printf '        %s\n' "$(printf '%s' "$body" | head -c 600)"
        fi
        journalctl -u "plynth-$name.service" -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/        | /'
        return 1
      fi
      sleep 3
    done
  }

  check_all() {
    local p failed=0
    p() { local v; v="$(envval "$1")"; printf '%s' "${v:-$2}"; }
    log "health (keeper waits up to 5 min for its first full pass)"
    health indexer "http://127.0.0.1:$(p INDEXER_PORT 8787)/health" 120 \
      '"head \(.head), max lag \(.maxLag) blocks over \(.streams | length) streams"' || failed=1
    health api "http://127.0.0.1:$(p API_PORT 8789)/v1/meta/health" 120 \
      '"head \(.head), db \(.db), indexed to \(.indexer.lastBlock) (lag \(.indexer.lagBlocks))"' || failed=1
    health eligibility "http://127.0.0.1:$(p ELIGIBILITY_PORT 8790)/health" 90 '"attester \(.attester)"' || failed=1
    health relayer "http://127.0.0.1:$(p RELAYER_PORT 8791)/health" 90 '"relayer \(.relayer)"' || failed=1
    health mcp "http://127.0.0.1:$(p MCP_PORT 8792)/health" 90 '"up"' || failed=1
    health treasury-marks "http://127.0.0.1:$(p TREASURY_MARKS_PORT 8797)/health" 90 '"\(.passes) mark pass(es)"' || failed=1
    health treasury-webhooks "http://127.0.0.1:$(p TREASURY_WEBHOOKS_PORT 8799)/health" 90 '"\(.polls) poll(s)"' || failed=1
    health keeper "http://127.0.0.1:$(p KEEPER_PORT 8788)/health" 300 \
      '"keeper \(.keeper), pass at \(.last.at): " + ([.last.jobs[] | "\(.job)=\(if .ok then "ok" else "FAIL" end)/\(.actions)"] | join(" "))' || failed=1
    local s port
    for s in "${OPTIONAL[@]}"; do
      systemctl is-enabled --quiet "plynth-$s.service" 2>/dev/null || continue
      case "$s" in
        treasury-desks) port="$(p TREASURY_DESKS_PORT 8793)" ;;
        treasury-close) port="$(p TREASURY_CLOSE_PORT 8794)" ;;
        treasury-risk) port="$(p TREASURY_RISK_PORT 8795)" ;;
        treasury-receipts) port="$(p TREASURY_RECEIPTS_PORT 8796)" ;;
        treasury-reconciler) port="$(p TREASURY_RECONCILER_PORT 8798)" ;;
      esac
      health "$s" "http://127.0.0.1:$port/health" 90 '[to_entries[] | select(.key != "ok" and .key != "service") | "\(.key)=\(.value | tostring)"] | join(" ")' || failed=1
    done
    systemctl is-active --quiet caddy || { printf '  FAIL  %-20s not running\n' caddy; failed=1; }
    return "$failed"
  }

  if [[ "$mode" == check ]]; then
    check_all || die "unhealthy services above"
    log "all healthy ($(cat "$BASE/current/REVISION" 2>/dev/null || echo "unknown revision"))"
    return 0
  fi

  local R="$BASE/releases/$rel"
  [[ -n "$rel" && -d "$R/app" ]] || die "release $rel was not uploaded"

  # ---- preflight: plynth.env
  local left
  left="$(grep -oE '^[A-Z0-9_]+=(CHANGE_ME|GENERATED_BY_PROVISION)$' "$ENVF" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$left" ]] || die "fill these in /etc/plynth/plynth.env first: $left"
  local v
  for v in INDEXER_CHAIN KEEPER_CHAIN RELAYER_CHAIN API_CHAIN ELIGIBILITY_CHAIN; do
    [[ "$(envval "$v")" == mainnet ]] || die "$v must be mainnet in /etc/plynth/plynth.env"
  done
  local rpc chain
  rpc="$(envval RHC_MAINNET_RPC_URL)"
  rpc="${rpc:-https://rpc.mainnet.chain.robinhood.com}"
  chain="$(curl -fsS -m 20 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc" | jq -r '.result // empty')" \
    || die "RHC_MAINNET_RPC_URL did not answer eth_chainId"
  [[ -n "$chain" && "$((chain))" == 4663 ]] || die "RHC_MAINNET_RPC_URL answered chain id ${chain:-nothing}, not Robinhood Chain mainnet 4663: refusing"

  local dep="$R/app/deployments/4663.json"
  [[ -f "$dep" && -f "$R/app/deployments/4663-treasury.json" ]] || die "4663.json / 4663-treasury.json missing from the release"
  jq -e '.chainId == 4663 and (.fork // false) == false' "$dep" >/dev/null || die "4663.json is not a mainnet (4663) deployment"
  local pair key var want have
  for pair in eligibilityRegistry:ELIGIBILITY_REGISTRY treasuryFactory:TREASURY_FACTORY; do
    key="${pair%%:*}"
    var="${pair#*:}"
    want="$(jq -r --arg k "$key" '.[$k] // empty' "$dep")"
    have="$(envval "$var")"
    [[ -z "$want" || "$(lower "$want")" == "$(lower "$have")" ]] || die "$var in plynth.env is $have but 4663.json says $key = $want"
  done
  for v in KEEPER_PRIVATE_KEY RELAYER_PRIVATE_KEY ELIGIBILITY_ATTESTER_KEY TREASURY_CONTROLLER_KEY TREASURY_CONTROLLER_KEYSTORE_PASSWORD; do
    [[ -z "$(envval "$v")" ]] || log "WARNING: $v is set in plynth.env; use a keystore + password file under /etc/plynth/keys instead"
  done
  local path
  for v in $(grep -oE '^[A-Z0-9_]+_(KEYSTORE|KEYSTORE_PASSWORD_FILE)=' "$ENVF" | tr -d = | sort -u); do
    path="$(envval "$v")"
    [[ -n "$path" ]] || continue
    # Access test only: the file is never read or printed here.
    runuser -u plynth -- test -r "$path" \
      || die "$v names $path, which the plynth user cannot read: copy it into /etc/plynth/keys, chown root:plynth, chmod 0440"
  done
  log "preflight ok: chain 4663, deployment block $(jq -r '.deployBlock' "$dep"), keystores readable"

  # ---- units, ownership, dependencies
  bash "$R/app/scripts/server/provision.sh" --units-only
  printf '%s\n' "$sha" >"$R/REVISION"
  chown -R plynth:plynth "$R"
  log "bun install --frozen-lockfile"
  (cd "$R/app" && runuser -u plynth -- env HOME=/var/lib/plynth PATH=/usr/local/bin:/usr/bin:/bin \
    bun install --frozen-lockfile --production) || die "bun install failed; /opt/plynth/current is unchanged"

  # ---- switch, migrate (roll the link back on failure), restart
  local prev=""
  [[ -L "$BASE/current" ]] && prev="$(readlink "$BASE/current")"
  ln -sfn "releases/$rel" "$BASE/current.new"
  mv -T "$BASE/current.new" "$BASE/current"
  log "current -> releases/$rel; migrating"
  if ! systemctl start plynth-migrate.service; then
    journalctl -u plynth-migrate.service -n 30 --no-pager -o cat | sed 's/^/  | /'
    if [[ -n "$prev" ]]; then
      ln -sfn "$prev" "$BASE/current.new"
      mv -T "$BASE/current.new" "$BASE/current"
    fi
    die "migrations failed: current is back on ${prev:-nothing}; services were not restarted"
  fi

  local ipdb
  ipdb="$(envval ELIGIBILITY_IP_DB)"
  if [[ -n "$ipdb" && ! -s "$ipdb" ]]; then
    log "no IP country database yet: downloading it"
    systemctl start plynth-ipdb.service || log "WARNING: plynth-ipdb failed (journalctl -u plynth-ipdb); screening has no IP country until it works"
  fi

  local s units=()
  for s in "${CORE[@]}"; do units+=("plynth-$s.service"); done
  systemctl enable --quiet plynth.target "${units[@]}"
  log "restarting plynth.target"
  systemctl restart plynth.target

  local failed=0
  check_all || failed=1

  # ---- keep the 5 newest releases (never the current or the previous one)
  local keep_cur keep_prev d
  keep_cur="$(readlink -f "$BASE/current")"
  keep_prev=""
  [[ -n "$prev" ]] && keep_prev="$(cd "$BASE" && readlink -f "$prev" || true)"
  while IFS= read -r d; do
    [[ -n "$d" && "$d" != "$keep_cur" && "$d" != "$keep_prev" ]] && rm -rf "$d"
  done < <(ls -1dt "$BASE"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +6)

  if [[ "$failed" != 0 ]]; then
    printf '\nRelease %s is live but unhealthy. Logs: journalctl -u plynth-<service> -n 100\n' "$rel" >&2
    [[ -n "$prev" ]] && printf 'Roll back: ln -sfn %s %s/current && systemctl restart plynth.target\n' "$prev" "$BASE" >&2
    exit 1
  fi
  log "release $rel ($sha) live and healthy"
}
main "$@" </dev/null
REMOTE
}

run_remote() { remote_script | ssh_ bash -s -- "$@"; }

# ---------------------------------------------------------------- --check
if [[ "$MODE" == check ]]; then
  run_remote check
  exit 0
fi

SHA="$(git -C "$ROOT" rev-parse --verify "${REF}^{commit}")" || die "no commit $REF"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  log "note: the checkout has uncommitted changes; they are NOT deployed (only commit ${SHA:0:12})"
fi

# ---------------------------------------------------------------- --provision
if [[ "$MODE" == provision ]]; then
  log "copying app/scripts/server at ${SHA:0:12} to /root/plynth-server"
  git -C "$ROOT" archive --format=tar "$SHA" app/scripts/server | gzip -c \
    | ssh_ "rm -rf /root/plynth-server && mkdir -p /root/plynth-server && tar -xzf - -C /root/plynth-server --strip-components=3 --no-same-owner"
  envs=""
  for v in API_DOMAIN RELAYER_DOMAIN ACME_EMAIL DB_NAME SWAP_SIZE; do
    [[ -n "${!v:-}" ]] && envs+="$v=$(printf '%q' "${!v}") "
  done
  log "running provision.sh on the server (takes a few minutes)"
  ssh_ "cd /root/plynth-server && ${envs}bash provision.sh"
  exit 0
fi

# ---------------------------------------------------------------- deploy: local checks
DEP_SRC="${PLYNTH_DEPLOYMENTS_SRC:-$APP/deployments}"
if [[ ! -f "$DEP_SRC/4663.json" ]]; then
  if [[ -f "$DEP_SRC/4663-beta.json" ]]; then
    die "$DEP_SRC has 4663-beta.json but no 4663.json: run 'cd app && bun scripts/mainnet/setup.ts --check-only' first (it writes 4663.json and 4663-treasury.json)"
  fi
  die "no mainnet deployment in $DEP_SRC (4663.json): set PLYNTH_DEPLOYMENTS_SRC to the folder that has it"
fi
[[ -f "$DEP_SRC/4663-treasury.json" ]] || die "$DEP_SRC/4663-treasury.json missing (scripts/mainnet/setup.ts writes it with 4663.json)"
grep -Eq '"chainId"[[:space:]]*:[[:space:]]*4663([^0-9]|$)' "$DEP_SRC/4663.json" || die "$DEP_SRC/4663.json is not for chain 4663"
if grep -Eq '"fork"[[:space:]]*:[[:space:]]*true' "$DEP_SRC/4663.json"; then die "$DEP_SRC/4663.json comes from a fork run"; fi
DEP_FILES=(4663.json 4663-treasury.json)
[[ -f "$DEP_SRC/4663-beta.json" ]] && DEP_FILES+=(4663-beta.json)

# ---------------------------------------------------------------- deploy: upload, then run on the server
REL="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}"
log "deploying ${SHA:0:12} to $HOST as release $REL"
git -C "$ROOT" archive --format=tar "$SHA" app sdk LICENSE README.md | gzip -c \
  | ssh_ "set -e; test -d /opt/plynth/releases || { echo 'not provisioned: run deploy.sh --provision first' >&2; exit 1; }; mkdir /opt/plynth/releases/$REL; tar -xzf - -C /opt/plynth/releases/$REL --no-same-owner"
ssh_ "mkdir -p /opt/plynth/releases/$REL/app/deployments"
for f in "${DEP_FILES[@]}"; do
  ssh_ "cat >/opt/plynth/releases/$REL/app/deployments/$f" <"$DEP_SRC/$f"
done
log "uploaded code and ${DEP_FILES[*]}"

run_remote deploy "$REL" "$SHA"

# ---------------------------------------------------------------- optional public checks from this machine
if [[ -n "${PLYNTH_PUBLIC_API_URL:-}" ]]; then
  curl -fsS -m 20 "${PLYNTH_PUBLIC_API_URL%/}/v1/meta/health" >/dev/null && log "public API ok (${PLYNTH_PUBLIC_API_URL%/}/v1/meta/health)" \
    || die "public API check failed at ${PLYNTH_PUBLIC_API_URL%/}/v1/meta/health (DNS, Caddy certificate or firewall?)"
fi
if [[ -n "${PLYNTH_PUBLIC_RELAYER_URL:-}" ]]; then
  curl -fsS -m 20 "${PLYNTH_PUBLIC_RELAYER_URL%/}/health" >/dev/null && log "public relayer ok (${PLYNTH_PUBLIC_RELAYER_URL%/}/health)" \
    || die "public relayer check failed at ${PLYNTH_PUBLIC_RELAYER_URL%/}/health"
fi
log "done"
