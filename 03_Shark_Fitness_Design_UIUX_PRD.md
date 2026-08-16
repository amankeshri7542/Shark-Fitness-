# Shark Fitness
## Design and UI/UX Product Requirements Document

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
- [05_Shark_Fitness_Remaining_Implementation_Plan.md](./05_Shark_Fitness_Remaining_Implementation_Plan.md) — build status and the sequenced plan for the phases still outstanding. Subordinate to this registry; where it appears to relax a SHALL, the PRD wins.

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


# Purpose

This document defines the complete experience architecture for a premium, fast, accessible Admin Web Dashboard and Member Mobile App. It is normative for information hierarchy, navigation, interaction, visual system, content, states, responsive behavior, and design acceptance.

The goal is not visual novelty alone. The product should feel premium because it is coherent, quick, calm under complexity, and unusually good at repetitive gym tasks.

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

# 5. Premium UX and Visual Design Specification

## 5.1 Experience attributes

Shark Fitness should feel:

- Athletic without looking aggressive.
- Premium without becoming visually heavy.
- Data-rich without resembling accounting software.
- Motivating without manipulative streak pressure.
- Fast and direct during workouts.
- Calm and trustworthy during payments and account management.

## 5.2 Brand direction

Recommended visual direction:

- Deep neutral base colors.
- One vivid “Shark” accent used selectively.
- High-contrast typography.
- Soft elevation and layered surfaces.
- Large numeric metrics.
- Clean charts with meaningful annotations.
- Premium photography used sparingly.
- Optional dark mode on both surfaces.

Avoid:

- Excessive neon gradients.
- Bodybuilder clichés on every screen.
- Tiny grey text.
- Glass effects behind dense tables.
- Animated backgrounds.
- Multiple competing accent colors.

## 5.3 Design system

### Foundations

- Color tokens with light/dark semantic roles.
- Type scale.
- Spacing scale based on 4-point increments.
- Radius scale.
- Elevation.
- Motion duration and easing.
- Icon rules.
- Data visualization palette.
- Focus, hover, pressed, disabled, loading, success, warning, and error states.

### Component inventory

- Button, icon button, segmented control, tabs.
- Input, select, autocomplete, date/time picker, amount input.
- Data table with column visibility and saved filters.
- Card, metric tile, list row, timeline.
- Modal, drawer, bottom sheet, popover.
- Badge, status chip, avatar, branch indicator.
- Empty state, error state, skeleton, offline state.
- Toast and persistent operational alert.
- Chart wrappers.
- Command palette.
- Permission guard.
- Audit diff viewer.
- Mobile set logger and rest timer.

### Accessibility

- WCAG 2.2 AA target for the web dashboard.
- Dynamic type/font scaling support on mobile.
- Minimum touch targets.
- Keyboard navigation throughout the dashboard.
- Visible focus states.
- Screen-reader labels.
- Color never used as the only status signal.
- Reduced-motion support.
- Captions/transcripts for video.
- Accessible chart summaries.

## 5.4 Motion and feedback

Use motion to:

- Confirm a set was logged.
- Show a successful check-in.
- Transition an active workout.
- Explain hierarchy when opening detail panels.
- Celebrate a meaningful achievement.
- Indicate live synchronization.

Do not animate:

- Every dashboard card on load.
- Repetitive table operations.
- Critical financial confirmation in a distracting way.

Motion must respect system reduced-motion settings.

## 5.5 Admin dashboard UX rules

- Desktop-first, dense but breathable.
- Master-detail patterns for members, leads, and tickets.
- Preserve filters in the URL.
- Bulk actions appear only after selection.
- Destructive actions show consequence and affected records.
- Command palette available with keyboard shortcut.
- Every list supports search, filter, sort, column preferences, saved views, and export when permitted.
- Use drawers for quick edits; full pages for complex records.
- Keep branch scope permanently visible.

## 5.6 Member app UX rules

