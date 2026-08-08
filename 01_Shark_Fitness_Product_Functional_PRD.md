# Shark Fitness
## Product and Functional Requirements Document

## Document governance

**Status:** Normative build specification  
**Version:** 2.0  
**Last reviewed:** 6 August 2026  
**Product:** Shark Fitness, multi-tenant gym management and member engagement SaaS  
**Primary surfaces:** Admin Web Dashboard, Member Mobile App, responsive trainer workflows, SaaS Super Admin  

### Requirement language

- **MUST / SHALL:** mandatory for production acceptance.
- **SHOULD:** expected unless an Architecture Decision Record documents a justified exception.
- **MAY:** optional or tenant-configurable.
- A feature is not complete because a screen exists. Completion requires authorization, validation, persistence, error states, auditability where applicable, analytics, tests, and documentation.

### Cross-document precedence

When requirements conflict, agents SHALL apply this order:

1. **Enterprise/Compliance PRD** for law, privacy, security, retention, audit, accessibility, and operational controls.
2. **Engineering/Technical PRD** for architecture, contracts, data integrity, concurrency, deployment, and testing.
3. **Design/UIUX PRD** for interaction, navigation, visual hierarchy, responsive behavior, accessibility implementation, and states.
4. **Product/Functional PRD** for business scope, roles, workflows, product rules, and outcomes.

No agent may silently resolve a contradiction. It must cite the requirement IDs, select the higher-precedence rule, and record the decision in an ADR or product decision log.

### Canonical companion files

- [01_Shark_Fitness_Product_Functional_PRD.md](./01_Shark_Fitness_Product_Functional_PRD.md)
- [02_Shark_Fitness_Engineering_Technical_PRD.md](./02_Shark_Fitness_Engineering_Technical_PRD.md)
- [03_Shark_Fitness_Design_UIUX_PRD.md](./03_Shark_Fitness_Design_UIUX_PRD.md)
- [04_Shark_Fitness_Enterprise_Compliance_PRD.md](./04_Shark_Fitness_Enterprise_Compliance_PRD.md)

### AI-agent execution contract

Every implementation agent SHALL:

1. Read all four PRDs plus current ADRs before changing code.
2. State the requirement IDs being implemented.
3. List assumptions before implementation; assumptions may not override a SHALL requirement.
4. Preserve tenant and branch isolation in every read, write, cache key, event, export, and log.
5. Reuse canonical schemas and enums. Do not create duplicate client-only domain models.
6. Implement loading, empty, error, permission-denied, offline, retry, and destructive-confirmation states where relevant.
7. Add migrations, seed/fixture updates, observability, tests, and documentation in the same change.
8. Run formatting, linting, type checks, unit tests, integration tests, and affected end-to-end tests.
9. Report changed files, verification evidence, unresolved risks, and follow-up work.
10. Never claim compliance, performance, or completion without evidence.


# Purpose and scope

This document defines **what Shark Fitness must do**, for whom, and under which business rules. It is the primary source for product scope and functional behavior. It intentionally avoids implementation details except where a business guarantee depends on them.

The product is not limited to an MVP. It describes the complete commercial platform intended for independent gyms, studios, personal-training businesses, multi-branch clubs, franchise operators, and regional chains. Features may be packaged or feature-flagged, but missing implementation must not be disguised as a plan restriction.

# Normative functional requirement registry

The narrative feature catalog later in this document remains authoritative. This registry adds stable IDs for implementation, tests, tickets, and traceability.

## PF-TEN: Tenant, gym and branch setup

- **PF-TEN-001 — SHALL:** Create a tenant with legal name, display name, owner, subscription plan, locale, currency, tax profile, timezone, and data-processing settings.
- **PF-TEN-002 — SHALL:** Create one or more branches with independent address, hours, holidays, capacity, rooms, amenities, contact details, and access policies.
- **PF-TEN-003 — SHALL:** Configure tenant-wide defaults and branch overrides with explicit inheritance indicators.
- **PF-TEN-004 — SHALL:** Support draft, active, temporarily closed, suspended, and archived branch states without deleting historical records.
- **PF-TEN-005 — SHALL:** Apply branding, feature flags, quotas, terminology, unit system, and notification sender configuration per tenant.
- **PF-TEN-006 — SHALL:** Provide a guided setup checklist whose completion status is visible to authorized owners.

### Required edge-case coverage

- Owner creates a branch in a different timezone.
- Branch closes temporarily while future bookings exist.
- Tenant changes currency after invoices exist.
- A branch is archived while members retain cross-branch entitlement.

### Module completion rule

PF-TEN is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-DASH: Owner and operations dashboard

- **PF-DASH-001 — SHALL:** Display permission-scoped KPIs for active members, check-ins, occupancy, revenue, collections, expiring plans, leads, classes, and operational alerts.
- **PF-DASH-002 — SHALL:** Allow every KPI to drill into the filtered source list that produced it.
- **PF-DASH-003 — SHALL:** Show data freshness and clearly distinguish real-time, near-real-time, and batch-calculated metrics.
- **PF-DASH-004 — SHALL:** Allow authorized users to save branch, date-range, and comparison presets.
- **PF-DASH-005 — SHALL:** Surface actionable exceptions before vanity metrics, including failed payments, access denials, class overbooking, and member-risk tasks.
- **PF-DASH-006 — SHALL:** Provide compact mobile/tablet layouts for managers without reproducing the full desktop information density.

### Required edge-case coverage

- User has access to only two of ten branches.
- No prior comparison period exists.
- A KPI source provider is temporarily unavailable.
- Different widgets use different reporting cut-off times.

### Module completion rule

PF-DASH is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-CRM: Lead and sales CRM

- **PF-CRM-001 — SHALL:** Capture leads from manual entry, self-service forms, referrals, campaigns, imports, trial bookings, and API/webhooks.
- **PF-CRM-002 — SHALL:** Deduplicate leads by normalized phone, email, and configurable identity rules while preserving source attribution.
- **PF-CRM-003 — SHALL:** Manage configurable pipeline stages, owners, next actions, tasks, notes, communication history, loss reasons, and expected value.
- **PF-CRM-004 — SHALL:** Support trials, tours, waivers, follow-up sequences, offers, and conversion into a member without re-entering data.
- **PF-CRM-005 — SHALL:** Attribute conversion and revenue to source, campaign, salesperson, branch, and referral where available.
- **PF-CRM-006 — SHALL:** Provide SLA alerts for untouched, overdue, and high-intent leads.

### Required edge-case coverage

- Two branches capture the same person.
- A lead uses a shared family phone number.
- A converted member submits another trial form.
- A salesperson leaves with open leads.

### Module completion rule

PF-CRM is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-MEM: Member management

- **PF-MEM-001 — SHALL:** Maintain a unified member profile containing identity, contact, emergency contact, preferences, membership, attendance, billing, training, progress, consent, documents, tags, and internal notes.
- **PF-MEM-002 — SHALL:** Support lifecycle states including trial, active, frozen, grace, expired, suspended, former, corporate, dependent, and digital-only.
- **PF-MEM-003 — SHALL:** Support family/dependent relationships, corporate sponsorship, branch access, trainer assignments, and communication preferences.
- **PF-MEM-004 — SHALL:** Allow safe merge of duplicate members with preview, conflict handling, immutable audit, and provider-account reconciliation.
- **PF-MEM-005 — SHALL:** Support bulk tag, assignment, message, export, membership action, and archive operations with permission checks and dry-run summaries.
- **PF-MEM-006 — SHALL:** Separate member-visible notes from private staff notes and sensitive coaching/health fields.

### Required edge-case coverage

- Duplicate records contain conflicting dates of birth.
- Primary account holder is deleted but dependents remain.
- Member transfers branches mid-billing-cycle.
- A former member rejoins with the same identity.

### Module completion rule

PF-MEM is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-CAT: Memberships, packages, credits and products

- **PF-CAT-001 — SHALL:** Create versioned products for memberships, class packs, personal-training credits, trials, day passes, corporate plans, digital plans, add-ons, and retail bundles.
- **PF-CAT-002 — SHALL:** Configure price, tax, billing cadence, commitment, access rights, branch scope, booking priority, usage limits, freeze rules, cancellation policy, and eligibility.
- **PF-CAT-003 — SHALL:** Preserve purchased product terms even when the catalog product changes later.
- **PF-CAT-004 — SHALL:** Support upgrades, downgrades, renewals, extensions, transfers, pauses, grace periods, and proration according to explicit policy.
- **PF-CAT-005 — SHALL:** Track entitlements independently from payment records so failed or refunded payments can be resolved deterministically.
- **PF-CAT-006 — SHALL:** Prevent invalid combinations and show a human-readable explanation before purchase or assignment.

### Required edge-case coverage

- Product is retired while active members use it.
- Upgrade occurs during a freeze.
- A class credit expires during a provider outage.
- Corporate sponsor removes one employee.

### Module completion rule

PF-CAT is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-BILL: Billing, payments, invoices and revenue recovery

