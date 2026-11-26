# Shark Fitness

**Current acceptance scope (23 September 2026):** one staffed gym; manual verified settlement and reception attendance. Online payment runs through Razorpay **in test mode only** when `SHARK_PAYMENT_PROVIDER=razorpay` is configured (see [docs/PAYMENTS-RAZORPAY.md](docs/PAYMENTS-RAZORPAY.md)); without it members pay at reception. Demo provider callbacks stay disabled. See [current evidence and gates](docs/STABILIZATION-2026-09-20.md), [local recovery/hosted blockers](docs/deployment-stabilization.md), and [the presentation guide](docs/PILOT-TEST-AND-DEMO.md). Historical module descriptions and test counts below do not establish complete PRD delivery or pilot readiness.

A multi-tenant gym operating system: a public website, a member PWA and a staff
operations console, built to the four PRDs in the parent directory. One origin serves
all three: the website at `/`, the member app at `/app/`, the console at `/admin/`,
the API at `/v1/`.

**Member core (P05, November 2026), all on by default:**

- **Entry pass.** A rotating, single-use QR code on the member's phone (with a
  member-number fallback offline), scanned at reception from the console's
  camera, a USB scanner or a typed code, through the same decision as the door.
- **Waitlists.** Join a full class; a freed seat is offered to the first
  eligible member and held for them (30 minutes, or until an hour before
  class), then passes on. Nobody else can take a held seat.
- **Credit packs.** Class and PT packs sold at the desk or bought in the app
  (Razorpay test mode, or pay at reception). Credits appear when the invoice is
  paid in full, are used earliest expiry first, come back with their original
  expiry on a timely cancellation, and are refunded by a stated rule (unused:
  in full; part used: unused credits at the pack's unit price; expired: not
  refundable).
- **Progress photos.** Stored privately (metadata stripped, five-minute signed
  links), only with consent, shared with the assigned coach only if the member
  chooses, compared side by side, and deleted after consent is withdrawn.
- **Log a workout of your own** from the exercise library, offline included,
  with the same PRs, XP and summary as a coached session.

```
apps/
  api/            Hono + SQLite (D1-compatible) + Drizzle. 94 tables, migrations, seed.
  member-pwa/     React + Vite PWA at /app/: installable, offline-capable, Web Push,
                  Android TWA definition (android/). See docs/MOBILE-APP.md.
  admin-web/      React + Vite operations console at /admin/, installable on tablets.
  website/        Astro static public website at /, with lead and free-trial forms (docs/WEBSITE.md).
packages/
  contracts/      Zod schemas, enums, error + event envelopes. One source of truth.
  domain/         Pure business rules. 252 tests. No I/O, no framework.
  design-tokens/  The Sonar design system + the copy register.
infrastructure/
  migrations/     Generated SQL, checked in.
e2e/              Playwright against the production build (e2e/README.md).
docs/
  DESIGN.md       The visual direction and why each decision was made.
  BUILD-PLAN.md   Conventions every contributor builds against.
  ADR-001-runtime.md  Why this deviates from the PRD's Cloudflare/Expo stack.
  ADR-002-member-mobile-app.md  The mobile app: PWA + Android TWA, Expo deferred.
  MOBILE-APP.md   Install, push, Play Console, asset links, iOS, Data safety draft.
  ADR-004-mfa-totp.md TOTP two-step sign-in now, passkeys later.
  SECURITY.md         Sessions, MFA, step-up, CSP, webhooks (with a verification snippet).
  PILOT-HOSTING.md    One-server pilot: deploy, backups (encrypted off-site), drills.
  OPERATIONS-ALERTS.md  Error reporting, /metrics and the alert rules.
  WEBSITE.md      The public website: content, forms and leads, SEO switches, budgets.
```

## Running it

```bash
pnpm install
pnpm db:reset      # migrate + seed. Deterministic — same gym every time.
pnpm db:backup:verify # isolated backup → mutate → restore proof
pnpm dev           # api :8787 · member :5173/app/ · admin :5174/admin/ · website :5175
```

In production one process serves the public website at `/`, the member app at
`/app/`, the console at `/admin/` and the API at `/v1`. Old member links
(`/#activationId=…`, `/sign-in#…`, `/book`) forward to `/app/` with their
fragment kept. Dev ports can be moved with
`SHARK_MEMBER_DEV_PORT`, `SHARK_ADMIN_DEV_PORT` and `SHARK_API_DEV_ORIGIN`.

