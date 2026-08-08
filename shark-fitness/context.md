<mission>
Build the Shark Fitness gym management SaaS — a member mobile app and admin dashboard — from four PRD documents and a v2 design prototype. The PRDs mandate Expo/React Native for the member app, but the user chose React + Vite PWA (mobile-first) because Expo cannot render in this environment. The design direction is fixed by the v2 prototype ("Sonar": near-black hull, blue-tinted hairlines, one cyan accent, Anton display type, zero radius, zero shadow). The goal is a complete, functional application with all features from the PRDs, built on a monorepo with a Hono/SQLite API, shared contracts/domain packages, and two frontends.
</mission>

<state>
The monorepo skeleton, shared packages, API backend, and member PWA foundation are built and verified. Specifically:

**Settled and working:**
- Monorepo at `/Volumes/T7-MacSSD/Codes/shark-gym/shark-fitness/` with pnpm workspace, TypeScript base config, root scripts
- `@shark/design-tokens` — sonar.css (dark+light themes), theme.css (Tailwind v4 bindings), index.ts (JS mirrors), tone.ts (predator/plain copy system)
- `@shark/contracts` — all Zod schemas: enums (243 lines), error envelope, pagination, realtime events, offline outbox, identity, membership, attendance, schedule, training, progress, engagement, ops
- `@shark/domain` — pure business rules: membership state machine, freeze/proration, booking eligibility, access decisions, rotating entry codes, strength maths (1RM, plate loading, recovery model, adaptive engine), gamification (XP, levels, streaks, challenges), money, permissions, safety scanning, retention risk
- 101 domain tests passing across 6 test files
- `@shark/api` — Hono server with: Drizzle schema (86 tables, 110 indexes, 7 guard triggers), migrations generated and applied, deterministic seed (39 members, 550 class sessions, 93 invoices, 49 exercises, workout history, community, media), auth (OTP + password), middleware (request ID, logger, error handler, authenticate, rate limit), audit log, transactional outbox, realtime WebSocket hub, background scheduler (membership expiry, stale check-in cleanup, waitlist offer expiry, hold release)
- API server boots and authenticates — verified via curl: health check, tenant list, password sign-in for demo member, bad password rejection, unauthenticated rejection
- `@shark/member-pwa` — package.json, vite.config.ts (with PWA plugin), index.html, styles.css, API client (api.ts with ApiError/OfflineError), design primitives (primitives.tsx: Eyebrow, Label, Display, Metric, Panel, Seam, Chip, LiveDot, Bar, Button, Field, Segmented, Scanlines, SonarSweep, Skeleton, EmptyState, ErrorState, PermissionState), app shell (shell.tsx: BottomNav with 5 nav marks, AppHeader, ScreenBody, Hero, Stack, Surface), session/workout store (store.ts with Zustand)

**Open / incomplete:**
- All member route stubs and admin route stubs are empty Hono instances (created via shell script in `apps/api/src/routes/`)
- Member PWA has no router setup, no screens, no sign-in flow, no offline outbox client, no realtime client
- Admin web app (`apps/admin-web/`) directory exists but has no files
- `packages/ui/` directory exists but is empty
- The `me.ts` route is implemented (preferences, consents, sessions, notifications, data export, deletion request) but member/admin route files are stubs
- Session was cut off immediately after completing `store.ts` in the member PWA

**Redacted values noted:** Several values were redacted in the transcript (API tokens, password hashes, idempotency keys, cookie names, secret parameters). These are referenced by variable name where they appear in code.
</state>

