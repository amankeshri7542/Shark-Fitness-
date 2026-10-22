import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { createSession } from '../services/auth.js';

/** A seeded member on the seven-day seed programme, signed in directly. */
function memberOnSeedProgram(): Record<string, string> {
  const row = db
    .select({ userId: schema.members.userId, tenantId: schema.members.tenantId })
    .from(schema.assignments)
    .innerJoin(schema.programs, eq(schema.programs.id, schema.assignments.programId))
    .innerJoin(schema.members, eq(schema.members.id, schema.assignments.memberId))
    .where(and(eq(schema.assignments.state, 'active'), eq(schema.programs.name, 'Apex Hypertrophy'), isNotNull(schema.members.userId)))
    .get();
  if (!row?.userId) throw new Error('seed has no member on Apex Hypertrophy');
  const { token } = createSession(row.userId, row.tenantId, '127.0.0.1', 'vitest');
  return { cookie: `shark_session=${token}`, origin: 'http://localhost:5173' };
}

describe('Home and the workout screen agree on today', () => {
  afterEach(() => vi.useRealTimers());

  // 19:00 UTC Thursday is 00:30 Friday in Bengaluru. Home used to pick the
  // programme day from the UTC weekday and offered Thursday's session, which
  // the workout screen (branch-local) then called a rest day.
  it.each(['2026-10-22T19:00:00Z', '2026-10-23T09:00:00Z'])('offers the same programme day at %s', async (instant) => {
    const headers = memberOnSeedProgram();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));

    const home = (await (await app.request('/v1/member/home', { headers })).json()) as {
      training: { programDayId: string | null };
    };
    const plan = (await (await app.request('/v1/member/training/plan', { headers })).json()) as {
      today: { programDayId: string | null } | null;
    };

    expect(plan.today?.programDayId).toBeTruthy();
    expect(home.training.programDayId).toBe(plan.today!.programDayId);
  });
});