Push notifications are off until `SHARK_VAPID_*` is set
(`pnpm -F @shark/api vapid:keys`); see `docs/MOBILE-APP.md`.

The seed builds one tenant (Shark Fitness, Bengaluru) with three branches, 39 members,
550 class sessions across 21 days, a six-week training programme, twelve weeks of
workout history, live floor occupancy, and the awkward states the PRDs demand — a
member in grace with a failed payment, a full class with a waitlist, a lead past its
SLA, an overdue safety work order.

## Signing in

| Account | Role | What it demonstrates |
|---|---|---|
| `aman@sharkfitness.in` | member | Active, mid-block, level 8, PRs, a pending adaptive change |
| `rohit@sharkfitness.in` | member | Grace period with a failed renewal — the denial path |
| `owner@sharkfitness.in` | owner | The whole console |
| `manager@sharkfitness.in` | branch manager | One branch, no refunds |
| `reception@sharkfitness.in` | reception | Six modules, balances but not revenue |
| `rehan@sharkfitness.in` | trainer | Their own roster only, no money |
| `accounts@sharkfitness.in` | accountant | Money and reports, no schedule |

Password for all: `shark1234`. Members can also sign in by OTP; in a dev build the
code is echoed to the API log and prefilled.

Owners (and regional managers and platform staff) must use **two-step sign-in**.
On a fresh database `owner@sharkfitness.in` is asked to set it up after the
password: scan the QR code with any authenticator app (Google Authenticator,
Microsoft Authenticator, 1Password…), enter the code, keep the recovery codes.
The other demo staff accounts are not asked unless the gym turns on
Settings → Security → "Require two-step sign-in for all staff". Lost the
authenticator on a dev database? `pnpm db:reset` starts over. Details in
`docs/SECURITY.md`.

The console changes shape per role — that is the point, not a detail. Sign in as
reception and then as owner to see it.

## Verifying

```bash
pnpm lint                   # ESLint across the workspace, --max-warnings=0
pnpm typecheck              # all six packages, zero errors
pnpm test                   # 1,215 tests: 252 domain, 681 API, 26 member, 256 console
pnpm build                  # both apps
pnpm e2e                    # Playwright, after a build: owner, member, crash recovery
pnpm -F @shark/api db:check-drift  # drizzle-kit generate must find no schema changes
```

`pnpm e2e` needs Chromium once: `pnpm -F @shark/e2e exec playwright install chromium`.
It starts its own production server on a temporary database and removes both afterwards.

Do not pipe `pnpm test` through `tail`. The four packages interleave and the
tail shows one of them; a package can fail while the visible summary is green.

A green suite is not a smoke test. On anything that touches money, also run the
production single-origin server and work the screen by hand — the last two
rounds of Store defects were both invisible to the suite and obvious in a
browser within a minute. `docs/BUILD-PLAN.md` has the commands.

And one width is not a browser pass. Work 1440×900, 1024×768, 768×1024 and
375×812 in both themes, open a dialog, and press Escape. The phone layout put
sign-out outside a clipping grid column with no scrollbar, and every dialog
with an autofocused field returned focus to `<body>` instead of to the control
that opened it — neither is visible from a desktop window.

## The parts worth knowing about

**Money is integer minor units everywhere.** Tax is computed per line and summed, never
on a rounded subtotal — the two differ by a rupee often enough to matter on a
reconciliation.

**The domain package holds the rules.** Membership state machine, booking eligibility,
door decisions, the adaptive training engine, XP and streaks, retention risk, safety
scanning, dunning. All pure, all tested. Route handlers are adapters; if a rule is
being written inside a handler, it is in the wrong place.

**Tenant isolation is enforced by the repository layer**, not by the database. SQLite
and D1 have no row-level security, so every query filters on `tenantId` and every
branch-scoped query checks `ctx.branchIds`. There is no code path that reads a business
table without a tenant.