- Home screen adapts to current context rather than showing a static grid.
- During gym hours, access pass and today’s workout are prominent.
- During an active workout, logging dominates the interface.
- Booking takes no more than three primary actions.
- Previous workout data is visible without navigating away.
- Network loss never destroys workout input.
- Progress is explained in plain language.
- Notifications deep-link to the exact object.

## 5.7 Member Home composition

Possible prioritized cards:

1. Membership/access status.
2. Continue or start today’s workout.
3. Upcoming booking.
4. Trainer action/request.
5. Weekly progress.
6. Current challenge.
7. Announcement.
8. Suggested habit.

The order is generated by deterministic priority rules, not by an opaque feed algorithm.

## 5.8 Signature “wow” moments

- Animated successful QR check-in with immediate occupancy and greeting.
- Workout set logger that remembers last values and advances automatically.
- Muscle recovery visualization with clear explanation.
- Personal-record celebration that can be shared.
- Live class seat changes.
- Premium monthly progress story.
- Trainer-reviewed adaptive workout change with before/after explanation.
- Equipment QR that opens the correct exercise and last-used settings.

---


# Design system specification

## Brand character

Shark Fitness should feel **disciplined, energetic, precise, premium, and trustworthy**. It must not look like a gaming casino, crypto dashboard, or generic neon fitness template.

Recommended visual direction:

- Dark mode may be the signature member experience, but light mode is first-class.
- Use one high-energy brand accent and restrained semantic colors.
- Use deep neutral surfaces, sharp typography, high-quality exercise imagery, and generous spacing.
- Use shark references through motion curves, progress shapes, naming, and subtle graphic language rather than cartoon mascots on operational screens.
- Premium means strong hierarchy, fast response, consistency, and excellent states. It does not mean excessive blur, gradients, or animation.

## Token architecture

Tokens SHALL live in a platform-neutral package and generate web and mobile representations.

```text
token/
  color/{primitive,semantic,component}
  typography/{family,size,lineHeight,weight,tracking}
  space/{0..n}
  radius/{sm,md,lg,xl,pill}
  border/{width,style}
  elevation/{webShadow,androidElevation,iosShadow}
  motion/{duration,easing,distance}
  size/{icon,touchTarget,contentWidth}
  chart/{categorical,sequential,diverging}
```

### Color semantics

- `surface/*`: canvas, raised, overlay, inverse.
- `text/*`: primary, secondary, muted, inverse, disabled.
- `brand/*`: primary, strong, subtle, onBrand.
- `status/success`, `warning`, `danger`, `info` with text, border, fill variants.
- `data/*`: chart colors tested for contrast and non-color differentiation.
- Never encode status by hue alone. Pair color with icon, label, shape, or pattern.

### Typography

- Use a highly legible UI family with tabular numerals support.
- Admin tables and financial screens require tabular numerals.
- Mobile workout values use large, high-contrast numerals readable at arm's length.
- Dynamic type/text scaling must not truncate critical labels or values.
- Avoid all-caps body labels and excessive letter spacing.

### Spacing and density

- Use a 4-point base grid.
- Mobile default touch targets SHALL be at least 44×44 pt on iOS and 48×48 dp on Android where platform guidance applies.
- Admin desktop supports comfortable and compact density, but compact mode cannot reduce interactive targets below accessible minimums.
- Forms group related fields and expose advanced policy controls progressively.

### Motion

- Motion communicates relationship, status, and completion.
- Typical micro-feedback: 100–180 ms.
- Standard transitions: 180–280 ms.
- Large navigational transitions: 240–360 ms when platform appropriate.
- Reduced-motion mode replaces spatial movement with opacity or instant state change.
- No essential instructions, timers, or error messages may depend solely on animation.
- Avoid simultaneous motion in multiple dashboard regions.

### Haptics

Use haptics only for high-confidence actions: successful check-in, set completion, personal record, destructive confirmation warning, and timer completion. Repeated set logging must not become annoying; allow preference control.

## Component contract

Every reusable component SHALL define:

