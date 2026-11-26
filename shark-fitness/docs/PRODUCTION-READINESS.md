# Production readiness

What this system genuinely is today, what it is not, and what has to be true
before a real gym trusts it with its members and its money.

Written after the Phase 11–13 pass, against the code rather than against the
plan. Everything below was checked in the source; where a section says
"unverified", that means nobody has run it, and it is written that way on
purpose.

**Scope assumption.** The target is a normal small or medium gym — one to five
branches, hundreds to a few thousand members, a few thousand check-ins a month.
Nothing here recommends architecture for a scale this product does not have.

---

## The short version

| Area | State | Blocking? |
|---|---|---|
| Business logic and authorisation | Strong. More than 1,200 automated tests, including tenant and branch isolation from the outside | No |
| Persistence | SQLite on one disk, private uploads in `SHARK_MEDIA_DIR` beside it. Nightly backups (database plus a checksummed media archive), optional age-encrypted off-site copies and restore drills are scripted (`deploy/pilot/`); no server, bucket or key exists yet | **Yes** until off-site copies are configured and drilled |
| Entry and classes | Rotating single-use QR pass on the member's phone, scanned at reception (camera, USB scanner or typed code) through the same decision as the door; waitlists whose offers hold the seat; sellable credit packs with a refund policy | No |
| Private media | Progress photos on the API host's disk behind a storage port; five-minute signed links re-checked per request; metadata stripped; no object storage adapter yet | No, at one server |
| Payments | Razorpay in **test mode** (checkout, plan purchase, payment links, provider refunds, signed webhooks, reconciliation); live keys refused by config. Desk payments are still recorded, not taken | **Yes** until Razorpay KYC and a reviewed live-mode change |
| Scaling | Single instance only, by design and by constraint | No, at this size |
| Realtime | In-process WebSocket fan-out, lost on restart | No |
| Scheduler | In-process timers, one set per instance | **Yes** if ever scaled |
| Observability | Structured logs, error reporting (Sentry-protocol DSN, JSON endpoint or console) from the server, the scheduler, process crash handlers and both apps, Prometheus `/metrics`, written alert rules. No collector or alert account is configured | **Yes** until a destination is configured |
| Secrets | Every variable the API reads is declared and validated at boot | No |
| Rate limiting | In-memory, endpoint-sensitive IP/actor/tenant budgets | Partially |
| Migrations | Forward-only, additive, tested; CI fails on schema drift | No |

**External blockers.** Razorpay KYC and live keys (the integration runs in test mode); a
configured error-reporting and alerting destination; and an off-site backup
bucket with an age key whose private half the owner keeps. The code and scripts
for all three are in the repository (November 2026); none has been connected to
a real account, and no hosted restore drill has run.

---

## 1. Persistent database

**What it is.** SQLite via `better-sqlite3`, one file at `SHARK_DB`
(`data/shark.db`), WAL journal, `foreign_keys = ON`, `busy_timeout = 5000`.
`transact()` in `db/client.ts` is the single concurrency authority: booking
capacity, stock movements and payment idempotency all serialise through it.

**Why that is defensible here.** A gym of this size writes perhaps a few
thousand rows a day. SQLite handles that on a laptop. The schema is D1-shaped
so the port to a hosted SQLite is a migration-runner change rather than a
rewrite. The deviation is noted in `db/client.ts`.

**What remains operational work.**

- **Repository tooling exists.** `pnpm db:backup` uses SQLite's online backup
  API, timestamps the result, runs `integrity_check`, and writes a sidecar
  manifest with size and SHA-256. `pnpm db:restore -- <backup>
  <separate-target>` verifies that manifest, refuses the backup itself as a
  target, stages and integrity-checks the restored copy before replacement,
  and refuses to overwrite by default. `pnpm db:backup:verify` proves migrate → seed → representative
  audit/ledger writes → backup → restore → migrate, checks immutable rows and
  counts, boots the restored API, signs in, and completes an authenticated
  read.
