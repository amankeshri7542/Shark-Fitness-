# Pilot hosting: one real gym

How to run Shark Fitness for the two-week pilot at one branch: one small server in India, the app behind HTTPS, the database on a disk that keeps its data, nightly backups, a restore drill and alerts. Everything here is in [`deploy/pilot/`](../../deploy/pilot) at the repository root.

**Status, 2026-11-24: ready to provision, not provisioned.** Encrypted off-site copies, Sentry-compatible error reporting and `/metrics` were added in November and are off until configured. The owner chose to wait before paying for a server. The scripts were run on a Mac against a stand-in for Docker (see [Evidence](#evidence)), and the [Pilot stack](../../.github/workflows/pilot-stack.yml) workflow runs them on a real Docker host for every change to them. Three checks can only happen on the real server and are still open: `/ready` there, the owner signing in to the empty gym, and a backup plus restore drill.

The free Render demo is a separate thing and stays as it is: `render.yaml` and the `shark-fitness-demo` service are untouched, and its database still resets on every sleep or deploy. Never point the pilot at it, and never run `scripts/postman/run.mjs` against the pilot: that suite expects the demo seed.

## What runs where

| Piece | Choice | Cost |
| --- | --- | --- |
| Server | DigitalOcean droplet in Bangalore (BLR1), Ubuntu 24.04, Basic Regular: 1 vCPU, 1 GiB RAM, 25 GiB SSD | **$6.00 a month**, billed hourly at $0.00893 (DigitalOcean's price page, read 2026-10-25). A two-week pilot is about $3 if the droplet is destroyed afterwards. |
| DigitalOcean backups | Off. They would add 20% (weekly) or 30% (daily). | $0 |
| HTTPS | Caddy, with a free Let's Encrypt certificate for your own domain | $0 |
| Database | SQLite at `/srv/shark-fitness/data/shark.db` on the droplet's own disk | included |
| Backups | Nightly on the server, plus optional encrypted off-site copies (`age` + `rclone` to any object store, e.g. Backblaze B2 or Cloudflare R2); copies can also be pulled to your Mac with `pull-backup.sh` | $0 on the stores' free 10 GB tiers; off-site is off until configured |
| Alerts | UptimeRobot for `/ready`, healthchecks.io for missed backups, ntfy.sh or a Sentry-compatible DSN for server and browser errors, DigitalOcean Monitoring for disk ([OPERATIONS-ALERTS.md](OPERATIONS-ALERTS.md)) | $0 (free plans) |
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
| `backup.sh` | `pnpm db:backup` plus a restore check, optional encrypted off-site upload, pruning, and healthchecks.io pings |
| `shark-backup.service`, `shark-backup.timer` | Run `backup.sh nightly` at 02:00 India time |
| `restore-drill.sh` | Restores a backup (local, or downloaded and decrypted from off-site with `--from-offsite`) into a throwaway copy, boots it with no network, and signs in as the owner |
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

**Server and browser errors.** Two choices; set one.

- *Sentry-compatible (recommended once someone triages errors):* create a project in Sentry, GlitchTip or a self-hosted collector and put its DSN in `shark.env` as `SHARK_ERROR_DSN=https://<public key>@<host>/<project id>`. Reports arrive grouped, with stack frames, the release, the request id and the route. No SDK is installed; the app speaks the envelope protocol itself.
- *ntfy.sh (simplest):* below.

`SHARK_ERROR_REPORTER` defaults to `auto` (DSN first, then the ntfy endpoint, otherwise none in production). The startup log line `api_listening` names the reporter in use. Browser crashes in the member app and the console reach the same reporter through `POST /v1/client-errors`, tagged `source=member` or `source=admin`, with the reference the person sees on the "Something went wrong" screen.

**ntfy.sh.** Install the ntfy app on your phone and subscribe to a long random topic. Anyone who knows the name can read it, so generate one with `openssl rand -hex 16`. Then:

```text
SHARK_ERROR_REPORTING_ENDPOINT=https://ntfy.sh/shark-pilot-<random>
```

Unexpected server errors arrive as notifications. The reporter sends only the error's name, redacted message and stack frames, the route, the request id and tenant/actor IDs: no request bodies, member fields, cookies or headers. Test the channel from the server with `curl -d "Shark pilot test" https://ntfy.sh/shark-pilot-<random>`.

**Disk and memory: DigitalOcean Monitoring.** Tick *Monitoring* when creating the droplet (free), then add alert policies for disk utilization above 80 % and memory above 75 % for 15 minutes.

**Metrics (optional).** Setting `SHARK_METRICS_TOKEN` (`openssl rand -hex 32`) turns on `GET /metrics` for a Prometheus-compatible scraper. Every alert rule, with what to do when it fires, is in [OPERATIONS-ALERTS.md](OPERATIONS-ALERTS.md).

### 9. Backups

The timer runs `backup.sh nightly` at 02:00 India time; `Persistent=true` catches up after downtime. Each run:

1. Runs `pnpm db:backup` in a one-off container with the app's mounts. That is SQLite's online backup, so the gym stays open while it runs. It checks the copy's integrity and writes a manifest with its size and SHA-256.
2. Restores that copy into a throwaway path with `pnpm db:restore`, which re-checks the manifest, size, checksum and integrity.
3. With off-site copies configured, encrypts the copy and its manifest with `age` and uploads both with `rclone` (below). Prints `offsite=uploaded`, `offsite=failed` or, when not configured, `offsite=skipped`.
4. Deletes copies older than `SHARK_BACKUP_KEEP_DAYS` (14), but only after a good backup and (when configured) a good upload, so a run of failures never removes the last copy.

`deploy.sh` also takes a `pre-deploy` copy before every deploy, because the new release migrates the database and migrations only go forward. For a copy on demand, run `backup.sh` (it goes to `backups/manual/`). Logs: `journalctl -u shark-backup`. Next run: `systemctl list-timers shark-backup.timer`.

Each copy is one self-contained `.db` file plus its `.manifest.json`. The empty `-shm` and `-wal` files beside it are left by SQLite when the backup tool reopens the copy read-only to check it. They hold nothing and are pruned with it.

**These copies share a disk with the database.** They cover a bad deploy or a mistake, not losing the droplet (account problem, accidental destroy, disk failure). Off-site copies cover that.

#### Encrypted off-site copies

Off until both `SHARK_BACKUP_OFFSITE_REMOTE` and `SHARK_BACKUP_AGE_RECIPIENT` are set. Then every backup (nightly, pre-deploy and manual) is encrypted on the server with [age](https://age-encryption.org) to your public key and uploaded with [rclone](https://rclone.org) to `<remote>/<kind>/shark-<time>.db.age` plus `.manifest.json.age`. Nothing readable leaves the server, and the storage provider only ever holds ciphertext. `provision.sh` installs both tools.

Set it up once:

1. **Make the key on your Mac, not on the server:** `brew install age`, then `age-keygen -o ~/shark-pilot-offsite.key`. It prints the public key (`age1…`). Store the key file in your password manager and on one offline USB stick. Without it the off-site copies cannot be read by anyone, you included.
2. **Create a bucket** (Backblaze B2 or Cloudflare R2; this creates an account) and an API key limited to that one bucket. Turn on the bucket's object lock or versioning if offered, so a stolen server key cannot erase history.
3. **On the server**, `sudo rclone config` and create a remote, e.g. named `offsite`, with that key. Its credentials stay in `/root/.config/rclone/rclone.conf` (mode 600), never in `shark.env`.
4. **In `shark.env`:**

   ```text
   SHARK_BACKUP_OFFSITE_REMOTE=offsite:shark-pilot-backups
   SHARK_BACKUP_AGE_RECIPIENT=age1<your public key>
   SHARK_BACKUP_OFFSITE_KEEP_DAYS=30
   ```

   Several recipients may be given, comma-separated (for example the owner's key and a second key kept by whoever maintains the server).
5. Run `/srv/shark-fitness/src/deploy/pilot/backup.sh` and check it prints `offsite=uploaded` and an `offsite_object=` line. Then do the off-site drill in step 10.

**Key custody.** The server only holds the *public* key, so a compromised server can add copies but not read old ones. The private key lives with the owner (password manager plus offline copy). It is brought to a machine only to restore or drill, kept in `/run` or `/dev/shm` (memory, not disk), and deleted straight after. Never put it in `shark.env`, the backups directory or the repository. If it is lost, make a new key, update `SHARK_BACKUP_AGE_RECIPIENT`, and treat the old copies as unreadable; if it leaks, do the same and delete the old copies.

**When an upload fails** (remote unreachable, credentials revoked, bucket full): the local copy is kept, local pruning is skipped until an upload succeeds, a nightly run pings healthchecks.io's `/fail` and the systemd unit is marked failed. A pre-deploy or manual run warns and carries on with its good local copy. Off-site copies older than `SHARK_BACKUP_OFFSITE_KEEP_DAYS` are deleted only after an upload succeeds, so a broken remote never prunes the last good copy.

**Retention and deleted members.** Engineering PRD 02 requires backups to follow the same deletion and retention commitments as the live data. An erasure request anonymises the member in the live database at once, but copies taken before it still hold their data until they age out: at most `SHARK_BACKUP_KEEP_DAYS` (14) days on the server and `SHARK_BACKUP_OFFSITE_KEEP_DAYS` (30) days off-site. The privacy notice must state that window (30 days with these defaults; keep it short and do not raise it without updating the notice). Backups are never restored partially to read one person's data. After a full restore (step 12), the erasures completed after the copy was taken must be applied again: in the restored database they show as still open in the console's Settings → Privacy (apply them there), and requests submitted after the copy are missing entirely. So keep a short off-server log of completed erasures (date and member number only, nothing else personal) and re-enter any that the restored copy lacks before reopening.

#### Pulling a copy by hand

```bash
deploy/pilot/pull-backup.sh root@203.0.113.10
```

That takes a fresh backup on the server, copies it and its manifest to `~/shark-pilot-backups/` (mode 700), and checks the SHA-256. Without off-site copies, do it at least weekly and after any day with a lot of payments. The files are not encrypted and hold members' personal data: keep that folder off shared drives.

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

A pass ends with `synthetic_proof=passed`, `owner_sign_in=200`, `owner_mfa=…` (the owner's two-step state; `challenge` once they use it), `owner_session=200` and `drill=passed`; any failure exits non-zero. The drill copy is deleted afterwards (`--keep` keeps it). Record the output under [Evidence](#evidence).

**Drilling an off-site copy.** This is the one that proves the droplet can be lost. Copy the private key into memory on the server for the drill only, run it, and delete the key:

```bash
scp ~/shark-pilot-offsite.key root@203.0.113.10:/run/shark-offsite.key
```

```bash
/srv/shark-fitness/src/deploy/pilot/restore-drill.sh --gym <gym code> --email <owner email> \
  --from-offsite nightly/shark-<time>.db --age-identity /run/shark-offsite.key
shred -u /run/shark-offsite.key
```

`--from-offsite` takes the `offsite_object=` line `backup.sh` printed, or a path under `SHARK_BACKUP_OFFSITE_REMOTE` (`rclone ls offsite:shark-pilot-backups` lists them). It downloads the copy and its manifest, decrypts both, prints `offsite_download=verified` when the SHA-256 matches, then runs the drill above. The decrypted copy is deleted afterwards, also when the drill fails.

### 11. Updating and rolling back

After a change is merged to main:

```bash
/srv/shark-fitness/src/deploy/pilot/deploy.sh
```

Pass a commit or tag to deploy something else: `deploy.sh 6f7d3d6`. To roll back, deploy the previous commit; `docker image ls shark-fitness` lists the commits built on this server. That works when the older release can read the migrated database. If it cannot, restore the `pre-deploy` copy as in step 12, using the older commit. Expect about 10–30 seconds of downtime per deploy, while the app container restarts and migrates. Deploy outside opening hours.

### 12. Recovering onto a new server

If the droplet is lost, create a new one (steps 1–4, with the same domain and your saved `shark.env` copied to `/srv/shark-fitness/shark.env` before running `deploy.sh`). With off-site copies, recreate the rclone remote (`sudo rclone config`), bring the private key into `/run` as in step 10, and fetch and decrypt the newest copy:

```bash
cd /srv/shark-fitness
rclone lsf offsite:shark-pilot-backups/nightly | sort | tail -n 2
rclone copy --include 'shark-<time>.db*' offsite:shark-pilot-backups/nightly ./incoming
age -d -i /run/shark-offsite.key -o shark-<time>.db incoming/shark-<time>.db.age
age -d -i /run/shark-offsite.key -o shark-<time>.db.manifest.json incoming/shark-<time>.db.manifest.json.age
shred -u /run/shark-offsite.key && rm -rf incoming
```

Then put the copy back (from the Mac's `~/shark-pilot-backups/` instead, if that is the newest):

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
| `SHARK_MFA_ENCRYPTION_KEY` | yes | 44 characters from `openssl rand -base64 32` | Exactly 32 bytes or startup fails. Encrypts staff two-step sign-in secrets and webhook signing secrets. Set by `provision.sh` (added to an older `shark.env` on the next run); keep a copy with the backup key — without it every staff member must set up two-step sign-in again and webhook secrets must be rotated |
| `SHARK_PASS_SECRET` | yes | 64 characters from `openssl rand -base64 48` | At least 48 bytes or startup fails. Signs members' rotating entry passes and roster-import confirmations. Set by `provision.sh`; keep a copy in a password manager |
| `SHARK_ERROR_REPORTING_ENDPOINT` | no | `https://ntfy.sh/shark-pilot-<random>` | HTTPS only. Receives redacted JSON for unexpected errors |
| `SHARK_BACKUP_PING_URL` | no | `https://hc-ping.com/<uuid>` | Read by `backup.sh` (nightly runs only) |
| `SHARK_BACKUP_KEEP_DAYS` | no | `14` | Read by `backup.sh` |
| `SHARK_BACKUP_OFFSITE_REMOTE` | no | `offsite:shark-pilot-backups` | rclone `remote:path`; set together with the next one, or neither. Read by `backup.sh` and `restore-drill.sh` |
| `SHARK_BACKUP_AGE_RECIPIENT` | no | `age1…` (public key) | One or more age public keys, comma-separated. Never the private key |
| `SHARK_BACKUP_OFFSITE_KEEP_DAYS` | no | `30` | Off-site retention; pruned only after a successful upload |
| `SHARK_ERROR_REPORTER` | no | `auto` | `auto`, `none`, `console`, `http` or `sentry`. `auto`: DSN, then endpoint, otherwise none in production |
| `SHARK_ERROR_DSN` | no | `https://<key>@<host>/<project id>` | Sentry-protocol DSN (Sentry, GlitchTip, self-hosted). HTTPS in production |
| `SHARK_METRICS_TOKEN` | no | `openssl rand -hex 32` | Turns on `GET /metrics` with this bearer token; at least 32 characters in production. Unset: `/metrics` is a 404 |

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
| `RCLONE_CONFIG` | `/root/.config/rclone/rclone.conf` | `backup.sh`, `restore-drill.sh` (named explicitly because the systemd unit runs without `$HOME`) |

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

### Local, 2026-11-24: off-site copies (no Docker)

On a Linux box without Docker, a stand-in `docker` produced a fake backup and manifest, a stand-in `install` dropped the root-only ownership flags, and the real `age` 1.2.1 and `rclone` 1.68.2 binaries did the rest, against an rclone `local` remote and a throwaway key:

- Unset: `offsite=skipped`, pings `/start` then success, exit 0. Half a configuration (only a recipient): refused before backing up, exit 1.
- Set: the remote held `shark-<time>.db.age` and `.manifest.json.age`; `offsite=uploaded`; healthchecks stand-in got `/start` then success.
- `restore-drill.sh --skip-synthetic --from-offsite <object> --age-identity <key>`, with the full `remote:path` and with `nightly/shark-<time>.db`: `offsite_download=verified`, `drill=passed`, and no decrypted file left in `drill/inbox`. With another key: `age: error: no identity matched`, exit 1, nothing left behind.
- Unreachable remote (WebDAV on a closed port): `offsite=failed`, exit 1, the new local copy kept, a 40-day-old local copy *not* pruned, and `/fail` pinged. Back on the good remote, the upload succeeded and only then were the 40-day-old off-site objects and the old local copy pruned.

The flows that need Docker (the real `pnpm db:backup` in the container, systemd, the restore container) run only in the Pilot stack workflow below.

### CI

The Pilot stack workflow runs the same flow on an Ubuntu 24.04 runner with real Docker, Caddy (`SHARK_DOMAIN=localhost`, using Caddy's own local CA) and systemd. It checks shellcheck, provisioning, HTTPS and the 308 redirect, the empty gym, the nightly unit (`offsite=skipped`), the restore drill, encrypted off-site copies through the nightly unit to an rclone `local` remote with a key generated in the job, a drill from that off-site copy, a forced upload failure that keeps local copies and pings `/fail`, a redeploy whose pre-deploy copy also goes off-site, and a replaced container that still has the gym.

### Hosted: pending

| Check | Result |
| --- | --- |
| `https://<domain>/ready` reports ready with the deployed commit | not run: no server yet |
| Owner signs in at `/admin/` to an empty gym | not run |
| `systemctl start shark-backup` succeeds and healthchecks.io turns green | not run |
| `pull-backup.sh`, then `restore-drill.sh` on the returned copy, passes | not run |
| Off-site upload to a real bucket, then `restore-drill.sh --from-offsite` passes | not run: no bucket or key yet |
| UptimeRobot alert on `docker compose stop app`, and recovery | not run |
| ntfy test message reaches the phone | not run |
