# P07 notes — Messaging channels, member messaging, community moderation, tasks, coaching, broadcasts

Branch `phase/P07-engagement-ops-modules` from `phase/P06-staff-security` (d9e656c). Worktree `/workspace/sf-wt/P07`. Node 22.23.5, pnpm 10.28.0.
Baseline on this branch before any change (`pnpm test`): contracts 6/1, domain 271/12, member-pwa 40/11, admin-web 328/43, API 982/70 — all green.

On this branch: P01 (e2e harness), P06 (step-up, CSP). **Not** on this branch: P02 (Razorpay), P03 (website), P04 (push), P05 (media storage). See "Integration notes".

## Plan (build order from the phase risks: channels → messaging → community → tasks → coach → broadcast → palette → quick add)

1. **Foundation**: one additive migration (`0019_engagement_ops`, new schema file `db/schema/engagement-ops.ts` + a few `ALTER TABLE … ADD COLUMN`), new permissions (`inbox.view`, `task.view`, `task.manage`, `broadcast.send`, `broadcast.approve`), `navFor` with new modules (Inbox, Tasks, Nutrition & Habits, Community, Marketing) and a rail limit so reception keeps ≤ 7 rail modules (the rest stays reachable from the palette).
2. **NotificationService** (`services/notifications/*`): channels `in_app`, `push`, `email`, `sms`, `whatsapp`; drivers `log` (default everywhere, status `logged`), Resend email, MSG91 Flow / Twilio SMS, WhatsApp Cloud API (template names), push via a P04 seam. Every attempt recorded in `notification_deliveries` (status, provider id, error, attempts). Purpose consent (transactional / operational / coaching / promotional) checked at enqueue **and again at send**; quiet hours in branch time defer; dedupe keys (unique index); missing template variables refuse the send with the reason; 4xx = permanent failure, 5xx/429/network = bounded retries with backoff. Scheduler job `deliver-notifications`. Automations, dunning and (later) broadcasts send through it; the Automations UI shows each channel's real availability.
3. **Member messaging**: start a thread with my coach or my branch front desk (topic picker), outside-hours copy from branch hours, attachments (JPEG/PNG/WebP/PDF by magic bytes, ≤ 10 MB) through a `MediaStorage` port with HMAC-signed short-lived URLs that re-check authorization; minors refused unless the tenant allows staff↔minor threads. Admin **Inbox** module: list, assignment, staff read state, reply, internal notes in `conversation_notes` (never serialized to members). Member thread keeps queued (outbox) messages visible after navigation.
4. **Community**: comments UI, report, block, mute; blocked content hidden both ways incl. challenge leaderboards; rate limits → 429; tenant approval mode (posts wait as `pending`); minors have no public profile. Admin **Community** module: reports queue with context, hide/remove with reason (audited, author notified in-app), restore, ban from community, approval queue.
5. **Tasks**: `tasks` table, generator job from operational alerts (lead SLA breach, failed payment, at-risk member, safety work order, overdue waitlist offer) with idempotent `generation_key`; manual tasks; assignee/due/priority/status/source link/outcome; "Create task" from Command Center alerts and member/lead detail; status strip `alertCount` wired and "My tasks" chip.
6. **Coach view (Nutrition & Habits)**: trainer sees assigned members only; habit adherence + weekly check-ins; assign habit templates; feedback (notifies member via the service, coaching purpose); safety-flagged check-ins surfaced; opted-out members excluded.
7. **Broadcasts (Marketing)**: segment (status, branch, tags, last visit, membership end window), preview with exclusion counts (consent, quiet hours, opt-out, no destination) and cost per channel from a configurable rate table; dry run; owner approval (step-up) above a threshold; send via the service; delivery outcome report.
8. **Command palette**: server search (`/v1/admin/search`) over members, leads, invoices, classes, staff (permission- and scope-aware), actions (Add member, Record payment, Check in member, Create class, New task), ARIA combobox/listbox, keyboard, recent items.
9. **Quick add member**: short form with duplicate detection (link to an in-scope existing member), enrollment service, optional plan, activation issuance.
10. Tests (API integration, domain unit, component tests per new screen state, e2e per module), docs, PR description.

## Checklist (mirrors P07-progress.json)

