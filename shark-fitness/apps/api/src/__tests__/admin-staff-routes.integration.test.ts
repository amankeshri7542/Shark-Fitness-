import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { hashPassword } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
import { DAY, HOUR, now } from '../lib/time.js';
import { call, signIn, type TestSession } from './helpers/session.js';

/* ============================================================================
   Staff shifts, absences, the coverage board and the commission queue
   (PF-STAFF).

   GET /v1/admin/staff/:staffId/shifts, PATCH /v1/admin/staff/shifts/:shiftId,
   GET /v1/admin/staff/:staffId/unavailability, GET /v1/admin/staff/coverage/board,
   GET /v1/admin/staff/commission/pending and /rules.

   Two fixture coaches are built here so no seeded rota is read or changed:
   `twoBranch` works Koramangala and Indiranagar, `indOnly` only Indiranagar
   (outside the branch manager's scope). Everything is removed afterwards.
   ========================================================================= */

const TENANT = 'ten_shark';
const MARK = `stf${now().toString(36)}`;
// Far enough ahead that no other suite's rota or class lands in the window.
const BASE = now() + 400 * DAY;

let owner: TestSession;
let manager: TestSession; // branch_manager, br_kor only; staff.view but not staff.manage
let trainer: TestSession; // no staff.view
let accountant: TestSession;

const twoBranch = { userId: id('usr'), staffId: id('stf') };
const indOnly = { userId: id('usr'), staffId: id('stf') };

const korShift = id('sft');
const indShift = id('sft');
const overlapShift = id('sft');
const farShift = id('sft');
const indOnlyShift = id('sft');

const activeAbsence = id('sun');
const withdrawnAbsence = id('sun');
const indOnlyAbsence = id('sun');
const classId = id('ses');

