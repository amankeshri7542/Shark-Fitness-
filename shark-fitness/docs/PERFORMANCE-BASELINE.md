# 5,000-member performance baseline

Measured 27 August 2026 with `pnpm perf:baseline`, Node 22.23.2 on
darwin-arm64. The script creates a fresh migrated/seeded WAL database, expands
Shark Fitness to 5,000 members across three branches, boots the production API,
signs in as the seeded owner, warms each route twice, then records 20 sequential
HTTP samples per route.

The 24.8 MB fixture contained 5,000 memberships, 5,068 invoices, 4,072
payments, 8,079 bookings, 5,225 check-ins, 504 support tickets and 348 stock
movements. Money remained integer minor units and booking allocation stayed
within each class capacity.

## Results

| Surface | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Dashboard | 10.07 | 11.68 |
| Member directory, offset 2,400 | 7.29 | 8.11 |
| Member detail | 3.01 | 3.47 |
| Retention report | 8.85 | 9.18 |
| Revenue report | 14.89 | 15.96 |
| Attendance report | 16.73 | 17.07 |
| Automation planning | 57.95 | 71.81 |

## Evidence-led optimizations

The first run found two materially slower paths:

| Surface | Before p95 (ms) | After p95 (ms) | Change |
|---|---:|---:|---:|
| Attendance report | 190.09 | 17.07 | -91.0% |
| Automation planning | 304.93 | 71.81 | -76.4% |

Automation planning performed two indexed dedupe reads per audience member and
re-read identical branch policy/account facts inside the subject loop. At
5,000 candidates that was up to 10,000 dedupe queries. Planning now calculates
event keys once, loads prior delivery/run keys in two bounded set queries,
loads account/consent state in sets, and resolves quiet-hour policy once per
branch. Its send, consent, account-state and dedupe decisions remain covered by
the existing integration suites.

Attendance loaded 5,225 rows through `checkins_branch_time_idx`, then created a
new `Intl.DateTimeFormat` for every local-hour conversion. Reusing pure
timezone formatter instances removed that CPU cost without caching any
authorization, balance, branch policy or other mutable business decision.

`EXPLAIN QUERY PLAN` on the measured database confirmed:

- membership audience uses `memberships_tenant_state_idx` plus the members
  primary key;
- attendance range reads use `checkins_branch_time_idx`;
- batched delivery dedupe uses `automation_deliveries_event_uq`;
- sent-run dedupe uses the partial `automation_runs_sent_uq` index.

No additional index was added: the measured plans already use the intended
indexes, and the post-change p95 values did not justify extra write/storage
cost.

## Limits of this result

This is a repeatable single-instance, warm-cache, sequential baseline on one
developer machine. It is not a concurrency, soak, disk-failure or hosted-volume
benchmark, and it does not establish a service-level objective. Run the same
command on the intended production disk and retain its output before onboarding
a gym; investigate material regressions against these route shapes rather than
treating the absolute laptop numbers as a promise.
