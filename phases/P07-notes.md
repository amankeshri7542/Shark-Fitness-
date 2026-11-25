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

(filled in as the work proceeds)

## Integration notes

(filled in as the work proceeds)
