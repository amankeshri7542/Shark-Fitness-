# Shark Fitness

**23 September 2026:** the release scope is one staffed gym with reception-recorded, independently received payments. Simulated checkout is disabled. Local rehearsal evidence and incomplete hosted/human gates are tracked in [the stabilization report](shark-fitness/docs/STABILIZATION-2026-09-20.md) and [demo guide](shark-fitness/docs/PILOT-TEST-AND-DEMO.md). The historical feature inventory below is not a claim of PRD completion or real-member pilot approval.

A high-performance gym management SaaS and member mobile platform engineered for multi-branch gym chains, independent clubs, and boutique fitness studios.

---

## 🦈 Platform Overview

Shark Fitness provides an end-to-end multi-tenant platform comprising:
- **Member Mobile PWA (`apps/member-pwa`):** Member app featuring the industrial "Sonar" dark-mode theme (`#04080b` abyss, `#46c8dd` cyan accent, zero border-radius), workout logger with adaptive load calculation, plate calculator, rest timers, reception identification card, training calendar, class booking, progress charts, and gym pack leaderboards.
- **Admin Web Dashboard (`apps/admin-web`):** Command center for gym owners, managers, and staff with real-time multi-branch KPIs, live animated occupancy trace canvas, searchable member directory, and 360° member detail drawer with lifecycle controls (freeze, cancel, renew).
- **API Backend (`apps/api`):** High-performance Hono server with Drizzle SQLite, transactional outbox, WebSocket hub, audit logging, rate limiting, and background schedulers.
- **Domain Business Engine (`packages/domain`):** Pure TypeScript domain rules with **252 unit tests** covering membership state machines, 1RM progression, recovery index, plate math, XP tiers, fair waitlists, and reporting periods and comparisons.
- **Store / point of sale (`screens/store`, `routes/admin/store.ts`):** Till with mixed tender and a stable idempotency key per checkout attempt, stock derived from an append-only ledger, returns as compensating entries, inter-branch transfers with visible shrinkage, and cost/margin gated separately by permission.
- **Support / retention (`screens/support`, `routes/admin/support.ts`):** Ticket queue with an SLA computed in the branch's *open* hours, staff replies flowing into the member's existing conversation rather than a parallel thread, an append-only ticket timeline for disputes, NPS/CSAT and cancellation reporting with honest reporting floors, and explainable retention risk with intervention effectiveness tracking.
- **Reports and analytics (`screens/reports`, `routes/admin/reports.ts`):** Revenue, membership, attendance, coach utilisation and retention cohorts over any range, computed in the branch's timezone; `report.financial` withholds money as *absent* rather than as zero; totals are never summed across currencies; every figure states how fresh it is; and every CSV export is audited with the filters that produced it.
- **Settings (`screens/settings`, `routes/admin/settings.ts`):** tenant profile, tax and data-processing policy, branch CRUD with per-day hours and holidays, rooms, a five-state branch lifecycle, and tenant defaults a branch may override — where the *absence* of a key is what "inherited" means, and the overrides genuinely change what the door, the front desk and the till decide.
- **Automations (`screens/automations`, `routes/admin/automations.ts`):** trigger → conditions → message, with an audience preview that gives equal room to who is being held back and why, a dry run that is structurally incapable of sending, quiet hours read in the branch's own timezone, and a duplicate send refused by a database index rather than by remembering to check.
- **Platform (`screens/platform`, `routes/platform.ts`):** cross-tenant customer list, health, plans and quotas, and time-boxed support access that borrows a gym owner's authority without acquiring any of the operator's — announced by a banner that cannot be scrolled away and audited into the gym's own log.

---

## 📂 Repository Structure

```
├── 01_Shark_Fitness_Product_Functional_PRD.md     # Product & functional specifications
├── 02_Shark_Fitness_Engineering_Technical_PRD.md  # Architecture, stack & engineering specs
├── 03_Shark_Fitness_Design_UIUX_PRD.md            # Design system, UI/UX specs
├── 04_Shark_Fitness_Enterprise_Compliance_PRD.md  # Compliance, audit & security specs
├── Shark-inspired member app prototype/           # Standalone design prototypes
└── shark-fitness/                                 # Main monorepo application
    ├── apps/
    │   ├── api/                                   # Hono API & SQLite backend
    │   ├── member-pwa/                            # Member PWA (React + Vite)
    │   └── admin-web/                             # Admin Dashboard (React + Vite)
    ├── packages/
    │   ├── contracts/                             # Shared Zod schemas & API contracts
    │   ├── design-tokens/                         # Sonar CSS tokens & tone copy register
    │   └── domain/                                # Pure business logic & 252 unit tests
    ├── infrastructure/migrations/                 # Generated Drizzle SQL migrations
    └── scripts/                                   # CI browser smoke harness
```

