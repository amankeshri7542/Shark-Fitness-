# Shark Fitness
## Engineering and Technical Product Requirements Document

## Document governance

**Status:** Normative build specification  
**Version:** 2.0  
**Last reviewed:** 6 August 2026  
**Product:** Shark Fitness, multi-tenant gym management and member engagement SaaS  
**Primary surfaces:** Admin Web Dashboard, Member Mobile App, responsive trainer workflows, SaaS Super Admin  

### Requirement language

- **MUST / SHALL:** mandatory for production acceptance.
- **SHOULD:** expected unless an Architecture Decision Record documents a justified exception.
- **MAY:** optional or tenant-configurable.
- A feature is not complete because a screen exists. Completion requires authorization, validation, persistence, error states, auditability where applicable, analytics, tests, and documentation.

### Cross-document precedence

When requirements conflict, agents SHALL apply this order:

1. **Enterprise/Compliance PRD** for law, privacy, security, retention, audit, accessibility, and operational controls.
2. **Engineering/Technical PRD** for architecture, contracts, data integrity, concurrency, deployment, and testing.
3. **Design/UIUX PRD** for interaction, navigation, visual hierarchy, responsive behavior, accessibility implementation, and states.
4. **Product/Functional PRD** for business scope, roles, workflows, product rules, and outcomes.

No agent may silently resolve a contradiction. It must cite the requirement IDs, select the higher-precedence rule, and record the decision in an ADR or product decision log.

### Canonical companion files

- [01_Shark_Fitness_Product_Functional_PRD.md](./01_Shark_Fitness_Product_Functional_PRD.md)
- [02_Shark_Fitness_Engineering_Technical_PRD.md](./02_Shark_Fitness_Engineering_Technical_PRD.md)
- [03_Shark_Fitness_Design_UIUX_PRD.md](./03_Shark_Fitness_Design_UIUX_PRD.md)
- [04_Shark_Fitness_Enterprise_Compliance_PRD.md](./04_Shark_Fitness_Enterprise_Compliance_PRD.md)
- [05_Shark_Fitness_Remaining_Implementation_Plan.md](./05_Shark_Fitness_Remaining_Implementation_Plan.md) — build status and the sequenced plan for the phases still outstanding. Subordinate to this registry; where it appears to relax a SHALL, the PRD wins.

### AI-agent execution contract

Every implementation agent SHALL:

1. Read all four PRDs plus current ADRs before changing code.
2. State the requirement IDs being implemented.
3. List assumptions before implementation; assumptions may not override a SHALL requirement.
4. Preserve tenant and branch isolation in every read, write, cache key, event, export, and log.
5. Reuse canonical schemas and enums. Do not create duplicate client-only domain models.
6. Implement loading, empty, error, permission-denied, offline, retry, and destructive-confirmation states where relevant.
7. Add migrations, seed/fixture updates, observability, tests, and documentation in the same change.
8. Run formatting, linting, type checks, unit tests, integration tests, and affected end-to-end tests.
9. Report changed files, verification evidence, unresolved risks, and follow-up work.
10. Never claim compliance, performance, or completion without evidence.


# Purpose

This document defines **how the product is engineered**: architecture, stack, boundaries, data model, APIs, realtime, offline behavior, security implementation, infrastructure, cost controls, quality, and phased agent execution. It is normative for all code and infrastructure changes.

# Normative technology decisions

## Approved baseline stack

| Layer | Decision | Guardrail |
|---|---|---|
| Admin web | React + TypeScript + Vite | Authenticated SPA; public marketing site is separate if added later |
| Mobile | React Native + Expo, New Architecture | Pin one supported Expo SDK/RN release; upgrade on a scheduled branch |
| Web routing/data | TanStack Router + TanStack Query | Router owns navigation; Query owns remote state |
| UI state | Zustand | Ephemeral UI only; no duplicate server cache |
| Forms/contracts | React Hook Form + Zod | Server revalidates every request |
| API | Cloudflare Workers + Hono + strict TypeScript | No business logic in route handlers |
| Database | D1 with SQL migrations and typed repository layer | Shared shard baseline; no direct client access |
| Realtime | Durable Objects + WebSocket Hibernation | D1 is source of record; DO coordinates live state |
| Storage | R2 signed upload/download | Malware/content validation and ownership finalization |
| Async | Cloudflare Queues + Cron Triggers | Idempotent jobs and dead-letter handling |
| Auth | Better Auth on Worker/D1 behind an identity port | Do not implement custom password/token cryptography |
| Enterprise identity | Optional WorkOS/Auth0-style adapter | Tenant-funded SSO/SCIM connection |
| Payments | Razorpay primary for India, Stripe adapter for global | Hosted/tokenized checkout only |
| Video | Managed streaming provider such as Cloudflare Stream | Video never flows through business WebSockets/API |
| AI | Provider abstraction + rules-first domain engine | Structured output, quotas, redaction, evaluation |
| Observability | Structured logs, metrics, traces/error monitoring | Request/event/job correlation IDs |

## Version policy

- `package.json`, lockfile, Expo SDK, React Native, Wrangler compatibility date, database migrations, and provider API versions SHALL be pinned.
- “Latest” is forbidden inside implementation instructions. Agents must use the versions already approved in the repository or create an upgrade ADR.
- Production supports the latest three maintained React Native minor series only when compatible with the selected Expo SDK; the project itself pins one series.
- Dependency upgrades run through a dedicated pull request with changelog review, compatibility tests, bundle/performance comparison, and rollback plan.

## Architectural style

Use a modular monolith at the Worker boundary:

```text
route adapter → authentication/authorization → application service
              → domain rules → repository/provider port
              → event/outbox/audit
```

Modules may not import another module's database tables directly. Cross-module work uses an application service or versioned domain event. This keeps future Rust or Postgres extraction possible without turning the MVP into microservices theatre.

# 7. Technical Architecture

## 7.1 Recommended architecture

```text
Admin Web (React + Vite)
Member App (React Native + Expo)
        │
        ├── HTTPS REST API
        └── Secure WebSocket channels
                 │
        Cloudflare Worker API (Hono + TypeScript)
                 │
     ┌───────────┼────────────┬─────────────┐
     │           │            │             │
    D1      Durable Objects   R2        Queues/Cron
 business   realtime +        media     async jobs
 data       coordination
```

External adapters:

```text
Razorpay / Stripe
Email provider
Expo Push / FCM / APNs
SMS / WhatsApp provider
Cloudflare Stream or another managed video provider
Apple HealthKit / Android Health Connect
Access control vendors
AI provider abstraction
```

## 7.2 Admin Web Stack