- Purpose and non-goals.
- Variants and sizes.
- Content constraints.
- Interactive states: default, hover, focus, pressed, selected, disabled, loading, error.
- Keyboard and screen-reader behavior.
- RTL and long-text behavior.
- Reduced-motion behavior.
- Responsive behavior.
- Analytics ownership, if any.
- Unit, visual regression, and accessibility tests.

Required component families:

- Buttons, icon buttons, split buttons, links, floating action controls.
- Text fields, numeric fields, phone fields, select/combobox, date/time, multi-select, file upload.
- Checkbox, radio, switch, segmented control, chips, tags, status badges.
- Dialog, sheet, popover, menu, tooltip, toast, inline alert, confirmation flow.
- Tabs, breadcrumbs, side navigation, bottom navigation, command/search palette.
- Data table, virtualized list, pagination, filter bar, saved view, bulk action bar.
- KPI card, chart frame, metric definition, freshness indicator, comparison pill.
- Calendar, schedule grid, class card, availability indicator, waitlist state.
- Member card, membership card, payment state, access state, trainer card.
- Exercise card, set row, rest timer, program outline, progress chart, PR badge.
- Empty state, skeleton, error boundary, offline banner, sync status, permission state.

# Interaction and content rules

## Navigation

### Admin web

- Desktop uses a persistent left navigation with role-aware groups and a top utility bar.
- Tablet may collapse navigation to an icon rail or drawer.
- Deep pages use breadcrumbs and preserve list filters when returning.
- Global search finds members, leads, invoices, classes, staff, and commands with permission-aware results.
- The active branch and date scope must remain visible whenever they affect data.

### Member app

Recommended bottom navigation:

1. Home
2. Train
3. Book
4. Progress
5. More or Community, determined through usability testing

Check-in remains a prominent contextual action without permanently crowding every screen. Messaging and notifications are available from the top-level shell.

## Forms

- Use plain-language labels above fields; placeholders are examples, not labels.
- Validate syntax locally but validate business rules server-side.
- Preserve user input after recoverable errors.
- Long forms use sections and a completion summary, not a maze of modal dialogs.
- Financial and policy changes show a before/after summary.
- Required fields must be genuinely required for the workflow, not collected “just in case.”

## Tables and dense operations

- Default to task-focused columns, not every available field.
- Offer saved views, column control, filters, density, and export where allowed.
- Keep bulk actions hidden until selection.
- Sticky headers/identity columns may be used when they improve orientation.
- Row click and inline controls must not conflict. Interactive cells require explicit hit areas.
- Mobile does not shrink desktop tables; it uses cards, summaries, and drill-down.

## Feedback and status

- Optimistic updates are allowed only when rollback is understandable and data integrity is not at risk.
- Payments, refunds, last-seat booking, permission changes, and destructive operations wait for authoritative confirmation.
- Offline mutations show queued/syncing/failed status and a recovery action.
- Toasts are supplementary; critical results remain visible in the page state or activity history.

## Content design

- Use member-friendly terms: “membership ends on” rather than internal status codes.
- Explain denial and failure without exposing security-sensitive details.
- AI recommendations include “why this changed,” source inputs, limitations, and human support path.
- Avoid shame, fear, body negativity, manipulative urgency, and guilt-based streak copy.
- Cancellation and privacy controls must be as understandable as acquisition flows.

# Admin Web Dashboard screen specifications

## UX-A01: Command Center

**Primary roles:** Owner, regional manager, branch manager  
**User job:** Understand today's business state and act on exceptions.

### Information hierarchy

- permission-aware KPI strip
- priority alerts
- occupancy and check-in feed
- today schedule
- collections and expiry queue
- branch/date controls

### Primary actions

- drill into KPI
- assign alert
- record resolution
- change branch/date

### Mandatory states

- new tenant
- partial data
- provider outage
- permission-limited
- live update

### Acceptance requirements

- The screen SHALL preserve the Command Center user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A02: Lead Pipeline

**Primary roles:** Owner, sales, reception  
**User job:** Move leads from capture to trial and purchase with minimal lost follow-up.

