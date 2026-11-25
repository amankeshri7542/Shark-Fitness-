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

1. **Website stack**: Astro 7.4.13 (pinned, dev dependency so the image's `--prod` install stays lean), `output: 'static'`,
   `build.format: 'directory'`, CSS inlined per page, no UI framework and no Tailwind (hand-written CSS composing the
   `@shark/design-tokens` Sonar tokens). Added dev deps and why: `astro` + `@astrojs/check` (build + typecheck of `.astro`),
   `eslint-plugin-astro` + `astro-eslint-parser` (root, so `pnpm lint` covers `.astro`), `@fontsource/{anton,archivo,archivo-narrow}`
   (self-hosted OFL WOFF2 subsets instead of Google Fonts), `playwright-core` 1.65.1 (already in the lockfile via e2e; renders the
   OG image). No runtime dependency was added to any app.
2. **Light theme** follows `prefers-color-scheme` through a ~200-byte inline head script that sets `data-theme` (the tokens
   only switch on `:root[data-theme="light"]`; duplicating the light token block in CSS would drift). Without JS the site is
   dark, the signature theme.
3. **Prices** are shown GST-inclusive and exact to the paisa (`₹3,538.82`), the same figure the invoice totals, because the
   catalogue prices are pre-tax and invoices add 18% per line. Rounding to `₹3,539` would put a number on the website that
   no invoice will ever show.
4. **"Buy" on the website**: prospects cannot sign in to the member app (members are created by staff), so a plan's primary
   action is "Start with a free week" (trial form with `?plan=<id>` recorded as interest and expected value on the lead) and the
   secondary action, for existing members, is `/app/billing?plan=<productId>` (P02's plan purchase entry point, see
   Integration notes).
5. **Public responses never reveal a match**: new lead, existing lead, existing member, honeypot and too-fast all get the
   same `202 {received:true, message}`, so the form cannot be used to test whether a phone number belongs to a member.
6. **Dedupe semantics** (PF-CRM-002): a website submission matching a lead by normalised phone (last 10 digits, the
   existing rule) or email adds a note to that lead instead of creating another; first-touch attribution (source, campaign,
   UTM) is never overwritten and the new campaign is recorded in the note; a lost/disqualified lead is reopened; a lead in
   another branch keeps its branch and the note names the requested branch. A converted member is linked: the enquiry is
   recorded on the lead that became that member, or on a new `won` lead linked to the member if they joined another way.
   No member, no open duplicate.
7. **Lead-SLA alert**: there is no separate alert object for leads; the existing mechanism is `leadSlaBreached` (the Leads
   board's "overdue" chip and count), driven by `nextActionAt`. Website leads get `nextActionAt` = two hours after the
   branch next opens (per-day hours, closed days skipped) and a next-action label, and a realtime `lead.captured` event
   refreshes the console. Confirming a trial sets the next action to the trial itself.
8. **Confirm trial** is a dedicated endpoint allowed from `new/contacted/qualified/trial_booked/nurture/reopened`: the call
   that confirms a trial is also the contact and the qualification, so forcing staff through two stage moves first would
   be busywork. It records the session, never books a seat (a lead is not a member).
9. **Form-start check vs clock skew**: the 3-second check compares the page's clock with the server's; a negative interval
   (visitor clock ahead) is not held against the visitor. The honeypot, rate limits and Origin requirement still apply.
10. **Rate limits**: 5 per IP per 10 minutes *per form* (contact and trial have separate budgets), plus 300 submissions per
    tenant per hour across both. Implemented with the existing in-memory limiter; `rateLimit` gained an identity function
    option (additive) so the tenant budget keys on the tenant resolved from the URL.
11. **CSRF**: public form paths are exempt from the double-submit token (a visitor signed in to `/app/` on the same origin
    carries `shark_session` but the website has no CSRF token); the routes require a known `Origin` themselves, as
    `/v1/client-errors` does. No cookie is read or set.
12. **Consent storage**: a new append-only `lead_consents` table (no-update/no-delete triggers; wiped only by the seed
    reset, which already drops and restores triggers) because `consents` is keyed by user and leads have none. The website
    sends the notice version it displayed (`web-2026-11`, `PRIVACY_NOTICE_VERSION`), stored per row with purpose, grant,
    source (`website:trial|contact`), request id and time.
13. **Public flag**: `products.is_public`, default false (opt-in), toggled by `PUT /v1/admin/billing/products/:id/website`
    in a new small route file (keeps churn in `billing.ts`, which P02 is rewriting, to one line). Publishing is audited and
    does not bump the product version. The seed publishes every active plan except the free trial (the website's trial
    request replaces it).
14. **Classes endpoint**: range is *clamped* (past → today, more than 14 days → 14) rather than refused, and the effective
    `from`/`to` are returned. Availability is `available` / `few_left` (≤ max(3, 20% of capacity) open) / `full`. Coach
    first name only.
15. **CORS scoped to `/v1/*`**: Hono's CORS middleware on every path replaced `Vary: Accept-Encoding` and dropped the
    Content-Type of precompressed static responses (browsers showed the HTML as text). Static files never needed CORS.
16. **Legacy member paths**: besides `/`'s fragment forwarding (spec), the API 302s the old member routes (`/sign-in`,
    `/book`, `/pass`, `/workout/…`, …) to `/app/…`, because activation links handed out before the move were
    `/sign-in#…`, not `/#…`. The member router's session guard keeps an activation/recovery fragment on its redirect to
    sign-in, so `/app/#activationId=…` also works.
17. **Ports**: Lighthouse and smoke runs used 18402–18405 instead of 8788 (shared machine). Lighthouse was run without
    `--preset=perf`, because that preset skips the Accessibility, Best Practices and SEO categories the criteria need, and
    against an `SITE_INDEXABLE=true` build (a `noindex` page cannot score SEO 100 by design).
18. **Copy**: written for this gym from the seeded facts (branches, hours, plans, trainers, class types). Coach credentials,
    postcodes, map coordinates, "getting there" details and the founding year are plausible placeholders in
    `src/content/site.ts` that the client must confirm. Privacy notice and terms are marked draft for counsel review.

## Integration notes

- **P02 (payments)**: the website links members to `/app/billing?plan=<productId>` (Plans cards, "Already a member? Buy
  or renew in the app"). P02's member Billing screen should read the `plan` search param and preselect that plan in
  "Choose a plan"/"Renew" (when signed out, the member app shows sign-in first). Files: `apps/website/src/components/PlanCard.astro`.
  Product prices come from the same `products` rows P02 sells; `products.is_public` only affects the website.
  P02 removes dead handlers in `routes/admin/billing.ts`; P03 changed only the products list there (adds `public:
  p.isPublic`). Both phases add a migration (P03: `0018_public_website_leads.sql`); renumber at merge and regenerate the
  drizzle snapshot (`pnpm -F @shark/api db:check-drift` must report no changes).
- **P04 (member app at /app/)**: P04 makes the same base-path move on its branch. This branch follows the plan's decision
  exactly and owns the website at `/`: `apps/member-pwa/vite.config.ts` (`base`, manifest `id/scope/start_url`,
  `navigateFallback: /app/index.html`, allow-list `/app`, deny-list kept), `apps/member-pwa/src/router.tsx` (`basepath:
  '/app'`, fragment-preserving guard), `apps/api/src/lib/static-sites.ts` (replaces the static block in `server.ts`;
  P04's placeholder `/` redirect and its own `/sw.js` must be dropped in favour of the website and
  `apps/website/public/sw.js`), console activation/recovery links (`/app/sign-in#…`), e2e helpers (`/app/`), CI smoke and
  `scripts/admin-browser-smoke.mjs`. P04's manifest fields (`start_url: /app/?source=pwa`, icons, shortcuts) win over the
  minimal ones here; keep `scope`/`id` at `/app/`. P04's `registerType: 'prompt'`/injectManifest SW must keep the `/app/`
  scope and fallback. The website's `/sw.js` deletes only caches named for scope `/` and the old `fonts` runtime cache.
- **P06 (CSP)**: the website uses inline scripts (theme/attribution/legacy-worker boot script on every page, the `/` forward
  script) and inline `<style>` (font faces + inlined CSS) and JSON-LD. A CSP for `/` needs hashes for those scripts
  (Astro emits them at build; compute from `dist`) or `'unsafe-inline'` for styles, and `connect-src 'self'`. No
  third-party origins unless `SITE_ANALYTICS_SRC` is set.
- **P08**: e2e specs added here: `website-trial.spec.ts` (desktop + `website-mobile` project), `website-routing.spec.ts`.
  Worth adding: Lighthouse/axe in CI for the website, the Plans "Show on website" toggle end to end, and Confirm trial
  from the console.
- **Realtime**: new event topic `lead.captured` (contracts `EVENT_TOPICS`, hub `STAFF_TOPICS` → `lead.view`, console
  invalidates `leads`, `lead`, `dashboard`).
