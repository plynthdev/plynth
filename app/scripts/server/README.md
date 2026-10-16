# Running the backend on a server

Scripts to run the Plynth services against Robinhood Chain mainnet (chain id 4663) on one small Ubuntu server
(written for a Cherry Servers VPS: Ubuntu 26.04 64-bit, 2-4 GB RAM, root SSH login with a key). Everything runs on
the one machine: Postgres, the Bun services under systemd, and Caddy in front for HTTPS.

| File | What it is |
| --- | --- |
| `provision.sh` | Run once as root on the server (safe to run again): user, packages, Postgres, firewall, fail2ban, automatic security updates, swap, Bun, cast, Caddy, systemd units, backup timer |
| `deploy.sh` | Run from your own machine: ships a commit, installs dependencies, migrates the database, restarts the services, checks every one |
| `backup.sh` | Nightly `pg_dump` into `/var/backups/plynth`, 14 days kept (installed as `/usr/local/sbin/plynth-backup`) |
| `env.example` | Every variable the services read on mainnet; provision splits it into `/etc/plynth/env/<service>.env` |
| `split-env.sh` | Routes each variable to the services that read it (one env file per service) |
| `Caddyfile` | HTTPS reverse proxy template: the API and the relayer, certificates automatic |
| `systemd/` | One unit per service, `plynth.target` grouping them, the migration unit, the backup and IP database timers |

## Layout on the server

| Path | |
| --- | --- |
| `/opt/plynth/releases/<time>-<commit>` | One folder per deploy (the last 5 are kept) |
| `/opt/plynth/current` | Link to the live release; every unit runs from here |
| `/etc/plynth/env/common.env` | Shared, non-secret settings (RPC URLs, log level) (root, 0600) |
| `/etc/plynth/env/<service>.env` | One per service: `indexer`, `keeper`, `api`, `eligibility`, `relayer`, `mcp`, `treasury` (all `plynth-treasury-*` units). Each unit gets only `common.env`, its own file and, if it uses the database, `db.env` (root, 0600) |
| `/etc/plynth/db.env` | `DATABASE_URL` with the random database password (root, 0600) |
| `/etc/plynth/<unit>.env` | Optional, overrides values for one unit (for example `keeper.env`, `treasury-desks.env`) |
| `/etc/plynth/keys/` | The keystores and their password files, copied in by the owner; each readable only by the service that signs with it |
| `/var/lib/plynth/data` | IP country database and sanctions list cache (group `plynth-screening`: the eligibility service and the API) |
| `/var/lib/plynth-<service>` | Each service's working directory (systemd `StateDirectory`) |
| `/var/backups/plynth` | Database dumps |

Services and ports (only 22, 80 and 443 are open to the internet):

| Unit | Port | Public |
| --- | --- | --- |
| `plynth-indexer` | 8787 | no |
| `plynth-keeper` | 8788 | no |
| `plynth-api` | 8789 | `https://api.plynthnetwork.com` |
| `plynth-eligibility` | 8790 | no (the API serves the same routes) |
| `plynth-relayer` | 8791 | `https://relayer.plynthnetwork.com` |
| `plynth-mcp` | 8792 | no |
| `plynth-treasury-marks`, `plynth-treasury-webhooks` | 8797, 8799 | no |
| `plynth-treasury-desks`, `-close`, `-risk`, `-receipts`, `-reconciler` | 8793-8796, 8798 | no; optional, one treasury each, off until you enable them |

## Steps, in order

1. **Server.** Create the VPS with your SSH key for root. Note its address; it never goes into any file in this repository.

2. **DNS.** Point `api.plynthnetwork.com` and `relayer.plynthnetwork.com` (A record, and AAAA if the server has IPv6) at the server. Use other names if you like and pass them in the next step. Leave Cloudflare's proxy off (grey cloud); see [Cloudflare](#cloudflare).

3. **Provision.** From the repository on your machine:

   ```sh
   ACME_EMAIL=you@example.com app/scripts/server/deploy.sh --provision <server>
   ```

   `<server>` is the address, an `~/.ssh/config` alias, or `user@address` (root by default). Extra ssh options go in `SSH_OPTS`, for example `SSH_OPTS="-i ~/.ssh/plynth"`. This copies this folder to `/root/plynth-server` and runs `provision.sh` there. Other names: `API_DOMAIN=... RELAYER_DOMAIN=...`. You can also copy the folder yourself and run `bash provision.sh` as root.