- React with TypeScript.
- Vite build system.
- TanStack Router for typed client routing.
- TanStack Query for server state.
- Zustand only for short-lived UI state.
- React Hook Form + Zod.
- Tailwind CSS + shadcn/ui-derived owned components.
- Radix primitives where useful.
- Motion for restrained transitions.
- ECharts or another capable chart library for operational analytics.
- AG Grid Community or TanStack Table depending grid requirements and licensing review.
- PWA support for installability and offline shell.
- Playwright for end-to-end tests.
- Vitest + React Testing Library.

### Why not Next.js for the authenticated dashboard

- The dashboard does not need search-engine rendering.
- A static SPA is cheaper and simpler to deploy.
- API logic remains in a dedicated backend rather than mixed server actions.
- AI agents have clearer boundaries between web, mobile, and backend.
- A separate marketing site can use Next.js later without coupling it to the operations product.

## 7.3 Member Mobile Stack

- React Native + Expo.
- Expo Router.
- TanStack Query.
- Zustand for active-workout UI state and ephemeral preferences.
- Expo SQLite for persistent offline data and mutation outbox.
- React Hook Form + Zod.
- Reanimated and Gesture Handler.
- FlashList for long lists.
- Expo Image.
- Expo Notifications.
- Expo SecureStore for secrets/session material.
- Expo Camera for QR.
- Expo Haptics.
- Expo Video.
- React Native Skia only for signature visualizations.
- Maestro or Detox for device flows, plus unit/component tests.

## 7.4 Backend Stack

### Runtime

- Cloudflare Workers.
- Hono framework.
- TypeScript strict mode.
- Zod or Standard Schema validation.
- OpenAPI generation from route schemas.

### Database

Normative production topology:

- **Control-plane D1:** tenants, subscriptions, feature flags, environment configuration, support authorization, usage meters, and shard routing metadata.
- **Business D1 shard(s):** shared operational data with mandatory `tenant_id` and, where applicable, `branch_id` on every business record. The first commercial deployment uses one business shard; additional shards are introduced through the control-plane routing table.
- **Dedicated enterprise deployment:** a separate Worker and statically bound D1 database or an approved managed Postgres deployment. This is an enterprise add-on, not the default micro-budget topology.

Rationale:

- Cloudflare Worker D1 bindings are deployment configuration. The baseline SHALL NOT assume arbitrary runtime creation and binding of one database per tenant.
- Shared shards keep deployment simple and inside the budget while repository guards, compound indexes, authorization, tests, and audit enforce isolation.
- Sharding and dedicated deployments provide a documented growth path without changing public API contracts.

Trade-offs:

- D1 does not provide Postgres row-level security. Tenant isolation is enforced by server-side authorization and repository APIs that require tenant context.
- Cross-shard analytics require asynchronous aggregation.
- Tenants needing contractual data residency, advanced SQL/BI, larger storage, or dedicated database isolation move to a tenant-funded enterprise deployment.

### Data access

- Drizzle ORM or carefully reviewed SQL query layer.
- Migrations stored in repository.
- Prepared statements.
- Explicit transactions/batches for related writes.
- Required indexes for every high-frequency filter.
- Query metadata monitored for rows read and written.

### Authentication

Recommended default:

- Better Auth hosted inside the Worker environment where compatible, or a thin custom integration if runtime limitations require it.
- Email/password and email OTP.
- Passkeys.
- Two-factor authentication for privileged users.
- Session revocation.
- Device/session list.
- Step-up authentication.

Alternative:

- Managed authentication can accelerate launch but may create recurring per-user costs. Keep auth behind an adapter.

### Media

- R2 for images, PDFs, exercise media, receipts, exports, and attachments.
- Direct signed upload from client.
- Server validates metadata and finalizes ownership.
- Signed download URLs for private objects.
- Lifecycle policies for temporary uploads and expired exports.

### Realtime

- Durable Object per active tenant/branch/class room depending channel.
- WebSocket Hibernation enabled.
- Small event payloads.
- Event sequence and replay window.
- Durable Objects coordinate class capacity and live state; D1 remains system of record for normal business records.

### Background processing

- Queues for notifications, webhook delivery, imports, exports, media finalization, analytics events, and automation actions.
- Cron Triggers for expiry transitions, reminders, risk calculation, report rollups, cleanup, and retries.

## 7.5 Rust usage

Rust is not the default CRUD backend because it would increase deployment and operational complexity without improving the primary bottlenecks.

Use Rust selectively for:

- On-device or server-side pose processing.
- CPU-heavy analytics.
- Specialized recommendation engine.
- Media processing outside managed services.
- High-volume data transformation.

Expose such components behind stable interfaces. Never let a future Rust service leak domain-specific persistence details into clients.

## 7.6 Monorepo

```text
apps/
  admin-web/
  member-mobile/
  api-worker/
  docs/

packages/
  contracts/          # schemas, API types, events
  domain/             # pure business rules
  ui-web/
  ui-mobile/
  design-tokens/
  auth/
  observability/
  test-fixtures/
  eslint-config/
  tsconfig/

infrastructure/
  cloudflare/
  migrations/
  scripts/
```

## 7.7 Architectural boundaries

- Clients never access D1 or R2 credentials directly.
- Domain rules do not import UI frameworks.
- Payment provider code lives behind a payment port/interface.
- Notification channels live behind one notification service.
- AI providers live behind one metered inference service.
- Every cross-module event has a versioned contract.
- Shared package imports follow one direction to avoid circular dependencies.

---


# Tenancy, authorization and identity

## Request context

Every authenticated request SHALL produce an immutable context:

```ts
interface RequestContext {
  requestId: string;
  actorUserId: string;
  actorType: 'member' | 'staff' | 'platform' | 'service';
  tenantId: string;
  branchScopes: string[];
  permissions: string[];
  sessionId: string;
  authStrength: 'single_factor' | 'mfa' | 'step_up';
  supportSessionId?: string;
}
```

Repository functions SHALL require tenant context as an argument. A repository method that can query tenant data without `tenantId` is prohibited except for a documented platform-control-plane function.

## Authorization sequence

1. Verify session/token signature, issuer, audience, expiry, revocation, and device/session status.
2. Resolve tenant membership and account state.
3. Resolve role grants and branch scope.
4. Evaluate resource/action/scope permission.
5. Evaluate record ownership/assignment and sensitive-field policy.
6. Require step-up authentication for refunds, role/permission changes, exports, deletion, support access, and configured high-risk actions.
7. Record denied high-risk attempts with redacted metadata.

## Identity rules

- Email and phone normalization are explicit and locale-aware.
- One platform identity may participate in multiple tenants, but tenant roles and member records remain separate.
- Member and staff profiles may link to the same platform identity only through an explicit supported workflow.
- Session list, revocation, password reset, passkeys, MFA, recovery codes, rate limits, lockout/risk controls, and audit are mandatory.
- Support impersonation uses delegated authorization, never shared passwords or token copying.

# 8. Data Model

## 8.1 Common fields

Most tenant business tables include:

```text
id TEXT PRIMARY KEY
 tenant_id TEXT NOT NULL
 branch_id TEXT NULL
 created_at INTEGER NOT NULL
 updated_at INTEGER NOT NULL
 created_by TEXT NULL
 updated_by TEXT NULL
 version INTEGER NOT NULL DEFAULT 1
 archived_at INTEGER NULL
```

## 8.2 Core domains and entities

### Identity and tenancy

- tenants
- tenant_settings
- branches
- users
- user_profiles
- staff_assignments
- roles
- permissions
- role_permissions
- user_roles
- sessions
- passkeys
- mfa_methods
- consents

### CRM and members

- leads
- lead_activities
- lead_assignments
- lead_stage_history
- members
- member_contacts
- member_tags
- member_notes
- member_documents
- member_relationships
- member_status_history

### Products and billing

- products
- product_versions
- product_entitlements
- memberships
- membership_status_history
- subscriptions
- invoices
- invoice_lines
- payments
- refunds
- payment_attempts
- discounts
- coupons
- credits
- wallet_transactions
- gateway_events

### Attendance and access

- access_credentials
- check_ins
- occupancy_sessions
- access_denials
- kiosks
- access_devices

### Schedule

- class_types
- class_sessions
- recurring_schedules
- bookings
- waitlist_entries
- rooms
- resources
- appointments
- appointment_types

### Training

- exercises
- exercise_media
- exercise_alternatives
- program_templates
- programs
- program_days
- program_exercises
- workout_sessions
- workout_exercises
- workout_sets
- personal_records
- recovery_inputs
- plan_adaptations

### Progress and coaching

- assessments
- assessment_templates
- assessment_responses
- goals
- goal_milestones
- body_measurements
- progress_photos
- habits
- habit_assignments
- habit_logs
- nutrition_goals
- meal_logs
- weekly_check_ins

### Engagement

- challenges
- challenge_participants
- challenge_events
- achievements
- member_achievements
- xp_ledger
- posts
- comments
- reactions
- groups
- group_members
- referrals

### Communication

- conversations
- conversation_members
- messages
- notifications
- notification_deliveries
- templates
- automations
- automation_runs
- tasks

### Operations

- staff_shifts
- staff_attendance
- commissions
- equipment
- maintenance_schedules
- equipment_issues
- facility_tasks
- incidents
- products_inventory
- stock_movements
- pos_orders
- pos_order_lines

### Platform

- audit_logs
- idempotency_keys
- webhook_endpoints
- webhook_deliveries
- feature_flags
- usage_meters
- support_sessions
- import_jobs
- export_jobs
- realtime_events

## 8.3 Data constraints

- Monetary values stored in minor currency units.
- Times stored in UTC; branch timezone retained for presentation and scheduling rules.
- No hard delete for financial/audit records.
- Member deletion anonymizes permissible personal data while preserving legal financial records.
- Every provider event has a unique provider/event key.
- Booking uniqueness protects one active booking per member/session.
- Attendance uniqueness protects duplicate scans within configured interval.
- Workout set IDs are client-generated UUIDs to support offline idempotency.

---


# Data engineering details

## Database conventions

- IDs are UUIDv7/ULID-style sortable opaque strings generated through one shared package.
- External timestamps use RFC 3339 UTC. Database timestamps use integer epoch milliseconds or an explicitly standardized representation.
- Money is integer minor units plus ISO currency code.
- Quantities requiring decimals use fixed-scale integer or documented decimal representation, never binary floating point for money.
- Every mutable aggregate has `version` for optimistic concurrency.
- Financial, audit, XP, stock, and usage ledgers are append-only; correction uses compensating entries.
- Soft archive is distinct from legal anonymization and hard deletion.
- Provider event tables have unique `(provider, external_event_id)` constraints.
- High-frequency indexes begin with `tenant_id` and match actual filter/order patterns.

## Migration rules

- Migrations are forward-only in production; rollback uses a corrective migration unless a deployment is stopped before data writes.
- Every migration is tested against an anonymized-scale fixture and a fresh database.
- Destructive changes use expand/migrate/contract: add new field/table, dual-read/write if required, backfill, verify, switch, then remove later.
- Schema changes include an impact note for D1 rows read/written and database-size growth.
- No agent may edit an already-applied migration.

## Data retention implementation

- Retention policy is stored as data and evaluated by scheduled jobs.
- Legal hold supersedes normal deletion.
- Generated exports use encrypted/private R2 objects with short-lived signed URLs and automatic expiry.
- Anonymization jobs are idempotent, resumable, and produce an evidence report.
- Backups and logs must follow the same deletion/retention commitments within documented technical limits.

## Analytics architecture

- Product events are versioned and sent asynchronously.
- Operational dashboards use materialized aggregate tables updated by queue/cron jobs where transactional scans are expensive.
- Raw sensitive free text, access tokens, payment secrets, exact progress photos, and message bodies are excluded from analytics.
- Metric definitions live in a versioned catalog with owner, formula, dimensions, freshness, and known limitations.

# 9. API and Real-Time Contracts

## 9.1 REST conventions

- Base path: `/v1`
- JSON request/response.
- Zod-validated contracts.
- Cursor pagination.
- RFC 3339 timestamps externally.
- Consistent error envelope.
- Idempotency key for payment, booking, attendance, and offline mutation operations.
- ETag/version for conflict-sensitive updates.

## 9.2 Error envelope

```json
{
  "error": {
    "code": "CLASS_FULL",
    "message": "This class has no available seats.",
    "requestId": "req_...",
    "details": {
      "waitlistAvailable": true
    }
  }
}
```

## 9.3 Example endpoints

```text
POST   /v1/auth/sign-in
GET    /v1/me
GET    /v1/members
POST   /v1/members
GET    /v1/members/:memberId
PATCH  /v1/members/:memberId
POST   /v1/members/:memberId/memberships
POST   /v1/payments/checkout
POST   /v1/webhooks/razorpay
POST   /v1/attendance/check-in
GET    /v1/attendance/current
GET    /v1/classes
POST   /v1/classes/:classId/bookings
DELETE /v1/bookings/:bookingId
POST   /v1/workouts/:workoutId/complete
POST   /v1/sync/mutations
GET    /v1/sync/changes
```

## 9.4 Real-time event envelope

```json
{
  "eventId": "evt_01...",
  "sequence": 18442,
  "type": "CLASS_CAPACITY_CHANGED",
  "tenantId": "ten_01...",
  "branchId": "br_01...",
  "entityId": "cls_01...",
  "entityVersion": 7,
  "occurredAt": "2026-08-06T12:30:00Z",
  "payload": {
    "availableSeats": 2,
    "waitlistCount": 4
  }
}
```

## 9.5 Channels

```text
tenant:{tenantId}
branch:{branchId}
member:{memberId}
class:{classId}
conversation:{conversationId}
admin-alerts:{tenantId}
```

