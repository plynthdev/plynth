#!/usr/bin/env bash
# Prepares a fresh Ubuntu server (Cherry Servers VPS, Ubuntu 26.04 64-bit, 2-4 GB RAM) to run the Plynth services.
# Run as root ON THE SERVER, from this folder (it reads ./systemd, ./Caddyfile, ./env.example and ./backup.sh).
# Safe to run again: every step checks the current state first. `deploy.sh --provision <host>` copies the folder
# up and runs it for you.
#
#   bash provision.sh                 everything below
#   bash provision.sh --units-only    only the service users, the per-service env files, key permissions, the systemd
#                                     units and the backup script (deploy.sh runs this on every deploy)
#
# What it does: a `plynth` system user that owns the code and runs migrations, and one system user per service
# (plynth-indexer, -keeper, -api, -eligibility, -relayer, -mcp, -treasury); apt upgrade; git, build tools, jq; Postgres (the distro's current major)
# with a `plynth` role and database whose random password goes to /etc/plynth/db.env (0600); ufw allowing only
# 22, 80 and 443; fail2ban for SSH; unattended security upgrades; a swap file when there is none; Bun and cast
# (Foundry) at pinned versions; Caddy as the HTTPS reverse proxy for the API and the relayer; the systemd units; the
# nightly backup timer; the settings from env.example on the first run, split into one file per service in
# /etc/plynth/env/ (split-env.sh; an existing single /etc/plynth/plynth.env is split the same way and kept as
# plynth.env.pre-split); each keystore readable only by the service that signs with it.
#
# Env (optional; saved to /etc/plynth/provision.conf and reused on the next run):
#   API_DOMAIN       default api.plynthnetwork.com
#   RELAYER_DOMAIN   default relayer.plynthnetwork.com
#   ACME_EMAIL       contact address for Let's Encrypt (blank = none)
#   DB_NAME          default plynth_mainnet
#   SWAP_SIZE        default 2G when the server has no swap (0 = never add swap)
#
# It never creates, reads or moves keys: /etc/plynth/keys is created empty and the owner copies the keystores in.
set -euo pipefail

# Pinned tool versions. Bun matches the version the repo is developed and tested with (README: Bun 1.4+,
# @types/bun 1.4.2); cast matches the Foundry release used for the mainnet scripts.
BUN_VERSION="1.4.2"
FOUNDRY_VERSION="1.8.4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF=/etc/plynth/provision.conf

log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[provision] WARNING: %s\n' "$*" >&2; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

UNITS_ONLY=0
case "${1:-}" in
  "") ;;
  --units-only) UNITS_ONLY=1 ;;
  -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (try --help)" ;;
esac

[[ "$(id -u)" == 0 ]] || die "run as root"
for f in systemd/plynth.target Caddyfile env.example backup.sh split-env.sh; do
  [[ -e "$HERE/$f" ]] || die "missing $HERE/$f: run provision.sh from the app/scripts/server folder"
done
cd /