- **Private media is part of every backup (P05).** `pnpm db:backup` archives
  `SHARK_MEDIA_DIR` (else `media/` beside the database) as
  `<copy>.media.tar` and lists every file's SHA-256 in the manifest (version
  2). `pnpm db:restore` checks the archive and each file before anything
  moves, restores media into `SHARK_MEDIA_DIR` only when the target is
  `SHARK_DB` (any other target, such as a scratch or drill copy, gets `media/`
  beside it, so the live photos are never touched), and refuses to overwrite a non-empty media directory
  without both destructive flags. `pnpm db:backup:verify` restores media too,
  compares it with the snapshot and with the `media_objects` checksums, and
  proves a tampered archive is refused. A photo uploaded between the database
  snapshot and the archive restores as an orphan file, which is harmless. A
  photo deleted (by the member, the retention purge or an erasure) in that
  same window restores as a live row without its file; the restore drill
  reports it as a missing media file. Re-run the backup if a drill fails that
  way.
- **No point-in-time recovery.** WAL gives crash consistency, not history. A
  bad migration or a wrong `DELETE` is permanent.
- **The file must be on a real disk.** On a platform with an ephemeral
  filesystem the database is lost on every deploy. `render.yaml` must attach a
  persistent volume; the free tier does not.

**Scheduled and off-site (pilot host).** `deploy/pilot/backup.sh` runs nightly
from a systemd timer and before every deploy, proves each copy restores, and,
when `SHARK_BACKUP_OFFSITE_REMOTE` and `SHARK_BACKUP_AGE_RECIPIENT` are set,
encrypts the copy and its manifest with `age` and uploads them with `rclone`
to any object store. Off-site retention is pruned only after a successful
upload; a failed upload keeps every local copy and pings healthchecks.io's
`/fail`. `restore-drill.sh --from-offsite` downloads, decrypts, checks and
boots a copy without touching the live app. The Pilot stack workflow runs all
of this on a real Docker host against an rclone `local` remote.

**Before production:** create the bucket and the age key, keep the private key
off the server (PILOT-HOSTING.md "Key custody"), and run the off-site drill on
the real host. Recovery point is one day; Litestream remains the option if
that is too much to lose.

---

## 2. Backups and recovery

Run `pnpm db:backup:verify` after dependency or SQLite upgrades. To restore a
real backup, first use a separate target and validate it; replacing an existing
file requires both `--replace` and `--yes-replace`.

The `.db` artifact, its `.manifest.json` sidecar and (when the gym has
uploads) its `.media.tar` archive go off-site, each encrypted to the owner's
age public key, so the storage provider holds only
ciphertext and a stolen server credential cannot read old copies. A checksum
detects corruption or accidental replacement; it is not an authenticity
signature and does not replace storage access controls, object lock or
versioning, which should be turned on at the bucket.

**Retention.** PRD 02 requires backups to follow the same deletion and
retention commitments as live data. An erased member stays in copies taken
before the erasure until they age out: 14 days on the server and 30 days
off-site by default (`SHARK_BACKUP_KEEP_DAYS`, `SHARK_BACKUP_OFFSITE_KEEP_DAYS`).
The privacy notice must state that window, and after a full restore every
erasure completed after the copy's timestamp is applied again before the gym
reopens (PILOT-HOSTING.md).

---

## 3. SQLite assumptions the code actually makes

These are load-bearing and would each break under a client/server database:

- **One writer.** `transact()` is synchronous and the process is single-node.
  The last-seat booking claim, the stock ledger and `idempotency_keys` all
  assume no second process is writing. Postgres would need `SELECT … FOR
  UPDATE` or serialisable transactions at those three sites.
- **Synchronous drivers.** `better-sqlite3` is blocking. Every handler is
  written as straight-line synchronous code. A network database would make all
  of it async — a mechanical change, but it touches every service.
- **`json_extract` and JSON columns.** Product snapshots, policies, feature
  flags and template variables are JSON text. Portable, but not indexable the
  way a `jsonb` column would be.

None of this is wrong for the target size. It is written down so nobody
discovers it during an incident.

---

## 4. Horizontal scaling

**Not supported. One instance only.** Three things break with a second:

1. **Writes.** Two processes cannot share a SQLite file safely under load.
2. **The scheduler.** `startScheduler()` runs `setInterval` per process, so
   two instances run every job twice — including the automations job, which
   sends messages. The partial unique index on `automation_runs` means the
   second one loses at the insert rather than double-messaging anybody, which
   is a real safety net, but the other jobs have no such guard.