## 9.6 Synchronization strategy

- Optimistic UI for reversible actions.
- Server-authoritative booking, payment, membership, and attendance outcomes.
- Mobile writes to local SQLite before network submission.
- Mutation outbox uses client mutation ID.
- Server records idempotency result.
- Clients save last event sequence.
- Reconnect requests events after sequence.
- If replay window expired, client performs scoped reconciliation.

## 9.7 Conflict rules

- Workout sets: append and deduplicate by UUID.
- Notes: version check; user chooses when conflict matters.
- Membership: server/admin authoritative.
- Booking: serialized server authoritative.
- Payment: provider webhook authoritative.
- Program: published immutable version; edits create new version.
- Progress measurements: append-only with explicit correction record.

---


# API contract catalog

All routes use `/v1`, JSON, Zod validation, structured errors, cursor pagination, request IDs, and explicit authorization.

## Core route groups

```text
/auth/*
/me/*
/tenants/*
/branches/*
/roles/*
/leads/*
/members/*
/products/*
/memberships/*
/invoices/*
/payments/*
/refunds/*
/check-ins/*
/occupancy/*
/classes/*
/bookings/*
/waitlist/*
/staff/*
/exercises/*
/programs/*
/workouts/*
/assessments/*
/progress/*
/habits/*
/nutrition/*
/challenges/*
/community/*
/conversations/*
/notifications/*
/automations/*
/media/*
/pos/*
/inventory/*
/equipment/*
/support/*
/reports/*
/imports/*
/exports/*
/integrations/*
/webhooks/*
/platform/*
```

## Mutation rules

- `Idempotency-Key` is required for payments, refunds, booking, waitlist promotion acceptance, check-in, offline workout sync, stock movement, imports, exports, and provider actions.
- Conflict-sensitive updates require `If-Match`/version or a version field.
- `202 Accepted` is used for queued jobs and returns a job resource.
- Validation errors identify safe field paths and canonical error codes.
- Authorization errors do not reveal whether an inaccessible cross-tenant resource exists.
- List routes have bounded page size and deterministic ordering.

## Error codes

At minimum define stable codes for:

```text
AUTH_REQUIRED, MFA_REQUIRED, FORBIDDEN, TENANT_SCOPE_VIOLATION,
NOT_FOUND, VALIDATION_FAILED, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT,
MEMBERSHIP_INACTIVE, ACCESS_DENIED, CLASS_FULL, WAITLIST_UNAVAILABLE,
BOOKING_WINDOW_CLOSED, PAYMENT_REQUIRED, PAYMENT_PROVIDER_PENDING,
QUOTA_EXCEEDED, OFFLINE_RECONCILIATION_REQUIRED, RATE_LIMITED,
PROVIDER_UNAVAILABLE, EXPORT_TOO_LARGE, UNSAFE_AI_OUTPUT
```

Clients map codes to localized content; they do not parse English messages.

# Realtime and offline synchronization

## Event envelope

```ts
interface RealtimeEvent<T> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  tenantId: string;
  branchId?: string;
  channel: string;
  sequence: number;
  aggregateId?: string;
  aggregateVersion?: number;
  occurredAt: string;
  actorId?: string;
  correlationId: string;
  payload: T;
}
```

## Channels

- `tenant:{tenantId}` for tenant-wide operational events.
- `branch:{branchId}` for occupancy, class, staff, and branch alerts.
- `member:{memberId}` for membership, payment, program, booking, and message events.
- `class:{classSessionId}` for seat, waitlist, live chat, and attendance state.
- `conversation:{conversationId}` for authorized message participants.
- `platform:{scope}` for super-admin operational signals.

## Rules

- D1 is the source of record for durable business state.
- Durable Objects coordinate last-seat allocation, live occupancy fan-out, room state, and WebSocket sequencing.
- Hibernation API is mandatory; no idle polling loop.
- Realtime payloads are small invalidation/patch messages, not complete sensitive records.
- Client reconnect sends the last sequence. Server replays within the retention window or instructs scoped HTTP reconciliation.
- Push notification is a background wake/attention mechanism, not the source of record.

## Mobile offline outbox

Each queued mutation contains:

```text
operationId, idempotencyKey, entityType, entityId,
baseVersion, operationType, payload, createdAt,
attemptCount, lastError, dependencyOperationIds
```

Synchronization sequence:

1. Apply allowed local mutation transactionally in SQLite.
2. Add outbox record and update visible sync status.
3. Send in dependency order when connectivity/session is valid.
4. Server validates authorization, idempotency, base version, and business rules.
5. On success, store authoritative version and remove outbox record.
6. On retryable failure, use exponential backoff with jitter.
7. On conflict, apply domain-specific resolver or show a human reconciliation surface.
8. Never discard unsynced workout data silently.

Domain conflict rules:

- Workout sets: append by client-generated ID; duplicate ID is idempotent.
- Workout metadata: server version with explicit user reconciliation if both changed.
- Booking and capacity: server authoritative.
- Payment and membership: provider/server authoritative.
- Notes: last-write-wins only for explicitly low-risk fields; otherwise version conflict.
- Program assignment: immutable published versions; active workout keeps its snapshot.

# Provider and expensive-feature architecture

## Payments

- Use hosted checkout/tokenization and provider SDK only where required.
- Verify webhook signatures against the raw request body.
- Persist provider event before processing.
- Acknowledge quickly, process idempotently through queue, and record attempts.
- Browser/app redirect is informative; webhook/API verification determines payment truth.
- Reconciliation job compares platform records with provider settlements.

## Notifications

- Notification service accepts purpose, template version, recipient, locale, channel preference, data, priority, and dedupe key.
- Transactional, operational, coaching, and promotional purposes have separate consent rules.
- Provider failures go through bounded retry and dead-letter review.
- Bulk sends calculate recipients and estimated metered cost before activation.

## Media

- Clients request signed upload intent, upload directly to R2/provider, then call finalize.
- Finalize verifies tenant ownership, MIME/type, size, checksum, metadata, and scan/moderation status.
- Private media uses short-lived signed access and authorization before URL issuance.
- Image derivatives and video transcoding are asynchronous/managed.

## AI

- Domain rules generate the training decision. LLMs may explain or summarize it.
- Input builder minimizes and redacts personal data.
- Prompts are versioned assets, not inline strings scattered through code.
- Output uses JSON schema and is rejected on parse/policy failure.
- Evaluation dataset covers unsafe advice, prompt injection, hallucinated exercise, medical claims, extreme nutrition, and privacy leakage.
- Tenant and platform hard budgets fail closed or fall back to deterministic content.

## Live video

- Streaming provider issues ingest/playback identifiers.
- API stores metadata and entitlement; provider delivers media.
- Chat and attendance use normal realtime channels.
- Signed playback tokens are short-lived and tenant/member scoped.
- Delivered/stored minutes are metered before creating future sessions.

