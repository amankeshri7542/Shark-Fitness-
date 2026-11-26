# P07 independent review

Branch `phase/P07-engagement-ops-modules` (stacked on `phase/P06-staff-security`), reviewed at `0621707`. Fixes were committed on top, ending at `05bd3d6`.
Reviewer: independent senior review, 2026-11-26. Node 22.23.5, worktree `/workspace/sf-wt/P07`.

## Verdict

**Ready for PR, with known minor issues.**

The phase is broad and largely well built: one notification service with truthful log drivers, a network guard, consent re-checked at send time, signed attachment URLs that re-check access, and permission- and scope-aware search.

The review found **no blockers**. It found **10 major issues**: authorization leaks in the Inbox, a broadcast approval that could be bypassed, a shared-PC privacy leak in the palette, and a missing member check-in screen. All ten are fixed with tests. Eight smaller issues were also fixed. The minor issues listed under "Remaining" are recorded for follow-up.

## How the review was done

- I read the spec, the notes and the full diff (115 files). The new services and routes were read in full.
- Every finding was traced through the code before it was acted on. Audit leads that could not be substantiated were dropped.
- Baseline before any fix: `pnpm typecheck`, `pnpm lint` and `pnpm test` were all green. The counts matched the PR: contracts 6, domain 282, member-pwa 55, admin-web 369, API 1,045.
- For each fix, a regression test was added where it made sense. For the broadcast hold and the palette highlight, I confirmed that the new test fails without the fix.

## Findings

### Major (all fixed)

| # | Area | Finding | Fix (commit) |
| --- | --- | --- | --- |
| M1 | Messaging | **A coach kept access to a member's coach threads after the member changed coach.** `staffCanSee` allowed it through `conversation.staffId` and `assignedStaffId`, and nothing updated either field when the trainer changed. The old coach could keep reading, replying, downloading attachments and receiving notifications, which breaks PF-STAFF-005. | All three trainer-change writers (single, bulk, and assign-with-program) now hand the member's coach threads to the new coach. A manager's cover assignment is kept. Test added. (`614f77d`) |
| M2 | Inbox | **Assignment checked only the branch.** Anyone with `inbox.view` could assign a desk thread (billing, membership) to a trainer, who could then read it. | `assignInbox` now checks the assignee's role against the thread kind, as the picker already did. Test added. (`614f77d`) |
| M3 | Broadcasts | **Owner approval had no size bound.** After approval, a send recomputed the audience and sent to all of it, however much the segment had grown. A dry run also overwrote the approved count. | Approval now records the audience it approved, and a dry run no longer moves it. A send that has outgrown the approval goes back to `awaiting_approval` (audited) and needs approving again. (`28b35d4`) |
| M4 | Broadcasts | **The "awaiting approval" state was never saved from the console.** The send route runs inside `runIdempotently`'s transaction whenever an idempotency key is present, and the console always sends one. The 412 rolled the state back, so the broadcast stayed a draft and the owner never saw Approve. The API test missed this because it sent no key. | The hold is now checked and recorded before the idempotent transaction. The test sends with a key and fails without the fix. (`28b35d4`) |
| M5 | Settings | **Safeguards could be loosened without step-up.** `PATCH /settings/engagement` could raise the approval threshold to 1,000,000 or switch on staff↔minor messaging with only `settings.manage`. That sidesteps the step-up that broadcast approval requires. | Raising the threshold or allowing staff↔minor messages now needs a fresh re-authentication (`settings.engagement`). Tightening either does not. Added to the step-up matrix in `docs/SECURITY.md`. (`731b3bf`) |
| M6 | Palette | **Recents leaked between users on a shared desk PC.** They were stored under one browser-wide localStorage key and survived sign-out. The next person to sign in, whether another role or another tenant, saw the previous user's member names and invoice amounts. | Recents are now keyed by tenant and user, and cleared at sign-out. Component test added. (`1c9b0c3`) |
| M7 | Tasks | **Generated tasks went to staff who could not act on them.** The source's person (lead owner, coach, work-order assignee) was assigned without checks, so a task could land with a deactivated person or someone at another branch, where nobody would see it. | Such tasks are now created unassigned, in the open queue. Test added. (`4061746`) |
| M8 | Community | **Comment counts gave away blocked commenters.** The feed sent the stored counter, which includes comments by blocked or muted people and hidden comments. "3 comments" over two visible told a member that someone they blocked was still commenting. | The count is now the number of comments the reader actually receives. Test added. (`876ccc6`) |
| M9 | Coaching | **Re-sending a check-in cleared the coach's safety flag.** Re-sending the same week overwrote the note, the flag and the signals. A distress note edited to "all fine" disappeared from the coach's roster and the original words were lost. P07's new dedupe key also silenced a second alert. | Once a check-in is flagged for a person, it stays as written, and the member is pointed to messaging. Test added. (`eb6aa22`) |
| M10 | Member app | **Members had no way to send the weekly check-in.** The spec asks members to submit one, and the coach view reads and replies to them. The API existed, but no member screen called it, so the coaching loop could only be exercised from tests. | The Habits screen now has a weekly check-in section with six 1–5 scales, a note, who reads it, the coach's reply, and the server's safety response rendered verbatim. It sends directly rather than through the outbox, so a safety response shows at once. Loading, error, offline, opted-out, sent and replied states each have a component test (6 tests). Checked in the production build, with screenshots in `phases/P07-screens/review/`. (`27749c4`) |