- **PF-BILL-001 — SHALL:** Generate invoices and receipts with immutable line items, tax calculation, numbering rules, currency, discounts, credits, and payment status.
- **PF-BILL-002 — SHALL:** Record online and offline payments while differentiating cash, card, bank transfer, UPI, wallet, voucher, and provider settlement states.
- **PF-BILL-003 — SHALL:** Process provider webhooks idempotently, verify signatures, preserve raw event metadata, and tolerate duplicate or out-of-order delivery.
- **PF-BILL-004 — SHALL:** Support full and partial refunds, credit notes, voids, write-offs, chargebacks, payment links, and reconciliation.
- **PF-BILL-005 — SHALL:** Run configurable dunning with retry rules, grace access, staff tasks, and communication preferences.
- **PF-BILL-006 — SHALL:** Expose owner-level revenue, tax, outstanding balance, settlement, refund, and collection reports without storing raw card or UPI credentials.

### Required edge-case coverage

- Payment succeeds after the user closes checkout.
- Webhook arrives before redirect confirmation.
- Refund is requested after entitlements were partly consumed.
- Cash payment is entered twice by different staff.

### Module completion rule

PF-BILL is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-ATT: Attendance, check-in and access

- **PF-ATT-001 — SHALL:** Support dynamic QR, staff-assisted, kiosk, device, manual, and future hardware-controller check-in methods.
- **PF-ATT-002 — SHALL:** Validate membership status, branch entitlement, time window, anti-passback rules, capacity, suspension, and outstanding-policy exceptions server-side.
- **PF-ATT-003 — SHALL:** Create occupancy sessions with reliable check-in/check-out behavior and automatic closure policy.
- **PF-ATT-004 — SHALL:** Display reasoned access denials and an authorized override workflow with mandatory reason and audit entry.
- **PF-ATT-005 — SHALL:** Prevent replay of dynamic QR tokens and rapid duplicate scans while providing an offline contingency procedure.
- **PF-ATT-006 — SHALL:** Synchronize occupancy and attendance changes to relevant dashboards in near real time.

### Required edge-case coverage

- Member has no network at the door.
- A screenshot of a QR is reused.
- Member is entitled to another branch only.
- Gym closes while users remain checked in.

### Module completion rule

PF-ATT is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-SCH: Classes, courses and appointments

- **PF-SCH-001 — SHALL:** Create class types, sessions, recurring series, courses, appointments, rooms, resources, trainers, capacity, and eligibility rules.
- **PF-SCH-002 — SHALL:** Support booking, cancellation, waitlist, promotion, late cancellation, no-show, guest booking, and credit consumption.
- **PF-SCH-003 — SHALL:** Make last-seat allocation transactional and prevent overbooking under concurrent requests.
- **PF-SCH-004 — SHALL:** Notify affected members when a session is changed, cancelled, relocated, or assigned a replacement trainer.
- **PF-SCH-005 — SHALL:** Support booking windows, cancellation deadlines, member priority, branch timezone, holidays, and series exceptions.
- **PF-SCH-006 — SHALL:** Provide utilization, fill-rate, no-show, waitlist-conversion, and trainer-capacity analytics.

### Required edge-case coverage

- Two members request the last seat.
- Recurring class crosses daylight-saving transition.
- Trainer changes one occurrence only.
- Waitlisted member lacks required credits when promoted.

### Module completion rule

PF-SCH is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-STAFF: Trainers, staff, rosters and compensation

- **PF-STAFF-001 — SHALL:** Manage staff identity, employment status, branches, roles, specialties, certifications, availability, schedules, and permissions.
- **PF-STAFF-002 — SHALL:** Assign trainers to members, programs, assessments, classes, appointments, and follow-up tasks.
- **PF-STAFF-003 — SHALL:** Support shift planning, attendance, substitutions, leave, conflicts, and coverage warnings.
- **PF-STAFF-004 — SHALL:** Calculate configurable commissions for sessions, packages, sales, renewals, and classes while preserving calculation evidence.
- **PF-STAFF-005 — SHALL:** Restrict trainers to assigned members and permitted sensitive fields by default.
- **PF-STAFF-006 — SHALL:** Provide workload, utilization, retention, sales, class, and coaching-quality metrics with fair interpretation warnings.

### Required edge-case coverage

- Trainer serves multiple branches.
- Trainer leaves with active programs.
- Commission rule changes mid-period.
- Substitute trainer should not see private notes.

### Module completion rule

PF-STAFF is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-WORK: Exercise library and workout programming

- **PF-WORK-001 — SHALL:** Maintain a structured exercise library with canonical name, aliases, instructions, cues, equipment, muscles, difficulty, contraindication flags, substitutions, and media.
- **PF-WORK-002 — SHALL:** Build reusable programs with weeks, days, exercises, sets, reps, load, tempo, RPE/RIR, rest, supersets, circuits, notes, progression, and deload rules.
- **PF-WORK-003 — SHALL:** Assign and version programs without mutating completed workout history.
- **PF-WORK-004 — SHALL:** Allow fast mobile logging with previous performance, timers, substitutions, warm-ups, notes, personal records, and offline operation.
- **PF-WORK-005 — SHALL:** Sync client-generated workout entities idempotently and resolve duplicate or conflicting edits predictably.
- **PF-WORK-006 — SHALL:** Provide trainer review, adherence, volume, exercise, muscle-group, and progression analytics.

### Required edge-case coverage

- Program is edited during an active workout.
- The same workout syncs twice after reconnect.
- Exercise is archived but exists in history.
- Member substitutes equipment at another branch.

### Module completion rule

PF-WORK is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-PROG: Assessments, goals and progress

- **PF-PROG-001 — SHALL:** Create configurable assessment templates with measurement units, questionnaires, photos, notes, and trainer-only fields.
- **PF-PROG-002 — SHALL:** Track goals with baseline, target, target date, milestones, status, and responsible coach.
- **PF-PROG-003 — SHALL:** Present trends for body measurements, attendance, strength, volume, habits, class participation, and selected health integrations.
- **PF-PROG-004 — SHALL:** Store progress photos privately with consent, retention, visibility, and deletion controls.
- **PF-PROG-005 — SHALL:** Explain measurement uncertainty and avoid presenting non-medical estimates as diagnosis.
- **PF-PROG-006 — SHALL:** Allow members to control which progress elements are visible to trainers or community features.

### Required edge-case coverage

- Measurement units change.
- Photo upload fails after metadata save.
- Member revokes photo consent.
- Goal becomes unsafe or unrealistic.

### Module completion rule

PF-PROG is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-NUTR: Nutrition, recovery and habits

- **PF-NUTR-001 — SHALL:** Support lightweight calorie/macro goals, meal logging, photo logging, water, sleep, steps, recovery, and configurable habits.
- **PF-NUTR-002 — SHALL:** Allow coach-created nutrition guidance and templates without presenting the system as medical care.
- **PF-NUTR-003 — SHALL:** Provide weekly check-ins containing adherence, energy, hunger, sleep, soreness, mood, and free-text context.
- **PF-NUTR-004 — SHALL:** Use member preferences, allergies, exclusions, culture, and unit system when presenting guidance.
- **PF-NUTR-005 — SHALL:** Detect and safely handle content indicating injury, eating-disorder risk, extreme restriction, or medical symptoms.
- **PF-NUTR-006 — SHALL:** Allow complete opt-out from nutrition and recovery modules.

### Required edge-case coverage

- Member reports pregnancy or injury.
- A coach enters unsafe calorie targets.
- Health integration sends duplicate days.
- Member deletes a meal photo but keeps totals.

### Module completion rule

PF-NUTR is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-AI: Adaptive training and AI assistance

- **PF-AI-001 — SHALL:** Generate training changes through deterministic, versioned rules using goals, history, volume, recovery, equipment, missed sessions, and safety exclusions.
- **PF-AI-002 — SHALL:** Use generative models only for bounded explanation, summarization, content drafting, and approved knowledge assistance.
- **PF-AI-003 — SHALL:** Show why a recommendation changed, the inputs used, confidence/limitations, and an override or trainer-review path.
- **PF-AI-004 — SHALL:** Apply provider allowlists, redaction, output schemas, safety filters, rate limits, tenant quotas, and cost caps.
- **PF-AI-005 — SHALL:** Never autonomously diagnose, prescribe treatment, ignore injury, or publish high-impact changes without configured review.
- **PF-AI-006 — SHALL:** Log model/provider/version, prompt template version, policy decision, cost, latency, and user feedback without exposing secrets.

### Required edge-case coverage

- Model provider is unavailable.
- Generated output violates schema.
- Member prompt contains injection text.
- Recommendation conflicts with trainer lock.

### Module completion rule

PF-AI is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-GAME: Gamification, challenges, community and referrals

- **PF-GAME-001 — SHALL:** Support streaks, achievements, XP ledger, levels, challenges, teams, leaderboards, rewards, and referral campaigns.
- **PF-GAME-002 — SHALL:** Calculate every reward from auditable events and make corrections through compensating ledger entries rather than destructive edits.
- **PF-GAME-003 — SHALL:** Provide private, friends/team, branch, and tenant visibility settings.
- **PF-GAME-004 — SHALL:** Use fairness rules that avoid rewarding unsafe exercise volume or disadvantaging new, older, disabled, or lower-frequency members.
- **PF-GAME-005 — SHALL:** Provide reporting, blocking, moderation, rate limits, and escalation for community content.
- **PF-GAME-006 — SHALL:** Track referral attribution, eligibility, anti-fraud rules, reward status, and expiration.

### Required edge-case coverage

- Workout is deleted after XP was granted.
- Two users share the same referral device.
- A leaderboard encourages unsafe volume.
- Blocked users share a group.

### Module completion rule

PF-GAME is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-COMM: Messaging, notifications and automation

