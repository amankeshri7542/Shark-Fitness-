# Phase 4/5 migration and recovery evidence — 2026-09-23

Both bounded local checks passed. The additive migrations were tested on existing populated synthetic data, and the updated recovery proof covers populated new records. Neither check earns hosted, off-instance, physical-phone, private browser-password or real-member pilot credit. No customer database, deployment, paid resource or real personal data was used.

## Populated baseline upgrade

The baseline source was archived from `14f2b183f73b87c9c8733e40ec680d70bed1116d`, including API code, schema, migrations and shared contracts/domain source. Its API package links were verified to resolve to the archived shared packages; installed third-party dependencies were reused locally. The archived migrator created a database through `0014_membership_freeze_end` (15 journal entries). The archived seeder populated it, and archived `bootstrapGym` created a synthetic tenant with an audit record. Seeder credentials and bootstrap password were withheld from output.

Before upgrading, every row in all 102 existing application tables was fingerprinted in stable row order. The current migrator then applied `0015_account_recovery` and `0016_payment_receipts` **without reseeding**. All 102 fingerprints matched exactly, the migration count increased from 15 to 17, both new tables existed and were empty, and SQLite integrity returned `ok`. Existing member, financial and audit identities were preserved; historical payments were not rewritten or given invented issuance snapshots.

| Representative existing table | Rows preserved exactly |
| --- | ---: |
| Members | 41 |
| Memberships | 39 |
| Invoices | 107 |
| Payments | 104 |
| Audit log | 1 |
| Attendance | 1,237 |

Upgrade artifacts:

- Evidence: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-schema14-migration-Uq95IV/evidence.json`; SHA-256 `27b295826c282549a59e0d7f72cdf6772082006d93a2268c4fc0edaa68ae198d`.
- Populated upgraded database: same directory, `populated.db`; SHA-256 `8adccef07dbc69049da1bc4c28e63687352ac3dc905ed40ffd9a4aeb9ae56e91`.
- Executable local proof: `/tmp/shark-phase45-populated-migration.mjs`; output: `/tmp/shark-phase45-populated-migration.log`.
- Applied migration hashes: `0015_account_recovery.sql` → `6cf4b4157b6404bc6dafaf1d225b30b1b3539bc9e961ab9598e63b69764b561f`; `0016_payment_receipts.sql` → `0b527f39bac9313a7f2e5904f4b91a86db81bef5be2dae9abd4549db096f16b6`.

## Populated new-table recovery

The existing `scripts/verify-backup-restore.mjs` now fingerprints 14 populated tables, adding `account_recoveries` and `payment_receipts`. A synthetic ordinary member's recovery is issued through the owner-authenticated HTTP route with current-password reauthentication, verified-identity confirmation and a reason. The response's raw handoff token is discarded; evidence retains only record identities and table fingerprints. This check preserves an issued, unredeemed challenge; it does not claim browser redemption or a private password handoff.

The existing ₹100 manual cash payment / ₹25 partial refund and their retries create exactly one new payment, one refund and one receipt snapshot. Restart, copied-API process replacement and backup/restore preserve all 14 table fingerprints, including the new recovery/receipt identities. Receipt updates and deletes are refused by the restored immutable constraints. Authenticated invoice, receipt and dashboard reads pass after recovery. The recovery fixture contains 1 account recovery, 1 receipt snapshot, 4 audit rows, 105 payments and 1 refund. The original synthetic database is removed during the proof; the archive and restored database remain in separate local directories with private artifact permissions.

This was **one** focused `db:backup:verify` execution after the additions, not another hosted rehearsal. Evidence: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-recovery-proof-IJGNpw/evidence.json` (SHA-256 `66522d0c9f26273ea4761aee7e3646bec633f595165c91ffb6c96b924d07dff5`). Log: `/tmp/shark-phase45-recovery-proof.log`.

Archive: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-retained-backup-l7HpYu/backup.db` and its manifest; 10,223,616 bytes, SHA-256 `39fd5893bd9fb2d3554aaed8b1e12207ffce5d50ed4cce69cebfce8616bf3825`, mode `0600`. Restored database: `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-restored-app-aejkK2/restored.db`.

The verified recovery-script SHA-256 was `bf071b09943666409478936b37017a7b06fb4c704f5f745777612cd35804abf3`. These checks used the working tree's additive migrations and runtime source; final commit/CI identity is reported separately by the integration task.

## Executed commands and limits

Node 22.23.2 and pnpm 10.28.0 were pinned. The recovery command ran from `/Users/mackie/Codes /shark-fitness/shark-fitness`; the standalone migration command uses its explicit repository path.

```sh
rtk proxy env PATH=/Users/mackie/.local/share/fnm/node-versions/v22.23.2/installation/bin:$PATH /Users/mackie/.local/share/fnm/node-versions/v22.23.2/installation/bin/node /Users/mackie/.cache/node/corepack/v1/pnpm/10.28.0/bin/pnpm.cjs db:backup:verify > /tmp/shark-phase45-recovery-proof.log 2>&1
rtk proxy env PATH=/Users/mackie/.local/share/fnm/node-versions/v22.23.2/installation/bin:$PATH /Users/mackie/.local/share/fnm/node-versions/v22.23.2/installation/bin/node /tmp/shark-phase45-populated-migration.mjs > /tmp/shark-phase45-populated-migration.log 2>&1
```

Focused ESLint on the changed recovery script and `git diff --check` passed. The runtime check required local-listener permission outside the sandbox. Temporary artifacts can be removed by the operating system and are not durable backups. Hosted persistence/replacement, independent storage recovery, delivered alerts, human acceptance and the actual pilot remain pending. No down-migration was attempted: retain the pre-upgrade archive and matching application for any approved rollback rather than dropping the new history tables.
