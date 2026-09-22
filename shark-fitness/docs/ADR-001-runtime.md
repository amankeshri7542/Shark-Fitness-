# ADR-001: Single-process Node and SQLite runtime

- **Status:** Accepted for the current alpha/demo runtime
- **Date:** 2026-08-23
- **Decision owners:** Shark Fitness engineering

## Context

The engineering PRD describes Cloudflare Workers, D1, Durable Objects and an
Expo member client. The repository that exists today runs a Hono API in Node
22, uses synchronous `better-sqlite3`, serves two Vite PWAs, fans realtime
events out through an in-process WebSocket hub, and starts background work with
`setInterval` in the API process.

That runtime is useful for a low-cost demo and a small controlled deployment,
but it has materially different failure and scaling properties. Treating it as
if the PRD runtime had already been delivered would hide operational risk.

## Decision

Keep the current runtime intentionally single-instance while the product is in
alpha:

- one Node 22 API process owns the SQLite writer, WebSocket clients and eight
  scheduled jobs;
- the SQLite database lives at the explicit `SHARK_DB` path and uses WAL,
  foreign keys and a busy timeout;
- schema changes remain forward-only and additive;
- the transactional outbox is durable in SQLite and reconnecting clients may
  replay seven days of delivered events;
- delayed automation deliveries and job execution history are durable tables,
  while timers are only wake-up mechanisms;
- authorization and tenant/branch isolation remain application-enforced;
  SQLite provides no row-level security;
- rate-limit counters and live WebSocket connections remain in process;
- `SHARK_DISABLE_JOBS=true` disables all timers on a non-leader process, but it
  is not leader election and does not make multi-instance writes safe.

The member experience remains a PWA. Its supported floor writes use the local
outbox, but bookings and door admission remain online decisions. The physical
door has no offline entitlement cache.

## Consequences

Positive consequences are a small deployment, deterministic local development,
simple transactions for booking/stock/payment invariants, and no external
infrastructure required to exercise the core product.

Constraints are equally explicit:

- do not run two writers against the SQLite file;
- attach durable storage and prove backup restoration before storing real gym
  data;
- a process restart drops live socket connections and in-memory rate counters;
  clients reconnect and replay durable outbox rows;
- timers do not provide high availability, even though job and delivery state
  survives a restart;
- an ephemeral host such as the current free preview is disposable and must
  never hold production data;
- SMS, email, WhatsApp, push, payment, object-storage, error-reporting and OTP
  providers are not supplied by this runtime. Their absence must be reported,
  never represented as success.

## Production exit criteria

Before a real unattended gym depends on this decision, all of the following
must be true:

1. Persistent storage, automated backups and a successfully rehearsed restore.
2. Searchable logs, error reporting and alerts for process, 5xx and failed jobs.
3. Provider adapters with credentials, signature verification, delivery
   evidence and reconciliation for every externally advertised channel.
4. Load tests using realistic member, report, door and automation volumes.
5. A documented recovery procedure for failed migrations and a lost instance.

If horizontal scale becomes necessary, migrate in this order: networked
database and transaction semantics, scheduler leader/lease, shared rate-limit
storage, then a shared realtime bus. The current API and event contracts may be
retained; the persistence and coordination assumptions may not.