- **PF-COMM-001 — SHALL:** Provide one-to-one and approved group conversations with message status, attachments, moderation, and staff boundaries.
- **PF-COMM-002 — SHALL:** Support in-app, push, email, SMS, and WhatsApp through channel adapters and per-purpose consent/preferences.
- **PF-COMM-003 — SHALL:** Create versioned templates with variables, preview, localization, sender identity, and fallback behavior.
- **PF-COMM-004 — SHALL:** Provide event-triggered automations with conditions, delays, quiet hours, deduplication, stop conditions, approvals, and dry-run mode.
- **PF-COMM-005 — SHALL:** Record delivery attempts, provider responses, retries, bounces, opt-outs, and action attribution.
- **PF-COMM-006 — SHALL:** Enforce tenant quotas and display estimated metered cost before large sends.

### Required edge-case coverage

- Member opts out after a job is queued.
- Template variable is missing.
- Provider delivers webhook twice.
- Automation re-enters itself through an emitted event.

### Module completion rule

PF-COMM is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-MEDIA: Live and on-demand content

- **PF-MEDIA-001 — SHALL:** Create live sessions with entitlement, capacity, trainer, schedule, reminders, chat, reactions, attendance, recording, and replay policy.
- **PF-MEDIA-002 — SHALL:** Deliver video through a managed streaming provider; business APIs and Durable Objects shall not proxy video bytes.
- **PF-MEDIA-003 — SHALL:** Provide an on-demand library with categories, search, progress, favorites, captions, access rules, and expiry.
- **PF-MEDIA-004 — SHALL:** Support moderation, participant removal, chat controls, copyright/consent confirmation, and incident handling.
- **PF-MEDIA-005 — SHALL:** Track stored and delivered minutes by tenant and enforce hard quotas before provider overage.
- **PF-MEDIA-006 — SHALL:** Provide graceful fallback when live video is unavailable while preserving class communications and attendance review.

### Required edge-case coverage

- Trainer stream starts late.
- Recording consent is missing.
- A member shares a playback URL.
- Video quota is exhausted mid-month.

### Module completion rule

PF-MEDIA is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-POS: Point of sale and inventory

- **PF-POS-001 — SHALL:** Manage retail products, variants, barcodes, tax, price, cost, suppliers, reorder thresholds, and branch stock.
- **PF-POS-002 — SHALL:** Create POS orders with member lookup, discounts, tax, mixed payment, receipt, return, void, and staff attribution.
- **PF-POS-003 — SHALL:** Track stock movements as an immutable ledger for purchase, sale, return, transfer, adjustment, and damage.
- **PF-POS-004 — SHALL:** Prevent negative stock unless a tenant explicitly enables it and records an override reason.
- **PF-POS-005 — SHALL:** Support stock transfer between branches with dispatch and receipt states.
- **PF-POS-006 — SHALL:** Provide margin, stock valuation, shrinkage, low-stock, and sales reports.

### Required edge-case coverage

- Payment succeeds but stock update fails.
- Item is returned to another branch.
- Barcode is duplicated.
- Stocktake conflicts with pending transfer.

### Module completion rule

PF-POS is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-FAC: Equipment and facility operations

- **PF-FAC-001 — SHALL:** Maintain equipment registry with branch, area, model, serial, vendor, warranty, documents, status, and QR identifier.
- **PF-FAC-002 — SHALL:** Schedule preventive maintenance and create work orders, assignments, costs, downtime, and completion evidence.
- **PF-FAC-003 — SHALL:** Allow members or staff to report issues with controlled visibility, media, severity, and location.
- **PF-FAC-004 — SHALL:** Track incidents, hazards, investigations, corrective actions, and restricted notes.
- **PF-FAC-005 — SHALL:** Create recurring facility tasks, inspections, checklists, and escalation.
- **PF-FAC-006 — SHALL:** Expose equipment downtime, recurring fault, maintenance cost, and completion metrics.

### Required edge-case coverage

- Equipment moves branches.
- Duplicate issue reports describe one fault.
- An incident contains sensitive personal data.
- Maintenance is overdue while equipment remains available.

### Module completion rule

PF-FAC is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-SUP: Support, feedback and retention

- **PF-SUP-001 — SHALL:** Provide member support tickets with category, priority, SLA, assignment, messages, attachments, and resolution.
- **PF-SUP-002 — SHALL:** Collect transactional feedback, NPS/CSAT, class ratings, trainer feedback, and cancellation reasons with configurable anonymity.
- **PF-SUP-003 — SHALL:** Calculate explainable retention-risk signals from attendance, payment, engagement, and membership events.
- **PF-SUP-004 — SHALL:** Create staff intervention tasks with recommended action, due date, outcome, and effectiveness tracking.
- **PF-SUP-005 — SHALL:** Prevent automated high-pressure communication and respect quiet hours, opt-outs, and vulnerability indicators.
- **PF-SUP-006 — SHALL:** Provide complaint escalation and immutable records for disputes or safety incidents.

### Required edge-case coverage

- Member submits anonymous harassment report.
- Risk score rises because gym was closed.
- Ticket remains open after membership deletion.
- A cancellation request conflicts with contract terms.

### Module completion rule

PF-SUP is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-RPT: Reports and analytics

- **PF-RPT-001 — SHALL:** Provide financial, member, attendance, class, training, sales, staff, inventory, retention, and platform-usage reports.
- **PF-RPT-002 — SHALL:** Use consistent metric definitions, timezone cutoffs, currency, filters, comparison periods, and permission-scoped dimensions.
- **PF-RPT-003 — SHALL:** Support drill-down, saved views, scheduled delivery, CSV export, and asynchronous large exports.
- **PF-RPT-004 — SHALL:** Label estimated, delayed, incomplete, or model-derived values explicitly.
- **PF-RPT-005 — SHALL:** Protect sensitive columns and log exports of personal or financial data.
- **PF-RPT-006 — SHALL:** Maintain aggregate tables or jobs for expensive analytics rather than unbounded transactional scans.

### Required edge-case coverage

- Refund occurs after report snapshot.
- User lacks permission for one dimension.
- Large export exceeds synchronous limits.
- Tenant changes timezone.

### Module completion rule

PF-RPT is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-MBR: Multi-branch and franchise

- **PF-MBR-001 — SHALL:** Support tenant-wide and branch-scoped products, pricing, staff, members, classes, inventory, reports, and branding.
- **PF-MBR-002 — SHALL:** Allow member home branch, permitted branches, branch transfers, roaming limits, and cross-branch booking rules.
- **PF-MBR-003 — SHALL:** Provide regional roles and consolidated reports without leaking data to unauthorized branches.
- **PF-MBR-004 — SHALL:** Support branch-specific tax, currency where contractually permitted, timezone, holidays, capacity, access, and notification sender.
- **PF-MBR-005 — SHALL:** Provide branch templates and controlled propagation of changes with preview and exceptions.
- **PF-MBR-006 — SHALL:** Track inter-branch inventory, revenue attribution, trainer activity, and member utilization.

### Required edge-case coverage

- Member books across timezones.
- Branch is sold to another tenant.
- Franchise template conflicts with local law.
- Cross-branch payment needs revenue allocation.

### Module completion rule

PF-MBR is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-PLAT: SaaS super admin

- **PF-PLAT-001 — SHALL:** Create, suspend, restore, archive, and inspect tenants with reason, approval, audit, and customer notification policy.
- **PF-PLAT-002 — SHALL:** Manage plans, entitlements, quotas, feature flags, trial periods, invoices, platform payments, and usage meters.
- **PF-PLAT-003 — SHALL:** Provide service health, queue, webhook, error, cost, storage, and active-user observability at platform and tenant level.
- **PF-PLAT-004 — SHALL:** Allow time-bound support access only after explicit authorization, with prominent impersonation banner and complete audit.
- **PF-PLAT-005 — SHALL:** Provide tenant export, offboarding, deletion, legal hold, and dedicated-deployment workflows.
- **PF-PLAT-006 — SHALL:** Prevent super-admin tooling from bypassing immutable financial or security controls.

### Required edge-case coverage

- Tenant is suspended during live class.
- Support access expires mid-session.
- Tenant disputes usage bill.
- Deletion request conflicts with legal hold.

### Module completion rule

PF-PLAT is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.

## PF-INT: Integrations, API, webhooks, imports and exports

- **PF-INT-001 — SHALL:** Provide versioned provider adapters for payment, communication, health, access control, streaming, analytics, and AI.
- **PF-INT-002 — SHALL:** Expose a scoped public API with OAuth/API credentials, rate limits, idempotency, audit, pagination, and tenant isolation.
- **PF-INT-003 — SHALL:** Deliver signed, retryable, ordered-when-required webhooks with replay tools and delivery logs.
- **PF-INT-004 — SHALL:** Provide import mapping, validation, dry-run, row-level errors, deduplication, resumability, and rollback/compensation strategy.
- **PF-INT-005 — SHALL:** Provide export formats with schema version, timezone, units, permission checks, encryption for sensitive files, and expiry.
- **PF-INT-006 — SHALL:** Track integration health, credentials, last success, failures, rate limits, and tenant-visible remediation.

### Required edge-case coverage

- Provider rotates webhook secret.
- Import contains members from wrong tenant.
- Webhook consumer is unavailable for days.
- Health provider revokes authorization.

### Module completion rule