### Minor (fixed)

| # | Finding | Fix |
| --- | --- | --- |
| m1 | **Late search results could change what Enter opens.** Results land above the modules after the debounce, but the palette highlight stayed on its old index, so Enter could open a member instead of the module that was chosen. | The highlight now follows the chosen item. The test fails without the fix. (`1c9b0c3`) |
| m2 | **A non-manager could unassign a task** given to them, dropping it off every "My tasks" list. | Only managers can unassign, which is what the UI already assumed. (`4061746`) |
| m3 | **Restore could publish a pending or rejected post** without going through the approval queue. | Restore now applies to hidden or removed content only. (`876ccc6`) |
| m4 | **Bulk messaging bypassed the minor rule.** Member bulk message posts a direct desk message to each member, including under-18s. | Minors are left out unless the gym allows staff↔minor messages, and the result says how many and why. (`5572acb`) |
| m5 | **WebP photos kept their EXIF/XMP metadata, including GPS.** WebP was accepted but its bytes were returned unchanged. | The EXIF and XMP chunks are now stripped and the VP8X flags cleared. Unit test added. (`a69eff4`) |
| m6 | **The quick-add duplicate check had no rate limit.** It reveals whether a phone or email is on file. | Rate-limited at 60/min per actor. (`a69eff4`) |
| m7 | **Files in support-ticket threads could never be opened.** Members could upload into a support-ticket thread (201), but staff read attachments through the Inbox rules and got a 404. | Ticket threads now say that files go to the coach or the desk, and uploads there are refused. (`05bd3d6`) |
| m8 | **Weak minor-rule test.** It covered only a member starting a thread. | The new tests cover bulk messaging and the settings step-up. |

### Remaining (not fixed; recommended follow-ups)

All of these are minor. None is a security or data-integrity issue.

1. **Busy Inbox truncates threads.** `listInbox` applies `.limit(200)` before the per-role `staffCanSee` filter, so at a busy branch a trainer's older threads can fall off the list. It needs pagination or role filters in SQL.
2. **Unsent uploads are never cleaned up.** No per-thread cap applies (only the 30/min actor limit). A sweep job is needed, ideally from P05's media lifecycle.
3. **Staff search can miss in-scope staff.** It caps at 12 rows tenant-wide before filtering by branch, so in a multi-branch gym a manager's own staff can be crowded out.
4. **Branch pickers offer unusable branches.** The broadcast segment and quick-add pickers list every entitled branch, but both act only on the active branch. The result is an empty audience or a 404, which fails closed but is confusing.
5. **Task generation keys:**
   - A lead with no next action keeps `lead_sla:<id>:stale` forever, so it never gets a second task after the first is done.
   - `member_risk` opens a new task every month even while last month's is still open.
6. **Reports don't apply feed visibility.** `/report` does not check that the reporter can see the post (private, other branch, blocked).
7. **The feed applies its limit before filtering** for block, mute and held-back posts, so a feed can come back short. This pattern predates P07.
8. **Small inconsistencies:**
   - Approvals do not expire.
   - `cancelBroadcast` is not wrapped in `transact`.
   - The comment POST response still returns the stored counter (the feed itself is now correct).
   - A message cannot be attachment-only (a body is required on both sides).
