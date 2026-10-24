import { beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

interface Session {
  cookie: string;
  csrfToken: string;
}

const sessions = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = sessions.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  sessions.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(session, true), body: JSON.stringify(body) });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

function staffId(email: string): string {
  return db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.users.tenantId, tenantId()), eq(schema.users.email, email)))
    .get()!.id;
}

function publishedProgramId(): string {
  return db
    .select({ id: schema.programs.id })
    .from(schema.programs)
    .where(and(eq(schema.programs.tenantId, tenantId()), eq(schema.programs.state, 'published')))
    .orderBy(asc(schema.programs.createdAt))
    .get()!.id;
}

function temporaryMember(label: string, trainerId: string): { id: string; memberNo: string } {
  const template = db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, tenantId()),
        eq(schema.members.homeBranchId, 'br_kor'),
        isNull(schema.members.deletedAt),
      ),
    )
    .orderBy(asc(schema.members.memberNo))
    .get()!;
  const memberId = id('mbr');
  const memberNo = `ISO-${memberId.slice(-10).toUpperCase()}`;
  const at = now();
  db.insert(schema.members)
    .values({
      ...template,
      id: memberId,
      userId: null,
      memberNo,
      firstName: 'Isolation',
      lastName: label,
      initials: 'IT',
      email: null,
      phone: null,
      phoneNormalized: null,
      emailNormalized: null,
      trainerId,
      guardianId: null,
      corporateSponsorId: null,
      memberNotes: null,
      staffNotes: null,
      mergedIntoId: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    })
    .run();
  return { id: memberId, memberNo };
}

function cleanTemporaryMembers(memberIds: string[]): void {
  db.delete(schema.checkIns).where(inArray(schema.checkIns.memberId, memberIds)).run();
  db.delete(schema.assignments).where(inArray(schema.assignments.memberId, memberIds)).run();
  db.delete(schema.memberBranches).where(inArray(schema.memberBranches.memberId, memberIds)).run();
  db.delete(schema.members).where(inArray(schema.members.id, memberIds)).run();
}

function memberAt(branchId: string, excludedGrantBranch?: string): { id: string } {
  const excluded = excludedGrantBranch
    ? new Set(
        db
          .select({ memberId: schema.memberBranches.memberId })
          .from(schema.memberBranches)
          .where(
            and(
              eq(schema.memberBranches.tenantId, tenantId()),
              eq(schema.memberBranches.branchId, excludedGrantBranch),
            ),
          )
          .all()
          .map((row) => row.memberId),
      )
    : new Set<string>();
  return db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, tenantId()),
        eq(schema.members.homeBranchId, branchId),
        isNull(schema.members.deletedAt),
      ),
    )
    .orderBy(asc(schema.members.memberNo))
    .all()
    .find((member) => !excluded.has(member.id))!;
}

let owner: Session;
let manager: Session;
let trainer: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  trainer = await signIn('rehan@sharkfitness.in');
});