PF-INT is accepted only when permissions, audit behavior, notifications, analytics events, import/export behavior where relevant, and automated tests are complete for the listed requirements and edge cases.


# Canonical business state machines

Agents MUST use these canonical states and transition guards. Adding a state requires changes to shared contracts, migration strategy, analytics catalog, UI states, and tests.

## Membership state machine

```text
DRAFT → PENDING_PAYMENT → ACTIVE
ACTIVE → FROZEN → ACTIVE
ACTIVE → GRACE → ACTIVE | EXPIRED
ACTIVE → CANCEL_SCHEDULED → CANCELLED
ACTIVE | GRACE | FROZEN → SUSPENDED → prior permitted state
EXPIRED | CANCELLED → REJOINED (creates a new membership record)
```

Rules:

- A membership record represents purchased terms and is never silently rewritten when the catalog changes.
- Freeze extends expiry only when the product version says so.
- Suspension is an access decision and does not automatically refund or cancel billing.
- Rejoining creates a new membership lifecycle linked to prior history.
- Status changes record actor, reason, effective timestamp, source, and previous state.

## Invoice and payment state machines

```text
Invoice: DRAFT → OPEN → PARTIALLY_PAID → PAID
                  └→ VOID
OPEN | PARTIALLY_PAID → OVERDUE
PAID → PARTIALLY_REFUNDED → REFUNDED

Payment attempt: CREATED → REQUIRES_ACTION → PROCESSING → SUCCEEDED
                                         └→ FAILED | CANCELLED | EXPIRED
SUCCEEDED → PARTIALLY_REFUNDED → REFUNDED
SUCCEEDED → CHARGEBACK_OPEN → CHARGEBACK_WON | CHARGEBACK_LOST
```

Rules:

- Provider events are immutable inputs; derived payment state is recomputed idempotently.
- Membership activation follows entitlement policy, not browser redirect state.
- Raw card number, CVV, UPI PIN, or equivalent secrets are never stored.
- Refund state and entitlement reversal are separate decisions.

## Booking and waitlist state machines

```text
Booking: HELD → CONFIRMED → ATTENDED
                 ├→ CANCELLED
                 ├→ LATE_CANCELLED
                 └→ NO_SHOW
Waitlist: WAITING → OFFERED → CONFIRMED
                     ├→ EXPIRED
                     └→ DECLINED
```

- A hold has a server expiry and does not consume capacity after expiry.
- Capacity changes and waitlist promotion execute through a single concurrency authority.
- Promotion must re-check eligibility, credits, branch access, and membership status.
- Cancellation policy is evaluated using branch-local class time and stored policy version.

## Lead state machine

```text
NEW → CONTACTED → QUALIFIED → TRIAL_BOOKED → TRIAL_COMPLETED → WON
  └→ NURTURE ────────────────────────────────────────────────┘
Any non-WON state → LOST | DISQUALIFIED
LOST → REOPENED
```

- Each stage change records source, actor, timestamp, reason, and next action.
- Conversion links the lead to the member; it does not erase the lead timeline.

## Member account state

```text
INVITED → ACTIVE → DISABLED
ACTIVE → DELETION_REQUESTED → ANONYMIZED
ACTIVE | DISABLED → LEGAL_HOLD
```

- Member identity state is distinct from membership state.
- Anonymization preserves legally required financial and security records while removing or pseudonymizing permitted personal fields.

# Detailed functional catalog

# 0. Executive Summary

Shark Fitness is a production-grade gym operating system designed to replace disconnected spreadsheets, attendance registers, WhatsApp groups, generic workout trackers, and payment reminder workflows with one coordinated product.

The platform has two primary experiences:

1. **Shark Business Dashboard:** A premium web dashboard for owners, managers, reception staff, trainers, accountants, and franchise administrators.
2. **Shark Member App:** A fast, offline-capable iOS and Android app for membership self-service, gym access, class booking, workout execution, progress tracking, trainer communication, nutrition habits, challenges, and community engagement.

The product must compete on two dimensions simultaneously:

- **Operational depth:** Memberships, billing, attendance, classes, staff, leads, reporting, equipment, point of sale, branch management, and auditability.
- **Member desirability:** Fast workout logging, adaptive plans, visible progress, recovery insights, achievements, challenges, community, live content, and premium interaction design.

The central product loop is:

> Join or renew → enter the gym → know exactly what to do → log the workout quickly → see progress → receive accountability → return consistently.

The central business loop is:

> Capture lead → convert member → collect payment → monitor attendance → identify risk → intervene automatically → retain and upsell.

## 0.1 Product decision summary

- Build the **Admin Dashboard as a React single-page application**, not a server-rendered marketing site. SEO is irrelevant inside an authenticated operations product, and a SPA is lighter and simpler to host.
- Build the **Member App with React Native and Expo** to maximize delivery speed, shared TypeScript knowledge, agent compatibility, and native experience.
- Use a **Cloudflare-first serverless architecture** for strict cost control: Workers, D1, Durable Objects, R2, Queues, Cron Triggers, and optional Stream.
- Use **rules-first adaptive programming**, with AI used for explanation, summarization, content assistance, and bounded recommendations rather than uncontrolled workout generation.
- Use **feature flags and usage quotas** for expensive capabilities such as live video, WhatsApp, SMS, generative AI, and media processing.
- Design as **multi-tenant and multi-branch from the first schema**, even if the first commercial customer has one location.

## 0.2 Important budget truth

A complete sellable platform can keep its **core fixed infrastructure near $5-$15 per month at low-to-moderate early usage**, but a permanent hard cap of $15 cannot absorb unlimited live streaming, SMS, WhatsApp, email, AI inference, storage, and thousands of active members.

Therefore, the commercial architecture must enforce this policy:

- Core platform remains inside the base infrastructure allowance.
- Usage-based premium services are disabled by default, quota-limited, sold as add-ons, passed through to the gym, or configured as bring-your-own-provider.
- Every metered integration has account-level and tenant-level spending limits.

This is not optional. Without this separation, “production-grade, fully featured, and always below $15” is financially impossible at meaningful scale.

---

# 1. Product Strategy

## 1.1 Vision

Create the most usable gym management and member engagement platform for modern gyms: operationally serious enough for owners, visually desirable enough for members, and inexpensive enough for small gyms to adopt.

## 1.2 Product positioning

Shark Fitness should sit between two existing categories:

- Traditional gym-management products that are operationally capable but feel dated and impersonal.
- Consumer workout apps that look excellent but do not manage memberships, billing, trainers, facilities, or retention.

**Positioning statement:**

> Shark Fitness is the premium operating system for gyms that combines business management, coaching, and member motivation in one real-time experience.

## 1.3 Research synthesis

Current successful products repeatedly converge on the following capabilities:

- Gym-management platforms emphasize membership administration, automated billing, scheduling, bookings, access control, lead management, member self-service, reporting, and retention automation.
- Member-facing fitness products emphasize fast workout logging, reusable routines, previous-performance visibility, progress graphs, social feeds, leaderboards, achievements, and shareable results.
- Adaptive-training products emphasize training history, available equipment, muscle recovery, progressive overload, fatigue, and dynamic plan updates.
- Coaching platforms combine workouts, nutrition, habits, messaging, check-ins, payments, and automated engagement.
- Premium operators increasingly use live and on-demand content, digital waivers, self-service joining, waitlists, reviews, referral programs, dynamic offers, and multi-location management.

Shark Fitness will implement these patterns while avoiding feature clutter through role-aware navigation, staged disclosure, sensible defaults, and a strong design system.

## 1.4 Product principles

1. **The next action must always be obvious.** Every screen should answer “What should I do now?”
2. **Routine actions require minimal input.** Check-in, booking, logging a set, recording payment, and assigning a plan should be one to three interactions.
3. **Real-time where operationally important.** Check-ins, class seats, payment status, chat, and membership changes synchronize immediately.
4. **Offline where workouts are performed.** Workout execution must continue through weak or unavailable gym connectivity.
5. **Explain intelligence.** Adaptive recommendations must show why they changed.
6. **Premium, not noisy.** Motion, gradients, haptics, charts, and visual effects must communicate hierarchy and feedback rather than decorate every screen.
7. **Multi-tenant by construction.** Every business record is scoped to a tenant and normally to a branch.
8. **Automation must be reversible.** Staff can inspect, override, pause, and audit automated actions.
9. **Safety over engagement.** The system must never encourage unsafe volume, extreme dieting, injury dismissal, or manipulative streak behavior.
10. **Cost is a product requirement.** Every feature includes storage, compute, notification, and third-party cost implications.

## 1.5 Product goals

### Business goals

- Reduce front-desk administrative time.
- Improve recurring payment collection and renewal conversion.
- Reduce class no-shows and empty capacity.
- Improve attendance consistency and member retention.
- Create upsell paths for personal training, classes, nutrition, products, and premium digital content.
- Give owners reliable branch, staff, revenue, and retention visibility.

### Member goals

- Enter the gym without friction.
- Know what workout to perform.
- Log workouts quickly.
- Understand progress.
- Receive trainer support and useful reminders.
- Stay consistent through accountability and community.
- Manage bookings, payments, membership, and profile without contacting reception.

### Platform goals

- Support one gym through regional multi-branch operators.
- Preserve tenant isolation and complete auditability.
- Provide stable APIs, webhooks, imports, exports, and integration adapters.
- Remain inexpensive at early scale and predictable at larger scale.