1. AC1 Channel tests: log driver `logged`; real drivers vs local fakes record provider ids, 4xx/5xx with bounded retries; opt-out after queueing prevents the send; missing template variable prevents send with reason; quiet hours defer; network guard.
2. AC2 Messaging tests: coach + front-desk threads; minor rule; internal notes never in member payloads; attachments signed URLs + authorization.
3. AC3 Community tests: report → queue → remove → hidden + author notified; block both ways incl. shared groups; rate limit 429; approval mode.
4. AC4 Task tests: no duplicates across scheduler runs; branch scope 404; outcome on completion; status-strip count.
5. AC5 Coach tests: trainer sees only assigned; safety phrase → coach flag, no analytics event; opted-out excluded.
6. AC6 Broadcast tests: preview counts = actual recipients; threshold approval; dry run no deliveries; cost = recipients × rate.
7. AC7 Quick add: duplicate detection with link; created member can be activated.
8. AC8 Palette: e2e keyboard flow to member detail; Record payment action opens payment flow; axe clean.
9. AC9 Every new screen has loading/empty/error/permission/offline states with component tests; e2e per module primary flow; standard gates + `pnpm e2e`.
10. navFor permission-aware for new modules; reception ≤ 7 (test).
11. Automations + dunning use the service; Automations UI shows real channel availability.
12. Docs (.env.example, docs/, README) and PR description `pr/P07.md`.

## Decisions and assumptions

**Navigation**
- Reception had 8 rail modules before this phase; the spec requires ≤ 7 with new modules added. `navFor` is now the *rail* and `modulesFor` everything the role may open. Reception's rail: Command, Inbox, Members, Floor, Billing, Schedule, Leads. Store, Support and Tasks stay reachable from ⌘K, and My tasks is always in the status strip. Owners and managers see every module.
- The Inbox is its own module (`inbox.view`), not a Support tab: trainers must answer coach threads and must not see the support queue. New permissions: `inbox.view`, `task.view`, `task.manage`, `broadcast.send`, `broadcast.approve` (owner only). Coach view uses the existing `training.assign`; Community uses the existing `community.moderate`.

**Notifications**
- Purpose model: transactional (no opt-out), operational and coaching (on until switched off via new consent rows `notifications_operational` / `notifications_coaching`, shown in Profile consents), promotional (metered channels need `marketing_<channel>`; in-app/push allowed). Automations keep their old consent semantics by sending as *promotional*.
- Quiet hours defer everything except in-app and transactional messages.
- Automations still refuse to go live on a channel whose driver is `log` (the existing "Provider required" gate and its test stay as they were): `providerAvailable` now means "a real driver delivers". With a real driver, automation deliveries are handed to the service. Dunning sends in-app always and the step's own channel through the service (logged when no provider).
- Email: Resend only. SMTP was listed in the spec but is not HTTP and would need a new dependency (nodemailer) or a hand-written SMTP client; deferred and recorded here.
- MSG91 uses the Flow API (DLT template per message or `SHARK_MSG91_NOTIFY_FLOW_ID`); WhatsApp Cloud API requires a template name per message (no free-form business-initiated messages). Both refuse permanently with the reason when no template is given.
- Retries: 4xx (except 408/429) is permanent; 5xx/429/408/network retry at +1 min and +5 min, 3 attempts total.
- A network guard (vitest `setupFiles`) refuses non-loopback hosts for `fetch`, `http.request/get`, `https.request/get` in every API test.

**Messaging**
- Attachments: no P05 on this branch, so a minimal `MediaStorage` port (local disk, `SHARK_MEDIA_DIR`; default beside SHARK_DB outside production; unset in production = uploads off) and HMAC signed paths (5 min) live in `lib/media-storage.ts`. JPEG APP1/APP13/COM and PNG text/eXIf/tIME chunks are stripped server-side; PDFs are served as downloads; type is decided by magic bytes.
- Client-supplied attachment URLs are always refused now (the old provider-truthfulness test was split: "unavailable without storage" is still proven with storage switched off, and URL refusal is proven with storage on).
- Minor rule applies to starting a thread, member sends and staff replies on coach/desk threads. Support tickets keep their own flow.
- An unassigned thread is assigned to whoever replies first.

**Community**
- Hide = reversible, the author still sees it with the reason; Remove = tombstone for everyone. Restore and "keep it" (dismiss) also exist. Removal/hide/restore/approve/reject/ban notices are transactional in-app messages.
- Mute is one-way and feed-only; block is two-way and also anonymises the other person on shared challenge boards (existing board logic, now tested).
- Minors' names show as "A member" in the feed (no public profile).

