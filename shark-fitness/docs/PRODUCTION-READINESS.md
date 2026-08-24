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
| Business logic and authorisation | Strong. 1,125 automated tests, including tenant and branch isolation from the outside | No |
| Persistence | SQLite on one disk. No backups configured | **Yes** |
| Payments | No real provider. Cash and card are recorded, not taken | **Yes** for card |
| Scaling | Single instance only, by design and by constraint | No, at this size |
| Realtime | In-process WebSocket fan-out, lost on restart | No |
| Scheduler | In-process timers, one set per instance | **Yes** if ever scaled |
| Observability | Durable scheduler runs plus `console.log`; no metrics, no traces, no alerting | **Yes** |
| Secrets | Canonical boot-time production validation | No |
| Rate limiting | In-memory, endpoint-sensitive IP/actor/tenant budgets | Partially |
| Migrations | Forward-only, additive, tested | No |

**Three blockers.** Backups, a payment provider where cards are accepted, and
somewhere for errors to go. Everything else is either fine at this size or a
known trade-off with a written reason.

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

**What is missing, and it is the first blocker.**

- **No backups.** There is no dump, no snapshot, no restore procedure and no
  test that a restore works. One disk failure loses every member, invoice and
  audit row. This is the single largest risk in the system and it is a
  configuration problem, not a code problem.
- **No point-in-time recovery.** WAL gives crash consistency, not history. A
  bad migration or a wrong `DELETE` is permanent.
- **The file must be on a real disk.** On a platform with an ephemeral
  filesystem the database is lost on every deploy. `render.yaml` must attach a
  persistent volume; the free tier does not.

**Before production:** a scheduled `VACUUM INTO` to object storage every hour,
a documented restore, and a restore actually performed once against a copy.
Litestream is the usual answer for SQLite and would give continuous replication
for near-zero effort.

---

## 2. Backups and recovery

Nothing exists. See above. The order of work is: take a backup, prove you can
restore it, then automate it — in that order, because an automated backup
nobody has restored is a belief rather than a backup.

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

Eight jobs on `setInterval`, unref'd, started in `server.ts`:

| Job | Every |
|---|---|
| `deliver-automation-queue` | 1 min |
| `run-automations` | 1 hour |
| `expire-memberships` | 6 hours |
| `roll-up-metrics` | 6 hours |
| `close-stale-check-ins` | 30 min |
| `expire-waitlist-offers` | 1 min |
| `release-expired-holds` | 1 min |
| `prune-operational-data` | 24 hours |

**Every job runs on every instance.** There is no lock and no leader election.
With one instance that is correct and simple. `SHARK_DISABLE_JOBS=true` turns
them off, which is what a second instance would need.

Each execution writes a durable `job_runs` record with start, finish, status,
duration and error. Platform health derives `overdue` from each job’s cadence,
and shows intentionally disabled jobs as `disabled`; a historical success no
longer means the scheduler is healthy forever.

---

## 7. Payment integration

**There is no payment provider.** This is the second blocker.

- Payments are **recorded**, not taken. `POST /billing/invoices/:id/payments`
  writes a row saying cash or card was received. Nothing is charged.
- `POST /billing/webhooks/demo` is a **simulator**, explicitly named so in the
  source. It exists to exercise dunning and provider-event handling.
- `payments.provider` is null everywhere. `provider_events` has the right shape
  for real webhooks and has never seen one.
- No stored cards, no mandates, no auto-renewal collection. A membership that
  says `autoRenew: true` renews the *record*, not the charge.

**What is genuinely built** and would survive a real integration: the invoice
and refund model, per-line tax, mixed tender, idempotency on the write path,
the dunning attempt ledger, and a grace period the door reads. Adding a
provider is an adapter and a webhook verifier, not a redesign — but until it
exists, this system cannot take money.

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

---

## 9. Logging and observability

**Durable job history plus `console.log`, but nothing else.** This is the third
blocker.

- One line per request with method, path, status and duration; warnings over
  400ms; errors on 5xx.