### Information hierarchy

- stage board/list toggle
- filters
- owner and next action
- source attribution
- SLA indicators

### Primary actions

- add lead
- schedule trial
- log contact
- move stage
- convert

### Mandatory states

- empty pipeline
- duplicate candidate
- overdue tasks
- bulk import
- restricted branch

### Acceptance requirements

- The screen SHALL preserve the Lead Pipeline user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A03: Lead Detail

**Primary roles:** Sales, reception, manager  
**User job:** See full context and take the next sales action.

### Information hierarchy

- identity summary
- activity timeline
- stage and score
- tasks
- offers
- communications
- consent

### Primary actions

- call/message
- book trial
- create task
- mark lost
- convert

### Mandatory states

- possible duplicate
- no consent
- member already exists
- assignee unavailable

### Acceptance requirements

- The screen SHALL preserve the Lead Detail user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A04: Member Directory

**Primary roles:** All authorized staff  
**User job:** Find a member in seconds and perform common actions safely.

### Information hierarchy

- search
- status chips
- branch/trainer filters
- membership status
- balance
- last visit
- bulk selection

### Primary actions

- open member
- check in
- record payment
- book class
- bulk action

### Mandatory states

- no results
- large dataset
- sensitive column hidden
- offline read-only

### Acceptance requirements

- The screen SHALL preserve the Member Directory user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A05: Member 360 Profile

**Primary roles:** Reception, trainer, manager, accountant  
**User job:** Provide one role-aware record without exposing irrelevant sensitive data.

### Information hierarchy

- summary header
- membership
- billing
- attendance
- training
- progress
- documents
- messages
- notes
- audit

### Primary actions

- edit permitted fields
- assign plan/trainer
- freeze
- collect payment
- message

### Mandatory states

- expired
- suspended
- deletion requested
- merged record
- sensitive access denied

### Acceptance requirements

- The screen SHALL preserve the Member 360 Profile user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A06: Membership Product Builder

**Primary roles:** Owner, manager  
**User job:** Create sellable plans without hidden policy ambiguity.

### Information hierarchy

- product type
- pricing and tax
- billing cadence
- access entitlement
- booking/freeze/cancel rules
- preview

### Primary actions

- save draft
- publish version
- duplicate
- retire

### Mandatory states

- invalid rule combination
- existing purchasers
- multi-branch override
- unsaved changes

### Acceptance requirements

- The screen SHALL preserve the Membership Product Builder user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A07: Billing and Reconciliation

**Primary roles:** Owner, accountant, reception  
**User job:** Understand money movement and resolve discrepancies.

### Information hierarchy

- invoice/payment table
- settlement summary
- failed attempts
- refunds
- reconciliation exceptions

### Primary actions

- record payment
- send link
- refund
- export
- resolve exception

### Mandatory states

- provider delayed
- partial refund
- chargeback
- duplicate cash entry

### Acceptance requirements

- The screen SHALL preserve the Billing and Reconciliation user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A08: Attendance and Live Occupancy

**Primary roles:** Reception, manager  
**User job:** Control entry and see who is currently inside.

### Information hierarchy

- scan/check-in surface
- occupancy count
- live member list
- denials
- manual override

### Primary actions

- check in/out
- override
- inspect denial
- close stale session

### Mandatory states

- camera denied
- network unavailable
- QR replay
- capacity reached

### Acceptance requirements

- The screen SHALL preserve the Attendance and Live Occupancy user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A09: Calendar and Class Operations

**Primary roles:** Manager, reception, trainer  
**User job:** Schedule resources and operate classes without conflicts.

### Information hierarchy

- day/week/resource views
- class cards
- capacity
- trainer/room
- waitlist
- conflict panel

### Primary actions

- create
- move
- cancel
- substitute
- book member

### Mandatory states

- DST
- series exception
- last seat race
- room conflict

### Acceptance requirements

- The screen SHALL preserve the Calendar and Class Operations user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A10: Trainer and Staff Operations