<decisions>
- **v2 prototype (Sonar/Anton) is the design, not v1** — the user explicitly chose v2 when asked; v1 used a different visual direction (Barlow fonts, lighter palette)
- **React + Vite PWA instead of Expo/React Native** — PRD mandates Expo but it can't render in this terminal environment; user chose PWA as the pragmatic target
- **Member app + admin dashboard scope** — not the full platform (no trainer mobile, no super admin); user chose this when asked how much to build
- **SQLite stands in for Cloudflare D1** — same SQL dialect, same migrations, same query shapes; documented as a deviation in an ADR referenced as `docs/ADR-001-runtime.md`
- **Transactional outbox stands in for Durable Objects** — events written in same transaction as the change, then fanned out via WebSocket
- **Dark theme is the signature; light mode is a token swap on `:root[data-theme]`** — not a second design; admin dashboard defaults to light
- **Predator copy is bounded** — never appears on billing, payment, access denial, injury, support, privacy, or safety surfaces; enforced via `PLAIN_ONLY_SURFACES` list in tone.ts
- **Admin dashboard designed as "one continuous hairline-seamed surface"** — no gaps between panels, no floating cards; the occupancy trace on Command Center is the only animated element
- **Money is always integer minor units** — never floats; tax computed per line, not on rounded subtotal
- **Audit log, XP ledger, stock ledger are append-only** — enforced by SQLite triggers that abort UPDATE and DELETE
</decisions>

<key_facts>
- **Demo member login:** `aman@sharkfitness.in` / `shark1234` — Aman Mehra · SF-40219 · level 8 Great White · 35 sessions logged
- **Grace demo login:** `rohit@sharkfitness.in` / `shark1234` — Rohit Bhaskar · SF-40188 · membership in grace with failed payment
- **Staff logins:** `owner@` / `manager@` / `reception@` / `rehan@` / `nikhil@` / `priya@` / `accounts@` `sharkfitness.in` — all password `shark1234`
- **API server:** port 8787, health at `/health`, routes under `/v1/`
- **Member PWA dev:** port 5173, proxies `/v1` to localhost:8787
- **Database:** `apps/api/data/shark.db` (SQLite, WAL mode, busy_timeout 5000ms)
- **Database stats:** 86 tables, 110 indexes, 7 triggers (capacity guards, append-only enforcement, partial unique index for live bookings)
- **Domain tests:** 101 passing across 6 files (membership, access, booking, training, fairness, permissions)
- **Seed stats:** 39 members, 550 class sessions over 21 days, 93 invoices, 49 exercises, 24 training days in Apex Hypertrophy programme, 23 assignments
- **Design tokens (dark):** abyss `#04080b`, hull `#050b10`, panel `#071119`, sonar `#46c8dd`, foam `#e8f1f5`, flare `#e8823c`, kelp `#7fe0c0`, chum `#e5544c`
- **Design tokens (light):** abyss `#eef2f4`, sonar `#0a6d81`, foam `#0b1a22`
- **Hairlines:** `rgba(120,190,215,α)` at 10–30% in dark; `rgba(45,90,110,α)` in light — never grey
- **Fonts:** Anton (display, uppercase, leading 0.94), Archivo (body, 400/500/600), Archivo Narrow (utility, 10–11px, uppercase, tracking 0.1–0.2em)
- **Geometry:** zero border-radius, zero box-shadow, primary CTA clip-path notch
- **Toolchain:** Node v22.20.0, pnpm 10.28.0, TypeScript 5.7.3, Vitest 3.0.5, Hono 4.6.20, Drizzle 0.38.4, better-sqlite3 11.8.1, React 19.0.0, TanStack Router 1.97.3, TanStack Query 5.64.2, Zustand 5.0.3, Tailwind 4.0.0
- **Adaptive engine rules version:** `v4.2`
- **Entry code rotation:** 30 seconds, 10-char Base32 (alphabet excludes O, I, 0, 1)
- **XP levels:** Minnow(0) → Reef(250) → Blacktip(600) → Bull(1100) → Mako(1800) → Hammerhead(2800) → Tiger(4200) → Great White(6200) → Megalodon(9000) → Apex(13000)
- **Tenant:** `ten_shark`, slug `shark`, 3 branches: `br_kor` (Koramangala, cap 120), `br_ind` (Indiranagar, cap 90), `br_hsr` (HSR, cap 75)
- **Env flags:** `SHARK_ECHO_OTP` (echo OTP in dev, default on), `SHARK_DISABLE_JOBS` (skip scheduler), `PORT` (default 8787), `SHARK_DB` (default `data/shark.db`)
</key_facts>


<dead_ends>
- **better-sqlite3 native binding not compiled** — pnpm blocks build scripts by default; initial `pnpm migrate` failed with "Could not locate the bindings file." Fixed by adding `pnpm.onlyBuiltDependencies: ['better-sqlite3','esbuild']`