## 1.6 Non-goals

- Medical diagnosis or injury treatment.
- Replacement for licensed dietitians, physiotherapists, or medical professionals.
- Fully autonomous AI-generated training without constraints or trainer review.
- Building proprietary payment rails.
- Building video transcoding infrastructure.
- Building custom door-control hardware in the first commercial rollout.
- Public social network discovery outside a gym’s tenant unless explicitly introduced later.

---

# 2. Users, Roles, and Permissions

## 2.1 SaaS platform roles

### Platform Super Admin

Manages gym tenants, plans, feature flags, service health, support access, billing, global templates, abuse controls, and platform-level audit logs.

### Platform Support Agent

Can inspect diagnostic information and, only with explicit time-limited authorization, impersonate a tenant administrator. Every support action is audited.

## 2.2 Gym business roles

### Gym Owner

- Full business access.
- Financials, branches, staff, products, reports, integrations, security, and subscription administration.
- Can create and restrict other roles.

### Regional/Franchise Manager

- Cross-branch operational access.
- Cannot modify platform subscription or ownership unless granted.

### Branch Manager

- Full operational control within assigned branches.
- Limited or aggregated financial permissions based on policy.

### Reception Staff

- Member lookup and onboarding.
- Check-in, manual payment recording, class booking, simple sales, and issue handling.
- No access to sensitive global reports or security settings.

### Trainer/Coach

- Assigned clients, assessments, programs, appointments, check-ins, messaging, habits, and progress.
- Cannot view unrelated financial records unless granted.

### Accountant

- Payments, invoices, refunds, payouts, reconciliation, taxes, and financial exports.
- No workout, private health note, or community moderation access by default.

### Marketing/CRM User

- Leads, segments, campaigns, offers, referrals, automations, and engagement metrics.
- No payment credentials or sensitive assessments.

### Equipment/Facility Staff

- Equipment inventory, maintenance schedules, incidents, and tasks.

### Custom Role

Owner-defined granular permissions. Permission assignment must support resource, action, and scope:

```text
resource: members
operation: read | create | update | delete | export
scope: own | assigned | branch | selected_branches | tenant
```

## 2.3 Member roles/statuses

- Lead
- Trial member
- Active member
- Frozen membership
- Grace-period member
- Expired member
- Suspended member
- Corporate member
- Family/dependent member
- Digital-only member
- Former member

## 2.4 Permission requirements

- Deny by default.
- Server-side enforcement for every API route.
- UI hiding is not authorization.
- Financial export, role changes, refunds, member deletion, and support impersonation require step-up authentication.
- Roles can be scoped to one or more branches.
- Sensitive fields can be protected separately from normal profile access.

---

# 3. Product Surfaces and Information Architecture

## 3.1 Admin Web Dashboard

The dashboard is a desktop-first responsive application that must work on tablets and remain usable on phones for urgent tasks.

### Primary navigation

1. Home
2. Leads
3. Members
4. Memberships
5. Billing
6. Attendance
7. Schedule
8. Training
9. Nutrition & Habits
10. Community
11. Staff
12. Sales & Store
13. Equipment
14. Marketing
15. Reports
16. Tasks
17. Settings

Navigation is permission-aware. Reception staff should not see sixteen modules when they only need five.

### Global controls

- Branch switcher
- Global search and command palette
- Create button with context-aware actions
- Notifications and operational alerts
- Pending approvals
- Help and support
- User profile and role
- Connection/sync status

## 3.2 Member Mobile App

### Bottom navigation

1. **Home**
2. **Train**
3. **Book**
4. **Community**
5. **Profile**

### Persistent contextual actions

- Digital access pass / QR
- Active workout mini-player
- Unread trainer message
- Current class/live session
- Offline/sync indicator

## 3.3 Trainer mobile behavior

Trainers primarily use the responsive business dashboard. A trainer role may later unlock a lightweight trainer mode inside the mobile codebase, but the first architecture must not require a separately maintained third application.

---

# 4. Detailed Functional Requirements

# 4.1 Tenant, Gym, and Branch Setup

## Business requirements

- Create a gym tenant with legal name, display name, contact details, timezone, currency, tax settings, language, and default units.
- Create multiple branches with address, geolocation, operating hours, holidays, capacity, amenities, access rules, and contact information.
- Configure gym type: open gym, class-based studio, personal-training facility, hybrid, corporate gym, residential gym, or franchise.
- Upload brand logo, icon, cover media, colors, typography selections, and app content.
- Preview member-app branding before publishing.
- Configure branch-specific plans, prices, classes, trainers, equipment, announcements, and policies.
- Copy configuration from an existing branch.
- Import members, plans, payments, attendance, and opening balances from CSV.
- Setup checklist with progress and validation.

## Acceptance criteria

- A tenant cannot access another tenant by changing any route identifier.
- A user assigned to one branch cannot view another branch unless explicitly granted.
- Currency, timezone, and tax behavior are consistent in dashboard, receipts, exports, and API data.
- Branding changes are versioned and can be previewed before publication.
# 4.2 Owner and Operations Dashboard

## Core widgets

- Active members
- Trial members
- New joins
- Memberships expiring in 7/15/30 days
- Payments due and overdue
- Revenue today, month-to-date, and trend
- Today’s check-ins
- Members currently inside
- Peak-hour occupancy graph
- Today’s classes and capacity
- Waitlist pressure
- Personal-training sessions
- At-risk members
- Failed payments
- Leads requiring follow-up
- Equipment issues
- Staff on duty
- Pending approvals
- Campaign performance

## Behavior

- Every widget links to the filtered operational list.
- Widgets respect role and branch scope.
- Dashboard layouts can be saved per role.
- Critical alerts have severity, owner, due date, and acknowledgement.
- Users can create a task directly from an insight.
- Dashboard data shows “last updated” and sync status.

## Premium interaction

- Live occupancy ring with restrained motion.
- Revenue and retention trends use clear comparative annotations, not decorative charts.
- Command palette supports actions such as “add member,” “record payment,” “check in member,” and “create class.”
# 4.3 Lead and Sales CRM

## Lead capture

- Manual lead creation.
- Public lead form and QR campaign links.
- Walk-in registration.
- Referral capture.
- Trial-class and trial-pass requests.
- Import from CSV.
- API and webhook capture from advertising systems.

## Lead record

- Name, phone, email, source, campaign, interested branch, goal, preferred time, preferred plan, budget range, notes, consent, owner, score, and status.
- Timeline of calls, messages, appointments, visits, offers, and status changes.
- Duplicate detection by phone/email.

## Pipeline

Default stages:

```text
New → Contacted → Appointment booked → Trial completed → Offer sent → Won/Lost
```

- Custom stages and reasons.
- Kanban and table views.
- Lead assignment rules.
- Follow-up tasks and overdue alerts.
- Sales scripts and templates.
- Conversion analytics by source, staff, branch, campaign, and offer.
- Lost reason analysis.

## Sales automation

- Immediate acknowledgement after lead creation.
- Reminder before trial.
- Follow-up after trial.
- Offer-expiry reminder.
- Re-engagement after inactivity.
- Human approval option before external messages.
# 4.4 Member Management

## Member profile

- Identity and contact information.
- Profile photo.
- Emergency contact.
- Date of birth and gender where legally permitted and relevant.
- Preferred language and communication channels.
- Home branch and allowed branches.
- Membership state.
- Active products and credits.
- Payment methods and history.
- Attendance summary.
- Class and appointment history.
- Assigned trainer.
- Goals, experience, injuries/limitations, equipment preferences, and assessment history.
- Training and habit adherence.
- Documents, contracts, waivers, receipts, and consent records.
- Private staff notes with visibility controls.
- Member timeline across all operational events.

## Member operations

- Add, edit, archive, suspend, merge duplicate, and anonymize.
- Transfer branch.
- Assign or change trainer.
- Apply tags and segments.
- Grant complimentary access or credits with reason and approval.
- Freeze, extend, upgrade, downgrade, cancel, or reactivate membership.
- Generate statement of account.
- Export member data.
- Data deletion request workflow.

## Bulk actions

- Assign tags.
- Send communication.
- Extend membership.
- Change branch.
- Export selected records.
- Assign trainer.
- Apply campaign.

Bulk financial or destructive actions require preview and explicit confirmation.
# 4.5 Memberships, Packages, Credits, and Products

## Product types

- Recurring membership
- Fixed-duration membership
- Pay-as-you-go membership
- Day pass
- Trial pass
- Class pack
- Session pack
- Personal-training package
- Digital-only subscription
- Corporate membership
- Family membership
- Add-on
- Promotional bundle
- Gift card

## Product configuration

- Name, description, internal code, branch availability, sales channel, tax category, price, joining fee, deposit, billing frequency, duration, renewal behavior, grace period, cancellation policy, freeze policy, transfer policy, access hours, allowed facilities, class entitlements, guest passes, credits, and trainer-session entitlements.
- Introductory pricing.
- Proration behavior.
- Minimum commitment.
- Auto-renew consent.
- Capacity or sales limits.
- Eligibility rules.
- Coupon and promotion compatibility.
- Versioning so existing contracts retain historical terms.

## Membership lifecycle

```text
Draft → Scheduled → Active → Grace period → Frozen/Suspended → Expired/Cancelled
```

