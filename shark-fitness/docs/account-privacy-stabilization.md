# Account access and realtime stabilization — 20 September 2026

## Independent staff-feed review — 23 September 2026

Member-channel separation alone did not complete realtime authorization. The independent reviewer traced live and replay delivery and reproduced private attendance/support payloads reaching unrelated trainers and accountants through branch feeds. Four role regressions failed before the fix.

Staff feeds now deliver only permission-allowlisted topics and alert kinds, with empty payloads. The admin client uses these solely to invalidate permission-scoped REST queries; it does not need member IDs, safety categories, denial reasons or financial row data in the event. Unknown topics/kinds fail closed. Replay and live delivery share the same projector and recheck tenant/branch/session authority. Member-owned event payloads remain available; revocation still closes the connection. Seven real-socket regressions passed after the change, covering reception, trainer, accountant, manager, member isolation and revocation.

This is evidence for the reviewed topic set, not permission to publish new topics without review. First-time activation remains distinct from account recovery: existing-password accounts cannot redeem activation as reset. Human/browser private activation and account-recovery policy acceptance remain pending for the real-member gate.

## Evidence before

- Both sign-in screens submitted literal gym slug `shark`. Other operational gyms could sign in through the API, but could not choose their gym in either UI.
- Lead conversion creates an invited user with no password; staff creation likewise lacks a production password activation path. Existing development OTP echo is expressly not delivery, and production OTP returns provider-unavailable. New real users therefore could not complete production onboarding.
- The original realtime hub granted every authenticated member tenant and branch channels. Attendance services emit staff reception records on those branch channels. The hub checked authority only at connection creation; a revoked session continued receiving events and answering ping.
- Reproduced original hub behavior against a temporary copy of HEAD: 2 failing assertions (member offered tenant/three branch channels; revoked socket stayed open instead of 4401). Temporary files were removed. Evidence: `/tmp/shark-realtime-before.log`. The first attempt to open a test server in the sandbox was blocked by EPERM; the actual reproduction and passing verification ran with loopback-server permission.
- Independent review reproduced an additional authenticated denial-of-service: sending JSON `null` raised an uncaught TypeError in the WebSocket message handler. A null/non-object guard fixes it; the real-socket regression sends both `null` and `42`, then confirms ping still works. Before/after logs: `/tmp/shark-realtime-null-before.log` and `/tmp/shark-realtime-after.log`.
- Preserved pre-existing auth email-versus-phone matching fix and account-access test edits.

## Changes

1. Staff-mediated activation, with no email/SMS claim or new provider: reception with `member.edit` can issue an activation for an in-scope member; only the owner can issue staff activation. The account must have email, be invited/active, not deleted, and have no password. Existing accounts cannot be reset or taken over through this endpoint.
2. A random 32-byte bearer secret is hashed in the existing challenge table, lasts 24 hours, and is consumed transactionally with password creation and the new session. Reissuing invalidates earlier links. Expired, used, incorrect, disabled-account, and already-password accounts are rejected. New passwords require 12–128 characters. Issuance is authenticated, CSRF-protected, rate-limited and audited without the secret; redemption retains the existing strict origin boundary and is rate-limited.
3. Both sign-in screens accept the gym code and a fragment activation link. The fragment is not sent in HTTP access/referrer URLs, and is removed after redemption. Production screens do not prefill demo credentials or display seeded demo account lists. Member production sign-in defaults to password while OTP continues to report absent delivery truthfully.
4. Realtime tickets resolve the current session on consumption. Open connections re-resolve session, account, tenant and branch authority before client messages/replay and before any event delivery. Members receive only their own member channel; staff branch/tenant event streams are no longer offered to members. Revoked/expired/ineligible sessions close with 4401 when next used or when an event is delivered. Idle connections are not periodically polled, but cannot receive data after revocation.

## Verification actually executed

- API account-access: 5 passed, including the user's pre-existing regression, disabled/legal-hold/deleted accounts, and staff session revocation.
- API realtime-privacy: 3 passed using real local WebSocket connections, covering revoked ticket consumption, member staff-channel subscription/replay denial, and revoked live connections.
- API activation: 2 passed. The member journey starts with `bootstrapGym` creating a new empty tenant and owner, then uses public authenticated lead capture → pipeline stages → member conversion → issue → redeem → password login. No member password/account database edits are used in this journey. Staff creation and activation are also tested; intentional database changes are used only to simulate expiry and disabled-account failure conditions.
- PWA sign-in: 10 passed, including custom gym, fragment activation submission, and same-document fragment changes.
- Admin sign-in: 3 passed, including custom gym, fragment activation submission, and same-document fragment changes.
- Focused ESLint: passed for all account/privacy implementation and tests. API, admin and member TypeScript checks all passed.
- Browser attempt against the built local production preview at `http://localhost:8787/admin/sign-in` was blocked by `net::ERR_BLOCKED_BY_CLIENT` in both Chrome and hidden IAB. Visible IAB is unavailable in a subagent task. No browser activation or phone viewport completion is claimed from this attempt. These are focused checks, not hosted delivery/deployment verification; the main report records any later successful browser path and full-suite results.

