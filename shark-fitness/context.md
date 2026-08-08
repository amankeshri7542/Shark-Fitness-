<mission>
Build the Shark Fitness gym management SaaS — a member mobile app and admin dashboard — from four PRD documents and a v2 design prototype. The PRDs mandate Expo/React Native for the member app, but the user chose React + Vite PWA (mobile-first) because Expo cannot render in this environment. The design direction is fixed by the v2 prototype ("Sonar": near-black hull, blue-tinted hairlines, one cyan accent, Anton display type, zero radius, zero shadow). The goal is a complete, functional application with all features from the PRDs, built on a monorepo with a Hono/SQLite API, shared contracts/domain packages, and two frontends.
</mission>

<state>
The monorepo skeleton, shared packages, API backend, and frontends are actively built, typechecked, and passing all tests.

**Settled and working (Verified with 0 TypeScript errors & 101 tests passing):**
- **Monorepo:** `/Volumes/T7-MacSSD/Codes/shark-gym/shark-fitness/` with pnpm workspace, TypeScript base config, root scripts (`pnpm typecheck`, `pnpm test`, `pnpm -r build` all passing).
- **`@shark/design-tokens`:** `sonar.css` (dark+light themes), `theme.css` (Tailwind v4 bindings), `index.ts` (JS mirrors), `tone.ts` (predator/plain copy register system).
- **`@shark/contracts`:** Full Zod schemas: enums, error envelope, pagination, realtime events, offline outbox, identity, membership, attendance, schedule, training, progress, engagement, ops.
- **`@shark/domain`:** Pure business rules: membership state machine, freeze/proration, booking eligibility, access decisions, rotating entry codes, strength maths (1RM, plate loading, recovery model, adaptive engine), gamification (XP, levels, streaks, challenges), money, permissions, safety scanning, retention risk. (101 domain tests passing across 6 test files).
- **`@shark/api`:**
  - Hono server with Drizzle schema (86 tables, 110 indexes, 7 guard triggers), migrations applied, deterministic seed (39 members, 550 class sessions, 93 invoices, 49 exercises, workout history, community, media).
  - Middleware: `validate.ts` (strict type-safe schema validator replacing raw zod-validator), request ID, logger, error handler, authenticate, rate limit.
  - Implemented routes: `auth.ts`, `me.ts`, `member/home.ts`, `member/training.ts`, `member/schedule.ts`, `member/pass.ts`, `member/progress.ts`, `member/habits.ts`, `member/messages.ts`, `member/engagement.ts`, `admin/dashboard.ts`, `admin/members.ts`, `admin/support.ts`.
- **`@shark/member-pwa`:**
  - Shell, design primitives (`primitives.tsx`, `shell.tsx`), TanStack Router, Zustand store, outbox queue.
  - Fully implemented screens: `SignIn.tsx`, `Home.tsx`, `Workout.tsx`, `Pass.tsx`, `Train.tsx`, `Book.tsx`, `Progress.tsx`, `Pack.tsx`.
- **`@shark/admin-web`:**
  - Console layout (`bridge`, `Rail`, `StatusStrip`, `CommandPalette`, `OccupancyTrace`), TanStack Router, admin store.
  - Fully implemented screens: `SignIn.tsx`, `CommandCenter.tsx`, `Members.tsx`, `MemberDetail.tsx`.

**Open / Incomplete (Remaining Stubs to Implement):**
- **Member PWA screens remaining (10 stubs):**
  - `Summary.tsx` (post-workout celebration, XP minted, PR badges)
  - `Exercise.tsx` (exercise detail, cues, 1RM graph, video container)
  - `Library.tsx` (exercise library & workout routines)
  - `Habits.tsx` (daily habit checkboxes, water/protein trackers)
  - `Challenge.tsx` (squad challenge detail & submission)
  - `Messages.tsx` & `Conversation.tsx` (coach-member messaging)
  - `Billing.tsx` (invoices & membership renewal)
  - `Profile.tsx` & `Notifications.tsx` (settings & notifications)
- **Admin Web screens remaining (15 stubs):**
  - `Leads.tsx` & `LeadDetail.tsx` (Sales CRM kanban & lead conversion)
  - `Floor.tsx` (Live turnstile check-in stream & gate overrides)
  - `Schedule.tsx` (Class calendar & trainer allocations)
  - `Training.tsx` (Workout template builder)
  - `Billing.tsx` & `Plans.tsx` (Invoices & plan catalog manager)
  - `Staff.tsx`, `Store.tsx`, `Equipment.tsx`, `Automations.tsx`, `Reports.tsx`, `Support.tsx`, `Settings.tsx`, `Platform.tsx`
- **Admin API routes remaining (10 stubs):**
  - `admin/attendance.ts`, `admin/billing.ts`, `admin/facility.ts`, `admin/leads.ts`, `admin/reports.ts`, `admin/schedule.ts`, `admin/settings.ts`, `admin/staff.ts`, `admin/store.ts`, `admin/training.ts`
  - Member API routes remaining: `member/billing.ts`, `member/media.ts`
</state>

<decisions>
- **v2 prototype (Sonar/Anton) is the design, not v1** — Sonar dark mode: `#04080b` abyss, `#071119` panel, `#46c8dd` cyan accent, Anton display headers, zero radius, zero shadow.
- **React + Vite PWA instead of Expo/React Native** — PRD mandates Expo but PWA selected for mobile-first environment.
- **SQLite stands in for Cloudflare D1** — same SQL dialect and migrations.
- **Transactional outbox stands in for Durable Objects** — events written in same transaction, fanned out via WebSocket.
- **Predator copy is bounded** — never appears on billing, payment, access denial, injury, support, privacy, or safety surfaces; enforced via `PLAIN_ONLY_SURFACES` list in `tone.ts`.
- **Validation Middleware:** Use `validate` from `apps/api/src/middleware/validate.ts` for type-safe route body/query/param validation.
</decisions>

<key_facts>
- **Demo member login:** `aman@sharkfitness.in` / `shark1234` — Aman Mehra · SF-40219 · level 8 Great White · 35 sessions logged
- **Grace demo login:** `rohit@sharkfitness.in` / `shark1234` — Rohit Bhaskar · SF-40188 · membership in grace with failed payment
- **Staff logins:** `owner@` / `manager@` / `reception@` / `rehan@` / `nikhil@` / `priya@` / `accounts@` `sharkfitness.in` — all password `shark1234`
- **API server:** port 8787, health at `/health`, routes under `/v1/`
- **Member PWA dev:** port 5173, proxies `/v1` to localhost:8787
- **Admin Web dev:** port 5174, proxies `/v1` to localhost:8787
- **Database:** `apps/api/data/shark.db` (SQLite, WAL mode, busy_timeout 5000ms)
- **Database stats:** 86 tables, 110 indexes, 7 triggers
- **Domain tests:** 101 passing across 6 files (`pnpm -F @shark/domain test`)
- **Typecheck:** `pnpm typecheck` (0 errors across entire repository)
</key_facts>