- Scheduled start.
- Renewal quote.
- Upgrade/downgrade.
- Early cancellation with fee.
- Freeze with duration and reason.
- Pause recurring billing where gateway allows.
- Automatic status transition.
- Entitlement recalculation.
- Full audit history.
# 4.6 Billing, Payments, Invoices, and Revenue Recovery

## Payment capabilities

- Online one-time payment.
- Recurring subscription/mandate.
- UPI, card, bank mandate, wallet, cash, bank transfer, cheque, and custom methods.
- Split payment.
- Partial payment.
- Deposit and balance.
- Payment link.
- Manual payment entry with proof.
- Stored payment token through gateway, never raw card storage.
- Branch and terminal attribution.

## Financial documents

- Quote
- Pro-forma invoice
- Tax invoice
- Receipt
- Credit note
- Refund receipt
- Member statement
- Settlement/reconciliation report

## Billing rules

- Configurable invoice numbering.
- Taxes inclusive or exclusive.
- Discount by amount or percentage.
- Staff discount approval threshold.
- Coupon constraints and usage limits.
- Late fee and grace period.
- Proration.
- Failed-payment retries.
- Balance and credit wallet.
- Refund and partial refund.
- Chargeback/dispute status.
- Write-off with approval.

## Dunning workflow

```text
Payment failed
→ immediate in-app notice
→ retry schedule
→ reminder sequence
→ grace-period warning
→ access restriction according to policy
→ staff escalation
→ recovery or cancellation
```

- Payment gateway webhooks are authoritative.
- Every webhook is idempotent and stored for audit.
- Manual records cannot silently override settled gateway transactions.

## India-ready requirements

- Razorpay adapter for cards, UPI Autopay, and eMandate.
- GST-ready tax fields and invoice configuration.
- UPI payment-link support.
- Cash reconciliation by shift.

## Global-ready requirements

- Stripe adapter.
- Configurable currency and tax fields.
- Payment-provider abstraction so business logic is not tied to one gateway.
# 4.7 Attendance, Check-In, and Access Control

## Check-in methods

- Dynamic QR in member app.
- Member barcode.
- Manual search by reception.
- Staff-assisted check-in.
- Kiosk mode.
- NFC or wallet pass integration later.
- Access-control hardware adapter.

## Dynamic QR requirements

- Short expiry.
- Rotating signed token.
- Bound to member and tenant.
- Replay protection.
- Optional screenshot warning.
- Server-side membership and access validation.

## Access validation

- Membership active.
- Branch access allowed.
- Time window allowed.
- Outstanding payment policy.
- Age/guardian policy.
- Suspended or blocked status.
- Capacity policy.
- Required waiver signed.

## Attendance operations

- Check-in and optional check-out.
- Live “currently inside” list.
- Occupancy count.
- Manual correction with reason.
- Guest check-in.
- Trial check-in.
- Class attendance.
- Trainer session attendance.
- Duplicate-entry detection.
- Tailgating/suspicious pattern flag.
- Peak-hour analytics.

## Offline fallback

- Reception kiosk can cache a short-lived signed eligibility list for temporary internet outages.
- Offline access decisions are logged and reconciled.
- Offline mode must not expose the full member database.
# 4.8 Schedule, Classes, Courses, and Appointments

## Scheduling entities

- Group class
- Personal-training appointment
- Assessment
- Consultation
- Workshop
- Course with multiple sessions
- Facility/resource booking
- Live digital class

## Class configuration

- Name, category, trainer, branch, room, start/end time, recurrence, capacity, waitlist capacity, booking window, cancellation window, eligibility, price/credits, difficulty, equipment, description, cover media, and streaming link.

## Member experience

- Calendar and list views.
- Search and filters.
- Instant booking.
- Credit/payment selection.
- Waitlist join and position.
- Automatic promotion.
- Calendar add.
- Reminder.
- Cancellation.
- Rebooking.
- Trainer and location details.
- Class preparation instructions.

## Operational behavior

- Prevent overbooking with serialized capacity control.
- Prevent duplicate booking.
- Support recurring series with exception editing.
- Support substitute trainer.
- Room and trainer conflict detection.
- Check-in roster.
- Late cancellation and no-show policy.
- Automatic credit restoration according to policy.
- Cancellation broadcast.
- Waitlist promotion expiry.

## Capacity optimization

- Show fill rate and forecast.
- Identify consistently underfilled classes.
- Suggest schedule changes.
- Optional controlled dynamic pricing or off-peak credits.
# 4.9 Trainers, Staff, Rosters, and Compensation

## Staff profile

- Identity, role, branches, certifications, specialties, bio, availability, employment status, contact information, documents, expiry dates, emergency contact, and compensation configuration.

## Trainer operations

- Assigned members.
- Today’s sessions.
- Program review queue.
- Missed-workout alerts.
- Member check-ins.
- Assessment forms.
- Workout and habit compliance.
- Secure messaging.
- Notes and follow-up tasks.
- Session completion and member signature.

## Rostering

- Shift scheduling.
- Availability.
- Leave requests.
- Shift swap request.
- Clock in/out.
- Conflict detection.
- Branch coverage.
- Exportable roster.

## Compensation

- Fixed salary record.
- Per-session commission.
- Sales commission.
- Class commission.
- Tiered rates.
- Cancellation/no-show compensation policy.
- Payroll export.

The product may calculate compensation records but should not become a full payroll/tax system initially.
# 4.10 Exercise Library and Workout Programming

## Exercise library

Each exercise supports:

- Name and aliases.
- Primary and secondary muscles.
- Equipment.
- Movement pattern.
- Difficulty.
- Tracking type: weight/reps, bodyweight/reps, duration, distance, calories, assisted weight, interval, or custom.
- Unilateral/bilateral flag.
- Instructions.
- Coaching cues.
- Common mistakes.
- Safety notes.
- Contraindication tags.
- Demonstration images/video.
- Alternatives and regressions/progressions.
- Custom gym-specific exercise.
- Visibility and moderation state.

## Program builder

- Day/week/program hierarchy.
- Drag-and-drop exercise assignment.
- Sets, target reps, load, RPE/RIR, tempo, rest, duration, distance, and notes.
- Warm-up, working, drop, failure, AMRAP, cluster, and back-off sets.
- Supersets, circuits, intervals, and EMOM structures.
- Conditional substitutions.
- Equipment-specific alternatives.
- Templates and reusable blocks.
- Progressive overload rules.
- Deload weeks.
- Testing sessions.
- Versioning and publish date.
- Assign to member, group, plan, or challenge.

## Member workout execution

- “Start workout” with preloaded plan.
- Previous set values displayed inline.
- One-tap completion.
- Numeric keypad optimized for weight and reps.
- Rest timer with haptics and notification.
- Add/remove/reorder exercise.
- Replace exercise with suitable alternative.
- Warm-up calculator.
- Plate calculator.
- RPE/RIR.
- Notes.
- Personal record recognition.
- Workout pause/resume.
- Lock-screen/live activity where supported.
- Complete offline.
- Session summary with volume, duration, records, muscles, and coach note.

## Workout history and analytics

- Calendar history.
- Exercise history.
- Estimated one-rep max.
- Volume, intensity, frequency, consistency, and rep-range analysis.
- Personal records.
- Muscle-group distribution.
- Program adherence.
- Export.
# 4.11 Assessments, Goals, and Progress

## Assessments

- PAR-Q/readiness questionnaire or gym-configured equivalent.
- Goal selection.
- Training experience.
- Injury/limitation record.
- Body measurements.
- Body weight and body-fat estimate.
- Photos with consent and privacy controls.
- Mobility and movement screens.
- Strength baseline.
- Cardio baseline.
- Lifestyle, sleep, stress, and activity questionnaire.
- Custom assessment templates.

## Goals

- Strength target.
- Body composition.
- Attendance consistency.
- Event preparation.
- Habit target.
- Mobility.
- Cardio performance.
- Custom goal with date and milestones.

## Progress presentation

- Trend charts.
- Before/after photo compare.
- Measurement history.
- Strength timeline.
- Attendance streak and consistency.
- Goal milestones.
- Trainer comments.
- Shareable progress card with privacy controls.
- Monthly progress report.
# 4.12 Nutrition and Habit Coaching

## Nutrition modes

Gyms can select the appropriate complexity per member:

1. Simple meal-photo journal.
2. Habit-based nutrition.
3. Calorie and macro targets.
4. Structured meal plan/document.
5. External nutrition-app integration.

## Features

- Meal photo and text log.
- Calories and macros.
- Water intake.
- Food preferences and exclusions.
- Meal reminders.
- Trainer feedback.
- Weekly compliance.
- Recipe/content library.
- PDF meal plan upload.
- Optional barcode/database provider integration.

## Habit coaching

- Trainer-created habits.
- Frequency, schedule, target, reminder, and completion.
- Positive habit and avoidance habit.
- Streak and compliance score.
- Weekly check-in.
- Habit templates.
- Pause and reschedule.
- Badge milestones without punitive loss messaging.
# 4.13 Adaptive Training and AI Features

## Rules-first recommendation engine

The training engine must consider:

- Goal.
- Experience.
- Available equipment.
- Exercise restrictions.
- Recent training volume.
- Muscle exposure.
- Completed and missed workouts.
- RPE/RIR.
- Performance trend.
- Recovery inputs.
- Schedule availability.
- Trainer-defined constraints.

## Allowed adaptations