# 11. Non-Functional Requirements

## 11.1 Performance targets

### Admin web

- Initial authenticated shell usable in under 2.5 seconds on a typical broadband connection and modern mid-range laptop.
- Route transitions under 200 ms when data is cached.
- Table filtering/sorting remains responsive at normal page sizes.
- Avoid shipping large chart/grid libraries on routes that do not use them.

### Mobile

- Cold start target under 2.5 seconds on representative mid-range Android hardware.
- Primary navigation maintains 60 FPS under normal load.
- Set logging responds within 100 ms locally.
- Check-in success response normally visible within 2 seconds.
- Active workout survives app backgrounding and process restart.

### API

- p50 under 100 ms for cached/simple edge operations.
- p95 under 500 ms for normal CRUD excluding third-party providers.
- p99 errors investigated with request correlation.

## 11.2 Availability and resilience

- Core target: 99.9% monthly availability after commercial launch.
- Graceful degradation when analytics, AI, email, or video provider is unavailable.
- Payment webhooks retry safely.
- Queue dead-letter handling.
- D1 point-in-time recovery runbook.
- R2 lifecycle and backup/export strategy.
- Disaster recovery exercise before broad launch.

## 11.3 Scalability

- Stateless API workers.
- Tenant database routing.
- Horizontal realtime rooms.
- Async report generation.
- Paginated APIs.
- No unbounded list endpoints.
- Aggregate tables for expensive dashboards.
- Feature flags for staged rollout.

## 11.4 Observability

- Structured logs.
- Request ID propagated through API, queue, webhook, and notification.
- Error monitoring.
- Latency and failure metrics by route.
- D1 rows read/written monitoring.
- Queue depth and age.
- Webhook delivery status.
- Notification delivery outcomes.
- Tenant usage and cost estimates.
- Synthetic check-in, booking, and payment-webhook tests.

## 11.5 Localization

- Internationalization-ready from first UI.
- English first.
- Configurable currency, time format, date format, unit system, timezone, tax labels, and phone formatting.
- Translatable notification templates.
- Right-to-left support not required initially but must not be structurally impossible.

---


# 13. Infrastructure Budget and Cost Guardrails

## 13.1 Core low-usage budget

| Service | Purpose | Expected early cost |
|---|---|---:|
| Cloudflare Workers Paid | API, web hosting, Durable Objects baseline | $5/month minimum |
| D1 | Business databases | Included within substantial paid-plan allowances at early scale |
| R2 | Images, files, exports | Free within 10 GB and operation allowance, then usage-based |
| Expo Push | Push orchestration | No direct platform charge for normal use |
| Transactional email | Email | Free tier initially, then usage-based |
| Domain | Dashboard/API hostname | Annual cost, not a monthly runtime service |

## 13.2 Cost model rules

- The base plan must exclude unlimited SMS, WhatsApp, video, and generative AI.
- Each tenant receives quotas.
- Reject or queue actions when hard spending cap is reached according to configured behavior.
- Never silently overrun the platform budget.
- Expose current usage to tenant owner.
- Set Cloudflare account budget alerts.
- Track usage by tenant in the control plane.

## 13.3 Metered add-ons

### Live video

- Sold by stored and delivered minute allowance.
- Cloudflare Stream currently bills stored and delivered minutes separately.
- No unlimited plan while operating under a micro-budget.

### AI

- Monthly credits.
- Rules-first features do not consume LLM tokens.
- Optional BYOK for larger gyms.

### SMS/WhatsApp

- Tenant connects provider or purchases message credits.
- Preview estimated recipient count and cost.

### Storage

- Quota by tenant.
- Compress images.
- Progress-photo retention policy.
- Temporary export expiry.
- Video stored in specialized video service, not casually in R2 without playback strategy.

## 13.4 Commercial recommendation

The product can be developed and piloted on the micro-budget. Once sold, infrastructure should be funded by subscription revenue. A rational commercial price must be based on members, branches, features, and metered add-ons rather than preserving a $15 total platform ceiling forever.

---


# Cost, scale and exit criteria

## Base cost objective

The low-usage shared platform targets approximately $5–$15 monthly fixed infrastructure. The target excludes app-store fees, domains, payment transaction fees, SMS/WhatsApp, large email volumes, live video, paid enterprise SSO connections, and AI beyond included quotas.

## Hard controls

- Per-tenant quota and usage meter for AI, media, storage, messages, exports, and API.
- Provider account budget alerts and application-level hard stop.
- Queue jobs reserve/check quota before provider call.
- Owner-visible usage and forecast.
- No “unlimited” plan for a metered service under this architecture.

## D1/shared-serverless exit criteria

Create an ADR and migrate a tenant/shard to managed Postgres or dedicated infrastructure when one or more are true:

- Contract requires dedicated database or specific data residency unavailable in baseline.
- Database approaches operational size threshold or D1 per-database limit.
- Write contention or transaction semantics cannot be safely modeled.
- Reporting requires advanced SQL/BI patterns that materially harm transactional workload.
- Tenant revenue supports dedicated infrastructure and SLA.
- Compliance agreement requires controls or evidence not available from baseline vendors.

Public API and domain contracts must remain stable during migration. Data-access ports, event outbox, and tenant routing exist specifically to support this exit.

# 14. Quality and Test Strategy

## 14.1 Test layers

- Domain unit tests.
- Schema/contract tests.
- API integration tests.
- Database migration tests.
- Payment webhook fixtures.
- Component tests.
- Web end-to-end tests.
- Mobile device-flow tests.
- Realtime concurrency tests.
- Offline synchronization tests.
- Accessibility tests.
- Visual regression tests for design-system components.
- Load tests for check-in, class booking, and dashboards.
- Security tests and dependency scans.

## 14.2 Mandatory critical test scenarios

- Cross-tenant access attempt.
- Branch permission boundary.
- Duplicate payment webhook.
- Concurrent last-seat booking.
- Dynamic QR replay.
- Offline workout retry.
- Membership freeze and renewal edge cases.
- Refund with partial membership consumption.
- Timezone/DST recurring schedule.
- Member deletion/anonymization.
- Notification opt-out.
- Large import with invalid rows.
- Realtime reconnect and missed-event replay.

## 14.3 Test data

Provide deterministic factories for:

- Tenant and branches.
- Every role.
- Lead stages.
- Member statuses.
- Membership lifecycle.
- Payment states.
- Full and waitlisted class.
- Offline workout.
- At-risk member.
- Multi-branch owner.

No production personal data may be copied into development environments.

---


# Delivery, environments and quality gates

## Environments

- `local`: local emulation and deterministic fixtures; no production credentials.
- `development`: shared integration environment with synthetic data.
- `staging`: production-like provider sandboxes, migrations, load/security/accessibility testing.
- `production`: isolated secrets, billing, domains, alerts, and approval controls.

