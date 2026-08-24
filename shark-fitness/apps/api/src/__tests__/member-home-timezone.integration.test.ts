import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

describe('member home branch calendar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the member branch calendar rather than India time around midnight', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-24T00:30:00.000Z'));

    const user = db.select().from(schema.users)
      .where(and(eq(schema.users.tenantId, 'ten_shark'), eq(schema.users.email, 'aman@sharkfitness.in')))
      .get()!;
    const member = db.select().from(schema.members).where(eq(schema.members.userId, user.id)).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get()!;

    db.update(schema.branches).set({ timezone: 'America/New_York' }).where(eq(schema.branches.id, branch.id)).run();
    try {
      const signIn = await app.request('/v1/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({ tenantSlug: 'shark', email: 'aman@sharkfitness.in', password: 'shark1234' }),
      });
      expect(signIn.status).toBe(200);
      const csrfToken = ((await signIn.json()) as { csrfToken: string }).csrfToken;
      const token = (signIn.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];

      const home = await app.request('/v1/member/home', {
        headers: { cookie: `shark_session=${token}; shark_csrf=${csrfToken}`, origin: 'http://localhost:5173' },
      });
      expect(home.status).toBe(200);
      expect(((await home.json()) as { today: { date: string } }).today.date).toBe('2026-08-23');
    } finally {
      db.update(schema.branches).set({ timezone: branch.timezone }).where(eq(schema.branches.id, branch.id)).run();
    }
  });
});