describe('trainer assignment isolation', () => {
  it('refuses every direct training read and write for an unrelated same-branch member', async () => {
    const rehanId = staffId('rehan@sharkfitness.in');
    const nikhilId = staffId('nikhil@sharkfitness.in');
    const victim = temporaryMember('Other roster', nikhilId);
    try {
      const created = await post(owner, '/v1/admin/training/assign-program', {
        memberId: victim.id,
        programId: publishedProgramId(),
        startsOn: '2026-08-23',
        trainerId: nikhilId,
      });
      expect(created.status).toBe(201);
      const assignmentId = ((await created.json()) as { assignment: { id: string } }).assignment.id;

      expect(
        (
          await post(trainer, '/v1/admin/training/assign-trainer', {
            memberId: victim.id,
            trainerId: rehanId,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(trainer, '/v1/admin/training/assign-program', {
            memberId: victim.id,
            programId: publishedProgramId(),
            startsOn: '2026-08-24',
            trainerId: rehanId,
            replaceActive: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (await post(trainer, `/v1/admin/training/assignments/${assignmentId}/state`, { state: 'paused' })).status,
      ).toBe(403);
      expect((await get(trainer, `/v1/admin/training/assignments/member/${victim.id}`)).status).toBe(403);

      const unchanged = db.select().from(schema.members).where(eq(schema.members.id, victim.id)).get()!;
      const assignment = db.select().from(schema.assignments).where(eq(schema.assignments.id, assignmentId)).get()!;
      expect(unchanged.trainerId).toBe(nikhilId);
      expect(assignment.state).toBe('active');
    } finally {
      cleanTemporaryMembers([victim.id]);
    }
  });

  it('keeps a trainer’s own assignment workflow working', async () => {
    const rehanId = staffId('rehan@sharkfitness.in');
    const own = temporaryMember('Own roster', rehanId);
    try {
      expect(
        (await post(trainer, '/v1/admin/training/assign-trainer', { memberId: own.id, trainerId: rehanId })).status,
      ).toBe(200);
      const created = await post(trainer, '/v1/admin/training/assign-program', {
        memberId: own.id,
        programId: publishedProgramId(),
        startsOn: '2026-08-23',
      });
      expect(created.status).toBe(201);
      const assignmentId = ((await created.json()) as { assignment: { id: string } }).assignment.id;
      expect((await get(trainer, `/v1/admin/training/assignments/member/${own.id}`)).status).toBe(200);
      expect(
        (await post(trainer, `/v1/admin/training/assignments/${assignmentId}/state`, { state: 'paused' })).status,
      ).toBe(200);
    } finally {
      cleanTemporaryMembers([own.id]);
    }
  });
});

describe('trainer attendance and dashboard isolation', () => {
  it('shows assigned members and hides unrelated members throughout the staff reads', async () => {
    const rehanId = staffId('rehan@sharkfitness.in');
    const nikhilId = staffId('nikhil@sharkfitness.in');
    const own = temporaryMember('Visible attendance', rehanId);
    const victim = temporaryMember('Hidden attendance', nikhilId);
    const at = now();
    const ownCheckInId = id('cin');
    const victimCheckInId = id('cin');
    try {
      db.insert(schema.checkIns)
        .values([
          {
            id: ownCheckInId,
            tenantId: tenantId(),
            branchId: 'br_kor',
            memberId: own.id,
            method: 'manual',
            decision: 'granted',
            enteredAt: at,
            visitNumber: 1,
          },
          {
            id: victimCheckInId,
            tenantId: tenantId(),
            branchId: 'br_kor',
            memberId: victim.id,
            method: 'manual',
            decision: 'granted',
            enteredAt: at - 1,
            visitNumber: 1,
          },
        ])
        .run();

      const current = (await (await get(trainer, '/v1/admin/attendance/current')).json()) as {
        items: Array<{ checkInId: string }>;
      };
      expect(current.items.some((item) => item.checkInId === ownCheckInId)).toBe(true);
      expect(current.items.some((item) => item.checkInId === victimCheckInId)).toBe(false);

      const victimFeed = (await (
        await get(trainer, `/v1/admin/attendance?memberId=${victim.id}&limit=20`)
      ).json()) as { total: number };
      expect(victimFeed.total).toBe(0);

      const victimSearch = (await (
        await get(trainer, `/v1/admin/attendance/search?q=${encodeURIComponent(victim.memberNo)}`)
      ).json()) as { items: Array<{ memberId: string }> };
      expect(victimSearch.items.some((item) => item.memberId === victim.id)).toBe(false);
      const ownSearch = (await (
        await get(trainer, `/v1/admin/attendance/search?q=${encodeURIComponent(own.memberNo)}`)
      ).json()) as { items: Array<{ memberId: string }> };
      expect(ownSearch.items.some((item) => item.memberId === own.id)).toBe(true);

      expect((await get(trainer, `/v1/admin/attendance/member/${victim.id}`)).status).toBe(403);
      expect((await get(trainer, `/v1/admin/attendance/member/${own.id}`)).status).toBe(200);

      const dashboard = (await (await get(trainer, '/v1/admin/dashboard')).json()) as {
        activity: Array<{ id: string }>;
      };
      expect(dashboard.activity.some((item) => item.id === ownCheckInId)).toBe(true);
      expect(dashboard.activity.some((item) => item.id === victimCheckInId)).toBe(false);
    } finally {
      cleanTemporaryMembers([own.id, victim.id]);
    }
  });
});

describe('support member association branch scope', () => {
  it('does not let a branch-A actor attach or expose a branch-B member', async () => {
    const foreign = memberAt('br_ind', 'br_kor');
    const suffix = id('probe');
    const subject = `Cross-branch ticket ${suffix}`;
    const comment = `Cross-branch feedback ${suffix}`;

    const ticket = await post(manager, '/v1/admin/support/tickets', {
      memberId: foreign.id,
      branchId: 'br_kor',
      category: 'other',
      subject,
      body: 'This member belongs to another branch.',
    });
    expect(ticket.status).toBe(404);
    expect(
      db.select().from(schema.tickets).where(and(eq(schema.tickets.tenantId, tenantId()), eq(schema.tickets.subject, subject))).get(),
    ).toBeUndefined();

    const feedback = await post(manager, '/v1/admin/support/feedback', {
      memberId: foreign.id,
      branchId: 'br_kor',
      kind: 'csat',
      score: 5,
      comment,
    });
    expect(feedback.status).toBe(404);
    expect(
      db.select().from(schema.feedback).where(and(eq(schema.feedback.tenantId, tenantId()), eq(schema.feedback.comment, comment))).get(),
    ).toBeUndefined();
  });

  it('keeps local branch associations and owner-wide associations working', async () => {
    const local = memberAt('br_kor');
    const foreign = memberAt('br_ind', 'br_kor');
    const suffix = id('probe');
    const ticket = await post(manager, '/v1/admin/support/tickets', {
      memberId: local.id,
      branchId: 'br_kor',
      category: 'other',
      subject: `Local branch ticket ${suffix}`,
      body: 'A local member remains reachable.',
    });
    expect(ticket.status).toBe(201);
    const detail = (await ticket.json()) as { ticket: { id: string }; member: { memberId: string } | null };
    expect(detail.member?.memberId).toBe(local.id);
    const reread = (await (await get(manager, `/v1/admin/support/tickets/${detail.ticket.id}`)).json()) as {
      member: { memberId: string } | null;
    };
    expect(reread.member?.memberId).toBe(local.id);

    const comment = `Owner-wide feedback ${suffix}`;
    expect(
      (
        await post(owner, '/v1/admin/support/feedback', {
          memberId: foreign.id,
          branchId: 'br_ind',
          kind: 'csat',
          score: 5,
          comment,
        })
      ).status,
    ).toBe(201);
    expect(
      db.select().from(schema.feedback).where(and(eq(schema.feedback.tenantId, tenantId()), eq(schema.feedback.comment, comment))).get()?.memberId,
    ).toBe(foreign.id);
  });
});
