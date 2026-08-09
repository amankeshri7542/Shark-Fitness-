import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
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
  cache.set(email, session);
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
const post = (session: Session, path: string, body: unknown, idempotencyKey?: string) =>
  app.request(path, { method: 'POST', headers: { ...headers(session, true), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: JSON.stringify(body) });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

let uniqueSuffix = 0;
function slug(): string {
  uniqueSuffix += 1;
  return `test-lift-${now()}-${uniqueSuffix}`;
}

describe('Phase 6 — exercise library, program builder and assignment', () => {
  it('keeps program creation idempotent and denies program management to branch managers', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const manager = await signIn('manager@sharkfitness.in');
    const body = { name: `Idempotent Program ${now()}`, goal: 'general', daysPerWeek: 1, weeks: 1, description: '' };
    const first = await post(owner, '/v1/admin/training/programs', body, 'phase6-program-create-replay');
    const replay = await post(owner, '/v1/admin/training/programs', body, 'phase6-program-create-replay');
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { program: { id: string } }).program.id).toBe(((await first.json()) as { program: { id: string } }).program.id);

    const denied = await post(manager, '/v1/admin/training/programs', body);
    expect(denied.status).toBe(403);
  });

  it('refuses an inactive trainer for a member assignment', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberRow = db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.memberNo, 'SF-40219')).get()!;
    const created = await post(owner, '/v1/admin/staff', { name: 'Inactive Phase 6 Trainer', email: `inactive-${now()}@sharkfitness.in`, phone: null, role: 'trainer', branchIds: ['br_kor'], specialties: [] });
    const { staff } = (await created.json()) as { staff: { id: string } };
    const inactive = await patch(owner, `/v1/admin/staff/${staff.id}`, { employmentStatus: 'on_leave' });
    expect(inactive.status).toBe(200);

    const response = await post(owner, '/v1/admin/training/assign-trainer', { memberId: memberRow.id, trainerId: staff.id });
    expect(response.status).toBe(422);
  });

  it('creates a tenant exercise and refuses editing the shared library', async () => {
    const owner = await signIn('owner@sharkfitness.in');

    const created = await post(owner, '/v1/admin/training/exercises', {
      slug: slug(),
      name: 'Test Cable Row',
      equipment: 'cable',
      primaryMuscles: ['lats'],
      secondaryMuscles: ['biceps'],
    });
    expect(created.status).toBe(201);
    const { exercise } = (await created.json()) as { exercise: { id: string } };

    const shared = db.select({ id: schema.exercises.id }).from(schema.exercises).where(isNull(schema.exercises.tenantId)).get();
    if (shared) {
      const attempt = await patch(owner, `/v1/admin/training/exercises/${shared.id}`, { name: 'Hijacked' });
      expect(attempt.status).toBe(404);
    }

    const own = await patch(owner, `/v1/admin/training/exercises/${exercise.id}`, { name: 'Test Cable Row (updated)' });
    expect(own.status).toBe(200);
  });

  it('refuses to publish an empty draft, then walks a draft through publish and a new version', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const exSlug = slug();

    const exerciseResponse = await post(owner, '/v1/admin/training/exercises', {
      slug: exSlug,
      name: 'Test Goblet Squat',
      equipment: 'dumbbell',
      primaryMuscles: ['quads'],
    });
    const { exercise } = (await exerciseResponse.json()) as { exercise: { id: string } };

    const draftResponse = await post(owner, '/v1/admin/training/programs', {
      name: `Test Program ${now()}`,
      goal: 'general',
      daysPerWeek: 2,
      weeks: 4,
      description: 'A short test program.',
    });
    expect(draftResponse.status).toBe(201);
    const { program } = (await draftResponse.json()) as { program: { id: string; version: number } };

    const emptyPublish = await post(owner, `/v1/admin/training/programs/${program.id}/publish`, {});
    expect(emptyPublish.status).toBe(422);

    const dayResponse = await post(owner, `/v1/admin/training/programs/${program.id}/days`, {
      week: 1,
      dayIndex: 0,
      label: 'Full body',
      focus: 'full_body',
      isRest: false,
      estimatedMin: 40,
    });
    expect(dayResponse.status).toBe(201);
    const { day } = (await dayResponse.json()) as { day: { id: string } };

    const itemResponse = await post(owner, `/v1/admin/training/days/${day.id}/items`, {
      exerciseId: exercise.id,
      sets: [
        { setIndex: 1, targetWeightKg: 20, repLow: 8, repHigh: 10, targetRpe: 8, restSec: 90, isWarmup: false },
      ],
      targetLabel: '1 × 8-10',
    });
    expect(itemResponse.status).toBe(201);

    const publish = await post(owner, `/v1/admin/training/programs/${program.id}/publish`, {});
    expect(publish.status).toBe(200);

    const immutable = await post(owner, `/v1/admin/training/days/${day.id}/items`, {
      exerciseId: exercise.id,
      sets: [{ setIndex: 1, targetWeightKg: 20, repLow: 8, repHigh: 10, targetRpe: 8, restSec: 90, isWarmup: false }],
      targetLabel: 'blocked',
    });
    expect(immutable.status).toBe(412);

    const versioned = await post(owner, `/v1/admin/training/programs/${program.id}/version`, {});
    expect(versioned.status).toBe(201);
    const { program: v2 } = (await versioned.json()) as { program: { id: string; version: number } };
    expect(v2.version).toBe(program.version + 1);
    expect(v2.id).not.toBe(program.id);

    const v2Detail = await get(owner, `/v1/admin/training/programs/${v2.id}`);
    const v2Body = (await v2Detail.json()) as { days: Array<{ items: unknown[] }> };
    expect(v2Body.days[0]?.items.length).toBe(1);
  });

  it('assigns a trainer, assigns a published program, and the member sees it through the unmodified member route', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = await signIn('aman@sharkfitness.in');

    const memberRow = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(eq(schema.members.memberNo, 'SF-40219'))
      .get()!;

    const trainerRow = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.users.role, 'trainer')))
      .get()!;

    const assignTrainer = await post(owner, '/v1/admin/training/assign-trainer', {
      memberId: memberRow.id,
      trainerId: trainerRow.id,
    });
    expect(assignTrainer.status).toBe(200);

    const exerciseResponse = await post(owner, '/v1/admin/training/exercises', {
      slug: slug(),
      name: 'Test Leg Press',
      equipment: 'machine',
      primaryMuscles: ['quads'],
    });
    const { exercise } = (await exerciseResponse.json()) as { exercise: { id: string } };

    const draftResponse = await post(owner, '/v1/admin/training/programs', {
      name: `Assign Test Program ${now()}`,
      goal: 'general',
      daysPerWeek: 1,
      weeks: 4,
      description: '',
    });
    const { program } = (await draftResponse.json()) as { program: { id: string } };

    const dayResponse = await post(owner, `/v1/admin/training/programs/${program.id}/days`, {
      week: 1,
      dayIndex: 0,
      label: 'Legs',
      focus: 'legs',
      isRest: false,
      estimatedMin: 40,
    });
    const { day } = (await dayResponse.json()) as { day: { id: string } };
    await post(owner, `/v1/admin/training/days/${day.id}/items`, {
      exerciseId: exercise.id,
      sets: [{ setIndex: 1, targetWeightKg: 60, repLow: 8, repHigh: 10, targetRpe: 8, restSec: 90, isWarmup: false }],
      targetLabel: '1 × 8-10',
    });
    await post(owner, `/v1/admin/training/programs/${program.id}/publish`, {});

    const draftAssign = await post(owner, '/v1/admin/training/assign-program', {
      memberId: memberRow.id,
      programId: program.id,
      startsOn: '2020-01-01',
      replaceActive: true,
    });
    // publishing above makes this succeed; verify a genuinely-unpublished
    // program is refused using a fresh draft.
    const secondDraft = await post(owner, '/v1/admin/training/programs', {
      name: `Unpublished ${now()}`,
      goal: 'general',
      daysPerWeek: 1,
      weeks: 1,
      description: '',
    });
    const { program: unpublished } = (await secondDraft.json()) as { program: { id: string } };
    const refused = await post(owner, '/v1/admin/training/assign-program', {
      memberId: memberRow.id,
      programId: unpublished.id,
      startsOn: '2020-01-01',
    });
    expect(refused.status).toBe(412);

    expect(draftAssign.status).toBe(201);

    const duplicate = await post(owner, '/v1/admin/training/assign-program', {
      memberId: memberRow.id,
      programId: program.id,
      startsOn: '2020-01-01',
    });
    expect(duplicate.status).toBe(409);

    const replacement = await post(owner, '/v1/admin/training/assign-program', {
      memberId: memberRow.id,
      programId: program.id,
      startsOn: '2020-01-02',
      replaceActive: true,
    });
    expect(replacement.status).toBe(201);

    const memberPlan = await get(member, '/v1/member/training/plan');
    expect(memberPlan.status).toBe(200);
    const planBody = (await memberPlan.json()) as { program: { id: string; name: string } | null };
    expect(planBody.program?.id).toBe(program.id);

    const history = await get(owner, `/v1/admin/training/assignments/member/${memberRow.id}`);
    const historyBody = (await history.json()) as { items: Array<{ programId: string; state: string }> };
    expect(historyBody.items.some((a) => a.programId === program.id && a.state === 'active')).toBe(true);
  });
});
