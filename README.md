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
    └── packages/
        ├── contracts/                             # Shared Zod schemas & API contracts
        ├── design-tokens/                         # Sonar CSS tokens & tone copy register
        ├── domain/                                # Pure business logic & 101 unit tests
        └── ui/                                    # Shared UI components
```

---

## 🚦 Current Implementation Status

### ✅ Completed & Working
- **Domain Engine:** 101 unit tests passing across membership, access decisions, training algorithms, and fair scheduling.
- **Database & Migrations:** 86 SQLite tables, 110 indexes, 7 SQL triggers, deterministic seed data.
- **Type Checking & Build:** `pnpm typecheck` and `pnpm -r build` pass with **0 errors**.
- **Member PWA:** `SignIn`, `Home`, `Workout` (set logger + plate math + timer), `Pass` (30s dynamic entry QR), `Train` (program syllabus), `Book` (class timetable & reservation), `Progress` (1RM & recovery charts), `Pack` (leaderboard & squad feed).
- **Admin Web:** `SignIn`, `CommandCenter` (live occupancy trace & alerts), `Members` (searchable grid), `MemberDetail` (360° profile drawer & membership actions).
- **API Core & Routes:** Auth, profile (`me`), member routes (`home`, `pass`, `training`, `schedule`, `progress`, `habits`, `messages`, `engagement`), admin routes (`dashboard`, `members`, `support`).

### ⏳ Remaining to Implement
- **Member PWA (10 screens):** `Summary`, `Exercise`, `Library`, `Habits`, `Challenge`, `Messages`, `Conversation`, `Billing`, `Profile`, `Notifications`.
- **Admin Web (15 screens):** `Leads`, `LeadDetail`, `Floor`, `Schedule`, `Training`, `Billing`, `Plans`, `Staff`, `Store`, `Equipment`, `Automations`, `Reports`, `Support`, `Settings`, `Platform`.
- **Admin API Route Adapters (10 stubs):** `attendance`, `billing`, `facility`, `leads`, `reports`, `schedule`, `settings`, `staff`, `store`, `training`.

---

## 🚀 Quick Start

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
pnpm typecheck              # Verifies TypeScript across all packages (0 errors)
pnpm -F @shark/domain test   # Runs 101 domain unit tests
pnpm -r build               # Verifies production bundle builds
```