**Primary roles:** Owner, manager  
**User job:** Manage people, permissions, schedules, assignments, and compensation.

### Information hierarchy

- staff table
- role/branch
- availability
- roster
- clients
- commission summary

### Primary actions

- invite
- assign role
- schedule shift
- transfer clients
- approve commission

### Mandatory states

- staff disabled
- role conflict
- certification expiry
- multi-branch shift

### Acceptance requirements

- The screen SHALL preserve the Trainer and Staff Operations user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A11: Workout Program Builder

**Primary roles:** Trainer, head coach  
**User job:** Build complex programs quickly with safe reuse and versioning.

### Information hierarchy

- program outline
- exercise search
- set prescription editor
- superset/circuit grouping
- progression rules
- member preview

### Primary actions

- add/reorder
- save template
- assign
- publish version
- compare

### Mandatory states

- exercise archived
- active assignment
- unsupported prescription
- unsaved conflict

### Acceptance requirements

- The screen SHALL preserve the Workout Program Builder user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A12: Automation Builder

**Primary roles:** Owner, marketing, operations  
**User job:** Create event-driven communication without accidental spam or runaway loops.

### Information hierarchy

- trigger
- conditions
- delay
- channel/action
- quiet hours
- stop conditions
- preview and cost

### Primary actions

- dry run
- activate
- pause
- duplicate
- inspect runs

### Mandatory states

- recursive event
- missing consent
- quota exceeded
- template missing variable

### Acceptance requirements

- The screen SHALL preserve the Automation Builder user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A13: Reports Workspace

**Primary roles:** Owner, managers, accountant  
**User job:** Answer business questions with consistent metrics and controlled exports.

### Information hierarchy

- report catalog
- filters
- saved views
- chart/table
- definitions
- freshness

### Primary actions

- drill down
- save
- schedule
- export

### Mandatory states

- no comparison
- partial data
- large export
- restricted dimension

### Acceptance requirements

- The screen SHALL preserve the Reports Workspace user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A14: Inventory and Facility

**Primary roles:** Reception, facility, manager  
**User job:** Operate retail, stock, equipment, maintenance, and incidents.

### Information hierarchy

- stock alerts
- equipment status
- work orders
- facility tasks
- incident queue

### Primary actions

- sell/return
- transfer stock
- report issue
- assign work
- close task

### Mandatory states

- negative stock
- duplicate issue
- sensitive incident
- branch transfer

### Acceptance requirements

- The screen SHALL preserve the Inventory and Facility user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-A15: Tenant and Platform Administration

**Primary roles:** Gym owner or platform admin  
**User job:** Configure organization safely and support tenants with explicit scope.

### Information hierarchy

- organization settings
- branches
- roles
- integrations
- usage
- audit
- support access

### Primary actions

- invite admin
- change policy
- rotate secret
- export tenant
- authorize support

### Mandatory states

- destructive change
- legal hold
- support expiry
- integration failure

### Acceptance requirements

- The screen SHALL preserve the Tenant and Platform Administration user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.


# Member Mobile App screen specifications

## UX-M01: Authentication and Onboarding

**Primary roles:** Member  
**User job:** Create or activate an account with low friction and correct consent.

### Information hierarchy

- brand context
- email/phone flow
- passkey option
- invitation/trial context
- terms and privacy

### Primary actions

- sign in
- verify
- create passkey
- accept required terms

### Mandatory states

- expired invitation
- existing account
- OTP delay
- offline
- minor/guardian

### Acceptance requirements

- The screen SHALL preserve the Authentication and Onboarding user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M02: Member Home

**Primary roles:** Member  
**User job:** Answer: what should I do now?

### Information hierarchy

- membership/access card
- today workout
- next booking
- progress pulse
- coach message
- challenge status

### Primary actions

- start workout
- show check-in code
- book
- message coach

### Mandatory states

- rest day
- membership issue
- offline cached
- no program
- new member

### Acceptance requirements

- The screen SHALL preserve the Member Home user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M03: Membership Pass and Check-In