Production personal data SHALL NOT be copied to lower environments. Provider staging and production credentials are separate.

## CI pipeline

1. Format and repository policy checks.
2. TypeScript strict type check.
3. Lint and dependency boundary check.
4. Unit/domain tests.
5. Contract and schema compatibility tests.
6. Migration test from previous production schema and fresh schema.
7. API integration tests with D1/Worker environment.
8. Web component and accessibility tests.
9. Mobile unit/component tests.
10. Web Playwright critical flows.
11. Mobile Maestro/Detox critical flows on representative devices.
12. Security/dependency/secret scan.
13. Bundle size and performance budget check.
14. Preview deployment and smoke tests.

## Deployment

- Use immutable build artifacts and environment-specific configuration.
- Run backward-compatible database expansion before code that uses it.
- Canary or limited-tenant feature flag for high-risk changes.
- Roll back application code independently where schema remains compatible.
- Post-deploy synthetic tests cover sign-in, member lookup, check-in, booking, workout sync, and webhook health.
- Release notes identify migrations, feature flags, provider changes, and rollback constraints.

## Definition of verified completion

An agent may say “done” only after providing command output or CI links for every applicable quality gate, plus screenshots/video for UI work and request/event evidence for backend/realtime work.

# AI-agent repository and skill requirements

- The repository root SHALL contain `AGENTS.md` with architecture boundaries, commands, quality gates, requirement-ID workflow, and prohibited shortcuts.
- Add tool-specific thin files such as `CLAUDE.md` only to point to the canonical `AGENTS.md`; do not maintain contradictory instructions.
- For Expo/React Native work, install and use the official Expo Skills for AI agents and Expo documentation/MCP integration. Agents must query the pinned SDK documentation rather than guess APIs.
- Use a worktree or isolated branch per phase/agent. One integration owner resolves cross-phase changes and owns migrations/contracts.
- Agents must inspect existing packages and ADRs before adding dependencies.
- UI agents must produce screenshot/video evidence and run device tests; backend agents must show request, database, queue, and event evidence.
- No agent may modify more than one architectural layer merely to avoid understanding an existing contract. Broad refactors require an ADR and dedicated phase.
- Every prompt SHALL name the exact phase, allowed directories, requirement IDs, dependencies, acceptance tests, and out-of-scope work.
- At phase end, a review agent SHALL compare implementation to all four PRDs and report omissions before the next dependent phase starts.

# 15. Phased Delivery Plan and AI-Agent Prompts

The phases below are implementation dependencies, not a reduced MVP scope. The complete product remains the target. Each phase must end with usable software, tests, documentation, and an updated architecture decision record.

## Agent operating rules for every phase

Every agent must:

1. Read this PRD, current repository architecture, domain glossary, and relevant ADRs before editing.
2. State assumptions and identify contradictions.
3. Preserve tenant and branch isolation.
4. Use shared contracts rather than duplicate types.
5. Add migrations, tests, fixtures, observability, and documentation with every feature.
6. Avoid introducing a new dependency when an existing approved dependency is sufficient.
7. Never make payment, authorization, health, or destructive decisions only in the client.
8. Keep UI accessible and responsive.
9. Run lint, type check, unit tests, integration tests, and affected end-to-end tests.
10. Return changed files, architectural decisions, risks, and verification evidence.

## Phase 0: Product Foundation and Design System

### Scope

- Monorepo.
- Shared TypeScript configuration.
- Admin web shell.
- Member mobile shell.
- Worker API shell.
- Shared contracts package.
- Design tokens and component foundations.
- CI checks.
- Local development and seed data.
- ADR template.
- Environment and secret strategy.

### Deliverables

- Working signless shells deployed to development environment.
- Storybook or equivalent component gallery for web.
- Mobile component preview route.
- Light/dark themes.
- Logging and request IDs.
- Basic health endpoint.

### Acceptance

- One command starts core development services.
- Web and mobile consume a shared typed health contract.
- No circular package dependency.
- Accessibility baseline tests run in CI.

### AI agent prompt

> You are the foundation architect for Shark Fitness. Read the full PRD and create Phase 0 only. Establish a pnpm monorepo with admin-web, member-mobile, api-worker, shared contracts, domain, design tokens, test fixtures, and configuration packages. Use React + Vite for admin, React Native + Expo for mobile, Cloudflare Workers + Hono for API, strict TypeScript, Zod contracts, Vitest, Playwright, and appropriate mobile tests. Build accessible light/dark shells and a small owned component system. Add CI, environment validation, structured logging, request IDs, local seed tooling, and architecture documentation. Do not implement business modules yet. Produce an ADR for every material choice, run all checks, and report exact verification results.

## Phase 1: Identity, Tenancy, Branches, and Authorization

### Scope

- Tenant creation.
- Branches.
- User authentication.
- Sessions.
- Passkeys/2FA path.
- Roles and permissions.
- Branch scope.
- Audit log.
- Support impersonation design.

### Deliverables

- Login, logout, recovery, session management.
- Tenant/branch switcher.
- Permission editor.
- API guards.
- Security test suite.

### Acceptance

- Cross-tenant tests fail closed.
- Privileged operations require step-up authentication.
- Audit records include actor and request ID.

### AI agent prompt

> Implement Shark Fitness Phase 1: identity, multi-tenancy, branches, RBAC, and auditability. Treat authorization as a backend concern. Model platform roles, gym roles, custom roles, and branch scopes. Implement secure web and Expo session handling, account recovery, session revocation, passkey-ready authentication, and two-factor enforcement for privileged roles. Add permission-aware navigation but never rely on hidden UI for security. Create comprehensive cross-tenant, cross-branch, privilege-escalation, and audit tests. Document the permission matrix and threat model. Do not implement membership or payment logic.

## Phase 2: CRM, Members, Onboarding, Documents, and Consent

### Scope

- Leads and sales pipeline.
- Member records.
- Timeline.
- Tags, notes, assignments.
- Documents, waivers, and consent.
- CSV import.
- Member mobile onboarding/profile.

### Deliverables

- Lead Kanban/table.
- Member list and detail.
- Bulk actions.
- Import dry run.
- Onboarding checklist.

### Acceptance

- Duplicate detection.
- Field-level permissions.
- Consent version stored.
- Import errors downloadable.

### AI agent prompt

> Implement Shark Fitness Phase 2: lead CRM, member management, onboarding, consent, documents, and import. Build the owner/reception workflows and the member mobile onboarding experience. Include lead pipeline, activities, ownership, duplicate detection, member timeline, tags, private notes, document upload with signed URLs, waiver versioning, communication consent, bulk actions, and CSV dry-run mapping. Add permission checks for sensitive notes and exports. Use master-detail UX on web and progressive onboarding on mobile. Add fixtures, tests, analytics events, and operational documentation.

