# Deployment and recovery evidence — 2026-09-20

## Final candidate recheck — 2026-09-22

Rechecked the current working tree before the parent task's authorized commit/push. No commit, push, deployment, hosted write, or remote CI rerun was performed by this review.

- `node scripts/verify-deployment.mjs`: passed default no-seed, explicit demo-seed, no-reseed and configured-source backup checks. Artifact directory: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-deployment-proof-iQ9MSf`.
- `pnpm db:backup:verify` using pinned Node 22.23.2 and pnpm 10.28.0: passed corruption/overwrite guards, restored row counts, append-only constraints, migration, production readiness and authenticated dashboard HTTP 200. Artifact directory: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-recovery-proof-7zEmLa`. Snapshot: 10,248,192 bytes; SHA-256 `8d32bdd590f8ef8fba6e1f8dc1557f4d4ebdd98fbd5af6e319223caba8d7c6d9`. Counts: members 41, memberships 39, invoices 107, payments 104, tickets 7, audit rows 1, stock ledger 102. Log: `/tmp/shark-final-recovery-2026-09-22.log`.
- Both YAML files parsed; every CI `run` block passed `bash -n`; `git diff --check` passed. Reviewed the complete deployment/recovery diff, Docker runtime copies, workspace paths, explicit demo seeding, persistent-volume replacement check, and production smoke environment. No additional confirmed release defect found in this scope.
- Read-only GitHub refresh still shows PR #15 open/unstable at `c9211b7e00212d4115058eaceed9900d94fc4502`, with the old August 27 image success and verify failure. These statuses do not validate the pending candidate. Exact pushed-commit checks must be observed after push.
- Docker image execution and actual Render disk/permissions/recovery remain unverified here. Blueprint source now explicitly selects `branch: main` and `autoDeployTrigger: 'off'` for a manual release, using fields confirmed by the fetched official Render Blueprint reference. This is a source-only safeguard. Existing live service settings are unknown and were not changed; pushing the candidate is not an explicit deployment action and this file alone does not prove an already-connected service has disabled auto-deploy.

This is local implementation and local verification. No Render deployment, hosted data mutation, or GitHub push was performed. Container and hosted restart checks remain unverified locally because Docker is not installed. Applying the Blueprint moves the service to a paid Starter instance with a 1 GB persistent disk; review that hosting cost before applying it.

## Findings and changes

| Finding | Change | Evidence |
| --- | --- | --- |
| Render Free used `/tmp/shark-fitness/shark.db`; an instance replacement could discard all writes. | Blueprint requests a persistent disk at `/var/lib/shark-fitness`; Docker and entrypoint use its database path. | Static review; CI now replaces a container against the same named volume and checks a sentinel write survives. Hosted disk attachment and permissions are not yet verified. |
| Every missing database was automatically populated with demo gyms, demo members and known passwords. | Seeding requires explicit `SHARK_SEED_DEMO=true`, only for a missing database. Normal startup migrates an empty database. | `node scripts/verify-deployment.mjs` passed: default fresh boot has no seed, explicit demo boot seeds, existing DB never reseeds. |
| Fresh customer provisioning had no independent operator path. | `pnpm db:bootstrap` accepts validated JSON on stdin and atomically creates tenant, initial branch, owner, staff membership and audit record. | Fresh empty migrated SQLite database integration test passed, including password sign-in and authenticated dashboard reads, both HTTP 200. No member rows created. Duplicate slug and weak password refused without partial data. |
| Runtime image omitted the scripts used by documented backup commands. | Runtime copies `scripts`; image CI executes full recovery proof. | Local full recovery passed; image execution pending CI. |
| `db:backup` hardcoded `data/shark.db` relative to repository root, unlike API workspace path resolution. | Default source follows `SHARK_DB`, resolving relative values against `apps/api`, or API's development `data/shark.db`. Production requires configured or explicit source. Explicit CLI source still resolves relative to caller. | Deployment proof backed up a configured isolated DB and read its marker from the artifact. |
| Render-generated 256-bit base64 secret is 44 characters; runtime requires 48 bytes. | Blueprint prompts for an operator-provided secret using `sync: false`. | Existing config validation requires 48 bytes. Generate 48 random bytes as base64 (64 characters) and store in Render environment. |