**This is beta software.** The business logic and the authorisation model are
production-grade and tested from the outside. The infrastructure is one instance
on one SQLite file, with scripted nightly backups, optional age-encrypted
off-site copies and restore drills (`docs/PILOT-HOSTING.md`), every setting
validated at boot, error reporting from the server and both apps, and a
Prometheus `/metrics` endpoint (`docs/OPERATIONS-ALERTS.md`). It still cannot
take money, and no hosted server, bucket or alert account has been set up.
`docs/PRODUCTION-READINESS.md` says exactly what is missing and what each gap
costs to close; read it before deploying this anywhere real.

**Configuration fails at boot, not at the first request.** Every variable the
API reads is declared and validated in `apps/api/src/lib/config.ts`; a test
refuses `process.env` anywhere else and any variable missing from
`.env.example`. A sign-in-code provider chosen without its credentials, a
malformed error DSN or, in production, a short metrics token stops the process
before it opens the database.

**Branch scope has one answer, and it lives in `branchScope(ctx, branchId?)`.**
No branch named and none selected means *every branch the caller may see* —
that is what the console's switcher means by "All branches", and a server-side
default to the caller's first branch makes the label a lie. An `x-branch-id`
outside the caller's entitlement is refused, never quietly narrowed to what
they do hold. And a detail endpoint is scoped exactly as hard as its list
endpoint: load through the module's `load*InScope` helper, which answers 404
rather than 403, because a 403 confirms the record exists somewhere the caller
may not look.

**Append-only ledgers are enforced by triggers.** `audit_log`, `xp_ledger`,
`stock_ledger` and `ticket_events` have `BEFORE UPDATE`/`BEFORE DELETE` triggers that
abort. A correction is a compensating entry, never an edit. `ticket_events` is separate
from `audit_log` on purpose: the audit log needs `audit.view`, which reception and
branch managers — the people who actually handle complaints — do not hold, and a
dispute record nobody involved may read is not much of a record.

**Overbooking is impossible at three levels**: the eligibility rule, the transactional
claim, and a database trigger that aborts if `booked > capacity`. The last one should
never fire; it exists because the first two are code.

**A retryable write owns its key for as long as it is the same write.** The
till builds one `Idempotency-Key` per checkout attempt and reuses it across
retries, so a lost response costs a retry rather than a second charge; a
changed basket mints a new one, and a completed sale retires it so the next
customer's identical basket is not swallowed as a duplicate. The server stores
the request hash beside the key and refuses a key replayed against different
content.

**Money visibility is three tiers, not two.** Stock, price and takings are
`inventory.view`; unit cost — on a product, a ledger row, a sold line or a
transfer line — is `inventory.manage`, because whoever books in a delivery
types it; margin, stock valuation and shrinkage *value* are `report.financial`.
A withheld figure is `null` and named in the response's `restricted` list,
never `0`.

**Offline is real on the member app.** Every write that can happen on a gym floor goes
through an IndexedDB outbox with a client-generated id that doubles as the idempotency
key. Losing signal mid-workout costs a retry and nothing else. Bookings deliberately do
*not* queue — a last-seat claim has to wait for the server.

**Messages are recorded, not assumed.** Every channel (in-app, push, email,
SMS, WhatsApp) goes through one NotificationService that checks purpose
consent at queue time and again at send time, defers quiet hours in branch
time and writes each attempt to `notification_deliveries`. Off in-app, every
channel defaults to a `log` driver that says "logged, not delivered". Member
messaging, the staff Inbox, community moderation, tasks, the coach view,
broadcasts, quick add and the command palette are described in
`docs/ENGAGEMENT.md`.

**Status is never colour alone.** Every `Chip` pairs its colour with a glyph, per WCAG
2.2 and the design PRD.

**The copy register is bounded.** The predator voice (Hunt / Strike / Depth / Pack) is
the training floor only. Payment, access denial, injury, support and privacy always use
the plain register — enforced by `PLAIN_ONLY_SURFACES` in `packages/design-tokens/src/tone.ts`,
so a caller cannot reach for the aggressive voice on a failed payment.

## Known deviations from the PRDs

Recorded properly in `docs/ADR-001-runtime.md`. In short: this runs on Node + SQLite +
a WebSocket hub rather than Cloudflare Workers + D1 + Durable Objects, and the member
app is a PWA (shipped to Android as a Trusted Web Activity) rather than Expo,
recorded in `docs/ADR-002-member-mobile-app.md`. The SQL dialect, migrations, query shapes and realtime
contract are all the ones the PRD specifies, so the port is mechanical rather than a
rewrite.
