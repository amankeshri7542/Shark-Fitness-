# Shark Fitness

A gym management SaaS and member mobile platform engineered for multi-branch gym chains, independent clubs, and boutique fitness studios.

---

## 🦈 Overview

Shark Fitness provides an end-to-end platform comprising:
- **Member Mobile PWA:** Member app featuring the industrial "Sonar" dark-mode theme, workout logger with adaptive load calculation, plate calculator, rest timers, and entry pass.
- **Admin Web Dashboard:** Command center for gym owners, managers, and staff with real-time multi-branch KPIs, occupancy trace canvas, class scheduler, and member CRM.
- **API Backend:** High-performance Hono server with Drizzle SQLite, transactional outbox, WebSocket hub, audit logging, and background schedulers.
- **Domain Business Engine:** Pure TypeScript domain rules with 101 unit tests covering membership state machines, 1RM progression, recovery index, plate math, XP tiers, and fair waitlists.

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
- **API Server:** http://localhost:8787
- **Member PWA:** http://localhost:5173
- **Admin Dashboard:** http://localhost:5174

---

## 🔑 Demo Credentials

| Role | Email | Password |
| :--- | :--- | :--- |
| **Member** | `aman@sharkfitness.in` | `shark1234` |
| **Grace Member** | `rohit@sharkfitness.in` | `shark1234` |
| **Owner** | `owner@sharkfitness.in` | `shark1234` |
| **Manager** | `manager@sharkfitness.in` | `shark1234` |
| **Head Coach** | `rehan@sharkfitness.in` | `shark1234` |
| **Reception** | `reception@sharkfitness.in` | `shark1234` |

---

## 🧪 Testing

```bash
cd shark-fitness
pnpm -F @shark/domain test
```