const pendingKor = id('cml');
const pendingInd = id('cml');
const approvedLine = id('cml');
const futureRate = id('crt');

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function fixtureStaff(person: { userId: string; staffId: string }, name: string, branchIds: string[]): void {
  const at = now();
  db.insert(schema.users)
    .values({
      id: person.userId,
      tenantId: TENANT,
      email: `${person.userId}@staff-routes.test`,
      phone: null,
      name,
      initials: name.split(' ').map((part) => part[0]).join(''),
      role: 'trainer',
      accountState: 'active',
      passwordHash: hashPassword('shark1234'),
      preferences: { register: 'plain', theme: 'dark', unitSystem: 'metric', haptics: true },
      lastSeenAt: null,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  db.insert(schema.staff)
    .values({
      id: person.staffId,
      tenantId: TENANT,
      userId: person.userId,
      employmentStatus: 'active',
      branchIds,
      specialties: [],
      certifications: [],
      commissionRules: [],
      hourlyRateMinor: null,
      joinedOn: '2026-01-01',
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

function shift(shiftId: string, staffId: string, branchId: string, startsAt: number, hours: number, state = 'planned'): void {
  db.insert(schema.shifts)
    .values({ id: shiftId, tenantId: TENANT, branchId, staffId, startsAt, endsAt: startsAt + hours * HOUR, role: 'floor', state, coveredByStaffId: null, note: null, createdAt: now() })
    .run();
}

function absence(absenceId: string, staffId: string, startsAt: number, endsAt: number, state: 'active' | 'withdrawn'): void {
  const at = now();
  db.insert(schema.staffUnavailability)
    .values({
      id: absenceId,
      tenantId: TENANT,
      staffId,
      startsAt,
      endsAt,
      reason: state === 'active' ? 'sick' : 'leave',
      note: `${MARK} ${state}`,
      state,
      createdByUserId: twoBranch.userId,
      withdrawnAt: state === 'withdrawn' ? at : null,
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

function commissionLine(lineId: string, branchId: string, amountMinor: number, state: string): void {
  db.insert(schema.commissionLines)
    .values({
      id: lineId,
      tenantId: TENANT,
      staffId: twoBranch.staffId,
      periodStart: '2019-01-01',
      periodEnd: '2019-01-31',
      kind: 'sale',
      basisMinor: amountMinor * 20,
      ratePct: 5,
      amountMinor,
      ruleVersion: 'test',
      evidence: [`${MARK} evidence`],
      state,
      refType: 'test',
      refId: lineId,
      branchId,
      correctionOfLineId: null,
      correctionReason: null,
      approvedByUserId: null,
      approvedAt: null,
      paidByUserId: null,
      paidAt: null,
      paidReference: null,
      createdAt: now(),
    })
    .run();
}

beforeAll(async () => {
  [owner, manager, trainer, accountant] = await Promise.all([
    signIn('owner@sharkfitness.in'),
    signIn('manager@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('accounts@sharkfitness.in'),
  ]);

  fixtureStaff(twoBranch, 'Tara Fixture', ['br_kor', 'br_ind']);
  fixtureStaff(indOnly, 'Ishan Fixture', ['br_ind']);

  shift(korShift, twoBranch.staffId, 'br_kor', BASE, 4);
  shift(indShift, twoBranch.staffId, 'br_ind', BASE + DAY, 4);
  // Overlaps indShift for the same person: both must read as conflicted.
  shift(overlapShift, twoBranch.staffId, 'br_ind', BASE + DAY + 2 * HOUR, 4);
  shift(farShift, twoBranch.staffId, 'br_kor', BASE + 60 * DAY, 4);
  shift(indOnlyShift, indOnly.staffId, 'br_ind', BASE, 4);

  absence(activeAbsence, twoBranch.staffId, BASE + 2 * DAY, BASE + 4 * DAY, 'active');
  absence(withdrawnAbsence, twoBranch.staffId, BASE + 5 * DAY, BASE + 6 * DAY, 'withdrawn');
  absence(indOnlyAbsence, indOnly.staffId, BASE + 2 * DAY, BASE + 3 * DAY, 'active');

  // One class the absent coach is still down to teach inside the absence.
  const classTypeId = db.select({ id: schema.classTypes.id }).from(schema.classTypes).where(eq(schema.classTypes.tenantId, TENANT)).get()!.id;
  const at = now();
  db.insert(schema.classSessions)
    .values({
      id: classId,
      tenantId: TENANT,
      branchId: 'br_kor',
      classTypeId,
      roomId: null,
      trainerId: twoBranch.staffId,
      seriesId: null,
      startsAt: BASE + 3 * DAY,
      endsAt: BASE + 3 * DAY + HOUR,
      capacity: 10,
      booked: 0,
      state: 'scheduled',
      bookingOpensAt: null,
      cancelDeadlineAt: BASE + 3 * DAY - 2 * HOUR,
      creditsRequired: 0,
      dropInPriceMinor: null,
      lateCancelFeeMinor: 0,
      waitlistEnabled: true,
      cancelledReason: null,
      substituteFor: null,
      notes: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  commissionLine(pendingKor, 'br_kor', 1_200, 'pending');
  commissionLine(pendingInd, 'br_ind', 3_400, 'pending');
  commissionLine(approvedLine, 'br_kor', 5_600, 'approved');
  // Not yet in force: must not displace the current sale rate.
  db.insert(schema.commissionRates).values({ id: futureRate, tenantId: TENANT, kind: 'sale', ratePct: 99, version: `${MARK}-future`, effectiveFrom: '2099-01-01' }).run();
});

afterAll(() => {
  db.delete(schema.commissionRates).where(eq(schema.commissionRates.id, futureRate)).run();
  db.delete(schema.commissionLines).where(inArray(schema.commissionLines.id, [pendingKor, pendingInd, approvedLine])).run();
  db.delete(schema.classSessions).where(eq(schema.classSessions.id, classId)).run();
  db.delete(schema.staffUnavailability).where(inArray(schema.staffUnavailability.staffId, [twoBranch.staffId, indOnly.staffId])).run();
  db.delete(schema.shifts).where(inArray(schema.shifts.staffId, [twoBranch.staffId, indOnly.staffId])).run();
  db.delete(schema.staff).where(inArray(schema.staff.id, [twoBranch.staffId, indOnly.staffId])).run();
  db.delete(schema.users).where(inArray(schema.users.id, [twoBranch.userId, indOnly.userId])).run();
});

interface ShiftItem {
  id: string;
  branchId: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  role: string;
  state: string;
  conflict: boolean;
  coveredByStaffId: string | null;
  note: string | null;
}

const windowQuery = (fromMs: number, toMs: number) =>
  `from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`;

describe('GET /v1/admin/staff/:staffId/shifts', () => {
  it("lists one person's shifts inside the window, flagging the overlapping pair", async () => {
    const response = await call(owner, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?${windowQuery(BASE - DAY, BASE + 30 * DAY)}`);
    expect(response.status).toBe(200);
    const { items } = await json<{ items: ShiftItem[] }>(response);
    // Ordered by start; the shift 60 days out is outside the window.
    expect(items.map((item) => item.id)).toEqual([korShift, indShift, overlapShift]);
    expect(items.every((item) => item.staffId === twoBranch.staffId)).toBe(true);
    expect(items[0]).toMatchObject({ branchId: 'br_kor', role: 'floor', state: 'planned', conflict: false, coveredByStaffId: null, startsAt: new Date(BASE).toISOString(), endsAt: new Date(BASE + 4 * HOUR).toISOString() });
    expect(items[1]!.conflict).toBe(true);
    expect(items[2]!.conflict).toBe(true);

    const indOnlyView = await json<{ items: ShiftItem[] }>(
      await call(owner, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?branchId=br_ind&${windowQuery(BASE - DAY, BASE + 30 * DAY)}`),
    );
    expect(indOnlyView.items.map((item) => item.id)).toEqual([indShift, overlapShift]);
  });

  it("shows a branch manager only their branch's shifts, and hides staff outside it", async () => {
    const own = await json<{ items: ShiftItem[] }>(
      await call(manager, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?${windowQuery(BASE - DAY, BASE + 30 * DAY)}`),
    );
    expect(own.items.map((item) => item.id)).toEqual([korShift]);

    expect((await call(manager, 'GET', `/v1/admin/staff/${indOnly.staffId}/shifts`)).status).toBe(404);
    expect((await call(manager, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?branchId=br_ind`)).status).toBe(403);
  });

  it('refuses an unknown person, a malformed window and roles without staff.view', async () => {
    expect((await call(owner, 'GET', '/v1/admin/staff/stf_missing/shifts')).status).toBe(404);
    expect((await call(owner, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?from=yesterday`)).status).toBe(422);
    expect((await call(trainer, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts`)).status).toBe(403);
    expect((await call(accountant, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts`)).status).toBe(403);
  });
});

describe('PATCH /v1/admin/staff/shifts/:shiftId', () => {
  it('moves a shift to a new state, keeps the note, and audits the change', async () => {
    const response = await call(owner, 'PATCH', `/v1/admin/staff/shifts/${korShift}`, { state: 'confirmed', note: `${MARK} confirmed by phone` });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ shift: { id: korShift, state: 'confirmed' } });

    const row = db.select().from(schema.shifts).where(eq(schema.shifts.id, korShift)).get()!;
    expect(row).toMatchObject({ state: 'confirmed', note: `${MARK} confirmed by phone`, coveredByStaffId: null });

    const auditRow = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, korShift), eq(schema.auditLog.action, 'shift.updated'))).get()!;
    expect(auditRow).toMatchObject({ entityType: 'shift', branchId: 'br_kor', actorRole: 'owner' });
    expect(auditRow.changes).toEqual([{ field: 'state', from: 'planned', to: 'confirmed' }]);

    // The listing reflects it.
    const { items } = await json<{ items: ShiftItem[] }>(
      await call(owner, 'GET', `/v1/admin/staff/${twoBranch.staffId}/shifts?${windowQuery(BASE - DAY, BASE + DAY)}`),
    );
    expect(items.find((item) => item.id === korShift)).toMatchObject({ state: 'confirmed', note: `${MARK} confirmed by phone` });
  });

  it('records who covers a shift, and refuses cover with nobody named or by someone not at the branch', async () => {
    const missing = await call(owner, 'PATCH', `/v1/admin/staff/shifts/${indShift}`, { state: 'covered' });
    expect(missing.status).toBe(422);

    const korShiftCoveredByIndOnly = await call(owner, 'PATCH', `/v1/admin/staff/shifts/${korShift}`, { state: 'covered', coveredByStaffId: indOnly.staffId });
    expect(korShiftCoveredByIndOnly.status).toBe(422);
    expect(db.select().from(schema.shifts).where(eq(schema.shifts.id, korShift)).get()!.state).toBe('confirmed');

    const covered = await call(owner, 'PATCH', `/v1/admin/staff/shifts/${indShift}`, { state: 'covered', coveredByStaffId: indOnly.staffId });
    expect(covered.status).toBe(200);
    expect(db.select().from(schema.shifts).where(eq(schema.shifts.id, indShift)).get()).toMatchObject({ state: 'covered', coveredByStaffId: indOnly.staffId });
  });

  it('refuses an unknown state, an out-of-scope shift, and roles without staff.manage', async () => {
    expect((await call(owner, 'PATCH', `/v1/admin/staff/shifts/${farShift}`, { state: 'vanished' })).status).toBe(422);
    expect((await call(owner, 'PATCH', '/v1/admin/staff/shifts/sft_missing', { state: 'confirmed' })).status).toBe(404);
    // Scoped to Koramangala by the branch switcher, the Indiranagar shift does not exist.
    expect((await call(owner, 'PATCH', `/v1/admin/staff/shifts/${indOnlyShift}`, { state: 'confirmed' }, { 'x-branch-id': 'br_kor' })).status).toBe(404);
    // A branch manager may view staff but not manage the rota.
    expect((await call(manager, 'PATCH', `/v1/admin/staff/shifts/${farShift}`, { state: 'confirmed' })).status).toBe(403);
    expect((await call(trainer, 'PATCH', `/v1/admin/staff/shifts/${farShift}`, { state: 'confirmed' })).status).toBe(403);
    expect(db.select().from(schema.shifts).where(inArray(schema.shifts.id, [farShift, indOnlyShift])).all().map((row) => row.state)).toEqual(['planned', 'planned']);
  });
});

interface Absence {
  id: string;
  staffId: string;
  startsAt: number;
  endsAt: number;
  reason: string;
  note: string | null;
  state: string;
  withdrawnAt: number | null;
}

describe('GET /v1/admin/staff/:staffId/unavailability', () => {
  it('lists active and withdrawn absences in start order', async () => {
    const response = await call(owner, 'GET', `/v1/admin/staff/${twoBranch.staffId}/unavailability`);
    expect(response.status).toBe(200);
    const { unavailability } = await json<{ unavailability: Absence[] }>(response);
    expect(unavailability.map((row) => row.id)).toEqual([activeAbsence, withdrawnAbsence]);
    expect(unavailability[0]).toMatchObject({ staffId: twoBranch.staffId, reason: 'sick', state: 'active', withdrawnAt: null, startsAt: BASE + 2 * DAY, endsAt: BASE + 4 * DAY });
    expect(unavailability[1]).toMatchObject({ state: 'withdrawn', reason: 'leave' });
    expect(unavailability[1]!.withdrawnAt).toEqual(expect.any(Number));

    // The branch manager can read it for someone who works their branch...
    const managerView = await json<{ unavailability: Absence[] }>(await call(manager, 'GET', `/v1/admin/staff/${twoBranch.staffId}/unavailability`));
    expect(managerView.unavailability.map((row) => row.id)).toEqual([activeAbsence, withdrawnAbsence]);
  });

  it('hides staff outside the caller scope and refuses roles without staff.view', async () => {
    expect((await call(manager, 'GET', `/v1/admin/staff/${indOnly.staffId}/unavailability`)).status).toBe(404);
    expect((await call(owner, 'GET', '/v1/admin/staff/stf_missing/unavailability')).status).toBe(404);
    expect((await call(trainer, 'GET', `/v1/admin/staff/${twoBranch.staffId}/unavailability`)).status).toBe(403);
  });
});

describe('GET /v1/admin/staff/coverage/board', () => {
  interface Board {
    absences: Array<{ id: string; staffId: string; name: string; reason: string; note: string | null; startsAt: number; endsAt: number; uncoveredSessions: number }>;
  }

  it('lists active absences in the window with the classes still pointing at the absent coach', async () => {
    const response = await call(owner, 'GET', `/v1/admin/staff/coverage/board?${windowQuery(BASE, BASE + 10 * DAY)}`);
    expect(response.status).toBe(200);
    const board = await json<Board>(response);
    const mine = board.absences.filter((row) => [activeAbsence, withdrawnAbsence, indOnlyAbsence].includes(row.id));
    // The withdrawn absence is not on the board.
    expect(mine.map((row) => row.id).sort()).toEqual([activeAbsence, indOnlyAbsence].sort());
    expect(mine.find((row) => row.id === activeAbsence)).toMatchObject({
      staffId: twoBranch.staffId,
      name: 'Tara Fixture',
      reason: 'sick',
      note: `${MARK} active`,
      uncoveredSessions: 1,
    });
    expect(mine.find((row) => row.id === indOnlyAbsence)!.uncoveredSessions).toBe(0);

    // Once the class is handed to someone else, nothing is left uncovered.
    db.update(schema.classSessions).set({ trainerId: indOnly.staffId }).where(eq(schema.classSessions.id, classId)).run();
    const after = await json<Board>(await call(owner, 'GET', `/v1/admin/staff/coverage/board?${windowQuery(BASE, BASE + 10 * DAY)}`));
    expect(after.absences.find((row) => row.id === activeAbsence)!.uncoveredSessions).toBe(0);
    db.update(schema.classSessions).set({ trainerId: twoBranch.staffId }).where(eq(schema.classSessions.id, classId)).run();
  });

  it('keeps to the window and to the caller branches', async () => {
    const outside = await json<Board>(await call(owner, 'GET', `/v1/admin/staff/coverage/board?${windowQuery(BASE + 20 * DAY, BASE + 30 * DAY)}`));
    expect(outside.absences.some((row) => [activeAbsence, indOnlyAbsence].includes(row.id))).toBe(false);

    const managerBoard = await json<Board>(await call(manager, 'GET', `/v1/admin/staff/coverage/board?${windowQuery(BASE, BASE + 10 * DAY)}`));
    const ids = managerBoard.absences.map((row) => row.id);
    expect(ids).toContain(activeAbsence);
    expect(ids).not.toContain(indOnlyAbsence);
  });

  it('refuses roles without staff.view and a malformed window', async () => {
    expect((await call(trainer, 'GET', '/v1/admin/staff/coverage/board')).status).toBe(403);
    expect((await call(accountant, 'GET', '/v1/admin/staff/coverage/board')).status).toBe(403);
    expect((await call(owner, 'GET', '/v1/admin/staff/coverage/board?to=next-week')).status).toBe(422);
  });
});

describe('GET /v1/admin/staff/commission/pending and /rules', () => {
  interface Pending {
    lines: Array<{ id: string; state: string; amountMinor: number; branchId: string | null }>;
    totalMinor: number;
    canApprove: boolean;
  }

  it('queues only pending lines, totals exactly what it lists, and narrows to the selected branch', async () => {
    const response = await call(owner, 'GET', '/v1/admin/staff/commission/pending');
    expect(response.status).toBe(200);
    const pending = await json<Pending>(response);
    const ids = pending.lines.map((line) => line.id);
    expect(ids).toEqual(expect.arrayContaining([pendingKor, pendingInd]));
    expect(ids).not.toContain(approvedLine);
    expect(pending.lines.every((line) => line.state === 'pending')).toBe(true);
    expect(pending.totalMinor).toBe(pending.lines.reduce((total, line) => total + line.amountMinor, 0));
    expect(pending.canApprove).toBe(true);

    const kor = await json<Pending>(await call(owner, 'GET', '/v1/admin/staff/commission/pending', undefined, { 'x-branch-id': 'br_kor' }));
    const korIds = kor.lines.map((line) => line.id);
    expect(korIds).toContain(pendingKor);
    expect(korIds).not.toContain(pendingInd);
    expect(kor.lines.every((line) => line.branchId === null || line.branchId === 'br_kor')).toBe(true);
    expect(pending.totalMinor - kor.totalMinor).toBeGreaterThanOrEqual(3_400);
  });

  it('states the rate in force per kind, ignoring a rate that has not started yet', async () => {
    const response = await call(owner, 'GET', '/v1/admin/staff/commission/rules');
    expect(response.status).toBe(200);
    const rules = await json<{
      kinds: string[];
      tenantRates: Array<{ kind: string; ratePct: number; version: string; effectiveFrom: string }>;
      unsourcedKinds: string[];
      canApprove: boolean;
    }>(response);
    expect(rules.kinds).toEqual(['sale', 'package', 'session']);
    expect(rules.unsourcedKinds).toEqual(['session']);
    expect(rules.canApprove).toBe(true);
    const kinds = rules.tenantRates.map((rate) => rate.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(rules.tenantRates.some((rate) => rate.version === `${MARK}-future`)).toBe(false);
    // The future sale rate is in the table, yet the sale rate in force is an older one.
    expect(rules.tenantRates.find((rate) => rate.kind === 'sale')!.effectiveFrom < '2099-01-01').toBe(true);
  });

  it('refuses both to roles without staff.commission', async () => {
    for (const session of [manager, trainer, accountant]) {
      expect((await call(session, 'GET', '/v1/admin/staff/commission/pending')).status).toBe(403);
      expect((await call(session, 'GET', '/v1/admin/staff/commission/rules')).status).toBe(403);
    }
  });
});