**Primary roles:** Member  
**User job:** Enter the gym quickly while clearly communicating eligibility.

### Information hierarchy

- rotating QR
- branch name
- validity
- brightness control
- offline guidance

### Primary actions

- show code
- select eligible branch
- request help

### Mandatory states

- expired
- grace
- suspended
- QR refresh failure
- access denied

### Acceptance requirements

- The screen SHALL preserve the Membership Pass and Check-In user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M04: Explore and Book

**Primary roles:** Member  
**User job:** Find an appropriate class or appointment with honest availability.

### Information hierarchy

- date strip
- filters
- class cards
- trainer
- capacity/waitlist
- eligibility

### Primary actions

- book
- join waitlist
- cancel
- share calendar

### Mandatory states

- full
- credit missing
- booking window closed
- schedule conflict
- promotion offer

### Acceptance requirements

- The screen SHALL preserve the Explore and Book user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M05: Active Workout

**Primary roles:** Member  
**User job:** Log a workout faster than paper while staying focused.

### Information hierarchy

- exercise header
- previous values
- set rows
- rest timer
- notes
- substitute
- offline indicator

### Primary actions

- log set
- edit
- complete exercise
- substitute
- finish

### Mandatory states

- app killed
- duplicate tap
- program updated
- timer backgrounded
- connectivity change

### Acceptance requirements

- The screen SHALL preserve the Active Workout user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M06: Workout Summary

**Primary roles:** Member  
**User job:** Reward completion and communicate useful progress without noise.

### Information hierarchy

- duration
- volume
- PRs
- muscle summary
- coach note
- share/privacy

### Primary actions

- save
- rate
- share
- message coach

### Mandatory states

- no PR
- partial workout
- sync pending
- unsafe volume warning

### Acceptance requirements

- The screen SHALL preserve the Workout Summary user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M07: Plan and Exercise Detail

**Primary roles:** Member  
**User job:** Understand the plan, technique, and substitutions.

### Information hierarchy

- weekly plan
- exercise media
- instructions/cues
- prescription
- why included
- alternatives

### Primary actions

- preview
- ask coach
- choose allowed alternative

### Mandatory states

- media unavailable
- contraindication flag
- trainer lock
- equipment unavailable

### Acceptance requirements

- The screen SHALL preserve the Plan and Exercise Detail user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M08: Progress

**Primary roles:** Member  
**User job:** Make improvement visible and understandable over time.

### Information hierarchy

- goal cards
- strength charts
- measurements
- photos
- attendance consistency
- recovery

### Primary actions

- add measurement
- upload photo
- change range
- set goal

### Mandatory states

- insufficient data
- unit change
- photo consent revoked
- outlier

### Acceptance requirements

- The screen SHALL preserve the Progress user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M09: Habits, Nutrition and Recovery

**Primary roles:** Member  
**User job:** Support consistent behaviors without pretending to provide medical care.

### Information hierarchy

- daily habits
- water/meals
- sleep/recovery
- weekly check-in
- coach feedback

### Primary actions

- log
- edit goal
- submit check-in
- opt out

### Mandatory states

- unsafe target
- health integration duplicate
- sensitive free text
- offline

### Acceptance requirements

- The screen SHALL preserve the Habits, Nutrition and Recovery user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M10: Challenges and Rewards

**Primary roles:** Member  
**User job:** Create social accountability with fair rules.

### Information hierarchy

- active challenges
- progress
- team/leaderboard
- rules
- rewards

### Primary actions

- join
- leave
- invite
- claim

### Mandatory states

- late join
- correction
- privacy mode
- suspicious activity

### Acceptance requirements

- The screen SHALL preserve the Challenges and Rewards user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M11: Community

**Primary roles:** Member  
**User job:** Share appropriate progress inside the gym community safely.

### Information hierarchy

- feed
- groups
- post composer
- moderation tools
- privacy

### Primary actions

- post
- react
- comment
- report
- block

### Mandatory states