4. **Settings.** On the server, `grep -l CHANGE_ME /etc/plynth/env/*.env` (provision wrote the files from `env.example`, filled in two random secrets and split them per service) and replace each `CHANGE_ME`: `ELIGIBILITY_REGISTRY` (in `eligibility.env` and `api.env`) and `TREASURY_FACTORY` (in `treasury.env`) are the `eligibilityRegistry` and `treasuryFactory` addresses in `app/deployments/4663.json`. Check `CORS_ORIGINS` (in `api.env` and `relayer.env`) lists every frontend origin. A value two services share is in both files: change it in both. If a keeper already ran somewhere else against its own database, read [Moving a running keeper](#moving-a-running-keeper) first.

5. **Keys.** Copy the four service keystores and their password files from the machine that holds them into `/etc/plynth/keys/` on the server, with these names, then lock them down:

   ```
   plynth-main-keeper      keeper.password
   plynth-main-relayer     relayer.password
   plynth-main-controller  controller.password
   plynth-main-attester    attester.password

   ```

   `deploy.sh` (through `provision.sh --units-only`) then gives each file to the one service that signs with it: the keeper's to `plynth-keeper`, the relayer's to `plynth-relayer`, the attester's to `plynth-screening` (the eligibility service and the API), the controller's and any desk keystore to `plynth-treasury`, all `root:<group>` 0440, and it refuses to deploy if a key is readable by any other service user.

   Keystores and passwords are never committed, never put in the env files as raw keys, and never sent by `deploy.sh`. The owner wallet is not one of them: it never goes on a server.

6. **Deployment file.** `deploy.sh` ships `app/deployments/4663.json` and `4663-treasury.json` (plus the raw `4663-beta.json`). If you only have `4663-beta.json` (the output of the mainnet deploy), make the other two first: `cd app && bun scripts/mainnet/setup.ts --check-only`.

7. **Deploy.**

   ```sh
   app/scripts/server/deploy.sh <server>
   ```

   It refuses to start anything while a `CHANGE_ME` is left, if the RPC does not answer chain id 4663, if `4663.json` and the env files disagree on an address, or if a keystore or password file is not readable by the service that uses it or is readable by another service. Then it installs, migrates, restarts `plynth.target` and prints one line per service: the keeper's last pass with each job's result, the indexer's lag, the API's view of the chain and database. Exit code 0 means every service answered healthy. Only committed code is shipped (`--ref <commit|tag>` for another one). Add `PLYNTH_PUBLIC_API_URL=https://api.plynthnetwork.com PLYNTH_PUBLIC_RELAYER_URL=https://relayer.plynthnetwork.com` to also check from outside once DNS and the certificates are in place.

8. **Every later release:** step 7 again. `deploy.sh --check <server>` re-runs the health checks without changing anything.

## Day to day

```sh
systemctl status 'plynth-*'                 # every unit
journalctl -u plynth-keeper -f              # follow one service's log
systemctl restart plynth.target             # restart everything
systemctl stop plynth.target                # stop everything
systemctl list-timers 'plynth-*'            # backup and IP database timers
```

**Roll back:** `ls -t /opt/plynth/releases`, then `ln -sfn releases/<older> /opt/plynth/current && systemctl restart plynth.target`. Migrations are not reversed, so roll back only to a release that has the same migrations, or restore a backup.

**Keeper.** One keeper per database and deployment. The unit is a single instance and the keeper also holds a Postgres lock; a second keeper anywhere exits with status 75 and systemd retries it every 30 s. Never start one by hand next to the service.

**Per-treasury services.** Fill the per-treasury block of `/etc/plynth/env/treasury.env` (or `/etc/plynth/treasury-desks.env` and so on), copy any desk keystores into `/etc/plynth/keys` the same way, then `systemctl enable --now plynth-treasury-desks` (and `-close`, `-risk`, `-receipts`, `-reconciler`). Enabled units join `plynth.target` and `deploy.sh` checks them too.

## Backups

`plynth-backup.timer` runs `backup.sh` every night at about 03:15: a `pg_dump` (custom format, checked with `pg_restore --list`) into `/var/backups/plynth`, dumps older than 14 days deleted. Run one now with `systemctl start plynth-backup`. The dumps live on the same disk as the database, so also copy them off the server regularly (for example `rsync` from your machine, or Cherry Servers backup storage). Restore into the database:

```sh
systemctl stop plynth.target
runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=plynth -d plynth_mainnet /var/backups/plynth/<file>.dump
systemctl start plynth.target
```

## Moving a running keeper

The keeper seals its beacon secrets in the database with `KEEPER_SECRET_KEY`. To move a keeper that already ran elsewhere: stop it there, restore its database here (dump there, `pg_restore` here as above), put its `KEEPER_SECRET_KEY` in `/etc/plynth/env/keeper.env` and `/etc/plynth/env/api.env` in place of the generated one, then deploy. Starting fresh on a new database with a new key is fine only before any beacon window was committed.

## Cloudflare

The API (its rate limits and eligibility routes) and the relayer take the client address from the proxy headers (`API_TRUST_PROXY=1`, `ELIGIBILITY_TRUST_PROXY=1`, `RELAYER_TRUST_PROXY=1`). Caddy sets `X-Forwarded-For` itself and removes `CF-Connecting-IP` and `CF-IPCountry` from every request, because a client could otherwise send them and choose its own country. If you put Cloudflare's proxy (orange cloud) in front, do both: allow 80 and 443 only from Cloudflare's address ranges in ufw, and delete the two `header_up -CF-...` lines from the `Caddyfile` template, then run `provision.sh` again. Doing one without the other either breaks the country screen or lets clients bypass it.

## What provision.sh sets up

- One system user per service (`plynth-indexer`, `-keeper`, `-api`, `-eligibility`, `-relayer`, `-mcp`, `-treasury`; no login shell), each with a read-only view of the system (`ProtectSystem=strict`), write access only to its own `/var/lib/plynth-<service>` (and `/var/lib/plynth/data` for screening), only its own settings, and only its own keys (`/etc/plynth/keys` is hidden from the services that sign nothing). The `plynth` user owns the code and runs the migrations.
- **Upgrading a server provisioned before this:** the next `deploy.sh` creates the users, splits `/etc/plynth/plynth.env` into `/etc/plynth/env/` (the old file stays as `plynth.env.pre-split`), re-owns the keys and installs the new units; nothing else to do.
- Postgres from Ubuntu (its current major version), listening on localhost only, with a `plynth` role and the `plynth_mainnet` database.
- ufw: inbound 22/tcp, 80/tcp and 443 only. fail2ban on SSH. SSH password logins off when root has an authorized key.
- Unattended security upgrades, a 2 GB swap file when there is none, NTP on, journald capped at 1 GB / 30 days.
- Bun 1.4.2 (checksum-checked against the release's `SHASUMS256.txt`) and cast 1.8.4 in `/usr/local/bin`.
- Caddy with automatic HTTPS for the API and the relayer.
- The systemd units, the nightly backup and the monthly IP country database refresh.
