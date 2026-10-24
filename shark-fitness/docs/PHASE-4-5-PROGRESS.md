# Phase 4 preparation / Phase 5 everyday operations

## Scope and starting point
Local rehearsal only; no hosting, spending, real-member import, pilot launch or main merge. Phase 3 hosted recovery/alerts, private activation, physical-phone and uncoached human acceptance remain pending. Existing strict demo/pilot rubric stays separate from the Phase 5 feature matrix.

Verified clean starting HEAD `14f2b183f73b87c9c8733e40ec680d70bed1116d`; remote divergence 0/0; PR #15 open against main. Follow-on branch `codex/phase-4-5-gym-operations` starts there; final PR will be stacked onto `codex/production-hardening-p0`.

## Implementation plan and acceptance
1. Member corrections + CSV import (integrator): reuse member/account enrollment and existing idempotency. Reception edits ordinary profile/emergency details with version checks; owner-only fresh-auth identity correction is separate. Full-name search and duplicate/conflict tests. CSV bounded read-only preview, explicit valid-row confirmation, stale-preview rejection, safe error export, persistent exact retry outcomes; no financial import or bulk invitations.
2. Recovery (account_recovery agent): distinct owner-supervised first-time-independent recovery for eligible ordinary accounts, current-password reauthentication, verified identity/reason, hashed short-lived one-use link, replacement/replay/expiry refusal and session revocation. Owner/platform targets excluded. Human performs private browser password submission; synthetic API tests prove security.
3. Money/entitlements (renewal_credits agent): existing expired/cancelled-only renewal with quote/terms/debt and stale/retry protection; printable canonical acknowledgement; credit balance/history and recorded expiry. New sales/fulfillment and credit-linked refunds remain unavailable until allocation/refund policy is approved.
4. Independent security/financial/import review (operations_review), then full synthetic everyday-operation rehearsal and pilot operating pack. No invented participants, elapsed pilot, signatures or hosted proof.
5. Integrate, verify migration over populated data, required typecheck/lint/tests/build/browser checks, review/secret/whitespace checks, milestone commits, normal push, stacked PR and actual final-SHA CI.

## Ownership and migrations
Integrator owns app routing, schema export index, migration journal, MemberDetail integration, profile/import and final docs/Git. Recovery reserves additive 0015_account_recovery; receipt identity uses additive 0016_payment_receipts. No speculative credit-purchase table was added. No destructive migrations or schema contraction. Rollback retains old data and added tables; inspect compatibility before older-runtime writes. Unique temporary DBs/ports per worker.

## Decisions
Confirmed: preserve architecture, integer money, manual settlement authority, immutable history, existing renewal eligibility. Ordinary recovery is owner-only with fresh authentication. Unanswered user questions: credit-pack refunds (wholly unused/revoke, unavailable, or explicit owner money-only/retain), pack-consumption ordering and whether cancellation returns retain original expiry. Continue independent work while pending; do not invent allocation/refund policy.

## Milestone evidence — 23 September 2026

- A: profile/emergency correction and full-name lookup implemented. Login identity correction is owner-only with fresh password, verified identity/reason, duplicate checks, linked-account updates and session/challenge revocation. Version checks protect stale edits. Imported provenance remains visible.
- B: separate recovery implemented for eligible ordinary member/staff accounts; owner/platform recovery excluded. Fifteen-minute hashed single-use links, replacement/expiry checks, identity binding, session/socket revocation. Private human browser submissions remain pending.
- C: bounded CSV mapping/preview/import, actor/tenant/branch-bound signed preview, exact idempotent retry, atomic rollback, per-row results and spreadsheet-safe export. Fifty-one valid contacts imported in focused API evidence; one imported account completed real activation and normal login programmatically. No financial history or bulk invitations created.
- D: expired/cancelled-only renewal reuses membership purchase, quotes dates/terms/debt, refuses stale/unsupported confirmation and replays exactly. Canonical printable/downloadable acknowledgements preserve new issuance identity. Historical missing identity is labelled. Gross/refund/principal rules unchanged.
- E: faithful credit balance/history and recorded expiry delivered, including visible signed shortfalls and PT-use limits. **PARTIAL:** new sales, payment-gated allocation, pack attribution/returns and credit-linked refunds are unavailable pending explicit policy. No new usable credits are allocated from an unpaid invoice.
- Independent review caught normalized OTP challenges surviving revocation, removal of an activated account's only login email, and a delayed profile refresh restoring a signed-out viewer. All fixed; focused regression tests verify the boundaries. No other blocking findings reported in the combined static review.
- Browser review found a profile-refresh reconnect loop: the viewer object changed, resetting the realtime replay cursor and repeatedly fetching Billing until rate limits. Connection lifetime now follows stable account/branch identity. A hook regression failed before and passed after; sign-out/account-switch/branch-change checks remain intact. Independent review closed the fix.
- Full-name regression reproduced through archived `14f2b18` application HTTP: full name returned zero while first-name/member-number controls found the person. Current regression passes. Before proof: `/tmp/shark-full-name-before.log` and the private artifact path recorded in the verification manifest.
- Extended `staffed-gym.integration.test.ts` starts with a new empty gym, creates/activates staff/member through supported services/APIs, normally signs in, enrolls, assigns unpaid plan, denies access, records/retries payment, prints receipt, checks attendance, corrects profile, partially refunds, recovers account and renews a cancelled term. No direct database writes in that continuous journey. This is API evidence, not fresh human browser acceptance.
- Populated upgrade from `14f2b18`: all 102 existing table fingerprints preserved, 15→17 migrations. One new-table local backup/restore proof passed, including recovery/receipt records and immutable receipt triggers. See [migration/recovery](phase45-migration-recovery.md); hosted/off-instance gates receive no credit.
- Node **22.23.2**, pnpm **10.28.0**: final typecheck, lint, **1,326 tests / 106 files** and production builds passed (domain255, admin275, member34, API762). Logs `/tmp/shark-phase45-{typecheck,lint,test,build}-final.log`. Initial full suite exposed two missing demo-reset table entries; fixed without weakening the existing invariant. Focused UI5/5 and realtime race1/1 passed; race failed before guard.