## Phase 3: Products, Memberships, Billing, and Payments

### Scope

- Product catalog.
- Product versions and entitlements.
- Membership lifecycle.
- Invoices, receipts, payments, refunds, discounts.
- Razorpay adapter.
- Stripe adapter interface.
- Dunning.
- Self-service purchase/renewal.

### Deliverables

- Plan builder.
- Checkout.
- Payment webhooks.
- Financial timeline.
- Invoice/receipt generation.
- Recovery queue.

### Acceptance

- Duplicate webhook is harmless.
- Membership activates only from verified payment or approved manual payment.
- Historical product terms remain stable.
- All money uses minor units.

### AI agent prompt

> Implement Shark Fitness Phase 3: products, memberships, billing, and payments. Use versioned product terms and a provider-neutral payment domain. Add recurring and fixed memberships, packs, add-ons, credits, freezes, upgrades, cancellations, grace periods, invoices, receipts, refunds, discounts, cash/manual payment, and dunning. Implement Razorpay first with verified idempotent webhooks and define a Stripe adapter contract. Never store raw payment credentials. Create a state-machine specification and property-focused tests for membership and payment transitions. Add member self-service renewal and payment history with accessible financial UX.

## Phase 4: Attendance, QR Access, Occupancy, and Realtime Core

### Scope

- Dynamic QR.
- Kiosk/scanner.
- Check-in/out.
- Eligibility policy.
- Occupancy.
- Durable Object realtime layer.
- Reconnect/replay.

### Deliverables

- Member access pass.
- Reception check-in screen.
- Live occupancy.
- Access denial workflow.
- Realtime SDK package.

### Acceptance

- QR replay blocked.
- Duplicate scan idempotent.
- Occupancy consistent after reconnect.
- Offline fallback is constrained and auditable.

### AI agent prompt

> Implement Shark Fitness Phase 4: secure dynamic QR access, attendance, live occupancy, and the reusable realtime foundation. Use short-lived signed QR tokens with replay protection and server-side entitlement validation. Implement manual and kiosk check-in, optional checkout, denial reasons, corrections with audit, and occupancy sessions. Build Durable Object WebSocket channels with hibernation, event sequences, replay, authorization, reconnect, and scoped cache updates. Add concurrency and abuse tests. Keep Durable Objects for coordination and D1 as the durable business source of truth.

## Phase 5: Scheduling, Classes, Waitlists, and Trainer Operations

### Scope

- Classes, recurrence, rooms, trainers.
- Booking and waitlist.
- Appointment scheduling.
- Trainer profiles and assignments.
- Rosters and attendance.
- Staff shifts.

### Deliverables

- Schedule calendar.
- Class booking mobile flow.
- Waitlist promotion.
- Trainer day view.
- Room/trainer conflict detection.

### Acceptance

- Concurrent final seat cannot overbook.
- Recurrence exceptions work.
- Credit restoration follows policy.
- Booking updates synchronize live.

### AI agent prompt

> Implement Shark Fitness Phase 5: schedule, classes, appointments, trainer workflows, waitlists, and staff rosters. Model recurring sessions and exceptions correctly across timezones. Create fast member booking, cancellation, calendar, waitlist, promotion expiry, reminders, capacity control, no-show rules, room conflicts, trainer availability, and class check-in. Use serialized coordination for capacity-critical operations. Build accessible calendar and list views. Include concurrency, timezone, cancellation-policy, and permission tests.

## Phase 6: Workout Engine, Offline Logging, Assessments, and Progress

### Scope

- Exercise library.
- Program builder.
- Program versioning.
- Offline workout execution.
- Workout history.
- Assessments, goals, measurements, photos.
- Progress analytics.

### Deliverables

- Trainer program editor.
- High-performance set logger.
- Local SQLite outbox.
- Sync API.
- Progress dashboard and monthly story.

### Acceptance

- No workout data loss across app restart.
- Duplicate sync does not duplicate sets.
- Program publication is versioned.
- Private progress media requires authorization.

### AI agent prompt

> Implement Shark Fitness Phase 6: exercise library, program builder, offline-first workout execution, assessments, goals, and progress. Prioritize logging speed and reliability. Support advanced set types, supersets/circuits, previous values, timers, substitutions, RPE/RIR, personal records, and program versions. Persist active workouts and a mutation outbox in Expo SQLite before network calls. Implement idempotent sync and conflict rules. Add body measurements, private progress photos, assessments, goals, and clear charts. Profile mid-range Android performance and include restart, offline, duplication, and media-authorization tests.

## Phase 7: Nutrition, Habits, Messaging, and Coaching

### Scope

- Meal photo/macros modes.
- Habits.
- Weekly check-ins.
- One-to-one and group messaging.
- Trainer alerts.
- Quiet hours and preferences.

### Deliverables

- Nutrition settings per member.
- Habit assignment/logging.
- Coaching inbox.
- Check-in templates.

### Acceptance

- Internal notes never leak to member chat.
- Notification preferences enforced.
- Attachments use signed access.
- Habit streak logic handles timezone and pauses.

### AI agent prompt

> Implement Shark Fitness Phase 7: nutrition modes, habit coaching, weekly check-ins, and secure coaching communication. Support meal-photo, simple habit, and macro-tracking modes without forcing every member into complex calorie tracking. Build trainer assignments, habit templates, reminders, compliance, check-in forms, one-to-one/group conversations, attachments, read state, quiet hours, and deep-linked notifications. Separate internal notes from member-visible communication at the schema and API level. Add timezone, privacy, authorization, and delivery tests.

## Phase 8: Gamification, Community, Challenges, and Referrals

### Scope

- XP ledger and Shark Level.
- Achievements.
- Challenges and leaderboards.
- Community feed/groups.
- Moderation.
- Referral rewards.

### Deliverables

- Challenge builder.
- Member community.
- Opt-in leaderboards.
- Shareable PR/progress cards.
- Moderation console.

### Acceptance

- Score changes are ledger-based and auditable.
- Members can opt out or hide identity.
- Fraud and duplicate event protection.
- Report/block/mute works.

### AI agent prompt

> Implement Shark Fitness Phase 8: gamification, community, challenges, and referrals. Use an append-only XP ledger and explain every score. Create fair challenge types based on consistency, improvement, attendance, habits, and participation rather than only maximum weight or volume. Add opt-in leaderboards, achievements, Shark Level, social posts, reactions, comments, groups, reporting, blocking, moderation, referral attribution, and qualifying reward rules. Build privacy defaults, anti-abuse controls, and event-deduplication tests. Keep visual celebrations premium and brief.

## Phase 9: Automation, Marketing, Retention, and AI Assistance

### Scope

- Segments.
- Automation builder.
- Campaigns.
- Retention risk.
- AI explanations/summaries/drafts.
- Cost limits and approval.

### Deliverables