- blocked user
- removed content
- upload failure
- rate limit

### Acceptance requirements

- The screen SHALL preserve the Community user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M12: Messages and Support

**Primary roles:** Member  
**User job:** Reach trainers or gym staff and understand response expectations.

### Information hierarchy

- conversation list
- coach/staff identity
- attachments
- support ticket
- status

### Primary actions

- send
- attach
- open ticket
- mute

### Mandatory states

- outside hours
- staff reassigned
- failed attachment
- restricted topic

### Acceptance requirements

- The screen SHALL preserve the Messages and Support user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M13: Live and On-Demand

**Primary roles:** Member  
**User job:** Join entitled fitness content with reliable controls.

### Information hierarchy

- live room
- player
- chat/reactions
- captions
- recording label
- library

### Primary actions

- join
- cast where supported
- react
- report
- resume

### Mandatory states

- stream unavailable
- quota blocked
- entitlement lost
- caption missing

### Acceptance requirements

- The screen SHALL preserve the Live and On-Demand user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.

## UX-M14: Profile, Settings and Privacy

**Primary roles:** Member  
**User job:** Control identity, preferences, devices, data, visibility, and communication.

### Information hierarchy

- profile
- membership
- devices
- notification preferences
- privacy controls
- data export/delete

### Primary actions

- edit
- revoke session
- change visibility
- request export/delete

### Mandatory states

- pending legal hold
- unverified contact
- guardian-managed dependent
- provider unlink

### Acceptance requirements

- The screen SHALL preserve the Profile, Settings and Privacy user job as the dominant visual hierarchy.
- Every destructive or financially significant action SHALL show impact, scope, and a reversible/approval path where possible.
- Keyboard, screen-reader, dynamic text, contrast, touch target, reduced-motion, and error-recovery behavior SHALL be verified.
- Analytics SHALL measure task completion and failure without capturing sensitive free text.
- Loading SHALL preserve layout; empty states SHALL explain the next useful action; permission denial SHALL not masquerade as missing data.


# Accessibility and inclusive design

Target **WCAG 2.2 Level AA** for the Admin Web Dashboard and apply W3C WCAG-to-mobile guidance plus native iOS/Android accessibility APIs for the Member App.

Mandatory requirements:

- Full keyboard operation for admin workflows, including tables, calendars, menus, dialogs, and drag/reorder alternatives.
- Visible focus that is not obscured by sticky UI.
- Screen-reader names, roles, values, state changes, validation, and live-region announcements.
- Text contrast and non-text contrast meeting WCAG AA criteria.
- No information conveyed by color, sound, motion, position, or haptics alone.
- Text zoom and dynamic type without loss of essential content or functionality.
- Accessible authentication: paste-enabled OTP, password-manager support, passkeys, and no memory puzzles.
- Reduced motion, reduced transparency where supported, and autoplay controls.
- Captions and transcripts for instructional and live/on-demand video where required.
- Error summaries with field links for long forms.
- Target-size compliance and adequate spacing between adjacent controls.
- Localization-safe layouts and no text baked into images or icons.

Fitness-specific inclusion:

- Exercise instructions should offer text, image/video, and concise cues.
- Timers include visual and optional audio/haptic feedback.
- Challenges allow privacy mode and do not require public body metrics.
- Progress charts provide textual summaries and data tables.
- Workout flows support one-handed operation and sweaty/gloved conditions through large targets and forgiving taps.

# Responsive and device requirements

## Admin web breakpoints

- **Large desktop:** 1440 px and above. Multi-column command center and wide operational tables.
- **Desktop:** 1024–1439 px. Full navigation and primary two-column layouts.
- **Tablet:** 768–1023 px. Collapsible navigation, fewer simultaneous panels, touch-safe controls.
- **Small tablet/mobile browser:** below 768 px. Supported for urgent management tasks, not a squeezed copy of dense desktop screens.

## Mobile test matrix

At minimum, design and QA SHALL cover:

