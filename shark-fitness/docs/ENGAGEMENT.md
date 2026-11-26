# Engagement and operations modules (P07)

Messaging channels, member messaging, community moderation, tasks, the coach
view, broadcasts, quick add and the command palette. What each does, where the
rules live, and what is still an operator decision.

## Notification channels

One service, `apps/api/src/services/notifications/service.ts`, is the only way
the product reaches a member outside the screen they are on. Automations,
dunning, broadcasts, inbox replies, moderation notices, coaching feedback and
task assignments all go through it.

| Channel | Driver (env) | Default |
| --- | --- | --- |
| In-app | the member's inbox (always) | delivered at once |
| Push | P04 web push, registered with `setNotificationDrivers({ push })` | **not set up**: deliveries are suppressed with that reason |
| Email | `SHARK_NOTIFY_EMAIL_DRIVER=log\|resend` (+ `SHARK_RESEND_API_KEY`, `SHARK_NOTIFY_EMAIL_FROM`) | `log` |
| SMS | `SHARK_NOTIFY_SMS_DRIVER=log\|msg91\|twilio` (MSG91 needs a DLT flow id per message or `SHARK_MSG91_NOTIFY_FLOW_ID`) | `log` |
| WhatsApp | `SHARK_NOTIFY_WHATSAPP_DRIVER=log\|cloud` (+ `SHARK_WHATSAPP_ACCESS_TOKEN`, `SHARK_WHATSAPP_PHONE_NUMBER_ID`; each message names an approved template) | `log` |

`log` records the attempt as **"logged, not delivered"** and sends nothing. A
real driver selected without its credentials stops the process at boot.
Provider credentials are shared with the sign-in code senders.

Every attempt is a `notification_deliveries` row: `queued → processing →
logged | sent (provider id) | deferred | suppressed | failed`, with the reason
in words and a masked destination. The `deliver-notifications` scheduler job
(every minute) sends what is due.

**Consent is by purpose** (`packages/domain/src/notifications.ts`):

- *transactional* (payment problems, account standing): no opt-out.
- *operational* (desk replies, class changes) and *coaching* (check-in replies,
  habits): on until the member switches `notifications_operational` /
  `notifications_coaching` off in Profile → consents.
- *promotional*: in-app is allowed; email, SMS and WhatsApp need that
  channel's `marketing_*` consent. Absence is refusal.

Consent is checked when the message is queued **and again immediately before
the driver is called**, so an opt-out after queueing prevents the send.
Quiet hours (branch timezone, `quietHoursFrom`/`quietHoursTo`) defer
everything except in-app and transactional messages. A dedupe key makes the
same event one message. Message bodies are templates (`{{firstName}}`)
rendered at send time; a missing value fails the send with the reason rather
than sending the placeholder. Provider 4xx fails at once; 5xx, 429 and network
errors retry three times (1 min, 5 min).

Tests never reach a provider: `apps/api/src/__tests__/helpers/network-guard.ts`
refuses every non-loopback host for `fetch`, `http` and `https`, and the
channel tests point the real drivers at local fake servers.

The Automations and Marketing screens show each channel's real state:
*Delivers*, *Logged only* or *Not set up*.

## Member messaging and the staff Inbox

Members start a thread with their coach or their branch's front desk from
Messages → New message (topic picker; reply window and outside-hours note
before they type). Retries with the same client id return the same thread.

**Minors** (under 18 from `members.dob`): direct staff↔member threads are
refused unless Settings → engagement `allowStaffMinorMessaging` is on (off by
default, plan decision 16). The refusal is plain and says a parent or guardian
can contact the desk.

The **Inbox** module (`inbox.view`) shows coach threads to the assigned coach
and managers, desk threads to front-of-house and managers, always within the
caller's branches (404 outside). Staff assign, mark read (the member sees
"read"), reply, close/reopen and keep **internal notes** in
`conversation_notes`; no member route reads that table.

