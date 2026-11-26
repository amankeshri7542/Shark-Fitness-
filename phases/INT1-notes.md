# INT1 — integration of P02–P07 into `integration/features`

Branch `integration/features` from `phase/P01-prod-readiness` (2c15353). Worktree `/workspace/sf-wt/INT1`.
Node 22 from `/home/box/opt/node22`, pnpm 10.28.0. Servers I start use ports 18700–18799.

## Plan

Merge with `git merge --no-ff` in the given order. After each merge: `pnpm install` (lockfile regenerated
from the resolved package.json files), `pnpm typecheck`, `pnpm test`, `db:check-drift`; fix and commit.

Topology found before starting:
- P05 is built on P02 (P02 head 2ffa570 is an ancestor of P05), so P05 carries P02's `0018_razorpay_payments`.
- P07 is built on P06 (P06 head d9e656c is an ancestor of P07), so P07 carries P06's `0018_staff_security`.
- P02, P04, P05, P06, P07 fork from P01 at 128aec1; P03 from 2c15353 (current P01 head).

Final linear migration sequence (later phases renumbered; journal `when` kept increasing; snapshots
regenerated with drizzle-kit and chained; SQL bodies unchanged):

| # | file | phase |
|---|---|---|
| 0018 | `0018_razorpay_payments.sql` | P02 |
| 0019 | `0019_public_website_leads.sql` (was 0018) | P03 |
| 0020 | `0020_push_notifications.sql` (was 0018) | P04 |
| 0021 | `0021_staff_security.sql` (was 0018) | P06 |
| 0022 | `0022_p05_member_core.sql` (was 0019) | P05 |
| 0023 | `0023_engagement_ops.sql` (was 0019) | P07 |

## Checklist (mirrors INT1-progress.json)

1. Merge phase/P02-payments-razorpay
2. Merge phase/P03-public-website
3. Merge phase/P04-member-mobile-app
4. Merge phase/P06-staff-security
5. Merge phase/P05-member-core-gaps
6. Merge phase/P07-engagement-ops-modules
7. Wire seams from every phase's Integration notes
8. Full verification (install, typecheck, lint, test, build, e2e, production single-origin smoke)
9. PR description `pr/INT1.md`

## Decisions

(added per merge below)