---

## Current stabilization status

The current offering is a **supervised demonstration for one staffed gym**:
owner setup, staff/member activation, walk-in enrollment, plan assignment,
manually verified payment recording, payment acknowledgement receipts and reception attendance.

The [stabilization report](shark-fitness/docs/STABILIZATION-2026-09-20.md)
records the final candidate, measured checks, readiness scores and remaining gates.
The [manual QA and 10–15 minute demo guide](shark-fitness/docs/PILOT-TEST-AND-DEMO.md)
covers fresh-account setup, failure cases and safe reset.

Real-member use remains **NO-GO** until the target deployment's persistence,
off-instance backup/restore and operator acceptance checks are proven. Local
recovery tools exist and are tested; a local proof is not a hosted recovery test.
Physical door scanning, integrated payment collection, automatic renewal and
waitlists are outside this offering. The member pass is a reception ID card;
waitlist joins/offers are disabled. Existing-password recovery and automated
activation delivery remain follow-up work. Broad module presence does not establish
production completeness.

Historical architecture and larger-product plans are retained in
[PRODUCTION-READINESS.md](shark-fitness/docs/PRODUCTION-READINESS.md) and the PRDs;
use the current stabilization report for release decisions.

---

## 🚀 Quick Start

### 0. Use Node 22

The project is pinned to **Node 22.x** (`.node-version`, `.nvmrc`, and
`engines` in `shark-fitness/package.json`). CI resolves its Node version from
`.node-version`, so local and CI agree by construction.

Node 24 aborts `better-sqlite3` partway through `pnpm db:seed` with an opaque
`SIGABRT`. `engine-strict=true` in `shark-fitness/.npmrc` therefore refuses an
unsupported runtime at install time, with a readable message instead.

```bash
fnm use    # or: nvm use
node -v    # expect v22.x
```

### 1. Install Dependencies
```bash
cd shark-fitness
pnpm install
```

### 2. Run the Full Stack
```bash
pnpm dev
```
- **API Server:** http://localhost:8787 (Health: http://localhost:8787/health)
- **Member PWA:** http://localhost:5173
- **Admin Dashboard:** http://localhost:5174

---

## 🔑 Demo Credentials

| Role | Email | Password | Details |
| :--- | :--- | :--- | :--- |
| **Member** | `aman@sharkfitness.in` | `shark1234` | Level 8 Great White, active plan, mid-workout block. |
| **Grace Member** | `rohit@sharkfitness.in` | `shark1234` | Membership in grace with failed payment warning. |
| **Gym Owner** | `owner@sharkfitness.in` | `shark1234` | Full multi-branch permissions. |
| **Branch Manager** | `manager@sharkfitness.in` | `shark1234` | Branch-specific operational access. |
| **Head Coach** | `rehan@sharkfitness.in` | `shark1234` | Training programming & coaching. |
| **Reception** | `reception@sharkfitness.in` | `shark1234` | Front-desk check-in access. |

---

## 🧪 Testing & Verification

```bash
cd shark-fitness
pnpm lint         # ESLint across the workspace; --max-warnings=0
pnpm typecheck    # TypeScript across all 6 packages
pnpm test         # domain, API integration, member PWA and admin console suites
pnpm build        # Production bundles for both front ends
```

All four run in CI on every push and pull request.

### Production single-origin check

One process serves both built apps. First migrate and bootstrap a disposable database using the QA guide; then:

```bash
cd shark-fitness
pnpm build
NODE_ENV=production SHARK_SERVE_STATIC=true PORT=8787 \
  SHARK_PASS_SECRET="$(openssl rand -hex 32)" \
  SHARK_ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787 \
  pnpm -F @shark/api start
```

- Member PWA: http://localhost:8787/
- Admin console: http://localhost:8787/admin/

The member service worker is scoped to `/` and explicitly denies `/admin/*`,
`/v1/*` and `/health`, so the admin console is never answered with the member
app shell.

---

## 🐳 Container

The published image builds the front ends in one stage, resolves **production
dependencies only** in a second, and copies just the API sources, the built
front ends and the migration SQL into the runtime stage. It runs as the
non-root `node` user and carries no front-end toolchain, compiler or test
runner. CI builds this image and smoke-tests the running container on every
push and pull request.

```bash
docker build -t shark-fitness .
docker run --rm -p 8787:8787 -v shark-data:/var/lib/shark-fitness \
  -e SHARK_PASS_SECRET="$(openssl rand -hex 32)" \
  -e SHARK_ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787 shark-fitness
```