- Final [browser rehearsal](phase45-browser-rehearsal.md) passed on exact runtime `b9da05ce7c6290ecac07b3f6437b1d3d64eb9a37`: live profile correction, 55-contact import with lost-response retry, supported renewal/retry, text/HTML/PDF acknowledgements, phone Billing, same-machine restart persistence and served asset hashes. The repeated original phone probe had no request storm/429 after the fix. Owner reauthentication and private activation/recovery browser submissions were not executed; prepared sessions remain labelled.

## Discarded test run / local database note

One discarded focused run set `DATABASE_URL` instead of the supported `SHARK_DB`, so it used `apps/api/data/shark.db`. Read-only inspection confirmed 56 new synthetic users/members during `2026-09-22T20:21:24Z–20:21:26Z`, with zero new invoices, payments or refunds. No destructive cleanup/reset was performed. This default demo database is **not** an accepted rehearsal artifact and contains these test contacts. All accepted focused/full/browser/migration/recovery evidence uses explicitly isolated databases. Use the exact artifact paths in the manifest/browser guide; do not use the default database as a clean starting gym.

## Feature acceptance and phase verdicts

| Area | Software/API acceptance | Interface/operational acceptance | Verdict |
|---|---|---|---|
| A Corrections/lookup | Passed scope, role, stale, duplicate, linked-data and history tests | Component and isolated browser checks passed | Implemented |
| B Existing recovery | Passed authority, tenant/branch, replacement, expiry, replay, session/socket and role preservation | Forms/client checks passed; private owner/recipient browser steps human pending | Implemented; human acceptance pending |
| C Contact import | Read-only preview, 51+, exact retry, stale/actor/scope refusal, rollback and imported activation passed | Component and isolated browser checks passed | Implemented |
| D Renewal/receipts | Supported transitions, quote staleness/retry, money/identity immutability passed | Component and isolated browser checks passed | Implemented |
| E Credit products | Existing balances/history/expiry and refund refusal tested | New sales intentionally unavailable pending policy | Partial; do not claim Phase 5 complete |
| Phase 4 preparation | [Operating pack](PILOT-OPERATING-PACK.md), synthetic API journey, migration/recovery evidence prepared | Local browser rehearsal passed; named humans unassigned | Prepared locally; remaining human gates explicit |
| Actual Phase 4 pilot | No real members or observation period | No human signatures/feedback manufactured | NOT RUN |
| Phase 3 | Earlier implementation preserved | Hosting, redeploy/persistence, off-instance restore, delivered alerts, private fresh browser, physical phone, uncoached staff pending | NOT COMPLETE |

The strict demo/pilot rubric remains **45/100** and retains its original weights; this feature matrix does not replace it.

## Release handoff / next action

Current branch: `codex/phase-4-5-gym-operations`, stacked on open PR #15's `codex/production-hardening-p0`. Implementation commit `c3d26f6318529deff99608331f936130589050dc`; browser-fix/runtime commit `b9da05ce7c6290ecac07b3f6437b1d3d64eb9a37`. The [verification manifest](evidence/phase45-local-verification.json) binds gate logs and 55 built assets to this runtime. Follow-on [PR #16](https://github.com/amankeshri7542/Shark-Fitness-/pull/16) targets `codex/production-hardening-p0`, preserving open PR #15. Its current head and linked CI runs are authoritative for the final documentation SHA and exact-head verify/image results. No main merge/deployment authorized. Implementation and local rehearsal handoff are complete within the stated limits. Next operator actions: decide credit policy, assign real owner/reception/custodian testers, complete the private human/device procedures, and separately authorize the pending hosted Phase 3 gates before any real pilot. Local runtime remains at `http://localhost:8898` with a separate synthetic database; the browser guide identifies its private artifact directory. Owner decisions and human/device/hosted checks remain pending after that handoff.