**Tasks**
- Generated sources and keys: `lead_sla:<lead>:<nextActionAt|stale>` (a new missed action is a new task), `failed_payment:<payment>`, `member_risk:<member>:<YYYY-MM>`, `safety_work_order:<order>`, `waitlist_offer:<entry>` (an *offered* entry past its expiry for a class still to come). Generated tasks are not auto-closed when the source resolves; staff close them with an outcome (an outcome is required).
- The strip's previously unused `alertCount` now shows the open alert-born tasks in scope ("to act on") for task managers.

**Broadcasts**
- Quiet hours do not exclude recipients; they are counted as "held until quiet hours end" and remain recipients. Default approval threshold 200 recipients; default rates email ₹0.10, SMS ₹0.25, WhatsApp ₹0.80 (configurable via `PATCH /v1/admin/settings/engagement`, owner, audited). A broadcast only supports `{{firstName}}`.
- Approval needs `broadcast.approve` (owner) plus step-up (`requireFreshAuth('broadcast.approve')`); the console's existing re-auth dialog handles it.

**Quick add**
- Duplicate in scope → 409 with `details.existing` (link); duplicate elsewhere → 409 naming nobody (existing enrolment rule). Activation uses the existing issue/redeem flow; without an email the form says the link needs one.

**Palette**
- Matching actions rank above search hits (typing "record" means the command). Record payment opens Billing on the chosen invoice with the payment sheet (`/billing?invoice=…&pay=1`); Check in member opens Floor searched for that member (`/floor?q=`); Create class opens the recurring-class form (`/schedule?tab=series&create=1`).

**Tests and harness**
- e2e helpers now wait out the 10-per-minute password sign-in limit (reading `retryAfterSec`) and extend the spec timeout by that wait; P06's `console-session` and `console-two-step` use the same helper. Nothing about the limit itself changed.
- Dependency added: `@axe-core/playwright` 4.10.2 (e2e dev only) for the palette accessibility check required by AC8.

## Integration notes

1. **P05 media**: replace `localDiskStorage`, `signMediaPath`, `verifyMediaSignature`, `sniffMime` and `stripImageMetadata` in `apps/api/src/lib/media-storage.ts` with P05's port/adapter/signer (same names used by `services/messaging.ts` only). Both phases add `SHARK_MEDIA_DIR` to `lib/config.ts` and `.env.example`; keep one. Add the attachments folder to P05's media backup tar.
2. **P04 push**: register the web-push driver with `setNotificationDrivers({ push: webPushDriver })` from `services/notifications/drivers.ts` (interface `ChannelDriver`; `to` is the user id, the driver looks up subscriptions). Until then push deliveries are suppressed "not set up". P04's own reminders should call `queueNotification` with `channel: 'push'`.
3. **P02 payments**: `payment.failed` rows created by Razorpay will feed the failed-payment task generator automatically (it reads `payments.state = 'failed'`). The palette's Record payment opens Billing's manual sheet; if P02 changes `RecordPaymentSheet`, keep the `initialSheet` prop on `InvoiceDetailPanel`.
4. **P03 website / member app at `/app/`**: member links in notifications are app-relative (`/messages/…`, `/pack`, `/habits`, `/billing`); e2e specs use `/messages/new` and `/pack` at the root and need `/app/` prefixes after P03.
5. **Migration**: `0019_engagement_ops.sql` (+ snapshot). Renumber if another phase adds a 0019, then run `pnpm -F @shark/api db:check-drift`. The migration ends with a backfill of `conversations.branch_id`.
6. **Shared files touched (additions)**: `packages/domain` (permissions, nav, `notifications.ts`), `apps/api/src/app.ts` (mounts), `lib/config.ts` (notify + media vars), `jobs/scheduler.ts` (two jobs), `db/seed.ts` (conversation branch/topic), `db/seed-tables.ts`, admin `router.tsx`, `ui/shell.tsx` (palette moved to `ui/CommandPalette.tsx`, strip chips), `e2e/support/demo.ts`, `e2e/global-setup.ts` (`SHARK_MEDIA_DIR`), lockfile.

### E2E specs P08 could add
- Attachments upload and view in the member thread and the staff Inbox (API-tested; e2e not written).
- Approval mode end to end (member post waits, manager approves).
- Broadcast above threshold with owner step-up in the browser.
- Minor refusal screen in the member app.