3. **Realtime.** Clients are held in an in-process `Set`. Two instances mean a
   member connected to A never sees an event emitted on B.

**At this size that is fine.** One instance with a few hundred concurrent
members is not close to a limit. Vertical scaling covers a long way. If a
second instance is ever needed, the order is: move to a networked database,
elect a scheduler leader, move realtime to a shared bus.

---

## 5. Realtime transport

`ws` WebSocket server on `/v1/realtime`, authenticated by a one-use ticket
(`lib/realtime-ticket.ts`) rather than by putting a session token in a URL.
Subscriptions are checked against the caller's tenant, branches and member id,
so a client cannot subscribe to a channel it has no claim on.

**Limits.** In-process only. No reconnect backoff on the server side; the
client reconnects and replays from a sequence number, which covers a dropped
connection but not a restart with a cold outbox. Delivered `outbox_events` are
retained for the reconnect window and then pruned while preserving the latest
sequence high-water row, so a restart cannot reuse a cursor.

---

## 6. Scheduler behaviour

Twelve jobs on `setInterval`, unref'd, started in `server.ts`:

| Job | Every |
|---|---|
| `deliver-automation-queue` | 1 min |
| `run-automations` | 1 hour |
| `expire-memberships` | 6 hours |
| `roll-up-metrics` | 6 hours |
| `close-stale-check-ins` | 30 min |
| `expire-waitlist-offers` | 1 min (a lapsed offer releases its held seat and offers it to the next eligible member) |
| `release-expired-holds` | 1 min |
| `run-dunning` | 15 min |
| `extend-class-series` | 6 hours |
| `prune-operational-data` | 24 hours |
| `reconcile-payments` | 6 hours |
| `purge-withdrawn-photos` | 1 hour (destroys progress photos whose consent was withdrawn longer ago than the retention setting) |

**Every job runs on every instance.** There is no lock and no leader election.
With one instance that is correct and simple. `SHARK_DISABLE_JOBS=true` turns
them off, which is what a second instance would need.

Two of the ten are safe under a second instance by construction rather than by
luck. `extend-class-series` dedupes on a partial unique index over
`(series_id, occurrence_date)`, so a duplicate run loses at the index instead of
producing a second Tuesday. `run-dunning` claims each step with a conditional
update before doing any work, with a five-minute lock timeout so a worker that
dies holding a step does not strand the sequence — which matters more there than
elsewhere because the work sends a message to a member.

Each execution writes a durable `job_runs` record with start, finish, outcome,
duration, bounded safe summary, error category/message and build identifier.
Platform health reports the last success, last failure, next expected time and
`healthy`/`stale`/`failing`/`never`/`disabled` state; a historical success no
longer means the scheduler is healthy forever.

---

## 7. Payment integration

**Razorpay is integrated in test mode** (November 2026, phase P02;
docs/PAYMENTS-RAZORPAY.md, ADR-003). It is a blocker only until the gym goes
live: config refuses any key id that does not start `rzp_test_`.

- **Members** pay open invoices and buy or renew plans in the app through
  Razorpay Checkout (loaded on demand from `checkout.razorpay.com`). The
  browser's success callback is verified (HMAC on our order id) and the payment
  is then fetched server-to-server; only a captured payment settles.
- **Webhooks** (`POST /v1/webhooks/razorpay`) are verified over the raw body,
  stored in `provider_events` before processing, idempotent per event id, and
  safe in any delivery order. Unknown events are stored and acknowledged.
- **Settlement** uses the single existing path (receipt, dunning stop,
  membership activation, audit as `system:razorpay`, realtime) at most once per
  Razorpay payment (unique index). Amount or currency mismatches and payments for
  already-settled invoices never settle; they become reconciliation exceptions.
- **Refunds** of online payments go through Razorpay with an idempotency key and
  stay pending until `refund.processed`; desk payments keep the manual path.
- **Payment links** for open invoices are created with Razorpay notifications
  off; staff copy and share them.