- Suggest next load or rep target.
- Substitute unavailable equipment.
- Reschedule missed session.
- Reduce volume after poor recovery.
- Suggest deload.
- Avoid recently overworked muscles.
- Adapt session duration.
- Recommend trainer review when progress stalls.

## AI assistant capabilities

- Explain why an exercise or adaptation is recommended.
- Summarize weekly progress.
- Draft trainer messages.
- Convert trainer instructions into member-friendly language.
- Create a draft program from approved templates and constraints.
- Answer questions from the gym’s approved knowledge base.
- Classify member feedback for staff review.
- Generate marketing drafts subject to approval.

## AI safety requirements

- No medical diagnosis.
- No extreme dieting recommendations.
- No automatic override of injury restrictions.
- No autonomous plan publication for high-risk members.
- Every recommendation includes source data and rationale.
- Trainer can accept, edit, or reject.
- Store prompt version, model, input summary, output, decision, and reviewer for audit.
- Per-tenant daily and monthly token/credit cap.
# 4.14 Gamification, Challenges, and Community

## Gamification

- XP for approved activities.
- Shark Level.
- Personal records.
- Attendance milestones.
- Workout streaks.
- Habit streaks.
- Achievement badges.
- Monthly missions.
- Team challenges.
- Branch challenges.
- Leaderboards by opt-in category.

## Fairness rules

- Avoid pure “most volume wins” leaderboards.
- Include consistency, improvement, attendance, and participation categories.
- Allow anonymous display name.
- Allow complete opt-out.
- Separate beginner and advanced categories where appropriate.
- Prevent staff from editing scores without audit.

## Community

- Gym announcements.
- Trainer posts.
- Member workout posts.
- Achievements and PR cards.
- Comments, reactions, and kudos.
- Challenge discussion.
- Groups by branch, class, goal, or trainer.
- Report, block, mute, and moderation.
- Admin approval mode.
- Content retention and community guidelines.

## Referral program

- Member referral code/link.
- Referral status.
- Reward after qualifying purchase or attendance milestone.
- Fraud detection.
- Configurable referrer and referred-member benefit.
- Campaign attribution.
# 4.15 Messaging, Notifications, and Automation

## Channels

- In-app notification.
- Push notification.
- Email.
- SMS adapter.
- WhatsApp Business adapter.
- Internal staff task.

## Messaging

- One-to-one member/trainer conversation.
- Group conversation.
- Announcement channel.
- Attach image, document, voice note, and approved video link.
- Read state.
- Message search.
- Staff internal note must never be visible to member.
- Quiet hours and member preferences.
- Moderation and retention policy.

## Event-triggered automation

Examples:

- Lead created.
- Trial booked/completed.
- Membership expiring.
- Payment failed.
- Member absent for configurable days.
- First check-in.
- Personal record.
- Class booked/cancelled/promoted.
- Birthday.
- Goal milestone.
- Low habit adherence.
- Trainer reassignment.
- Equipment issue updated.

## Automation builder

```text
Trigger → Conditions → Delay → Action → Exit/Goal
```

- Templates.
- Branch scope.
- Frequency cap.
- Consent check.
- Preview recipients.
- Test mode.
- Pause/resume.
- Delivery and conversion metrics.
- Human approval option.
- Cost estimate before sending paid-channel campaigns.
# 4.16 Live and On-Demand Fitness Content

## Live classes

- Schedule live session.
- Trainer broadcast details.
- Member eligibility.
- Reminder.
- Secure playback token.
- Live chat and reactions.
- Attendance credit.
- Viewer count.
- Recording option.
- Replay availability and expiry.
- Moderator controls.

## On-demand library

- Programs, classes, tutorials, mobility, recovery, nutrition, and onboarding content.
- Categories, levels, duration, equipment, trainer, and tags.
- Continue watching.
- Favorites.
- Completion history.
- Entitlement by membership/product.
- Signed playback URL.
- Captions and transcript.

## Cost controls

- Stream only through managed video infrastructure.
- Tenant quota by stored and delivered minutes.
- Video add-on billing.
- Default recording off when unnecessary.
- Automatic expiry for old recordings.
- No raw video proxying through the application API.
# 4.17 Point of Sale, Store, and Inventory

## Products

- Physical products.
- Supplements.
- Apparel.
- Accessories.
- Services.
- Gift cards.
- Membership add-ons.

## POS

- Barcode search.
- Member lookup.
- Cart.
- Discount approval.
- Tax.
- Cash/card/UPI/custom payment.
- Receipt.
- Return/refund.
- Shift and cash-drawer reconciliation.
- Staff attribution.

## Inventory

- SKU.
- Variants.
- Branch stock.
- Purchase cost and selling price.
- Stock movement.
- Low-stock threshold.
- Supplier.
- Purchase order record.
- Stock transfer.
- Damage/adjustment reason.
- Basic margin report.
# 4.18 Equipment and Facility Operations

## Equipment registry

- Asset ID and QR code.
- Name, category, brand, model, serial number, branch, area, purchase date, warranty, supplier, status, and media.
- Maintenance schedule.
- Usage or service counter where available.
- Documents and manuals.

## Issue workflow

```text
Reported → Triaged → Assigned → In progress → Resolved → Verified → Closed
```

- Member can scan QR to report issue.
- Photo and description.
- Severity.
- Equipment automatically marked limited/out of service.
- Staff assignment.
- Parts and cost record.
- Downtime report.
- Preventive maintenance reminders.

## Facility tasks

- Opening checklist.
- Closing checklist.
- Cleaning tasks.
- Safety inspection.
- Incident report.
- Lost and found.
- Recurring task templates.
# 4.19 Support, Feedback, Reviews, and Retention

## Member support

- Help center.
- FAQ.
- Contact branch.
- Support ticket.
- Category, priority, attachments, status, and SLA.
- Ticket history.

## Feedback

- Post-class rating.
- Trainer rating.
- Facility feedback.
- NPS survey.
- Anonymous feedback option.
- Review request after positive feedback.
- Public response workflow where integrated.

## Retention risk

Risk signals may include:

- Attendance decline.
- No visit for configurable period.
- Payment failure.
- Low plan adherence.
- Repeated class cancellations.
- Negative feedback.
- Trainer reassignment.
- Membership expiry without renewal.

Risk output must show contributing factors and recommended next action. Staff can mark false positive and record outcome.
# 4.20 Reports and Analytics

## Financial reports

- Revenue by branch, product, channel, and payment method.
- Recurring revenue.
- Collections and outstanding balances.
- Failed-payment recovery.
- Refunds and discounts.
- Tax report.
- Daily close.
- Settlement reconciliation.
- Product margin.

## Member reports

- Active, frozen, expired, suspended, trial, and former members.
- New joins.
- Renewal rate.
- Churn.
- Retention cohorts.
- Membership aging.
- Corporate/family utilization.
- At-risk members.

## Attendance reports

- Daily visits.
- Unique active members.
- Peak hours.
- Frequency distribution.
- Branch utilization.
- Class attendance, fill rate, no-show rate, and waitlist conversion.

## Training and engagement reports

- Workout adherence.
- Program completion.
- Habit adherence.
- Challenge participation.
- Community engagement.
- Trainer response and program-review times.

## Sales reports

- Lead conversion.
- Source performance.
- Pipeline aging.
- Staff conversion.
- Offer performance.
- Referral conversion.

## Report behavior

- Filter by date, branch, product, trainer, and segment.
- Saved views.
- Export CSV/XLSX/PDF.
- Scheduled report by email.
- Permission-controlled financial visibility.
- Definitions shown for metrics to prevent inconsistent interpretation.
# 4.21 Multi-Branch and Franchise Management

- Tenant-wide and branch-level configuration.
- Shared or branch-specific membership products.
- Cross-branch access rules.
- Member transfer.
- Central brand templates.
- Branch-level price overrides with permission.
- Consolidated and branch P&L-style operational reports.
- Inter-branch stock transfer.
- Central staff directory.
- Regional roles.
- Franchise royalty/report export.
- Branch benchmark without exposing individual member data unnecessarily.
- Configuration inheritance with explicit override indicators.
# 4.22 Shark Fitness SaaS Super Admin

## Tenant management

- Create, suspend, reactivate, and delete tenant.
- Subscription plan.
- Feature entitlements.
- Usage meters.
- Payment status.
- Trial lifecycle.
- Support contacts.
- Region and data location metadata.

## Platform operations

- Service health.
- Error rates.
- Queue backlog.
- Webhook failures.
- Email/push delivery status.
- Cost by tenant.
- AI usage.
- Video usage.
- Storage usage.
- Abuse/fraud flags.
- Version and migration status.

## Support tools

- Read-only diagnostic view.
- Time-limited audited impersonation.
- Replay failed webhook.
- Requeue notification.
- Export tenant audit package.
- Feature flag override.
# 4.23 Integrations, API, Webhooks, Imports, and Exports

## Payment integrations

- Razorpay.
- Stripe.
- Manual/cash adapter.

## Health integrations

- Apple HealthKit.
- Android Health Connect.
- Wearable integrations through supported APIs later.

## Communication integrations

- Transactional email provider.
- Expo/FCM/APNs push.
- SMS provider adapter.
- WhatsApp Business provider adapter.

## Access integrations

- QR kiosk.
- Generic access-controller webhook/API adapter.
- NFC/wallet pass later.

## Public API