# ---------------------------------------------------------------- systemd units + backup script
install_units() {
  local f dest changed=0
  for f in "$HERE"/systemd/*.service "$HERE"/systemd/*.target "$HERE"/systemd/*.timer; do
    dest="/etc/systemd/system/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then
      install -m 0644 "$f" "$dest"
      changed=1
    fi
  done
  if ! cmp -s "$HERE/backup.sh" /usr/local/sbin/plynth-backup; then
    install -m 0755 "$HERE/backup.sh" /usr/local/sbin/plynth-backup
  fi
  systemctl daemon-reload
  systemctl enable --now --quiet plynth-backup.timer plynth-ipdb.timer || die "could not enable the backup and IP database timers"
  if [[ "$changed" == 1 ]]; then log "systemd units installed"; else log "systemd units unchanged"; fi
}

# ---------------------------------------------------------------- service users, env files, key permissions
# Every service runs as its own system user and gets only its own env file (audit, privileged/ops). Group plynth
# lets a service traverse /etc/plynth/keys; each key file is readable only by the group of the service that signs:
#   plynth-main-keeper, keeper.password          plynth-keeper
#   plynth-main-relayer, relayer.password        plynth-relayer
#   plynth-main-attester, attester.password      plynth-screening (plynth-eligibility and plynth-api)
#   plynth-main-controller, controller.password  plynth-treasury (also any other file: treasury desk keystores)
SERVICE_USERS=(plynth-indexer plynth-keeper plynth-api plynth-eligibility plynth-relayer plynth-mcp plynth-treasury)
ensure_accounts() {
  id plynth >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/plynth --create-home --shell /usr/sbin/nologin plynth
  getent group plynth-screening >/dev/null || groupadd --system plynth-screening
  local u
  for u in "${SERVICE_USERS[@]}"; do
    id "$u" >/dev/null 2>&1 || { useradd --system --user-group --no-create-home --home-dir "/var/lib/$u" --shell /usr/sbin/nologin "$u"; log "created system user $u"; }
  done
  for u in plynth-keeper plynth-relayer plynth-api plynth-eligibility plynth-treasury; do usermod -a -G plynth "$u"; done
  for u in plynth-api plynth-eligibility; do usermod -a -G plynth-screening "$u"; done
  install -d -o plynth -g plynth -m 0755 /var/lib/plynth
  # IP country database and sanctions cache: written by plynth-eligibility (and its ipdb refresh), read by the API.
  install -d -o root -g plynth-screening -m 2770 /var/lib/plynth/data
  find /var/lib/plynth/data -maxdepth 1 -type f -exec chgrp plynth-screening {} + -exec chmod g+rw {} +
  install -d -o root -g plynth -m 0750 /etc/plynth /etc/plynth/keys
  install -d -o root -g root -m 0700 /etc/plynth/env
}

fix_key_permissions() {
  local f g
  shopt -s nullglob
  for f in /etc/plynth/keys/*; do
    case "$(basename "$f")" in
      plynth-main-keeper | keeper.password) g=plynth-keeper ;;
      plynth-main-relayer | relayer.password) g=plynth-relayer ;;
      plynth-main-attester | attester.password) g=plynth-screening ;;
      *) g=plynth-treasury ;;
    esac
    chown root:"$g" "$f"
    chmod 0440 "$f"
  done
  shopt -u nullglob
}

fill_generated() {
  # Replaces GENERATED_BY_PROVISION with fresh random secrets (passed through the environment, not argv).
  local src="$1" dst="$2"
  KSK="0x$(openssl rand -hex 32)" MTS="$(openssl rand -hex 32)" awk '
    /^KEEPER_SECRET_KEY=GENERATED_BY_PROVISION$/ { print "KEEPER_SECRET_KEY=" ENVIRON["KSK"]; next }
    /^MCP_TOKEN_SECRET=GENERATED_BY_PROVISION$/ { print "MCP_TOKEN_SECRET=" ENVIRON["MTS"]; next }
    { print }
  ' "$src" >"$dst"
}

# /etc/plynth/env/<service>.env from the single settings file: env.example on a fresh server, or the existing
# /etc/plynth/plynth.env on a server provisioned before the split (kept as plynth.env.pre-split, 0600).
ensure_env_files() {
  [[ -f /etc/plynth/env/common.env ]] && { log "per-service env files exist in /etc/plynth/env: left as they are"; return; }
  umask 077
  if [[ ! -f /etc/plynth/plynth.env ]]; then
    fill_generated "$HERE/env.example" /etc/plynth/plynth.env.tmp
    mv /etc/plynth/plynth.env.tmp /etc/plynth/plynth.env
    log "settings written from env.example: replace every CHANGE_ME in /etc/plynth/env/*.env before deploying"
  elif grep -q '=GENERATED_BY_PROVISION$' /etc/plynth/plynth.env; then
    fill_generated /etc/plynth/plynth.env /etc/plynth/plynth.env.tmp
    mv /etc/plynth/plynth.env.tmp /etc/plynth/plynth.env
  fi
  bash "$HERE/split-env.sh" /etc/plynth/plynth.env /etc/plynth/env
  chown root:root /etc/plynth/env/*.env
  chmod 0600 /etc/plynth/env/*.env
  mv /etc/plynth/plynth.env /etc/plynth/plynth.env.pre-split
  chmod 0600 /etc/plynth/plynth.env.pre-split
  umask 022
  log "split the settings into /etc/plynth/env/{common,indexer,keeper,api,eligibility,relayer,mcp,treasury}.env (the old file is /etc/plynth/plynth.env.pre-split)"
}

# Settings a newer release added (and the relayer's mainnet fee tables when blank) come from env.example.
add_new_settings() {
  bash "$HERE/split-env.sh" --add-missing "$HERE/env.example" /etc/plynth/env
}

if [[ "$UNITS_ONLY" == 1 ]]; then
  ensure_accounts
  ensure_env_files
  add_new_settings
  fix_key_permissions
  install_units
  exit 0
fi

# ---------------------------------------------------------------- settings
saved() { [[ -r "$CONF" ]] && (set +u; source "$CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\""); }
API_DOMAIN="${API_DOMAIN:-$(saved API_DOMAIN || true)}"
RELAYER_DOMAIN="${RELAYER_DOMAIN:-$(saved RELAYER_DOMAIN || true)}"
ACME_EMAIL="${ACME_EMAIL:-$(saved ACME_EMAIL || true)}"
DB_NAME="${DB_NAME:-$(saved DB_NAME || true)}"
API_DOMAIN="${API_DOMAIN:-api.plynthnetwork.com}"
RELAYER_DOMAIN="${RELAYER_DOMAIN:-relayer.plynthnetwork.com}"
DB_NAME="${DB_NAME:-plynth_mainnet}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ "$API_DOMAIN" =~ $domain_re ]] || die "API_DOMAIN '$API_DOMAIN' is not a domain name"
[[ "$RELAYER_DOMAIN" =~ $domain_re ]] || die "RELAYER_DOMAIN '$RELAYER_DOMAIN' is not a domain name"
[[ -z "$ACME_EMAIL" || "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "ACME_EMAIL '$ACME_EMAIL' is not an email address"
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DB_NAME '$DB_NAME' must be lowercase letters, digits and _"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || warn "written for Ubuntu, this is ${PRETTY_NAME:-unknown}"
fi

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
# needrestart (Ubuntu) would otherwise stop and ask which services to restart after an upgrade.
export NEEDRESTART_MODE=a
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
log "apt update + upgrade"
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install --no-install-recommends \
  git build-essential ca-certificates curl gnupg unzip jq openssl \
  ufw fail2ban python3-systemd unattended-upgrades \
  postgresql postgresql-client

# ---------------------------------------------------------------- swap, time
if [[ "$SWAP_SIZE" != 0 && -z "$(swapon --show --noheadings)" ]]; then
  log "adding a $SWAP_SIZE swap file"
  [[ -f /swapfile ]] || fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/60-plynth.conf
sysctl -q -p /etc/sysctl.d/60-plynth.conf
# The keeper and the beacon work in wall-clock windows: keep the clock synced.
timedatectl set-ntp true 2>/dev/null || warn "could not turn on NTP sync (timedatectl)"

# ---------------------------------------------------------------- user and directories
ensure_accounts
install -d -o plynth -g plynth -m 0755 /opt/plynth /opt/plynth/releases
install -d -o root -g root -m 0700 /var/backups/plynth

umask 077
{
  echo "# Written by provision.sh; read by provision.sh and plynth-backup."
  printf 'API_DOMAIN=%q\nRELAYER_DOMAIN=%q\nACME_EMAIL=%q\nDB_NAME=%q\n' "$API_DOMAIN" "$RELAYER_DOMAIN" "$ACME_EMAIL" "$DB_NAME"
} >"$CONF"
chmod 0600 "$CONF"
umask 022

# ---------------------------------------------------------------- Bun (pinned, checksum-verified)
install_bun() {
  if [[ -x /usr/local/bin/bun && "$(/usr/local/bin/bun --version 2>/dev/null)" == "$BUN_VERSION" ]]; then
    log "bun $BUN_VERSION already installed"
    return
  fi
  local asset tmp base
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; grep -qw avx2 /proc/cpuinfo || asset=bun-linux-x64-baseline ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($asset)"
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep -E " \*?${asset}\.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun download does not match SHASUMS256.txt"
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" /usr/local/bin/bun
  rm -rf "$tmp"
  [[ "$(/usr/local/bin/bun --version)" == "$BUN_VERSION" ]] || die "bun --version is not $BUN_VERSION after install"
}
install_bun

# ---------------------------------------------------------------- cast (Foundry), pinned; only cast is installed
install_cast() {
  if command -v cast >/dev/null 2>&1 && cast --version 2>/dev/null | grep -qF "$FOUNDRY_VERSION"; then
    log "cast $FOUNDRY_VERSION already installed"
    return
  fi
  local arch tmp url
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) warn "no Foundry build for $(uname -m): skipping cast"; return ;;
  esac
  url="https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  log "installing cast $FOUNDRY_VERSION"
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 -o "$tmp/foundry.tar.gz" "$url" && tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast; then
    install -m 0755 "$tmp/cast" /usr/local/bin/cast
  else
    # cast is only an operator tool here (chain id and balance checks); the services do not need it.
    warn "could not install cast from $url (set FOUNDRY_VERSION to a published release and re-run)"
  fi
  rm -rf "$tmp"
}
install_cast

# ---------------------------------------------------------------- Postgres: role, database, /etc/plynth/db.env
log "postgres: role plynth, database $DB_NAME"
systemctl enable --now --quiet postgresql || die "postgresql did not start"
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q && break
  sleep 1
done
psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

db_password=""
if [[ -f /etc/plynth/db.env ]]; then
  db_password="$(sed -n 's#^DATABASE_URL=postgres://plynth:\([^@]*\)@.*#\1#p' /etc/plynth/db.env | tail -1)"
fi
[[ -n "$db_password" ]] || db_password="$(openssl rand -hex 24)"

if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'plynth'")" != 1 ]]; then
  psql_admin -c "CREATE ROLE plynth LOGIN"
fi
# The password goes through stdin, never through a command line.
printf "ALTER ROLE plynth WITH LOGIN PASSWORD '%s';\n" "$db_password" | psql_admin
if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != 1 ]]; then
  runuser -u postgres -- createdb --owner=plynth "$DB_NAME"
fi

umask 077
{
  echo "# Written by provision.sh. Read by systemd (as root) for every plynth-* unit. Do not commit or copy."
  echo "DATABASE_URL=postgres://plynth:${db_password}@127.0.0.1:5432/${DB_NAME}"
} >/etc/plynth/db.env.tmp
mv /etc/plynth/db.env.tmp /etc/plynth/db.env
chown root:root /etc/plynth/db.env
chmod 0600 /etc/plynth/db.env
umask 022
unset db_password

# ---------------------------------------------------------------- settings: one env file per service
ensure_env_files
add_new_settings
fix_key_permissions

# ---------------------------------------------------------------- firewall: 22, 80, 443 only
log "ufw: allow 22/tcp, 80/tcp, 443 (tcp + udp for HTTP/3); deny everything else inbound"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- fail2ban (SSH)
cat >/etc/fail2ban/jail.d/plynth.local <<'EOF'
# Written by provision.sh.
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban

# ---------------------------------------------------------------- SSH: keys only
if [[ -s /root/.ssh/authorized_keys ]]; then
  cat >/etc/ssh/sshd_config.d/10-plynth.conf <<'EOF'
# Written by provision.sh: key-only logins (root keeps key login for deploy.sh).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl try-reload-or-restart ssh.service || warn "could not reload ssh; the settings apply at the next restart"
  else
    rm -f /etc/ssh/sshd_config.d/10-plynth.conf
    warn "sshd -t rejected the key-only settings: removed them, SSH unchanged"
  fi
else
  warn "/root/.ssh/authorized_keys is empty: SSH password settings left unchanged"
fi

# ---------------------------------------------------------------- unattended upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Written by provision.sh.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now --quiet unattended-upgrades || warn "could not enable unattended-upgrades"

# ---------------------------------------------------------------- journald: bounded logs
install -d /etc/systemd/journald.conf.d
printf '# Written by provision.sh.\n[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=30day\n' >/etc/systemd/journald.conf.d/plynth.conf
systemctl restart systemd-journald

# ---------------------------------------------------------------- Caddy (HTTPS reverse proxy)
if ! command -v caddy >/dev/null 2>&1; then
  if apt-cache policy caddy 2>/dev/null | grep -qE 'Candidate: [0-9]'; then
    log "installing caddy (Ubuntu package)"
  else
    log "installing caddy (Caddy's own apt repository)"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get "${APT_OPTS[@]}" install caddy
fi

caddy_tmp="$(mktemp)"
sed -e "s/__API_DOMAIN__/${API_DOMAIN}/g" -e "s/__RELAYER_DOMAIN__/${RELAYER_DOMAIN}/g" -e "s/__ACME_EMAIL__/${ACME_EMAIL}/g" \
  "$HERE/Caddyfile" >"$caddy_tmp"
if [[ -z "$ACME_EMAIL" ]]; then
  # No contact address: drop the global options block ({ email ... }), the only block that opens on a bare "{".
  sed -i '/^{$/,/^}$/d' "$caddy_tmp"
fi
chmod 0644 "$caddy_tmp"
install -d -o caddy -g caddy /var/log/caddy
# Validate as the caddy user so any log file it opens is owned by caddy.
runuser -u caddy -- caddy validate --adapter caddyfile --config "$caddy_tmp" >/dev/null 2>&1 \
  || { runuser -u caddy -- caddy validate --adapter caddyfile --config "$caddy_tmp" || true; rm -f "$caddy_tmp"; die "the rendered Caddyfile does not validate"; }
if ! cmp -s "$caddy_tmp" /etc/caddy/Caddyfile; then
  [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 0644 "$caddy_tmp" /etc/caddy/Caddyfile
  log "Caddyfile written for $API_DOMAIN and $RELAYER_DOMAIN"
fi
rm -f "$caddy_tmp"
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

# ---------------------------------------------------------------- units
install_units

cat <<EOF

provision: done.
  Postgres   database $DB_NAME, role plynth, DATABASE_URL in /etc/plynth/db.env (0600)
  Caddy      https://$API_DOMAIN -> API :8789, https://$RELAYER_DOMAIN -> relayer :8791
             (certificates arrive once both DNS records point at this server)
  Backups    nightly to /var/backups/plynth (systemctl list-timers plynth-backup.timer)
Next (README.md in this folder):
  1. Edit /etc/plynth/env/*.env: replace every CHANGE_ME (grep -l CHANGE_ME /etc/plynth/env/*.env).
  2. Copy the four keystores and password files into /etc/plynth/keys/; deploy.sh (or provision.sh --units-only)
     gives each one to the service that signs with it (root:<service group>, 0440).
  3. From the owner's machine: app/scripts/server/deploy.sh <host>
EOF