- Every request carries an `x-request-id`, and it is written into `audit_log`.
  That is genuinely useful and is the one thread that ties a user report to a
  server event.
- **No metrics.** No request rate, error rate, latency percentiles, database
  size, queue depth.
- **No error reporting.** An unhandled 500 prints to stdout. If nobody is
  tailing it, nobody knows.
- **No alerting.** Nothing pages anybody, ever.

The audit log is strong and is not a substitute: it records what people did,
not what the system did to itself.

**Before production:** ship stdout somewhere searchable, add error reporting
(Sentry or equivalent) with the request id attached, and alert on 5xx rate and
on the process being down. That is a day of work and it is the difference
between finding out from a graph and finding out from a member.

---

## 10. Rate limiting

`rateLimit(max, windowMs)` in `middleware/index.ts` has endpoint-sensitive
budgets. It uses a trusted-proxy hop count and the direct socket address rather
than accepting the leftmost client-supplied `x-forwarded-for` value.

Auth flows retain tight budgets. Protected API routes also have outer IP,
tenant and actor budgets, while door scans and manual automation runs have
their own lower ceilings.

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
  trigger.

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

Production additionally requires an explicit database path, a pass secret of
at least 48 bytes and at least one configured public/allowed/platform origin.
Origins must use HTTPS except for the explicit loopback smoke-test case, and
OTP echo is refused rather than silently ignored. A bad deployment now exits
at boot instead of failing on its first door scan or browser request.

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

Seven migrations, forward-only, generated by drizzle-kit, checked in with their
snapshots. The final hardening migration is additive: it adds durable delivery
and job history, retention indexes, delivery idempotency, and append-only stock
delete protection without rewriting existing business records.

`migrate.ts` applies extras drizzle cannot express — the append-only triggers
on `audit_log`, `xp_ledger`, `stock_ledger` and `ticket_events`, the capacity
guard, and the two partial unique indexes — idempotently, after the generated
files.

**No down migrations.** Rolling back a deploy does not roll back the schema.
With additive-only changes that is usually survivable; it is a real constraint
and it is why every migration so far has been additive on purpose.

---

## 15. Performance

Not measured. No load test has been run, so anything here is an estimate from
reading the code.

**Known hot spots:**

- **Retention risk** recomputes over every check-in, payment and membership of
  every member in scope. Fine at 40 members, visibly slow at 5,000.
- **Automation planning** loads the whole audience and runs a per-subject
  consent and dedupe query. At a few thousand members that is a few thousand
  small reads per run, hourly.
- **`branchPolicy()`** reads the tenant and branch rows on every call, and the
  door calls it twice per scan. Two indexed reads on tiny tables — deliberate,
  because a cached anti-passback window is worse than a fast one.
- **Reports** are backed by `metric_rollups` for completed days and recompute
  only the current day. This is the one place performance was designed in.

**Before production:** run the seed at 5,000 members and time the dashboard,
the member directory and a retention read. Nothing above needs fixing until
those numbers exist.

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
- **Append-only ledgers** enforced by triggers that do not check who is asking.
- **Money**: integer minor units, per-line tax, currency stored per invoice,
  refunds as compensating entries, never summed across currencies.
- **The audit trail**: every write, with actor, role, branch, request id and a
  field-level diff.

---

## Recommended order

1. **Backups.** `VACUUM INTO` on a timer, restore proven once. Half a day.
2. **Environment validation at boot.** An hour.
3. **Error reporting and log shipping**, with the request id attached. A day.
4. **A payment provider**, if the gym takes card. A week, plus their review.
5. **Job run records**, so a stopped scheduler is visible. Half a day.
6. **Prune `idempotency_keys` and delivered `outbox_events`.** An hour.
7. **Rate limits beyond auth**, per-tenant. A day.
8. **A load test at 5,000 members**, then optimise what it finds. Two days.

Items 1–3 are the difference between "a demo that works" and "a system a gym
can run on". Item 4 is the difference between running a gym and running its
membership records.