- **Reconciliation**: the `reconcile-payments` job (every 6 h, `job_runs`) settles
  what webhooks missed and records mismatches; staff resolve them with a reason
  in Billing → Reconciliation.
- No provider call ever runs inside a database transaction (enforced and tested).
- Without the Razorpay variables the system behaves exactly as before: payments
  are recorded, member checkout answers 412.
- **Still not built:** stored cards, mandates (UPI Autopay / eMandate) and
  automatic renewal collection. Dunning reports `no_stored_mandate` with a
  provider and `no_payment_provider_configured` without one, and the console
  never offers a retry that cannot happen. Drop-in class fees are still
  collected at reception.

**To go live:** see the checklist in docs/PAYMENTS-RAZORPAY.md (KYC, live keys
in the secret store, a reviewed code change to allow them, a live webhook, one
real low-value payment and refund, accountant sign-off, alerts, CSP).

---

## 8. Offline and access control

The door is **online-only**. `POST /door/scan` verifies a signed pass against
the database: it reads the membership, the outstanding balance, the branch
hours, the occupancy and the anti-passback window. With the network down, the
turnstile fails closed and nobody gets in.

For a gym with staffed reception that is an inconvenience. For a 24-hour
unstaffed site it is a business-stopping failure, and this product should not
be sold into one without an offline path — a reader with a cached entitlement
list and a reconciliation queue, which does not exist.

Pass tokens are HMAC-signed with `SHARK_PASS_SECRET`, single-use
(`used_access_windows` with a unique constraint), and rotate on a window. That
part is sound.

**Reception scanning (P05).** The member app shows the token as a real QR code
(ECC M, quiet zone, dark on light in both themes) that rotates every 30
seconds, a little before each window ends, read through the server's clock.
`POST /v1/admin/attendance/scan` runs the door's own decision for a member of
staff: signature, single-use window, tenant (`denied_wrong_tenant`), expiry
(`denied_token_expired`), branch entitlement, hours, capacity,
anti-passback and outstanding balance; a member already inside reads
"Already checked in" with no second visit. Every scan is audited, idempotent
and updates occupancy. The console uses the camera (BarcodeDetector, else
`jsqr` loaded on demand), a USB keyboard-wedge scanner or a typed code;
`Permissions-Policy: camera=(self)` is sent only for `/admin/` documents.
Offline, the member's pass shows their member number for reception to type.
The same online-only caveat as the door applies: with the API unreachable,
nobody is admitted by scan.

**Waitlists (P05, decision 12).** An offer holds the seat: it counts in
`class_sessions.booked` and in the database triggers that refuse more live
bookings plus live offers than capacity. The offer lasts until the earlier of
`waitlistOfferMinutes` (30) and `waitlistOfferCutoffMinutes` (60) before class,
both branch-overridable. A capacity cut below the people booked cancels nobody
and raises an `overbooked_class` dashboard alert until someone moves people.

---

## 9. Logging and observability

**Logs.** Every request emits one JSON line with request ID, method, route
template, status, duration, release and safe tenant/branch/actor identifiers;
warnings over 400 ms, errors on 5xx. Scheduler runs carry the job name and a
durable run id. Every request has an `x-request-id`, also written into
`audit_log`. No request bodies, cookies, passwords, tokens, OTPs or contact
fields appear in any structured record.

**Error reporting.** `SHARK_ERROR_REPORTER` (`auto` by default) chooses
`sentry` (`SHARK_ERROR_DSN`, the Sentry envelope protocol over `fetch` with no
SDK, so Sentry, GlitchTip or a self-hosted collector work), `http`
(`SHARK_ERROR_REPORTING_ENDPOINT`, e.g. a private ntfy topic), `console`
(development default) or `none` (tests, and production with nothing
configured). Reports carry the error type, redacted message and stack frames,
release, environment, request id, route and tenant/actor ids only, are capped
at 60 a minute, and the boot log names the reporter. Sources:

- unexpected 5xx errors in request handlers;
- scheduler job failures, reported once and tagged with the job;
- `unhandledRejection` (logged and reported, the process keeps serving) and
  `uncaughtException` (reported, flushed for up to 2 s, then exit 1 in
  production so Docker restarts it; development only logs);