9. **Coverage to add in P08**, beyond the specs already listed in the notes:
   - E2E for the member weekly check-in (now possible).
   - E2E for staff replying to a minor's thread (API-enforced in `replyInInbox`, but untested).
10. **Docs gap from P06.** The spec's production-smoke command lacks `SHARK_MFA_ENCRYPTION_KEY`, which production requires since P06. The P07 smoke needs it.

### Acceptance criteria re-check

| AC | Status | Evidence |
| --- | --- | --- |
| 1 Channels | Pass | `notification-channels` 15 tests: log driver `logged`; Resend, Twilio, MSG91 and WhatsApp against local fakes; 5xx bounded retries; 4xx permanent; opt-out after queueing; missing variable; quiet-hours defer; network guard. The test log has zero "Network guard" refusals. |
| 2 Messaging | Pass | `member-messaging` 15 tests: coach and desk threads; minor rule; a note scan across 6 member payloads; signed and expired attachment links; cross-member and cross-tenant refusal; plus the review tests for coach change, assignment roles and ticket threads. |
| 3 Community | Pass | `community-moderation` 10 tests: report → remove → tombstone plus author notified; block both ways, including the challenge board and now the comment count; 429 for posts and comments; approval mode, now including the restore bypass. |
| 4 Tasks | Pass | `tasks` 7 tests: no duplicates across runs and through the scheduler wrapper; 404 out of scope; outcome required; the strip count matches. The review added generated-assignee validation and the unassign rule. |
| 5 Coach view | Pass | `coaching` 5 tests: assigned members only; opted-out members excluded; safety flag with no analytics or outbox/integrations event; the flag now survives a re-send. Members can now submit from the app. |
| 6 Broadcasts | Pass | `broadcasts` 7 tests: preview equals send; cost = recipients × rate; dry run writes no deliveries; owner and step-up approval. The review added the hold under an idempotency key, the bound on approval size, and step-up for raising the threshold. |
| 7 Quick add | Pass | `palette-quick-add`: a duplicate is linked; the new member is activated and signs in. |
| 8 Palette | Pass | e2e `engagement-palette` (keyboard only, Ctrl+K → member detail; Record payment → payment dialog; axe clean; Add member). Component tests now 9. |
| 9 States, e2e, gates | Pass | Component tests cover each new screen's loading, empty, error, permission and offline states, and now the member check-in. `pnpm e2e` 14/14. All gates green. |
| Nav | Pass | Reception rail has 7 modules (domain test). |

## Final verification (fresh run after all fixes, `05bd3d6`)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` (`--max-warnings=0`) | pass |
| `pnpm test` | **1,773 tests in 156 files, all passing** (details below) |
| `pnpm -F @shark/api test -- notification messaging community task coach broadcast palette` | 1,053 / 79, all passing (the filter runs the whole API suite) |
| `pnpm build` | pass |
| `pnpm -F @shark/api db:check-drift` | `migration_drift=none` |
| `SHARK_E2E_PORT=18642 pnpm e2e` | **14 passed** (2.4 min) |

`pnpm test` by package:

| Package | Tests | Files |
| --- | --- | --- |
| contracts | 6 | 1 |
| domain | 282 | 13 |
| member-pwa | 61 | 14 |
| admin-web | 371 | 49 |
| API | 1,053 | 79 |

**Production single-origin smoke.** Port 18643, temporary `SHARK_DB` and `SHARK_MEDIA_DIR`, with `SHARK_MFA_ENCRYPTION_KEY` added.
- `/` and `/admin/` both returned 200.
- As Aman, in a real browser: Habits → Weekly check-in → six scales and a note → Send. The sent state shows "Sent. Rehan Ahmed reads these and will reply here."
- Zero CSP console messages.
- Screenshots are in `phases/P07-screens/review/`.
- The server was stopped and its temporary files removed.

No real provider host was contacted and no real credentials were used.

One mistake to disclose: an early direct `vitest` call, made without `SHARK_DB`, created an **empty** `apps/api/data/shark.db` (no tables). I checked it was empty and deleted it at once. No existing data was touched, and every later run used the test script's DB or a `mktemp` DB.
