# Shark Fitness

A high-performance gym management SaaS and member mobile platform engineered for multi-branch gym chains, independent clubs, and boutique fitness studios.

---

## 🦈 Platform Overview

Shark Fitness provides an end-to-end multi-tenant platform comprising:
- **Member Mobile PWA (`apps/member-pwa`):** Member app featuring the industrial "Sonar" dark-mode theme (`#04080b` abyss, `#46c8dd` cyan accent, zero border-radius), workout logger with adaptive load calculation, plate calculator, rest timers, rotating 30s security entry pass, training calendar, class booking, progress charts, and gym pack leaderboards.
- **Admin Web Dashboard (`apps/admin-web`):** Command center for gym owners, managers, and staff with real-time multi-branch KPIs, live animated occupancy trace canvas, searchable member directory, and 360° member detail drawer with lifecycle controls (freeze, cancel, renew).
- **API Backend (`apps/api`):** High-performance Hono server with Drizzle SQLite, transactional outbox, WebSocket hub, audit logging, rate limiting, and background schedulers.
- **Domain Business Engine (`packages/domain`):** Pure TypeScript domain rules with **101 unit tests** covering membership state machines, 1RM progression, recovery index, plate math, XP tiers, and fair waitlists.

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
    │   └── domain/                                # Pure business logic & 101 unit tests
    ├── infrastructure/migrations/                 # Generated Drizzle SQL migrations
    └── scripts/                                   # CI browser smoke harness
```

---

## 🚦 Current Implementation Status

Verified on `chore/production-hardening` (Node 22.23.2) on 18 August 2026:
`pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all clean, and the
production single-origin server exercised over HTTP and in a browser.

### ✅ Completed & Working
- **Domain Engine:** 101 unit tests across membership, access decisions, training algorithms and fair scheduling.
- **Test suite:** **282 tests** in 25 files — 101 domain, 142 API integration, 24 member PWA, 15 admin console.
- **Database & Migrations:** 85 SQLite tables across 5 schema files, 110 indexes, 7 append-only/guard triggers, deterministic seed data.
- **Quality gates:** `pnpm lint` (ESLint 10 flat config, `--max-warnings=0`), `pnpm typecheck` and `pnpm build` pass with 0 errors, all gated in CI.
- **Member PWA:** all 18 screens implemented — no stubs remain.
- **Admin Web:** 15 of 21 screens implemented.
- **API Routes:** auth, profile, the member surface, and the admin `attendance`, `billing`, `facility`, `leads`, `schedule`, `staff` and `training` modules.
- **Production serving:** one origin serves the member PWA at `/` and the admin console at `/admin/`, with hashed assets returning their own content types rather than the SPA HTML fallback.

### ⏳ Remaining to Implement
- **Admin Web (6 placeholder screens):** `Automations`, `Platform`, `Reports`, `Settings`, `Store`, `Support`.
- **Admin API Route Adapters (3 stubs):** `reports`, `settings`, `store`.

See [05_Shark_Fitness_Remaining_Implementation_Plan.md](./05_Shark_Fitness_Remaining_Implementation_Plan.md) for the sequenced plan.

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
pnpm test         # 282 tests (domain, API integration, member PWA, admin console)
pnpm build        # Production bundles for both front ends
```

All four run in CI on every push and pull request.

### Production single-origin check

One process serves both apps, which is how the demo is deployed:

```bash
cd shark-fitness
pnpm build
NODE_ENV=production SHARK_SERVE_STATIC=true PORT=8787 \
  SHARK_PASS_SECRET=local-smoke-secret \
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
docker run --rm -p 8787:8787 -e SHARK_PASS_SECRET=local-secret shark-fitness
```