- Versioned REST API.
- OAuth/API keys for approved integrations.
- Fine-grained scopes.
- Rate limits.
- Idempotency keys.
- Cursor pagination.
- Webhook subscriptions.
- Sandbox tenant.

## Webhook events

- member.created
- member.updated
- membership.activated
- membership.expiring
- membership.cancelled
- payment.succeeded
- payment.failed
- attendance.checked_in
- attendance.checked_out
- class.booked
- class.cancelled
- class.waitlist_promoted
- workout.completed
- lead.created
- lead.converted

## Import/export

- CSV templates.
- Column mapping.
- Dry-run validation.
- Error report.
- Chunked processing.
- Rollback for failed imports where feasible.
- Complete tenant export.

---

# 6. Critical End-to-End Workflows

## 6.1 Lead to active member

1. Lead is captured.
2. Assignment and follow-up task are created.
3. Trial is scheduled.
4. Lead receives confirmation.
5. Trial attendance is recorded.
6. Staff sends offer.
7. Member accepts plan and signs waiver.
8. Payment or mandate succeeds.
9. Membership and entitlements activate.
10. Member receives onboarding checklist and app access.
11. Baseline assessment is scheduled.

### Acceptance criteria

- Duplicate leads are detected.
- A failed payment does not activate a paid entitlement.
- Consent and waiver versions are stored.
- Every stage transition appears in the timeline.

## 6.2 Member check-in

1. Member opens dynamic QR.
2. Scanner submits token.
3. Server validates signature, replay, membership, branch, time, restrictions, and capacity.
4. Attendance is written idempotently.
5. Occupancy broadcasts in real time.
6. Member and reception receive success or actionable denial.

### Acceptance criteria

- Reusing an expired token fails.
- Double scan creates one attendance event.
- Denial gives a staff-actionable reason without leaking sensitive data publicly.
- Occupancy updates within two seconds under normal connectivity.

## 6.3 Class booking with waitlist

1. Member selects class.
2. Eligibility and credits are checked.
3. Capacity operation is serialized.
4. Seat is reserved or member joins waitlist.
5. Cancellation promotes first eligible member.
6. Promotion expires if confirmation is required.
7. All clients receive real-time updates.

### Acceptance criteria

- No overbooking under concurrent requests.
- Credit behavior follows cancellation policy.
- Waitlist order is stable and auditable.

## 6.4 Offline workout

1. Member starts cached plan.
2. Every set writes to local SQLite first.
3. App creates mutation IDs.
4. Connectivity returns.
5. Outbox synchronizes in order.
6. Server deduplicates and returns authoritative versions.
7. App resolves or surfaces conflict.

### Acceptance criteria

- App restart does not lose workout.
- Duplicate retries do not duplicate sets.
- User can complete workout offline.
- Sync status is visible without alarming the user.

## 6.5 Failed payment recovery

1. Gateway webhook reports failure.
2. Invoice/payment state updates.
3. Dunning workflow starts.
4. Member receives approved communication.
5. Retry succeeds or grace period expires.
6. Access policy changes if configured.
7. Staff queue receives unresolved case.

### Acceptance criteria

- Webhook replay is idempotent.
- Member status is not altered from an unverified client callback.
- Staff can inspect every attempt and message.

## 6.6 At-risk member intervention

1. Scheduled job computes risk signals.
2. Explainable risk record is created.
3. Recommended action is assigned.
4. Staff contacts member or sends approved automation.
5. Outcome is recorded.
6. Model/rule effectiveness is measured.

---

# 12. Product Analytics and Success Metrics

## 12.1 North-star metrics

### Gym value

- Active-member retention.
- Successful recurring collection rate.
- Member visits per active member.
- Class fill rate.
- Staff administrative hours saved.

### Member value

- Weekly active trainees.
- Workout completion rate.
- Four-week consistency.
- Booking completion time.
- Member self-service rate.

## 12.2 Funnel metrics

```text
Lead → Contact → Trial → Purchase → First check-in → First workout → 4-week active → Renewal
```

## 12.3 UX metrics

- Check-in success/failure.
- Time to log a set.
- Time to book class.
- Search-to-action conversion.
- Form abandonment.
- Offline sync failure.
- Notification open and action rate.

## 12.4 Analytics event requirements

- Versioned event catalog.
- No sensitive free-text payloads.
- Tenant and branch dimensions.
- Actor role.
- Feature flag exposure.
- Client version.
- Offline timestamp and received timestamp.
- Consent-aware analytics.

---


# Product-level acceptance scenarios

The following scenarios are mandatory cross-module demonstrations before commercial general availability.

1. A lead from a campaign is deduplicated, assigned, booked for a trial, completes a waiver, purchases a plan, pays through the gateway, receives an invoice, and becomes an active member without duplicated identity.
2. A member with a valid cross-branch entitlement checks in using a rotating QR while both the member app and admin occupancy dashboard update.
3. Two members race for the final class seat; exactly one receives CONFIRMED and the other receives a correct waitlist option.
4. A member logs a complete workout offline, terminates the app, reopens it, reconnects, and synchronizes once without duplicate sets or records.
5. A failed recurring payment triggers the configured grace policy, communications, staff task, retry, and restoration after eventual success.
6. An owner edits a product price; existing memberships retain their purchased product version while new sales use the new version.
7. A trainer edits a future program while a member is mid-workout; completed and active session history remains stable and the next eligible session receives the new version.
8. A member requests account deletion; personal data is anonymized according to policy while invoices, payment records, audit evidence, and legal holds are preserved appropriately.
9. A branch closes unexpectedly; classes are cancelled or moved, affected members are notified, occupancy is reconciled, and risk analytics exclude the closure period.
10. A provider sends duplicate and out-of-order payment webhooks; final payment and entitlement state remains correct.
11. An admin attempts to access another tenant by modifying an identifier; the API denies access and records a security event without revealing existence.
12. A member opts out of promotional WhatsApp messages but continues receiving transactional payment and class-cancellation notices where legally allowed.
13. A challenge correction reverses wrongly awarded XP through a ledger entry without altering prior audit evidence.
14. A support agent receives authorized, time-limited impersonation access; the banner, scope, expiry, and every action are recorded.
15. Video quota is exhausted; new live sessions are blocked or require owner approval while core booking and workout functions remain unaffected.
16. A large import includes valid rows, duplicates, invalid phone numbers, and another tenant's accidental data; dry-run and final execution prevent unsafe ingestion and produce a row-level report.
17. A user using keyboard only and a screen reader can complete essential admin tasks: find member, record payment, book class, and export a report.
18. A member with reduced-motion enabled completes check-in, booking, and workout flows without essential information relying on animation.
19. An at-risk member score explains contributing signals, excludes gym closure days, and lets staff record an intervention outcome.
20. A platform operator suspends a tenant for non-payment; member access follows configured policy, records remain available for export, and restoration is reversible.

# Commercial product delivery sequence

This sequence is dependency-oriented, not an MVP feature reduction. All listed domains remain in the sellable product scope.

| Phase | Product outcome | Included domains | Exit evidence |
|---|---|---|---|
| P0 | Product foundation | tenancy, roles, terminology, catalog foundations, audit model | approved information architecture, canonical enums, seeded demo tenant |
| P1 | Acquisition and onboarding | CRM, trials, waivers, member profiles, documents, consent | lead-to-member demonstration and import validation |
| P2 | Monetization core | products, memberships, invoices, payments, refunds, dunning | provider sandbox evidence and reconciliation report |
| P3 | Daily gym operations | attendance, access, occupancy, classes, bookings, trainers, rosters | concurrency and door/offline scenarios passed |
| P4 | Coaching system | exercise library, programming, workout execution, progress, assessments | offline workout and program-versioning evidence |
| P5 | Engagement system | habits, nutrition, messaging, automations, challenges, community, referrals | consent, moderation, fairness, and notification tests |
| P6 | Business expansion | POS, inventory, equipment, facility, support, retention, analytics | branch-level operational reporting and incident workflows |
| P7 | Multi-branch SaaS | franchise controls, super admin, usage meters, APIs, webhooks | cross-branch and cross-tenant isolation test report |
| P8 | Premium intelligence | rules engine, AI explanation, live/on-demand media, health integrations | safety evaluation, cost controls, and provider failure tests |
| P9 | Enterprise launch | SSO option, SCIM option, retention, legal hold, DR, security review, accessibility | enterprise checklist and commercial launch sign-off |

# Functional Definition of Done

A functional requirement is complete only when:

- The happy path and documented edge cases work for every authorized role and branch scope.
- Unauthorized and cross-tenant attempts fail server-side.
- State transitions use canonical values and preserve history.
- User-visible loading, empty, error, retry, offline, and permission states exist.
- The action has appropriate audit, notification, and analytics behavior.
- Imports, exports, APIs, and automations cannot bypass the same business rules.
- Acceptance tests reference the PF requirement ID.
- Documentation and demo seed data are updated.

# Product risks requiring owner awareness

- Unlimited streaming, SMS, WhatsApp, storage, and generative AI cannot remain inside a permanent $15 total platform bill. These are quota-controlled or tenant-funded.
- Fitness and nutrition features are wellness/coaching tools, not medical diagnosis or treatment.
- Community and leaderboards require active moderation and fairness controls, not only UI.
- Multi-tenant data isolation is a product promise and must be tested continuously.
- Enterprise certifications such as SOC 2 or ISO 27001 are organizational programs; architecture can prepare for them but cannot claim them.