- Small iPhone-class device.
- Current large iPhone-class device.
- Mid-range Android around 360×800 dp.
- Large Android device.
- Android font scale at 1.3× and maximum practical accessibility scale.
- iOS Larger Text accessibility sizes.
- Light/dark mode, reduced motion, screen reader, low bandwidth, offline, and landscape where media/workout requires it.

# Performance perception requirements

- First meaningful skeleton must match final layout and avoid cumulative jump.
- Tap feedback begins immediately even when the authoritative result is pending.
- Workout set logging is local-first and visually confirms within 100 ms.
- Route transitions with cached data should feel immediate; avoid full-page spinners.
- Images use placeholders, correct aspect ratio, and progressive loading.
- Expensive charts, editors, and media load only on routes that use them.
- Animations must not block input or extend task time.

# Design QA gates

A screen cannot be marked approved unless:

1. All mandatory states exist.
2. Realistic maximum-length data has been tested.
3. Accessibility annotations exist and automated/manual checks are planned.
4. Both light and dark themes are reviewed.
5. Responsive behavior is explicit.
6. Content uses canonical domain terms.
7. Destructive and financial actions show consequence and scope.
8. Analytics events do not collect sensitive free text.
9. Motion respects reduced-motion settings.
10. The screen traces to PF requirement IDs and does not invent unsupported functionality.

# Design delivery and AI-agent prompts

## Figma/file organization

```text
00 Foundations
01 Tokens and themes
02 Web components
03 Mobile components
04 Admin patterns
05 Member patterns
06 User flows and prototypes
07 Accessibility annotations
08 Content and localization
09 Archived explorations
```

Every approved screen frame SHALL include:

- Requirement IDs.
- Role and branch scope.
- Responsive variants.
- Loading, empty, error, offline, and permission variants.
- Keyboard/focus annotations for web.
- Screen-reader order and labels for critical controls.
- Motion and haptic notes.
- Analytics events and success criteria.
- Data assumptions and maximum realistic content samples.

## Design phase prompts

### D0: Foundations

> Read all Shark Fitness PRDs. Create only the design foundations: information architecture, role-based navigation, semantic token system, light/dark themes, typography, spacing, shape, elevation, icon rules, chart palette, motion, haptics, and accessibility rules. Do not design isolated glossy screens. Deliver Figma variables/tokens, component naming, responsive grid, and an accessibility annotation template. Validate contrast and long-text behavior.

### D1: Admin component system

> Build the production admin component library from the Design/UIUX PRD. Cover forms, tables, saved filters, calendars, dialogs, status, charts, file upload, bulk actions, command search, error/offline states, and permission states. Demonstrate keyboard and screen-reader behavior. Use realistic dense data and both comfortable and compact density. Do not invent product rules outside PF requirements.

### D2: Member component system

> Build the production mobile component library for authentication, membership pass, booking, active workout, progress, messaging, challenges, nutrition, and media. Include iOS and Android conventions, dynamic type, reduced motion, offline/sync states, haptics, safe areas, and one-handed use. Test on representative small and large devices.

### D3: Critical flows

> Prototype lead-to-member, member check-in, last-seat booking/waitlist, offline workout, failed payment recovery, account deletion, and trainer program assignment. For each flow include success, failure, permission, offline, concurrency, and recovery variants. Annotate requirements and analytics.

### D4: Validation

> Run expert review and moderated usability tests for reception, manager, trainer, new member, and experienced trainee personas. Measure task completion, time, error, confidence, and accessibility barriers. Return prioritized findings with evidence. Do not change business rules merely to hide implementation complexity.

# Design references and verified standards baseline

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines): accessibility, layout, typography, gestures, color, and motion.
- [Material Design 3](https://m3.material.io/): usability, adaptive layouts, interaction states, touch targets, and reduced-motion behavior.
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [guidance applying WCAG 2.2 to mobile applications](https://www.w3.org/TR/wcag2mobile-22/).
- [React Native New Architecture](https://reactnative.dev/architecture/landing-page) and native accessibility APIs.