- Trigger-condition-action workflows.
- Campaign preview.
- Risk queue.
- AI audit panel.
- Provider adapters.

### Acceptance

- Consent and quiet hours enforced.
- Paid-channel cost preview.
- AI cannot publish high-impact action without configured approval.
- Risk output is explainable.

### AI agent prompt

> Implement Shark Fitness Phase 9: segmentation, marketing automation, retention workflows, and bounded AI assistance. Build a trigger-condition-delay-action engine with frequency caps, consent checks, human approval, test mode, and cost estimates. Add segments, campaigns, delivery metrics, at-risk member scoring using explainable deterministic signals, and outcome tracking. Add an AI provider abstraction for summaries, explanations, draft messages, and constrained program drafts. Redact unnecessary PII, log model/prompt/version/cost, enforce tenant quotas, validate outputs, and require trainer review for safety-relevant recommendations.

## Phase 10: Reporting, Multi-Branch, Finance Controls, and Super Admin

### Scope

- Operational and financial reports.
- Scheduled exports.
- Multi-branch aggregation.
- Platform control plane.
- Usage and cost attribution.
- Support tooling.

### Deliverables

- Saved reports.
- Branch comparison.
- Tenant subscription/feature management.
- Cost dashboard.
- Audited support session.

### Acceptance

- Financial permissions enforced.
- Reports have metric definitions.
- Large exports run asynchronously.
- Support impersonation is time-limited and visible.

### AI agent prompt

> Implement Shark Fitness Phase 10: reports, multi-branch operations, finance controls, and the SaaS super-admin control plane. Add defined metrics, saved filters, scheduled reports, async exports, branch comparison, cross-branch permissions, configuration inheritance, tenant plans, feature flags, usage meters, cost attribution, service diagnostics, and time-limited audited support impersonation. Prevent cross-tenant analytics shortcuts. Use aggregate tables/jobs where needed. Add reconciliation, permission, large-export, and support-audit tests.

## Phase 11: POS, Inventory, Equipment, Live Video, and Integrations

### Scope

- POS and store.
- Inventory.
- Equipment and maintenance.
- Live/on-demand content.
- Public API and webhooks.
- Health and access-control integration adapters.

### Deliverables

- POS checkout.
- Stock movements.
- Equipment QR issue reporting.
- Managed streaming integration.
- Developer API docs.

### Acceptance

- Inventory mutations are auditable.
- Video cannot exceed tenant quota.
- Webhooks sign and retry.
- Health data permission and revocation handled.

### AI agent prompt

> Implement Shark Fitness Phase 11: POS, inventory, equipment operations, managed live/on-demand video, public API/webhooks, and external integration adapters. Build auditable stock movements, POS orders/refunds, equipment QR reporting, maintenance workflows, video entitlements and quotas, secure playback, webhook signing/retries, API scopes/rate limits, and integration consent. Do not build video transcoding or access hardware. Enforce tenant quotas and provider cost limits. Add reconciliation, quota, signature, inventory-concurrency, and privacy tests.

## Phase 12: Production Hardening and Commercial Launch

### Scope

- Full threat model.
- Load and soak tests.
- Accessibility audit.
- Disaster recovery.
- Data lifecycle.
- App store readiness.
- Billing/subscription for gym tenants.
- Support runbooks.
- Compliance documentation.

### Deliverables

- Release candidate.
- Incident runbooks.
- Backup/restore evidence.
- Pen-test remediation.
- Store assets.
- SLA/SLO dashboard.
- Customer onboarding guide.

### Acceptance

- Critical flows pass production-like load.
- Restore exercise succeeds.
- No open critical/high security findings.
- Accessibility blockers resolved.
- Cost alarms and kill switches tested.

### AI agent prompt

> Execute Shark Fitness Phase 12: production hardening and commercial launch. Review the entire system against the PRD. Perform threat modeling, dependency and secret review, load tests, realtime soak tests, offline recovery, payment reconciliation, backup/restore rehearsal, accessibility audit, privacy lifecycle validation, cost-failure simulations, and app-store readiness. Create operational dashboards, SLOs, incident runbooks, customer onboarding, support procedures, and release/rollback plans. Fix discovered issues rather than only documenting them. Return verification evidence and a signed-off launch checklist with any accepted residual risks.

---


# 16. Definition of Done

A feature is complete only when:

- Functional requirements and acceptance criteria are satisfied.
- Authorization and tenant scope are enforced server-side.
- Migration and rollback/forward strategy exist.
- API contract is documented.
- Loading, empty, error, offline, and permission states are designed.
- Accessibility has been checked.
- Analytics events are added where appropriate.
- Structured logs and error context exist.
- Unit/integration/end-to-end tests cover critical behavior.
- Mobile behavior is tested on representative Android and iOS devices when applicable.
- Performance impact is measured for critical interactions.
- Cost impact is documented.
- User-facing copy is reviewed.
- Support/runbook documentation is updated.
- No secrets or production data appear in code or fixtures.

---


# 17. Major Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Feature scope overwhelms UX | High | Role-aware navigation, progressive disclosure, saved views, usability testing, staged rollout |
| Full product exceeds $15 at scale | Critical | Metered add-ons, quotas, BYOK, customer-funded usage, budget alerts |
| D1 query cost from scans | Medium | Required indexes, query meta monitoring, aggregate tables, pagination |
| Realtime compute cost | Medium | WebSocket Hibernation, event batching, scoped rooms, no heartbeat abuse |
| Payment/member-state inconsistency | Critical | Provider-authoritative webhooks, idempotency, separate state machines, reconciliation jobs |
| Cross-tenant data leak | Critical | Database isolation strategy, server guards, automated security tests, scoped storage keys |
| Offline workout conflicts | High | Local-first IDs, mutation outbox, append-only sets, explicit conflict policy |
| AI gives unsafe guidance | Critical | Rules-first engine, constraints, review, explanations, restricted use cases |
| Community abuse | High | Opt-in, report/block/mute, moderation tools, audit, rate limits |
| Video costs spike | High | Stored/delivered minute quotas, add-on pricing, auto-expiry, hard stop |
| Admin tables become slow | Medium | Server pagination, typed filters, virtualized rows, async exports |
| AI-agent code inconsistency | High | Architecture rules, shared contracts, ADRs, phase ownership, automated quality gates |

---


# Engineering review checklist

Before merging any phase, reviewers SHALL confirm:

- Requirement IDs and ADR references are present.
- Tenant/branch scope appears in storage, cache, event, job, log, export, and authorization paths.
- Concurrency and idempotency are defined for every mutation.
- State transitions use canonical enums and preserve history.
- No provider redirect or client UI is treated as financial truth.
- Offline mutations cannot silently disappear.
- PII and secrets are absent from logs/analytics.
- Feature cost is measured and quota-controlled.
- Accessibility and performance budgets are tested, not assumed.
- Rollback/migration behavior is documented.
