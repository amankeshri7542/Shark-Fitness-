# Phase 2 closeout / Phase 3 rehearsal — 23 September 2026

## Scope and decisions

One staffed synthetic gym, manual independently received cash/verified UPI, reception attendance. No real people, real charges, live-service modifications, paid resources, main merge, or roadmap expansion.

Verified starting branch `codex/production-hardening-p0`, clean at `2a59a1fbda32fb8bd8f274adf49d34dbd1b1f5fd`; fetched candidate matches (0/0 divergence), main is 35 commits behind. PR #15 is open and starting-SHA verify/image checks passed. Runtime Node 22.23.2; use `npx pnpm@10.28.0` because ambient pnpm is 12.4.1.

## Milestones

1. Reproduce and close simulated payment settlement; retain manual receipts/refunds, review all writers and staff event visibility independently.
2. Execute isolated local restart/replacement/backup/recovery checks and prepare hosted operator steps.
3. Run fresh synthetic browser acceptance, update existing guide; distinguish API, viewport, physical device, human, container and hosted evidence.
4. Full release gates, independent boundary review, authorized commit/push/PR update and exact-SHA CI.

## Work ownership

- Integrator: payment service/routes/member Billing, regression proof, report, final gates/Git.
- Deployment agent: deployment scripts/config and deployment-stabilization report; unique temporary DB/ports.
- Browser agent: isolated browser rehearsal and PILOT-TEST-AND-DEMO guide.
- Independent reviewer: staff event visibility, then implemented payment boundary. No overlapping edits.

## Current evidence and pending decisions

Confirmed source defect: member confirmation and staff demo webhook invoke shared settlement with `provider: 'demo'`, no production guard. Missing configuration must fail closed. Plan: retire simulated routes universally and reject simulated/nonstaff settlement at shared boundary; preserve all historical rows.

User decision: **local rehearsal only; hosted work stays blocked. Prepare guide; human/device checks remain pending.** These gates receive no hosted/human credit. Prior browser credential auto-review denial must not be bypassed.

## Milestone 1 results

- Six new payment-boundary tests failed against starting code in production mode (simulator routes returned 200; shared service accepted fake money). Logs: `/tmp/shark-payment-before.log`.
- Retired member intent/confirm and admin demo webhook with unconditional 412 before side effects. Shared service requires manual staff authority, no provider, valid positive integer/UPI reference, scoped invoice and matching retry content; no created-intent upgrade path remains. Historical rows preserved.
- Six boundary tests passed in production and with NODE_ENV unset; 59 focused boundary/billing/staffed-gym/date/dunning tests passed in production. Logs `/tmp/shark-payment-{after,unconfigured,focused}.log`.
- Removed member checkout; truthful reception settlement copy. Reproduced stale Billing query key (one fetch after realtime invalidation), fixed to existing `billing` key; component regression passes. `/tmp/shark-billing-refresh-{before,after}.log`.
- Independent reviewer reproduced staff event payload leaks across four roles; permission-scoped staff invalidations implemented, replay/live regressions pass. Member payload behavior retained. Review of payment fix in progress.
- Local recovery now compares populated ledgers and authenticated reads across restart, copied API replacement, source loss and recovery. Backup artifact file permissions also being hardened. This is same-host local evidence, not off-instance/hosted proof.
- Browser fresh-owner/empty-gym checks passed. Staff/member private activation remains pending; shared form duplicate IDs found and being fixed with a regression.

Next: finish independent review/browser evidence, full release checks, dated report/rubric and authorized Git/CI. No current app database modified.

## Milestone 2 / integration checkpoint