- both browser apps: `error`/`unhandledrejection` listeners and a top-level
  error boundary post to `POST /v1/client-errors` (public, known Origin only,
  8 KB, Zod-validated, 30/min per IP and 300/min per tenant, redacted), once
  per error fingerprint per session. The person sees a plain "Something went
  wrong." screen with Reload and a reference that matches the report.

**Metrics.** `GET /metrics` (Prometheus text) exists only when
`SHARK_METRICS_TOKEN` is set, behind that bearer token: request counts by route
template and status, a duration histogram, job runs and last success per job,
undelivered outbox events, database size, free space on the data disk, and
process CPU and memory. No label carries an id or personal data.

**Alerting.** `docs/OPERATIONS-ALERTS.md` defines nine rules (readiness, 5xx
rate, new errors, failing and stale jobs, missed backups, disk, memory,
outbox) mapped to the pilot's UptimeRobot, healthchecks.io, ntfy/Sentry and
DigitalOcean Monitoring, with Prometheus rules for when a scraper exists.

**Before production:** configure an error destination and the alert accounts,
test each channel as the alerts document describes, and ship stdout somewhere
searchable. Nothing pages anybody until that is done.

---

## 10. Rate limiting

`rateLimit(max, windowMs)` in `middleware/index.ts` has endpoint-sensitive
budgets. It uses a trusted-proxy hop count and the direct socket address rather
than accepting the leftmost client-supplied `x-forwarded-for` value.

Auth flows retain tight budgets. Protected API routes also have outer IP,
tenant and actor budgets. Door scans, report computation/export, retention,
support writes, member messages, directory/attendance search, automation
preview and manual runs have separate actor and tenant ceilings.

**It is in-memory.** The bucket `Map` is per-process and lost on restart, so a
deploy resets every counter. With one instance that is a minor weakness; with
several it would be useless.

The limiter remains process-local, so it is an appropriate single-instance
safeguard rather than distributed DDoS protection.

---

## 11. Idempotency

The strongest part of the system, and the one most likely to be got wrong
elsewhere.

- `runIdempotently()` stores the response against a key and replays it, so a
  retried write returns the first answer rather than performing twice.
- The console mints one key per logical attempt and holds it across retries —
  fixed at all 16 write sites in an earlier pass.
- Three database-level guards back it up where money or a seat is at stake:
  `bookings_live_uq` (one live booking per member per session),
  `automation_runs_sent_uq` (one send per logical event) and the class capacity
  trigger — joined by `class_sessions_series_occurrence_uq` (one occurrence per
  series per branch-local date), `commission_lines_source_uq` (one accrual per
  source transaction, with the partial clause that lets corrections exist) and
  `dunning_attempt_uq` (one row per invoice per dunning step).

Operational idempotency evidence is retained for its documented window and
then pruned in bounded batches. Audit, accounting, consent and ledger history
are explicitly excluded from pruning.

---

## 12. Secrets and configuration

Read from the environment, with `.env.example` as the reference.

`src/lib/config.ts` validates the shared API configuration before the
application graph opens SQLite or registers static serving. Booleans accept
only the exact strings `true` and `false`; ports, reader JSON and exact browser
origins are parsed once and shared by every consumer.

Every variable the API reads is declared in one Zod schema there, including
the sign-in-code providers and their credentials, the OTP send limits, the
error reporter, its DSN and the metrics token. A unit test fails if any file
under `apps/api/src` reads `process.env` outside `lib/config.ts`, or if a
declared variable is missing from `.env.example`. A provider selected without
its credentials, an unknown provider or reporter name, a non-numeric OTP limit
or a malformed DSN is refused in every environment.

Production additionally requires an explicit database path, a pass secret of
at least 48 bytes and at least one configured public/allowed/platform origin,
an HTTPS error DSN, and a metrics token of at least 32 characters when one is
set.
Origins and the optional error collector must use HTTPS except for explicit
loopback smoke tests. OTP echo and bearer-session compatibility are refused,
not silently enabled, in production. Operational retention/prune settings are
bounded and parsed here as well. A bad deployment exits at boot instead of
failing on its first door scan or browser request.

---

## 13. Error handling