Render configuration checked against current Context7 `/websites/render` documentation: [Blueprint disk schema](https://render.com/docs/blueprint-spec). The change is checked in source only; no claim is made that the running service already uses it.

## Fresh gym provisioning

Use the same absolute `SHARK_DB` for migration, provisioning, runtime and backups. Production also requires its existing origin and pass-secret environment. Run from `shark-fitness/`:

```sh
pnpm db:migrate
pnpm db:bootstrap < /secure/path/gym-bootstrap.json
```

The JSON file must be readable only by the operator, contain a unique owner password of at least 12 characters, and be removed from the operating environment after secure credential handoff. Never commit the file. Example shape (replace all example values, including the password):

```json
{
  "slug": "your-gym",
  "legalName": "Your Gym Private Limited",
  "displayName": "Your Gym",
  "timezone": "Asia/Kolkata",
  "owner": { "name": "Gym Owner", "email": "owner@example.com", "password": "REPLACE-WITH-A-UNIQUE-OWNER-PASSWORD" },
  "branch": { "name": "Main", "slug": "main", "addressLine": "1 Example Road", "city": "Your City", "capacity": 60, "opensMinutes": 360, "closesMinutes": 1320 }
}
```

Output contains IDs and tenant slug, never the password. Reusing an existing slug is an error, not an update or reset. The owner signs into the admin app with the chosen gym slug, email and password. This creates a blank India/INR/metric gym with classes and POS enabled; it is not onboarding automation or a demonstration fixture. Configure actual branding, branch policy, tax profile, products, prices, and operational settings before taking payments. Bootstrap currently requires same-day opening/closing hours. Existing staff and member creation and activation flows remain separate from initial owner provisioning.

Do not run `db:seed` or `db:reset` against customer data: those remain explicit destructive development fixture commands. Keep `SHARK_SEED_DEMO=false` for customer deployments.

## Recovery and migration of an existing deployment

Before changing an existing service from `/tmp` to the disk path, capture a backup of the currently configured database and preserve both artifact and manifest outside that instance. A Blueprint path change does not migrate the old file. Restore into the mounted disk, then switch the running configuration. Keep the previous artifact until authenticated reads and representative row counts have been checked on the new deployment.

```sh
# From shark-fitness/; uses the API's configured SHARK_DB.
pnpm db:backup
# Or provide explicit source and destination (prefer an off-instance archive).
node scripts/sqlite-backup.mjs backup /absolute/live/shark.db /absolute/archive
# Stop the target application before restoring. Prefer a new target path.
pnpm db:restore /absolute/archive/shark-TIMESTAMP.db /absolute/recovery/shark.db
# Then use restored SHARK_DB, migrate, start and check /ready + authenticated reads.
```

An intentional overwrite requires both `--replace --yes-replace`. The tool checks manifest size/checksum and database integrity before replacement. It does not stop a running process or lock out concurrent target writers; the operator must stop the target application. Backups in the container's default `backups/` directory are not an off-instance disaster-recovery policy: transfer them and their manifests to durable external storage and set a retention schedule. Restore does not validate arbitrary operator-supplied paths as the intended customer environment; verify those before execution.

## Commands and measured results

- `node scripts/verify-deployment.mjs`: passed all seeding and configured-backup checks. Artifacts: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-deployment-proof-gh0aXc`.
- Fresh database migration followed by `vitest run src/__tests__/bootstrap.integration.test.ts`: one test passed on `/tmp/shark-fresh-bootstrap-proof.db`, without seeding. Password login and empty dashboard returned 200.
- `pnpm db:backup:verify`: passed on Node 22.23.2. Artifact directory `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-recovery-proof-B2c2vB`; SHA-256 `e55b20a8c1ef35ae6496cc4a25d31206f1a70c7342af30bb0968321f43924839`; 10,235,904-byte snapshot. Restored counts matched: members 41, memberships 39, invoices 107, payments 104, tickets 7, audit rows 1, stock ledger 102. Corruption, source/target identity and unconfirmed overwrite refused. Append-only audit/stock constraints survived. Restored production API `/ready` reported database/schema ready, and authenticated dashboard returned 200.
- API TypeScript check and targeted ESLint of provisioning and recovery files passed.
- Initial sandbox recovery attempt failed with `tsx` IPC `EPERM`; reran authorized outside sandbox, succeeded. The local pnpm shim selected Node 24 inside the nested project, so verification explicitly used Node 22.23.2 and cached pnpm 10.28.0.
- New CI checks include deployment guard script, runtime-image recovery commands, configured source backup, and replacement-container persistence. These checks have been authored but not run on GitHub or against a local Docker daemon in this session.

Remaining release evidence: CI image build and restart check, Render paid-disk attachment and write permission, live `/ready` release identity, and a backup/restore rehearsal using the actual hosted data under the operator's authorized maintenance procedure. Local proof does not establish any of those hosted outcomes.

## Read-only remote evidence

GitHub API inspected PR [#15](https://github.com/amankeshri7542/Shark-Fitness-/pull/15) on 2026-09-20. It is open, not a draft, with mergeability reported as `unstable`. Its head `c9211b7e00212d4115058eaceed9900d94fc4502` matches the local checkout's committed HEAD; current uncommitted implementation is not in that remote commit.

- [Image check](https://github.com/amankeshri7542/Shark-Fitness-/actions/runs/33096112749/job/98601351612): succeeded on 2026-08-27, before these changes.
- [Verify check](https://github.com/amankeshri7542/Shark-Fitness-/actions/runs/33096112749/job/98601351322): failed on 2026-08-27 at `git diff --check HEAD^ HEAD` with `fatal: ambiguous argument 'HEAD^'`. Default checkout fetched only one commit. Fixed locally by setting verification checkout `fetch-depth: 2`. This is an observed CI failure, not an inferred test failure.
- All downstream verify steps—fresh migration, recovery, lint, type checking, tests, build and browser runtime—were skipped in that remote run. The historical green image job cannot validate this working tree.
- A read-only GET of `https://shark-fitness-demo.onrender.com/ready`, derived from the Blueprint service name rather than an independently confirmed deployment URL, timed out after 30 seconds without receiving bytes. This does not establish the configured live URL, outage cause, deployment version, or data persistence. No hosted state was changed.

## Receipt and manual-payment review

Added authenticated text receipts for succeeded invoice payments, with tenant and branch authorization, stable payment-based ID, recorded amount/reference/date, succeeded refunds and net total. Receipt explicitly states that it is not a tax invoice or independent proof of bank settlement. Admin payment recording now requires a UI confirmation of independently received funds and a nonblank UPI reference on the server. The confirmation resets when amount, method or reference changes.

Focused integration proof passed: authorized receipt 200 with attachment and no-store headers; anonymous 401; out-of-branch reception 404; member role 403; blank UPI reference 422. Targeted lint and API/admin type checks passed. Native download UI and manual confirmation still require the parent task's browser verification.

Independent review of changed activation/session checks, invoice balance/refund scope, membership-date reconciliation and receipt authorization found no additional confirmed critical identity/financial defect beyond the fixed shallow-checkout gate. This was a focused review, not a claim of a complete security audit. Hosted verification and CI rerun remain outstanding.

## Production browser smoke compatibility

The existing CI browser smoke depended on demo-account text and prefilled owner credentials, which production sign-in intentionally no longer exposes. Updated the smoke to find the normal gym-code/username form and explicitly fill Gym code, Work email and Password, then wait for the enabled Sign in button. No product demo shortcut was added.

Executed the corrected smoke successfully with a separate Chrome profile on CDP port 9224 and an isolated seeded/restored database served in production mode on port 8788. It proved fresh member sign-in without a `/v1/me` restore dependency, activation and control by the root member service worker, navigation to the correct admin bundle under that worker, and ordinary owner sign-in to `/admin/` with no fatal runtime errors. Log: `/tmp/shark-smoke-production-proof.log`. Targeted ESLint passed. This is local browser evidence, not a remote CI or hosted-deployment result.

## Clean committed baseline (before changes)

For a fair before/after comparison, archived committed HEAD `c9211b7e00212d4115058eaceed9900d94fc4502` into `/tmp/shark-head-baseline-te9yub3u`. Dependency directories were APFS-cloned, and all API/admin/member `@shark/contracts` and `@shark/domain` links were verified to resolve inside the archive, not into the modified workspace. No current working-tree files were changed or discarded.

Ran the original `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` concurrently on Node 22.23.2/pnpm 10.28.0 with CI's `NODE_ENV=test`, outside the sandbox for local tsx IPC. All four exited 0. Summary: `/tmp/shark-head-baseline-results.json`; original logs: `/tmp/shark-head-baseline-{lint,typecheck,build,test}.log`. These local baseline passes do not erase the separately observed remote shallow-checkout failure or prove untested business workflows were correct before stabilization.