**Attachments**: JPEG, PNG, WebP or PDF, ≤ 10 MB, type decided by the bytes.
Images lose EXIF/XMP/text chunks (GPS) before storage. Files go through the
`MediaStorage` port (local disk under `SHARK_MEDIA_DIR`; unset in production
means uploads are off and the app says so) and are served only from
`/v1/attachments/:id?exp&sig`: an HMAC-signed path valid for five minutes, plus
a session, plus a re-check that the caller is the member in the thread or
staff who may see it. Back up `SHARK_MEDIA_DIR` with the database.

## Community

Members comment, delete their own comments, report posts and comments with a
reason, **mute** (one-way, feed only) and **block** (two-way; on shared
challenge boards a blocked member shows as "Blocked member"). Posting is
limited to 5 posts an hour and 15 comments per 10 minutes (429). With
`communityApprovalMode` on, new member posts wait as *pending*: only the
author sees them, with a note. Members under 18 have no public name in the
feed. A member blocked from the community can read but not post.

The **Community** module (`community.moderate`, branch-scoped) has the reports
queue grouped by content (what it replied to, report count, reasons and
notes), hide / remove / keep / restore with a required reason the author is
told in-app, an approval queue, and community bans. Every decision is audited.

## Tasks

`generate-tasks` (every 15 minutes) turns operational alerts into tasks with a
unique generation key, so runs never duplicate: a lead past its follow-up
(per missed action), a failed payment, a member at high risk (one a month), an
open safety work order, a waitlist offer left unanswered. Tasks have an
assignee (lead owner, coach or work-order assignee where known), due date,
priority, status, link and an **outcome, required to finish**. Managers
(`task.manage`) see the branch queue and assign; trainers and accountants work
their own. The status strip shows *My tasks* and the alert-born tasks still
open ("to act on"). "Create task" is on Command Center alerts, member and lead
pages and in the palette.

## Nutrition & Habits (coach view)

Trainers see only their assigned members; managers see their branches.
Members who switched nutrition and recovery off are not listed and not found.
The roster puts flagged check-ins first (a safety phrase in the note routes it
to the coach in plain words and never into reports or events), then check-ins
waiting for a reply. Coaches assign habits from templates and reply; both
reach the member as coaching messages.

## Broadcasts (Marketing)

`broadcast.send` (owner, regional and branch managers). A broadcast is one
message to a segment: status, branch, tags, last visit, membership end window,
frozen to the creator's branches. **Preview, dry run and send run the same
checks as the NotificationService**, so the counts left out for consent,
opt-out, missing number/address or an unavailable channel, and those held for
quiet hours, are what the send produces. Cost is recipients × the gym's rate
per channel (`messageRates`, paise; defaults email 10, SMS 25, WhatsApp 80).
Above `broadcastApprovalThreshold` (default 200 recipients) the send waits
until an owner approves with a fresh re-authentication (step-up). A dry run
cannot enqueue anything. The delivery report counts outcomes and reasons.

Engagement settings live at `GET/PATCH /v1/admin/settings/engagement`
(`settings.manage`, audited).

## Quick add and the command palette

Members → **Add member** (or ⌘K → Add member): name, phone, optional email,
branch, optional plan, through the same enrolment service as lead conversion.
A phone or email already used by a member in scope is refused with a link to
that member; otherwise the refusal names nobody. On success the activation
link can be created straight away.

⌘K / Ctrl+K searches members, leads, invoices, classes and staff on the server
(each behind its own permission, inside the caller's branches; trainers find
only their members), lists every module the role may open (including those
not on a trimmed rail), remembers recent picks, and runs actions: Add member,
Record payment (find the invoice → Billing opens on its payment form), Check in
member (find them → Floor), Create class, New task. It is an ARIA combobox with
a listbox: arrows, Home/End, Enter, Escape (steps back out of a follow-up
question first).

## Navigation

`navFor(role)` is the rail; `modulesFor(role)` is everything the role may
open. Reception's rail is seven modules (Command, Inbox, Members, Floor,
Billing, Schedule, Leads); Store, Support and Tasks stay one ⌘K away, and
Tasks is always in the status strip.