Good. One `AppError` type with a code that maps to a status, one envelope with
a request id, and a handler that turns unknown throws into a 500 without
leaking the message. Zod failures become 422 with field paths. Capacity and
unique-constraint failures are translated into their business meaning.

The console never renders a failed read as a zero — a rule Reports enforces
explicitly, because "revenue this month: ₹0" over a failed query is worse than
an error.

---

## 14. Migrations

Eighteen migrations (0000–0017), forward-only, generated by drizzle-kit,
checked in with their snapshots. `drizzle.config.ts` lists all eight schema
files, the snapshot chain reaches the latest migration, and CI runs
`pnpm -F @shark/api db:check-drift`, which fails if `drizzle-kit generate`
against a scratch database would write anything. A unit test keeps the config
list equal to the schema barrel and the snapshot chain equal to the journal. Every one of them is additive, and that is enforced by reading
the generated SQL rather than assumed: drizzle proposed a table rebuild for the
commission change whose `INSERT…SELECT` named the new columns while reading the
old table, which would have failed on any database with rows in it. The trigger
was a column default nothing reads, so the default stayed and the migration is
eight `ADD COLUMN`s.

`migrate.ts` applies extras drizzle cannot express — the append-only triggers
on `audit_log`, `xp_ledger`, `stock_ledger` and `ticket_events`, the capacity
guard, and the two partial unique indexes — idempotently, after the generated
files.

**No down migrations.** Rolling back a deploy does not roll back the schema.
With additive-only changes that is usually survivable; it is a real constraint
and it is why every migration so far has been additive on purpose.

---

## 15. Performance

Measured with the repeatable `pnpm perf:baseline` production-HTTP harness at
5,000 members across three branches. Post-optimization p95 results on the
recorded Node 22 darwin-arm64 run were: dashboard 11.68 ms, directory 8.11 ms,
member detail 3.47 ms, retention 9.18 ms, revenue 15.96 ms, attendance 17.07 ms
and automation planning 71.81 ms.

The first evidence run found attendance at 190.09 ms p95 and automation
planning at 304.93 ms p95. Reusing pure `Intl` timezone formatters reduced the
attendance CPU path; batching automation dedupe/account/consent facts removed
up to 10,000 per-candidate reads. Query plans already used the intended
membership, attendance and partial dedupe indexes, so no speculative index or
business-data cache was added. Full method, dataset, before/after numbers and
limitations are in `docs/PERFORMANCE-BASELINE.md`.

---

## What is genuinely production-grade

Worth saying plainly, because the list above is all caveats:

- **Tenant and branch isolation**, tested from the outside by a second seeded
  tenant and by roles that must be refused. Cross-tenant reads exist in one
  file.
- **The authorisation model** — permission, then tenant, then branch, then
  entitlement — applied consistently, with detail endpoints scoped as hard as
  their lists.
- **Impersonation containment**: borrowed authority that cannot re-enter
  platform tooling, cannot chain, and expires on a clock it cannot extend.
- **Append-only ledgers** enforced by triggers that do not check who is asking
  (audit, XP, stock, ticket events and, since P05, class credits).
- **Money**: integer minor units, per-line tax, currency stored per invoice,
  refunds as compensating entries, never summed across currencies.
- **The audit trail**: every write, with actor, role, branch, request id and a
  field-level diff.

---

## Recommended order

1. **Create the off-site bucket and the age key**, set the two backup
   variables, and run `restore-drill.sh --from-offsite` on the real host; then
   own a monthly drill. The scripts are done; local copies alone are not
   backups.
2. **Connect an error destination and the alert accounts**
   (docs/OPERATIONS-ALERTS.md) and test each channel. The reporting, metrics
   and rules exist; nobody is alerted until operations connects them.
3. **Take Razorpay live** when the gym is ready (KYC, live keys, the reviewed
   config change; docs/PAYMENTS-RAZORPAY.md). Test mode is integrated and
   tested; recorded desk card payments are still not charges.
4. **Run the performance harness on the intended persistent disk** and retain
   results before onboarding each materially larger gym.
5. **Add scheduler leadership and a shared database only before a second
   instance is introduced.** The current architecture remains explicitly
   single-instance.