## Manual verification

1. Provision an empty synthetic gym with the documented bootstrap command. Sign in to the dashboard using its gym code and owner account.
2. Create a staff account with a unique email. In Staff → staff detail, issue an activation. Hand the link only to that person; no message is sent automatically. Open its dashboard activation link in a separate/private browser, set a 12+ character password, and confirm staff access. Sign out and sign in again using that gym code/email/password.
3. Create/convert a synthetic member with email. In Members → member detail, issue activation and open its member-app link in a separate/private browser. Set a password; confirm that member's profile. Sign out and sign in again.
4. Replay the link: expect an invalid/expired response and no new session. Reissue an unused link: old link must fail. Try issuing staff activation as a manager or issuing any activation as a member: expect refusal. Try another gym's member ID: expect not found.
5. Disable a signed-in account and trigger/reconnect realtime: expect unauthenticated/4401 and no subsequent event payload. A member's realtime ready/subscribed list must not contain tenant/branch channels.
6. Reset safely by discarding the synthetic test database and browser site data, never by altering a real member's production account.

## Remaining limits

- Delivery is a deliberate in-person/manual handoff. Automated email/SMS and forgotten-password/account recovery are still not implemented; an existing password cannot be reset through activation.
- Members must provide an email to use this password activation path. Phone-only members need a verified email added through a supported profile workflow, or a later real SMS provider; do not promise phone-only activation.
- Removing unsafe member branch subscriptions also removes branch-wide push invalidations for those members. Normal authenticated reads/refetch continue; do not claim instantaneous member schedule/occupancy updates.
- This change protects members from staff feeds. Fine-grained filtering of staff event topics by permission is a separate audit area; existing staff channel policy is retained.

## Browser follow-up and 22 September verification

The earlier localhost:8787 block was a port/proxy collision. At `http://127.0.0.1:8797` the built local application loaded successfully in Chrome using only the isolated synthetic gym.

- Desktop owner sign-in succeeded; Staff → Add staff created a fresh `Browser Trainer`, and the staff-detail activation action generated a private link. Opening that link on a fresh page showed the activation form and 12-character minimum.
- At 390 × 844, the existing synthetic member signed in using the fresh gym code, reached the member home, opened Profile showing the correct member name/email and ACTIVE state, and signed out. This was an existing account login, not a substitute for new-account activation proof.
- At 1440 × 900, the synthetic receptionist signed in. Owner-only modules were absent; financial totals were restricted. Reception navigated the member directory and opened Leads → New lead, created `Browser Member`, moved it through Contacted → Qualified, and converted it directly to a member. The resulting profile and directory showed its new member number, supplied email, no membership, no invoices, and no attendance. Directory showed two members with both pagination boundaries disabled; browser navigation beyond 50 was not exercised in this small fixture.
- Automatic approval review rejected entering/submitting the new activation password, requiring user handoff for credential changes. A subsequent member activation-link issuance action was also rejected as creation of an access path requiring confirmation. Neither rejection was bypassed; API/component activation tests remain the executed end-to-end programmatic evidence. Full new-account browser activation remains unexecuted.
- Browser observation reproduced a real bug: a fragment-only activation navigation onto an already-mounted sign-in page left the ordinary login form visible until reload. Both sign-in screens now subscribe to `hashchange`, update activation credentials and gym code, and the member screen returns to password/identify mode. Removing the fragment restores ordinary login.
- On 22 September, stronger regressions were run with the listener temporarily omitted: both suites failed. With the existing listener fix restored, admin 3/3 and member 10/10 passed. The checks verify the latest token submitted to redemption, correct gym retention, and returning from activation to ordinary login. Both app TypeScript checks and focused ESLint passed. Original account/privacy implementation and user changes remain preserved.

### Anonymous activation client boundary

The 22 September source review found a second onboarding defect not covered by the earlier mocked sign-in component tests: both real `api()` clients omitted activation redemption from their CSRF session-entry exemptions. In a fresh browser without a stored CSRF token, redemption first requested `/auth/csrf`, which correctly rejected the anonymous visitor with 401, preventing activation entirely.

Regression tests now exercise each real client with a fetch double that returns 401 for an anonymous CSRF refresh and 200 for redemption. Both failed before the change. Adding only `/auth/activation/redeem` to each client's exemption set matches the server's existing session-entry policy; authenticated activation issuance remains guarded. Both tests now prove one direct redemption POST and storage of the newly issued CSRF token, with no preflight request.

Final focused 22 September results: admin API 1 + sign-in 3 passed; member API 10 + sign-in 10 passed (24 tests). Both app TypeScript checks and focused ESLint passed. Before logs are `/tmp/shark-admin-web-csrf-before.log` and `/tmp/shark-member-pwa-csrf-before.log`. These checks do not override the still-blocked browser activation-password submission.