- Independent payment review complete: no blocking defect found; manually authorized zero-price plans remain valid and do not manufacture payment rows.
- Seven final payment-boundary cases now cover expired intents as well as created/succeeded history.
- Local recovery final proof passed after artifact-permission fix; evidence: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-recovery-proof-xxtXLo/evidence.json`. Backup SHA-256 `3ba361c26e2fe8f524379996f9e7d78a7258cd9ffee8295d766c46de6f2faf41`. Four distinct production process releases, twelve populated table fingerprints, source loss, authenticated receipt/ledger reads. External archive/host proof remains blocked.
- Full typecheck and lint passed. First full suite: domain 255/255, member 29/29, admin 263/263, API 719/722. Three failures are under diagnosis: journey revenue/refund requests use UTC today instead of branch-local today; single-currency report assumes August seed rows. Build withheld at this gate; no assertion will be weakened. Logs `/tmp/shark-phase23-{typecheck,lint,test}.log`.
- Shared form fallback IDs fixed with existing React useId; regression failed before and passes after. No dependency or schema change. Browser verifier awaiting final build.

Next: focused report-fixture fixes and regression proof; rerun full suite/build, finish browser guide, record strict rubric, commit/push and final-SHA CI.

## Milestone 3 / final local release checks

- Source, tests and scripts committed and normally pushed as `54877acf08ad99e966e8a17c18b9309d0acdf124` (`fix: enforce staff payment boundary and rehearse recovery`). Remote was refreshed immediately before commit; 0/0 divergence from the original candidate and no unrelated changes were present. No main merge or force push.
- Corrected three independently reproduced test-date assumptions using branch-local dates and an explicit exact-money currency fixture; 80/80 focused tests passed. The new MemberDetail regression had TypeScript callback/options errors, corrected before final gates.
- Final Node 22.23.2 / pnpm 10.28.0 typecheck, lint, all **1,273 tests / 99 files** and build passed. API 725, admin 264, member 29, domain 255. Logs `/tmp/shark-phase23-{typecheck,lint,test,build}-final.log`.
- Final payment refusals pass **7/7 production** and **7/7 NODE_ENV unset**, each on its own synthetic DB: `/tmp/shark-payment-{production,unconfigured}-final.log`. Initial command setup mistakes (missing required production settings; unresolved temp path) stopped before test collection, then were corrected. No guard was weakened.
- Runtime manifest `docs/evidence/phase23-local-verification.json` identifies source, logs and 55 built asset hashes. Changed-file credential/conflict scan found zero signatures in 28 files; diff whitespace passed. Source files are frozen pending browser evidence.
- Source push CI: https://github.com/amankeshri7542/Shark-Fitness-/actions/runs/35773315871; source PR CI: https://github.com/amankeshri7542/Shark-Fitness-/actions/runs/35773323761. Final result and any later documentation-only head checks will be linked from PR #15.
- Browser agent is finishing the permitted prepared-fixture reception/member journey at the committed source release label. Fresh private activation, actual phone and uncoached repetition remain pending by user choice/policy; hosted work remains blocked by user choice.

Next: finish browser results and guide, record source CI, commit only handoff documents/evidence, normal push, verify actual final-head push and PR CI, then update PR #15 with exact identities and separate verdicts.

## Milestone 4 / source CI and browser closeout

- Both source `54877ac` push and PR CI completed successfully: **verify + image**, including populated backup/restore and production browser/container smoke. Runs `35773315871` and `35773323761`; these prove GitHub-runner behavior, not a hosted gym service.
- Prepared reception browser checks passed: assign priced plan (353,882 minor), show pending payment, deny unpaid entry without a granted visit, record acknowledged cash once, replay without a second payment, download truthful acknowledgement receipt, check in/replay the same visit/check out.
- A separate prepared member account passed normal sign-in and 390×844 Billing/Pass checks, with 35,000 minor across two synthetic unpaid invoices (10,000 + 25,000); the just-settled walk-in invoice is a different account/fixture. Member admin/receipt access was refused. Offline card warns that data may be stale. None of this completes the new member's private activation or an uncoached continuous journey.
- Both local APIs are now labelled with exact source release `54877acf08ad99e966e8a17c18b9309d0acdf124`; the browser agent is finishing fresh-owner production smoke and saving its final guide/evidence. No runtime source changed after the source commit.

## Final handoff checkpoint

Local work within the approved scope is complete. The browser agent finished all permitted prepared-account checks and a fresh-owner production browser smoke (exit 0). Secret-free evidence is committed in `docs/evidence/browser-2026-09-23.json` and `browser-smoke-2026-09-23.log`; the guide records exact saved amounts/identities, separate account scenarios and the full-day synthetic branch configuration used after correct outside-hours denial. Both local APIs on 8896/8897 report source `54877acf08ad99e966e8a17c18b9309d0acdf124`, with post-restart authenticated state verified. No runtime changes followed its successful full gates and source CI.

Handoff-only commit identity and its final push/PR CI are maintained in [PR #15](https://github.com/amankeshri7542/Shark-Fitness-/pull/15), avoiding a self-referential commit hash in this file. Source CI already passed both verify and image; the final handoff must also pass both before release bookkeeping is closed. No main merge, force push, paid resource or hosted deployment occurred.

Verdicts: Phase 2 safety implementation delivered, fresh/human closeout open; Phase 3 incomplete; prepared synthetic technical walkthrough only; complete fresh demonstration and real-member pilot NO-GO. Fixed-rubric scores: demo 45/100, pilot 45/100. No Phase 4 work started.

Next operator work: privately complete fresh staff/member activation and subsequent login, repeat the journey without coaching, and test a physical phone. Hosted service/disk, off-instance archive/recovery, backup ownership/retention and alert destination/cost remain unapproved; execute the deployment runbook only after that scope is authorized. Settle safe account recovery and fiscal receipt requirements before a real-member pilot. Estimated remaining Phase 3 effort: 1–2 engineer days plus half a day with the operator, assuming access/budget/DNS, with 0.5–1 day allowance for acceptance fixes.
