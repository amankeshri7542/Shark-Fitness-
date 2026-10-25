# Pilot hosting: one real gym

How to run Shark Fitness for the two-week pilot at one branch: one small server in India, the app behind HTTPS, the database on a disk that keeps its data, nightly backups, a restore drill and alerts. Everything here is in [`deploy/pilot/`](../../deploy/pilot) at the repository root.

**Status, 2026-10-25: ready to provision, not provisioned.** The owner chose to wait before paying for a server. The scripts were run on a Mac against a stand-in for Docker (see [Evidence](#evidence)), and the [Pilot stack](../../.github/workflows/pilot-stack.yml) workflow runs them on a real Docker host for every change to them. Three checks can only happen on the real server and are still open: `/ready` there, the owner signing in to the empty gym, and a backup plus restore drill.

The free Render demo is a separate thing and stays as it is: `render.yaml` and the `shark-fitness-demo` service are untouched, and its database still resets on every sleep or deploy. Never point the pilot at it, and never run `scripts/postman/run.mjs` against the pilot: that suite expects the demo seed.

## What runs where

| Piece | Choice | Cost |
| --- | --- | --- |
| Server | DigitalOcean droplet in Bangalore (BLR1), Ubuntu 24.04, Basic Regular: 1 vCPU, 1 GiB RAM, 25 GiB SSD | **$6.00 a month**, billed hourly at $0.00893 (DigitalOcean's price page, read 2026-10-25). A two-week pilot is about $3 if the droplet is destroyed afterwards. |
| DigitalOcean backups | Off. They would add 20% (weekly) or 30% (daily). | $0 |
| HTTPS | Caddy, with a free Let's Encrypt certificate for your own domain | $0 |
| Database | SQLite at `/srv/shark-fitness/data/shark.db` on the droplet's own disk | included |
| Backups | Nightly on the server; copies pulled to your Mac with `pull-backup.sh` | $0 |
| Alerts | UptimeRobot for `/ready`, healthchecks.io for missed backups, ntfy.sh for server errors | $0 (free plans) |
| Member sign-in | Activation links that reception hands over; members set their own password | $0 |

One origin serves everything: the member app at `/`, the console at `/admin/`, the API at `/v1/`, plus `/health` and `/ready`.

The server runs two containers under Docker Compose. `app` is built from the repository's `Dockerfile`; its entrypoint migrates the database and then starts the API. `caddy` gets the certificate, redirects HTTP to HTTPS and proxies to `app`. The app's port is never published.

Why not the others: a paid Render web service with a disk costs $7.25 a month and runs in Singapore. It also has nowhere to schedule a backup that can see the disk, so the backup would have to run inside the service. AWS Lightsail in Mumbai would work the same way as DigitalOcean; there was simply no AWS account in use.

### Files in `deploy/pilot/`

| File | What it does |
| --- | --- |
| `compose.yaml` | The two containers, the fixed production settings, and the data and backup mounts |
| `Caddyfile` | HTTPS for `SHARK_DOMAIN`, proxying to the app |
| `shark.env.example` | Template for the server's `shark.env` (secrets and options) |
| `provision.sh` | One-time server setup: Docker, swap, firewall, automatic security updates, directories, `shark.env` with a new secret, the backup timer |
| `deploy.sh` | Backs up, builds a git ref, restarts, then waits for `/ready` to report that commit |
| `bootstrap.sh` | Creates the empty gym and the owner's account; asks each question |
| `backup.sh` | `pnpm db:backup` plus a restore check, pruning, and healthchecks.io pings |
| `shark-backup.service`, `shark-backup.timer` | Run `backup.sh nightly` at 02:00 India time |
| `restore-drill.sh` | Restores a backup into a throwaway copy, boots it with no network, and signs in as the owner |
| `pull-backup.sh` | Run on your Mac: takes a backup on the server, copies it down, checks the checksum |

### Layout on the server

```text
/srv/shark-fitness/
  src/                 git checkout of this repository (deploy.sh moves it between commits)
  shark.env            secrets and options, mode 600, never in git
  release.env          SHARK_RELEASE=<commit>, written by deploy.sh
  data/shark.db        the gym's database (owned by uid 1000, the container's user)
  backups/nightly/     backup.sh copies, each shark-<UTC time>.db plus .manifest.json
  backups/pre-deploy/
  backups/manual/
  drill/inbox/         put copies here that came back from off the server
```

## Step by step

Commands that start with `ssh` run on your Mac; everything else runs on the server as root. Replace `pilot.example.com` with your domain and `203.0.113.10` with the droplet's IP throughout.

### 1. Create the droplet (this step spends money)

1. In DigitalOcean, open **Create → Droplets**.
2. Choose region **Bangalore (BLR1)**, image **Ubuntu 24.04 (LTS) x64**, and size **Basic → Regular → $6/mo** (1 GB / 25 GB).
3. Under Authentication choose **SSH key → New SSH key** and paste `~/.ssh/shark_pilot_ed25519.pub` from the Mac. That key was made only for this server.
4. Leave Backups off and set the hostname to `shark-pilot`. Create the droplet and note its IPv4 address.

### 2. Point your domain at it

At your DNS provider, add an **A record** for the pilot hostname (for example `pilot` under `example.com`) pointing at the droplet's IPv4 address, with a TTL of 300. Check it from the Mac before going on:

```bash
dig +short pilot.example.com
```

It must print the droplet's IP. Caddy cannot get a certificate until it does. Choose the final hostname now: members install the app from this address, and moving later means everyone reinstalls and signs in again.

### 3. Provision

```bash
ssh -i ~/.ssh/shark_pilot_ed25519 root@203.0.113.10
```

Then, on the server:

```bash
git clone https://github.com/amankeshri7542/Shark-Fitness-.git /srv/shark-fitness/src
bash /srv/shark-fitness/src/deploy/pilot/provision.sh pilot.example.com
```

This takes a few minutes. It installs updates, Docker, 2 GB of swap (building the image needs more than 1 GB of memory) and a firewall that allows only SSH, HTTP and HTTPS. It turns on automatic security updates and creates the directories above. It writes `shark.env` with a new 64-character `SHARK_PASS_SECRET` (`openssl rand -base64 48`) and enables the nightly backup timer. Running it again changes nothing that already exists.

Save a copy of `/srv/shark-fitness/shark.env` in your password manager.

### 4. Deploy

```bash
/srv/shark-fitness/src/deploy/pilot/deploy.sh
```

The first build takes about 5–10 minutes on this size of server. The script ends by printing the `/ready` response, which must carry the deployed commit as `release`, and by checking that `https://pilot.example.com/ready` answers. From the Mac:

```bash
curl -s https://pilot.example.com/ready
```

Expect `"status":"ready"`, `"database":"ready"`, `"schema":"ready"` and `"scheduler":"enabled"`. If HTTPS does not answer, look at `docker compose logs caddy` in `/srv/shark-fitness/src/deploy/pilot`; it is almost always the A record.

### 5. Create the empty gym

```bash
/srv/shark-fitness/src/deploy/pilot/bootstrap.sh
```

It asks for the gym code (the short name everyone types at sign-in, such as `shark-indiranagar`), the gym's names, the owner's name, email and password (12+ characters, typed hidden), and the first branch's address, capacity and opening hours. It runs `pnpm db:bootstrap` (`apps/api/src/db/bootstrap.ts`), which creates one tenant, one branch, the owner's account and an audit entry, and nothing else: no demo data. The password reaches the container only on stdin, never in arguments, environment, logs or a file. A gym code that already exists is refused, never overwritten. `SHARK_SEED_DEMO` is fixed to `false` in `compose.yaml`, so the demo seed can never run here.

### 6. The owner's first sign-in

The owner opens `https://pilot.example.com/admin/`, enters the gym code, email and password, and should see an empty dashboard: no members, invoices or check-ins. Before any member arrives, set up plans and prices, the tax profile, branch details and the reception staff accounts (staff get activation links the same way members do). [PILOT-OPERATING-PACK.md](PILOT-OPERATING-PACK.md) has the daily routine.

### 7. Members sign in with activation links

No SMS, WhatsApp or email provider is configured, and production never shows or logs sign-in codes. So:

1. Reception adds the member, **with an email address**: activation needs one.
2. On the member's profile, **Account activation → Create activation link**. The link works once and expires after 24 hours. Creating another link cancels the previous one.
3. Hand the link over in person or on a private WhatsApp chat, after checking who the person is.
4. The member opens it on their phone, sets a password of at least 12 characters, and adds the app to their home screen.
5. From then on members sign in with the gym code, their email and their password. Tell them not to use "request a code"; it cannot reach them in this pilot.

If someone forgets their password, the owner uses **Existing account recovery** ([account-recovery.md](account-recovery.md)).

To switch to sign-in codes later, set the provider variables listed under [Sign-in codes](#sign-in-codes-not-used-in-the-pilot) in `shark.env` and redeploy. Indian SMS needs DLT registration first, which takes days to weeks.

### 8. Alerts

All three use free plans. Every change to `shark.env` needs `docker compose up -d` in `/srv/shark-fitness/src/deploy/pilot` to take effect; Compose recreates the app when its environment changed.

**Site down: UptimeRobot.** Create a **Keyword** monitor for `https://pilot.example.com/ready` that looks for `"status":"ready"`, with a 5-minute interval and an email alert. To test it, run `docker compose stop app` on the server, wait for the alert (about 5–10 minutes), then `docker compose start app` and wait for the recovery email.

**Missed backup: healthchecks.io.** Create a check with a period of 1 day and a grace of 1 hour, and copy its ping URL into `shark.env`:

```text
SHARK_BACKUP_PING_URL=https://hc-ping.com/<uuid>
```

`backup.sh nightly` pings `/start` when it begins and the plain URL on success, with the backup's path and SHA-256. On failure it pings `/fail`, which emails you at once; a night with no ping at all emails you after the grace period. Test it with `systemctl start shark-backup` and watch the check turn green.

**Server errors: ntfy.sh.** Install the ntfy app on your phone and subscribe to a long random topic. Anyone who knows the name can read it, so generate one with `openssl rand -hex 16`. Then:

```text
SHARK_ERROR_REPORTING_ENDPOINT=https://ntfy.sh/shark-pilot-<random>
```

Unexpected server errors arrive as notifications. The reporter sends only the error's name and redacted message, the route, and tenant/actor IDs: no request bodies, member fields, cookies or headers. Test the channel from the server with `curl -d "Shark pilot test" https://ntfy.sh/shark-pilot-<random>`.

### 9. Backups

The timer runs `backup.sh nightly` at 02:00 India time; `Persistent=true` catches up after downtime. Each run:

1. Runs `pnpm db:backup` in a one-off container with the app's mounts. That is SQLite's online backup, so the gym stays open while it runs. It checks the copy's integrity and writes a manifest with its size and SHA-256.
2. Restores that copy into a throwaway path with `pnpm db:restore`, which re-checks the manifest, size, checksum and integrity.
3. Deletes copies older than `SHARK_BACKUP_KEEP_DAYS` (14), but only after a good backup, so a run of failures never removes the last copy.

`deploy.sh` also takes a `pre-deploy` copy before every deploy, because the new release migrates the database and migrations only go forward. For a copy on demand, run `backup.sh` (it goes to `backups/manual/`). Logs: `journalctl -u shark-backup`. Next run: `systemctl list-timers shark-backup.timer`.

Each copy is one self-contained `.db` file plus its `.manifest.json`. The empty `-shm` and `-wal` files beside it are left by SQLite when the backup tool reopens the copy read-only to check it. They hold nothing and are pruned with it.

**These copies share a disk with the database.** They cover a bad deploy or a mistake. They do not cover losing the droplet (account problem, accidental destroy, disk failure). Off-server storage was deliberately skipped for the pilot to keep it free, so the only off-server copies are the ones you pull to the Mac:

```bash
deploy/pilot/pull-backup.sh root@203.0.113.10
```

That takes a fresh backup on the server, copies it and its manifest to `~/shark-pilot-backups/` (mode 700), and checks the SHA-256. Do it at least weekly during the pilot, and after any day with a lot of payments. The files hold members' personal data: keep that folder off shared drives. For production, add an upload step to `backup.sh` that writes to object storage (Cloudflare R2 or Backblaze B2; both have a free 10 GB tier) and verifies the uploaded copy.

### 10. Restore drill

Do this once before the first member arrives, and monthly after that. It proves that a copy which has been off the server brings the gym back. The running app and its database are never touched.

From the Mac, take a copy off the server and send it back into the drill inbox:

```bash
deploy/pilot/pull-backup.sh root@203.0.113.10
```

```bash
scp -i ~/.ssh/shark_pilot_ed25519 ~/shark-pilot-backups/shark-<time>.db ~/shark-pilot-backups/shark-<time>.db.manifest.json root@203.0.113.10:/srv/shark-fitness/drill/inbox/
```

Then on the server:

```bash
/srv/shark-fitness/src/deploy/pilot/restore-drill.sh --gym <gym code> --email <owner email> /srv/shark-fitness/drill/inbox/shark-<time>.db
```

It asks for the owner's password (hidden), then:

1. Runs `pnpm db:backup:verify` (`scripts/verify-backup-restore.mjs`) in a container with no network. That is the app's full synthetic recovery proof: seeded data, a payment and refund, checksum and overwrite guards, restart, restore, and authenticated reads.
2. Restores the given copy with `pnpm db:restore` into `drill/<time>/`, checked against its manifest. It boots the deployed image on that copy with no network and the scheduler off, so it cannot message or bill anyone.
3. Checks that `/ready` reports ready, prints row counts, signs in as the owner and reads the dashboard.

A pass ends with `synthetic_proof=passed`, `owner_sign_in=200`, `owner_dashboard=200` and `drill=passed`; any failure exits non-zero. The drill copy is deleted afterwards (`--keep` keeps it). Record the output under [Evidence](#evidence).

### 11. Updating and rolling back

After a change is merged to main:

```bash
/srv/shark-fitness/src/deploy/pilot/deploy.sh
```

Pass a commit or tag to deploy something else: `deploy.sh 6f7d3d6`. To roll back, deploy the previous commit; `docker image ls shark-fitness` lists the commits built on this server. That works when the older release can read the migrated database. If it cannot, restore the `pre-deploy` copy as in step 12, using the older commit. Expect about 10–30 seconds of downtime per deploy, while the app container restarts and migrates. Deploy outside opening hours.

### 12. Recovering onto a new server

If the droplet is lost, create a new one (steps 1–4, with the same domain and your saved `shark.env` copied to `/srv/shark-fitness/shark.env` before running `deploy.sh`). Then put the newest off-server copy back:

```bash
cd /srv/shark-fitness/src/deploy/pilot
docker compose stop app
install -d -m 700 -o 1000 -g 1000 /srv/shark-fitness/backups/restore
install -m 600 -o 1000 -g 1000 -t /srv/shark-fitness/backups/restore shark-<time>.db shark-<time>.db.manifest.json
docker compose run --rm --no-deps -T --entrypoint pnpm app -s run db:restore /var/backups/shark-fitness/restore/shark-<time>.db /var/lib/shark-fitness/shark.db --replace --yes-replace
docker compose up -d
```

`--replace --yes-replace` is needed only because `deploy.sh` already created an empty database. The tool checks the manifest and integrity before it replaces anything. Then the owner signs in, and you compare members, balances and today's check-ins with reception's records. Anything after the copy was taken has to be re-entered. A new `SHARK_PASS_SECRET` only invalidates members' current entry passes, which renew within minutes; the saved one avoids even that.

## Environment variables

Every variable the API, the image and these scripts read. The app validates its settings at startup (`apps/api/src/lib/config.ts`) and refuses to start in production on a bad value. An optional variable must be absent or commented out, never left empty.

### Fixed in `compose.yaml`

These override anything in `shark.env`.

| Variable | Pilot value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | Turns on the production checks and HSTS; hides sign-in codes |
| `PORT` | `8787` | Inside the container; only Caddy reaches it |
| `SHARK_SERVE_STATIC` | `true` | The API serves the member app and the console |
| `SHARK_DB` | `/var/lib/shark-fitness/shark.db` | That is `/srv/shark-fitness/data/shark.db` on the server; required in production |
| `SHARK_SEED_DEMO` | `false` | Never seed demo gyms or known passwords into the real gym |
| `SHARK_ECHO_OTP` | `false` | Must be false in production |
| `SHARK_ALLOW_BEARER_AUTH` | `false` | Development-only; must be false in production |
| `SHARK_TRUST_PROXY_HOPS` | `1` | Caddy is the single proxy and replaces any client-sent `X-Forwarded-For`, so rate limits see real client IPs |
| `SHARK_PUBLIC_ORIGIN` | `https://${SHARK_DOMAIN}` | Must be HTTPS in production; also the allowed origin for cookies and CSRF |

### In `/srv/shark-fitness/shark.env`

| Variable | Required | Pilot value | Notes |
| --- | --- | --- | --- |
| `SHARK_DOMAIN` | yes | your hostname, e.g. `pilot.example.com` | Read by Compose for Caddy and `SHARK_PUBLIC_ORIGIN`; set by `provision.sh` |
| `SHARK_PASS_SECRET` | yes | 64 characters from `openssl rand -base64 48` | At least 48 bytes or startup fails. Signs members' rotating entry passes and roster-import confirmations. Set by `provision.sh`; keep a copy in a password manager |
| `SHARK_ERROR_REPORTING_ENDPOINT` | no | `https://ntfy.sh/shark-pilot-<random>` | HTTPS only. Receives redacted JSON for unexpected errors |
| `SHARK_BACKUP_PING_URL` | no | `https://hc-ping.com/<uuid>` | Read by `backup.sh` (nightly runs only) |
| `SHARK_BACKUP_KEEP_DAYS` | no | `14` | Read by `backup.sh` |

### Written by `deploy.sh`

| Variable | Where | Notes |
| --- | --- | --- |
| `SHARK_RELEASE` | `/srv/shark-fitness/release.env` | The 12-character commit; `/ready` reports it as `release` and error reports carry it. If absent, the app falls back to `RENDER_GIT_COMMIT`, then `GITHUB_SHA`, then `local` |

### App settings left at their defaults

Any of these can go in `shark.env` if needed; none is needed for the pilot.

| Variable | Default | Notes |
| --- | --- | --- |
| `SHARK_ALLOWED_ORIGINS` | none | Extra comma-separated HTTPS origins, beyond `SHARK_PUBLIC_ORIGIN` |
| `SHARK_DISABLE_JOBS` | `false` | `true` stops the scheduler (renewals, dunning, pruning). The restore drill sets it; the live app must not |
| `SHARK_READER_KEYS_JSON` | `{}` | Door-reader keys. The pilot checks members in at reception; production ignores the demo reader |
| `SHARK_DEMO_READER_KEY` | development value | Used outside production only |
| `SHARK_MEDIA_BUCKET` | unset | Must stay unset: startup refuses it until object-storage uploads exist |
| `SHARK_IDEMPOTENCY_RETENTION_DAYS` | `30` | 7–365 |
| `SHARK_OUTBOX_RETENTION_DAYS` | `7` | 7–365 |
| `SHARK_SESSION_RETENTION_DAYS` | `30` | 1–365 |
| `SHARK_OTP_RETENTION_HOURS` | `24` | 1–168 |
| `SHARK_ACCESS_WINDOW_RETENTION_HOURS` | `24` | 1–168 |
| `SHARK_AUTOMATION_RETENTION_DAYS` | `90` | 7–730 |
| `SHARK_JOB_RUN_RETENTION_DAYS` | `30` | 7–365 |
| `SHARK_PRUNE_BATCH_SIZE` | `1000` | 1–1000 |
| `SHARK_PRUNE_MAX_BATCHES` | `10` | 1–10 |

### Sign-in codes (not used in the pilot)

With these unset, both channels use the log sender, which in production neither sends nor prints codes; startup logs a warning saying so. Adapters: `apps/api/src/services/otp-delivery.ts`.

| Variable | Default | Notes |
| --- | --- | --- |
| `SHARK_OTP_SMS_PROVIDER` | `log` | `msg91` or `twilio` |
| `SHARK_OTP_EMAIL_PROVIDER` | `log` | `resend` |
| `SHARK_MSG91_AUTH_KEY`, `SHARK_MSG91_TEMPLATE_ID` | — | MSG91 needs a DLT-approved template with an `##OTP##` variable |
| `SHARK_TWILIO_ACCOUNT_SID`, `SHARK_TWILIO_AUTH_TOKEN`, `SHARK_TWILIO_FROM` | — | Twilio SMS or WhatsApp |
| `SHARK_TWILIO_CHANNEL` | SMS | `whatsapp` for WhatsApp |
| `SHARK_TWILIO_CONTENT_SID` | — | Approved WhatsApp template whose `{{1}}` is the code |
| `SHARK_RESEND_API_KEY`, `SHARK_OTP_EMAIL_FROM` | — | Resend; the sender must be on a domain verified in Resend |
| `SHARK_OTP_DEFAULT_COUNTRY_CODE` | `91` | For 10-digit phone numbers |
| `SHARK_OTP_RESEND_COOLDOWN_SEC` | `30` | |
| `SHARK_OTP_MAX_PER_DESTINATION_PER_DAY` | `10` | |
| `SHARK_OTP_MAX_PER_IP_PER_HOUR` | `30` | |

### Script settings (shell environment, not `shark.env`)

| Variable | Default | Used by |
| --- | --- | --- |
| `SHARK_HOME` | `/srv/shark-fitness` | every server script and `compose.yaml` |
| `SHARK_REPO` | this GitHub repository | `provision.sh`, when it clones |
| `SHARK_SSH_KEY` | `~/.ssh/shark_pilot_ed25519` | `pull-backup.sh` |
| `SHARK_REMOTE_HOME` | `/srv/shark-fitness` | `pull-backup.sh` |

### Not used on this host

`RENDER_EXTERNAL_URL` and `RENDER_GIT_COMMIT` are set by Render for the demo. `GITHUB_SHA` comes from CI. `SHARK_BASE_URL`, `SHARK_BROWSER_CREDENTIALS_FILE` and `SHARK_DEMO_PASSWORD` belong to test scripts that target the demo seed.

## Evidence

### Local, 2026-10-25 (no server)

There is no Docker on the Mac, so a stand-in `docker` ran each container command directly with Node 22.23.2 and pnpm 10.28.0, with the container paths mapped to a scratch directory. The commands themselves, the database and the API server were real.

- `deploy.sh --current`: migrated a fresh database, started the API, and `/ready` reported the deployed commit. The HTTPS check warned, as expected with no Caddy.
- `bootstrap.sh` with JSON on stdin created the gym. With the same gym code again it exited 1 and changed nothing. Driven through a pseudo-terminal, the interactive prompts rejected a short password and asked again, never echoed the password, and created a second gym whose owner then signed in (HTTP 200).
- `backup.sh nightly` produced a backup, manifest and SHA-256 and passed the restore check. It pruned a 2026-09-01 copy, sidecar files included, and pinged `/start` and then success with the backup details. A simulated failure pinged `/start` and then `/fail`. Manual runs did not ping, and two in a row both passed.
- A second `deploy.sh` took a `pre-deploy` backup first, and the owner still signed in.
- `pull-backup.sh` worked under macOS's bash 3.2, with and without the SSH key file. It copied the backup and manifest at mode 600 and verified the SHA-256; a one-byte change fails that check.
- `restore-drill.sh` on that pulled copy: `synthetic_proof=passed`, the restore checksum verified, the restored copy reported ready with `scheduler: disabled`, row counts matched the two empty gyms, and owner sign-in and the dashboard both returned 200. The drill copy was removed afterwards. With a wrong password the drill printed `owner_sign_in=401` and exited 1.

### CI

The Pilot stack workflow runs the same flow on an Ubuntu 24.04 runner with real Docker, Caddy (`SHARK_DOMAIN=localhost`, using Caddy's own local CA) and systemd. It checks shellcheck, provisioning, HTTPS and the 308 redirect, the empty gym, the nightly unit, the restore drill, a redeploy, and a replaced container that still has the gym.

### Hosted: pending

| Check | Result |
| --- | --- |
| `https://<domain>/ready` reports ready with the deployed commit | not run: no server yet |
| Owner signs in at `/admin/` to an empty gym | not run |
| `systemctl start shark-backup` succeeds and healthchecks.io turns green | not run |
| `pull-backup.sh`, then `restore-drill.sh` on the returned copy, passes | not run |
| UptimeRobot alert on `docker compose stop app`, and recovery | not run |
| ntfy test message reaches the phone | not run |
