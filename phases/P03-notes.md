# P03 — Public website, public API and lead capture

Branch `phase/P03-public-website` from `phase/P01-prod-readiness` (2c15353). Worktree `/workspace/sf-wt/P03`.
Node 22.23.5 from `/home/box/opt/node22`, pnpm 10.28.0. Servers I start use ports 18400–18499.

## Plan

Each step is committed when its checks pass.

1. **Schema (one migration, drizzle-kit generated)**: `products.is_public` (default false, opt-in);
   lead columns `goal`, `preferred_time`, `interested_product_id`, `utm` (json), `referral_code`,
   `trial_requested_at`, `trial_session_id`, `trial_preferred_time`, `trial_confirmed_session_id`,
   `trial_confirmed_at`; append-only `lead_consents` (lead, purpose, granted, notice version, source,
   request id, captured at). Seed marks the sellable plans public.
2. **Contracts**: `schemas/public-site.ts` (lead/trial input with E.164 phone normalisation, site and
   classes response types). The website imports types only (zod stays out of its bundle).
3. **API**: `services/public-site.ts` + `routes/public.ts` at `/v1/public/:tenantSlug`
   (`GET /site`, `GET /classes`, `POST /leads`, `POST /trial-requests`). Origin required, no cookies,
   CSRF-token exempt (Origin is the boundary, like `/v1/client-errors`), per-IP 5/10 min per endpoint
   and per-tenant limits, `Idempotency-Key`, honeypot + 3 s minimum, generic 404 for unknown/suspended
   tenants, dedupe through `services/leads.ts`, converted-member link, consent rows, lead activity,
   SLA next action, realtime `lead.captured`. Integration tests for every AC2 case + no outbound message.
4. **Admin**: products list returns `public`; `PUT /v1/admin/billing/products/:id/website` toggle
   (new small route file to stay out of P02's way in `billing.ts`); Plans "Show on website" switch;
   Leads list source/UTM/trial chip + "Website" filter (`source=website`); Lead detail attribution,
   consent, trial request and "Confirm trial" (`POST /v1/admin/leads/:id/trial/confirm`).
5. **Routing move**: member PWA `base: '/app/'`, router `basepath: '/app'`, manifest scope/start_url/id,
   SW scope `/app/` + adjusted `navigateFallback`/denylist; console activation/recovery links → `/app/…`;
   API static serving `/` website, `/app/*` member, `/admin/*` console, content types + cache headers;
   website `/sw.js` self-unregisters; `/` forwards legacy `#activationId=`/`#recoveryId=` and standalone
   display-mode to `/app/`.
6. **Website** `apps/website` (Astro 7, static, strict TS, ESLint incl. `.astro`): pages Home, Plans,
   Classes, Coaches, Locations (+3 branch pages), About, Free trial, Contact, FAQ, Privacy (draft),
   Terms (draft), 404. Typed content in `src/content/site.ts` seeded from the demo tenant;
   `sync-content -- --api <url>` refreshes it. Self-hosted subset WOFF2, preload, swap. SEO: titles,
   descriptions, canonical, OG/Twitter + generated 1200×630 PNG, JSON-LD (ExerciseGym, Offer, FAQPage,
   BreadcrumbList), sitemap, robots honouring `SITE_INDEXABLE`, 404 noindex. Progressive enhancement
   of plans/timetable from the public API. Vanilla TS form script (aria-live, focus first invalid).
7. **E2E**: website trial form keyboard-only on desktop + mobile projects → lead in admin Leads with
   Website + trial chip; legacy `/#activationId=` → `/app/`; SW at `/` removed; console at `/admin/`;
   member specs updated for `/app/`.
8. **Build/ops**: root `dev` adds website (5175, `/v1` proxy), Dockerfile copies website dist, CI static
   smoke checks `/`, `/app/`, `/admin/`, `scripts/admin-browser-smoke.mjs` paths.
9. **Lighthouse** (3 runs each, median) for Home, Plans, Free trial; JS budget script; screenshots.
10. **Docs**: `docs/WEBSITE.md`, README, `docs/PILOT-HOSTING.md`, `.env.example`; PR description.

## Checklist (mirrors P03-progress.json)

1. AC1 — `pnpm build` builds the website; production serving `/`, `/app/`, `/admin/`; immutable hashed
   assets with correct MIME; no-cache HTML; CI smoke checks all three.
2. AC2 — public API integration tests (dedupe phone/email, converted member, honeypot/too-fast 202,
   cross-tenant, suspended 404, 429, invalid phone 422 with path, consent version, classes no member ids
   + 14-day cap, non-public products hidden).
3. AC3 — Lighthouse mobile ≥ 95/95/95 and SEO 100 for Home, Plans, Free trial (median of 3), reports saved.
4. AC4 — JS ≤ 20 KB gzip on content pages, ≤ 35 KB on Free trial/Contact; CLS < 0.05.
5. AC5 — unique title/description, canonical, OG, valid JSON-LD (test); sitemap; robots + `SITE_INDEXABLE`.
6. AC6 — Playwright desktop + mobile keyboard-only trial form, aria-live errors + focus, admin Leads shows
   Website + trial chip; legacy activation hash → `/app/`; SW at `/` removed; console loads.
7. AC7 — member app tests + e2e pass with `/app/`; activation/recovery link tests assert `/app/`.
8. AC8 — no outbound message for leads (asserted).
9. AC9 — docs; standard gates + `pnpm e2e`.
10. Admin: Plans "Show on website" toggle; Leads source/UTM/trial + Website filter; Confirm trial.
11. `sync-content` script; `pnpm dev` adds the website dev server.
12. Screenshots in `phases/P03-screens/`, PR description `pr/P03.md`.

## Decisions and assumptions

(filled in as work proceeds)

## Integration notes

(filled in as work proceeds)
