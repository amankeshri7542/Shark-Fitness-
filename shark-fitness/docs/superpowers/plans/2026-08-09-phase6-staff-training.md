# Phase 6 — Trainers, Staff & Program Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin Staff and Training modules from their current `TODO(module)`/`TODO(screen)` stubs: staff directory/detail with employment/roles/branches/certifications/commission-rules, trainer availability (shifts), trainer-to-member assignment, an exercise-library admin surface, a draft→published→versioned program builder, assigning a published program to a member with replacement history, and read-only trainer-workload visibility — wired into Member 360 (`MemberDetail.tsx`).

**Architecture:** Two new backend service files — `services/staff.ts` (staff directory, shifts/availability, commission rules) and `services/training-admin.ts` (exercise library, programs/days/items, assignments) — consumed by the existing route stubs `routes/admin/staff.ts` and `routes/admin/training.ts` (thin adapters, matching every other admin route in this codebase). Two new admin-web screens (`StaffDetail.tsx`, `TrainingBuilder.tsx`) plus real implementations of the `Staff.tsx`/`Training.tsx` stubs, with two new routes added to `admin-web/src/router.tsx` (editable, unlike the member app's). `MemberDetail.tsx` and `routes/admin/members.ts` get small, additive extensions for Member 360 (assigned trainer + assigned program panels).

**Tech Stack:** Same as every other slice — Hono routes, Drizzle/SQLite, Zod validation, Vitest integration tests, TanStack Query + zustand in admin-web.

## Global Constraints

- Do not edit `packages/contracts`, `packages/domain`, `apps/api/src/db/schema`, `apps/api/src/app.ts`, `apps/member-pwa/*`. `apps/admin-web/src/router.tsx` and `apps/admin-web/src/ui/*` ARE editable.
- Every query filters `tenantId`; every branch-scoped query also checks `ctx.branchIds`. Single-record branch-scope violations return `notFound()`, never `forbidden()` (established pattern — `loadStaffInScope`/`loadProgramInScope` helpers).
- Every mutation touching money/access/membership/another person's record calls `audit()` in the same `transact()`. Anything another client should see live calls `emit()` — but see the flagged gap below: no new `EventTopic` values exist for staff/program changes, so most of this phase's mutations do **not** emit realtime events (the existing 22 topics don't fit); program-assignment reuses the existing `notification.created` topic via the `notifications` table, exactly like `waitlist.offered`.
- List endpoints compute totals over the full filtered scope before pagination (established pattern from `leads.ts`).

## Key design decisions (read before writing code)

1. **Program versioning has no template/family id column** (`programs.id` is the only key; `programs.version` is a plain int on that same row). Per the `Program.state: 'draft'|'published'|'archived'` contract and the `Assignment` contract's comment ("Editing the source program creates a new version; completed history is never mutated"), a version is **one immutable row once published**. "Create a new version" = a brand-new `programs` row (new `id`, `version = latest.version + 1`, `state: 'draft'`) whose `programDays`/`programItems` start as a **copy** of the source version's, then get edited independently. A draft can be edited in place (nobody references it yet). Once published, a program row's days/items are never mutated again — republishing an edit always means "create a new version" first. **Version history/lineage is grouped by matching `(tenantId, name)`** — there is no FK-backed family id; this is a best-effort heuristic and must be flagged in the PR as such (same category as the roadmap's other frozen-schema gaps).
2. **`assignments.programVersion` is a snapshot.** Assigning a program captures the exact `programId` (a specific immutable version row) so a later new version never retroactively changes what an already-assigned member sees. "Program replacement" = set the old `assignments` row's `state` to `'replaced'` and insert a new one.
3. **`members.trainerId` has no writer anywhere in the codebase today.** It is the field `requireAssignedMember` uses to scope a trainer's visible members, and `MemberDetail.tsx` already reads (but cannot set) `trainerName`. Phase 6 adds the first writer: `POST /admin/training/assign-trainer`. This is a *different* relationship from a program `assignments` row's own `trainerId` (who is administering that specific program) — the assignment defaults to the member's `trainerId` but does not have to match it.
4. **`appointments` (1:1 PT session booking, schema already exists, zero consumers anywhere) is explicitly OUT OF SCOPE for this pass.** The task list's "Trainer availability and assignments" is read as: shift/availability CRUD (the `shifts` table, which the `Shift` contract already models down to a `conflict` field) plus read-only visibility into a trainer's current program `assignments` (workload) — not a second full booking engine with its own eligibility/credit logic. Flag `appointments` as an identified, unbuilt gap in the final report, per the "flag, don't fabricate" convention — building it would roughly double this phase's scope and it was not named explicitly in the task list the way "program drafts/versions/publishing" was.
5. **Commission scope is rules-only, not a ledger.** `staff.commissionRules: Array<{kind, ratePct}>` is directly CRUD-able. The `CommissionLine` contract (accrued/approved/paid ledger with a `ruleVersion`/`evidence` receipt) requires a computation engine with no `packages/domain` function and no specified basis (which billing/booking events count, proration, dispute flow) — flagged as unbuilt, matching the roadmap's own prior note ("no commission-calc domain fn").
6. **No set-type field, no deload flag, no program-template table** — these are schema gaps already flagged in the roadmap memory from the original audit; still true, still not fabricated here.

## File list

**Backend — new:**
- `apps/api/src/services/staff.ts` — `loadStaffInScope`, list/create/update staff, shifts CRUD + conflict detection, workload aggregation
- `apps/api/src/services/training-admin.ts` — exercise CRUD, program/day/item CRUD, publish/new-version, assign-trainer, assign-program/replace, member-training-summary (for Member 360)

**Backend — modified:**
- `apps/api/src/routes/admin/staff.ts` (from stub)
- `apps/api/src/routes/admin/training.ts` (from stub)
- `apps/api/src/routes/admin/members.ts` — add `trainerId` + a `training` summary block to `GET /:memberId`

**Frontend — new:**
- `apps/admin-web/src/screens/StaffDetail.tsx`
- `apps/admin-web/src/screens/TrainingBuilder.tsx`

**Frontend — modified:**
- `apps/admin-web/src/screens/Staff.tsx` (from stub)
- `apps/admin-web/src/screens/Training.tsx` (from stub)
- `apps/admin-web/src/screens/MemberDetail.tsx` — "Coach" + "Training" panels, assign/replace actions
- `apps/admin-web/src/router.tsx` — add `/staff/$staffId`, `/training/$programId`

**Tests — new:**
- `apps/api/src/__tests__/phase6-staff.integration.test.ts`
- `apps/api/src/__tests__/phase6-training.integration.test.ts`

---

### Task 1: `services/staff.ts` — directory, employment, scope

- [ ] `loadStaffInScope(ctx, staffId)`: tenant + `ctx.branchIds.some(b => staff.branchIds.includes(b))` scoped load; `notFound` on violation (mirrors `loadMemberInScope`).
- [ ] `listStaff(ctx, {q, role, employmentStatus, branchId})`: filter by tenant + scope (branch overlap with `ctx.branchIds` or `ctx.activeBranchId`), search by name/email, compute `assignedMemberCount` (count of `members.trainerId = staff.id`) and `utilisationPct` (assignedMemberCount vs. a simple capacity constant — no capacity column exists on `staff`, so define `TRAINER_CAPACITY = 30` inline as a documented, flagged constant, not a fabricated schema field) per row, matching the `StaffMember` contract shape. Totals computed pre-pagination, `hasMore` flag — same pattern as `leads.ts`.
- [ ] `createStaff(ctx, {name, email, phone, role, branchIds, specialties})`: staff-manage only. Inserts a `users` row (`role`, `accountState: 'invited'`, `passwordHash: null` — mirrors `leads.ts`'s member-invite pattern exactly) + a `staff` row (`employmentStatus: 'active'`, empty `certifications`/`commissionRules`, `joinedOn: today`). Audited.
- [ ] `updateEmployment(ctx, staffId, {employmentStatus, branchIds, specialties, certifications, commissionRules, hourlyRateMinor})`: partial update, audited with before/after on whichever fields changed. `employmentStatus` transition to `'former'` should not delete anything (history stays queryable) — just flips the status; existing `assignments`/`shifts` referencing this staff member are left alone (matches "assignments/history are never mutated" pattern elsewhere).
- [ ] Test: create → appears in list scoped to the creating manager's branch; a manager at a different branch cannot see or edit them (404).

### Task 2: `services/staff.ts` — shifts (availability) + conflict detection

- [ ] `listShifts(ctx, {staffId?, branchId?, from, to})`: scoped by branch; computes `conflict` per shift (overlapping shift for the same `staffId`, OR a branch left with zero coverage during a role that requires it — start with the simpler, fully-specified case: **same-staff overlap only**; a "branch left uncovered" computation needs a roster/coverage-requirement concept that doesn't exist in the schema, so that half of `Shift.conflict` is flagged unbuilt, not fabricated).
- [ ] `createShift(ctx, {staffId, branchId, startsAt, endsAt, role})`: `endsAt > startsAt`; staff must be scoped to `branchId` (their own `branchIds`); refuses (409) if it overlaps another one of this staff member's shifts (half-open interval, same rule shape as `detectClashes` in `services/schedule.ts`).
- [ ] `updateShiftState(ctx, shiftId, {state, coveredByStaffId?, note?})`: `state` transitions (`planned→confirmed→in_progress→completed`, or `→absent`/`→covered`); `covered` requires `coveredByStaffId`.
- [ ] Test: overlapping shift for the same trainer is refused; a shift at a branch outside the caller's scope 404s.

### Task 3: `routes/admin/staff.ts` — thin adapters + permissions

- [ ] `GET /` → `staff.view`, `listStaff`.
- [ ] `GET /:staffId` → `staff.view`, `loadStaffInScope` + shifts + assigned-members list (for the workload panel) + commission rules.
- [ ] `POST /` → `staff.manage`, `createStaff`.
- [ ] `PATCH /:staffId` → `staff.manage`, `updateEmployment`. Commission-rule edits specifically also require `staff.commission` (composed-permission check, same pattern as PR #2's booking-override gate: `requirePermission(ctx,'staff.manage')` always; additionally `requirePermission(ctx,'staff.commission')` only when the patch body includes `commissionRules`/`hourlyRateMinor`).
- [ ] `GET /:staffId/shifts`, `POST /:staffId/shifts`, `PATCH /shifts/:shiftId` → `staff.view` / `staff.manage`.
- [ ] Test file `phase6-staff.integration.test.ts`: directory CRUD, branch scoping (404 not 403), commission-field permission split (branch_manager without `staff.commission`... check `packages/domain/permissions.ts` — branch_manager currently has neither `staff.manage` nor `staff.commission`, only `staff.view`; regional_manager/owner have all three. Test the reception-has-nothing / regional_manager-has-everything boundary instead), shift overlap conflict.

### Task 4: `services/training-admin.ts` — exercise library

- [ ] `listExercises(ctx, {q, equipment, muscle, archived})`: tenant's own additions (`tenantId = ctx.tenantId`) UNIONed with the shared library (`tenantId IS NULL`) — same predicate `exercisesByIds` in member `training.ts` already uses, generalized to a list query.
- [ ] `createExercise(ctx, input)`: `training.program.manage`. Always inserts with `tenantId: ctx.tenantId` (a tenant can add exercises, never edit the shared library — no route ever sets `tenantId: null`). Slug uniqueness enforced by the existing `exercises_slug_uq` index; catch the constraint violation and turn it into `conflict()`.
- [ ] `updateExercise(ctx, exerciseId, input)`: only if `tenantId === ctx.tenantId` (never edit a shared-library row — `notFound` if it belongs to the shared library or another tenant, same "don't confirm existence" shape).
- [ ] `archiveExercise(ctx, exerciseId)`: sets `archived: true` — never delete (program items/workout history reference it; the schema comment already says archived rows "stay resolvable").
- [ ] Test: tenant addition CRUD works; attempting to edit a shared-library exercise (`tenantId: null`) 404s; archiving hides it from the default list but a program item referencing it still resolves.

### Task 5: `services/training-admin.ts` — programs, days, items (the builder)

- [ ] `listPrograms(ctx, {state, q})`: tenant-scoped. Grouped-by-name "latest version per family" view for the default list (state defaults to hiding superseded drafts of an already-published family — simplest correct rule: within each `(name)` group, show the highest-`version` row unless the caller passes `?all=true`).
- [ ] `loadProgramInScope(ctx, programId)`: tenant-scoped read (programs aren't branch-scoped — no `branchId` column on `programs`, they're tenant-wide).
- [ ] `programDetail(ctx, programId)`: program + its `programDays` (ordered by week, dayIndex) + `programItems` per day, each item joined to its exercise name for display — same shape the member `/plan` endpoint already assembles, reused as read model for the builder.
- [ ] `createDraftProgram(ctx, {name, goal, daysPerWeek, weeks, description})`: `training.program.manage`. `state: 'draft'`, `version: 1`, `authorId: ctx.staffId`, `authorName: ctx.name`.
- [ ] `createNewVersion(ctx, sourceProgramId)`: loads the source (any state), finds the current max `version` among rows sharing `(tenantId, name)`, inserts a new `programs` row (`version: max + 1`, `state: 'draft'`, same `name`/`goal`/`daysPerWeek`/`weeks`/`description`), then deep-copies every `programDays`/`programItems` row under the source into new rows under the new program id (new ids throughout, same content). Refuses (`precondition`) if the source is itself already a draft (create-new-version is for revising something published; editing a draft is just editing it).
- [ ] `updateProgramMeta(ctx, programId, {name, goal, daysPerWeek, weeks, description})`: draft-only (`precondition` if `state !== 'draft'` — published/archived programs are immutable per the versioning decision above).
- [ ] `publishProgram(ctx, programId)`: draft-only; flips `state: 'published'`. No validation beyond "must have at least one non-rest day with at least one item" (`invalid()` otherwise) — a program with zero content publishing successfully would be a silent trap for the first member assigned to it.
- [ ] `archiveProgram(ctx, programId)`: published-only; flips to `'archived'`. Existing assignments referencing it are untouched (their `programId` still resolves — the row isn't deleted); archiving only removes it from the assignable list.
- [ ] `upsertProgramDay` / `deleteProgramDay`, `upsertProgramItem` / `deleteProgramItem` / `reorderProgramItems`: draft-only (same `precondition` guard as `updateProgramMeta`). Item sets validated as `PrescribedSet[]` shape via the existing `@shark/contracts` `PrescribedSet` schema (reuse the zod schema for `validate('json', ...)` rather than hand-rolling).
- [ ] Test: draft → add days/items → publish → items become immutable (a PATCH attempt on a published program's item is `precondition`, not silently ignored) → create-new-version copies content into a fresh draft → editing the new draft does not touch the published version's rows (assert via direct DB read of the original program's `programItems`).

### Task 6: `services/training-admin.ts` — trainer & program assignment

- [ ] `assignTrainer(ctx, memberId, trainerId | null)`: `training.assign`. Loads the member via `loadMemberInScope` (Task 1's centralization from PR #2, reused here — this is exactly the kind of call site that helper was built for), loads the trainer via `loadStaffInScope` (must have role `'trainer'`, `invalid()` otherwise — assigning a receptionist as someone's coach is a data-entry mistake worth blocking, not a security boundary), updates `members.trainerId`, audited (`action: 'member.trainer_assigned'`, before/after trainer names).
- [ ] `assignProgram(ctx, {memberId, programId, startsOn, trainerId?})`: `training.assign`. Program must be `state: 'published'` (`precondition` otherwise — "assign a draft" is the precise thing the versioning model exists to prevent). If the member already has an `active` assignment, set it to `state: 'replaced'` first (same `transact()`), then insert the new one (`programVersion` snapshot from the loaded program row, `trainerId` defaults to `member.trainerId` if not passed, `currentWeek: 1`, `currentBlock: 'A'`). Sends a `notifications` row + `emit(..., topic: 'notification.created', channel: channels.member(memberId))` telling the member their plan changed — reusing the exact established pattern from `promoteFromWaitlist`, not inventing a topic.
- [ ] `pauseAssignment` / `resumeAssignment` / `endAssignment(ctx, assignmentId, {reason})`: state transitions (`active↔paused`, `active/paused→completed`), audited.
- [ ] `assignmentHistory(ctx, memberId)`: every assignment row for the member (all states), newest first, each resolved to its program's name/version/goal — the "replacement and history" read model.
- [ ] `trainerWorkload(ctx, trainerId)`: count of `active` assignments + the member list (name, program name, week/of, `startsOn`) — the read model backing `StaffDetail.tsx`'s workload panel.
- [ ] `memberTrainingSummary(ctx, memberId)`: `{ trainerId, trainerName, activeAssignment: {programName, version, week, of, block, state} | null }` — the Member 360 read model, exported for `routes/admin/members.ts` to call directly (not exposed as its own route; it's a helper, avoiding a second permission-checked endpoint for data `member.view` already covers).
- [ ] Test: assign trainer → `GET /admin/members/:id` reflects it and a `trainer`-role session scoped to that staffId can now load the member (via existing `requireAssignedMember`) where it 404'd before; assign a draft program → refused; assign published program → old active assignment (if any) flips to `replaced`, new one `active`; assignment history shows both in order.

### Task 7: `routes/admin/training.ts` — thin adapters + permissions

- [ ] `GET /exercises`, `POST /exercises`, `PATCH /exercises/:id`, `POST /exercises/:id/archive` → `training.view` / `training.program.manage`.
- [ ] `GET /programs`, `GET /programs/:id`, `POST /programs`, `PATCH /programs/:id`, `POST /programs/:id/publish`, `POST /programs/:id/archive`, `POST /programs/:id/version` → `training.view` / `training.program.manage`.
- [ ] `GET /programs/:id/days`, `POST /programs/:id/days`, `PATCH /days/:id`, `DELETE /days/:id`, `POST /days/:id/items`, `PATCH /items/:id`, `DELETE /items/:id` → `training.program.manage`.
- [ ] `POST /assign-trainer`, `POST /assign-program`, `POST /assignments/:id/pause|resume|end` → `training.assign`.
- [ ] `GET /assignments/member/:memberId` (history) → `training.view`.
- [ ] `GET /workload/:staffId` → `training.view` (or reuse from the staff detail response in Task 3 instead of a separate route — prefer folding into `GET /admin/staff/:staffId` to avoid a second round trip; only add this route if the staff detail payload isn't the natural place for it).
- [ ] Test file `phase6-training.integration.test.ts`: end-to-end — create exercise, build a draft program (2 days, items with `PrescribedSet[]`), publish, assign trainer to a member, assign the program, verify member's existing member-side `GET /member/schedule`... no — verify via the **member training route** (`GET /member/training/plan`, already built) that the assigned program now actually renders for that member. This is the real integration proof: Phase 6's writes must be visible through Phase-1-era read paths with zero changes to those files.

### Task 8: `routes/admin/members.ts` — Member 360 extension

- [ ] Add `trainerId: member.trainerId` to the `member` object in `GET /:memberId`'s response (currently only `trainerName` is exposed).
- [ ] Add a top-level `training: memberTrainingSummary(ctx, memberId)` field (import from `services/training-admin.ts`).
- [ ] No other lines in this file change. Re-run `billing.integration.test.ts`/`leads.integration.test.ts`/`phase3-stabilization.integration.test.ts` (whichever exercise this endpoint) to confirm the additive field doesn't break an existing assertion that does a strict shape check.

### Task 9: `screens/Staff.tsx` + `screens/StaffDetail.tsx`

- [ ] `Staff.tsx`: directory table (name, role, branch(es), employment status chip, assigned-member count, utilisation) with role/branch/status filters, matching `Leads.tsx`'s list-screen structure (`Toolbar`, `Field` search, permission-gated "Add staff" button). Row click → `/staff/$staffId`.
- [ ] `StaffDetail.tsx`: employment panel (status, branches, hourly rate — edit gated on `staff.manage`), specialties/certifications panel (certifications show an expiry `Chip` in `warn`/`bad` tone when `expiresOn` is near/past), commission-rules panel (gated additionally on `staff.commission`), shifts/availability calendar-ish list with a "New shift" form and conflict `Chip`, and a workload panel (assigned members list with program/week, linking to `MemberDetail.tsx`).
- [ ] Loading/empty/error/permission states on every panel, per `docs/BUILD-PLAN.md` frontend rules. No raw divs/hex/`rounded-*`.

### Task 10: `screens/Training.tsx` + `screens/TrainingBuilder.tsx`

- [ ] `Training.tsx`: two sections — exercise library browser (search/filter, add/archive) and program list (state filter, "New program" → creates a draft and navigates to the builder). Row click on a program → `/training/$programId`.
- [ ] `TrainingBuilder.tsx`: the draft editor — day list (add/remove/reorder days across weeks), per-day item list (exercise picker from the library, sets editor matching `PrescribedSet` fields, target label, tempo, notes, rationale, trainer-locked toggle, allowed substitutions), a "Publish" action (disabled/explained when the draft is empty, matching the backend's own guard), and for a published program: a read-only view of its content plus "Create new version" and "Archive" actions.
- [ ] Assign-program flow: reachable from `MemberDetail.tsx` (Task 11) rather than duplicated here — the builder's job is authoring, not assignment.

### Task 11: `MemberDetail.tsx` + `router.tsx` — Member 360 wiring

- [ ] Add `/staff/$staffId` and `/training/$programId` to `admin-web/src/router.tsx`.
- [ ] `MemberDetail.tsx`: extend the existing "Recent training" panel area with a "Coach" line (trainer name, "Assign trainer" / "Reassign" action opening a sheet — same `setSheet('...')` pattern as `assign-plan`) and a "Training program" panel (active assignment's program name/version/week/state, "Assign program" / "Replace program" action listing published programs to pick from, and a link to assignment history).

### Task 12: Full verification

- [ ] `pnpm -F @shark/api typecheck && pnpm -F @shark/member-pwa typecheck && pnpm -F @shark/admin-web typecheck`
- [ ] `pnpm -F @shark/api test` — full suite green, including the two new Phase 6 files.
- [ ] `pnpm build` across all three apps.
- [ ] Live-verify over real HTTP against the seeded dev API: create a staff member, assign them as a trainer, build+publish a program, assign it to a member, confirm `GET /member/training/plan` (member-side, unmodified) renders it — the same cross-layer proof as Task 7's integration test, done for real.
- [ ] Open a PR against `main` from `agent/phase-6-staff-training`, report completed features, architecture decisions (this doc's "Key design decisions" section, condensed), tests, CI status, limitations (`appointments` unbuilt, commission ledger unbuilt, version lineage by name-match, shift conflict is same-staff-only), and the recommended next phase (Reports & Analytics, per the roadmap).
