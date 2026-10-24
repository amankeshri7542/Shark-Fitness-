import { describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { createSession } from '../services/auth.js';

describe('member privacy requests are truthful', () => {
  it('records manual work without promising an export or erasure worker that does not exist', async () => {
    const userId = id('usr');
    db.insert(schema.users)
      .values({
        id: userId,
        tenantId: 'ten_shark',
        email: `${userId}@privacy.test`,
        phone: null,
        name: 'Privacy Regression',
        initials: 'PR',
        role: 'owner',
        accountState: 'active',
        passwordHash: null,
        preferences: {},
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      })
      .run();
    const session = createSession(userId, 'ten_shark', '192.0.2.70', 'privacy-regression');
    const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };

    const exportResponse = await app.request('/v1/me/data-export', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(exportResponse.status).toBe(200);
    const exportBody = (await exportResponse.json()) as { status: string; message: string };
    expect(exportBody.status).toBe('recorded_manual');
    expect(exportBody.message).toMatch(/does not generate or send/i);
    expect(exportBody.message).not.toMatch(/within 24 hours|download link/i);

    const deletionResponse = await app.request('/v1/me/deletion-request', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(deletionResponse.status).toBe(200);
    const deletionBody = (await deletionResponse.json()) as { status: string; message: string };
    expect(deletionBody.status).toBe('recorded_manual');
    expect(deletionBody.message).toMatch(/does not erase data automatically/i);
    expect(deletionBody.message).not.toMatch(/removed within|you can cancel/i);

    expect(db.select().from(schema.users).where(eq(schema.users.id, userId)).get()?.accountState).toBe(
      'deletion_requested',
    );
    expect(
      db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, userId)))
        .get()?.revokedAt,
    ).not.toBeNull();
    expect(
      db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityId, userId), eq(schema.auditLog.action, 'account.deletion_requested')))
        .get(),
    ).toBeTruthy();

    const afterDeletion = await app.request('/v1/me', { headers });
    expect(afterDeletion.status).toBe(401);
  });

  it('refuses the gym’s only owner, who is also the only person who could review it', async () => {
    // Found by sending every route an empty body: one POST locked the seeded
    // owner out of their own gym, with nobody left able to undo it.
    const owner = db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, 'ten_shark'), eq(schema.users.email, 'owner@sharkfitness.in')))
      .get()!;
    // Other suites add owners of their own; for this question the seeded owner
    // has to be the only active one.
    const others = db
      .select({ id: schema.users.id, accountState: schema.users.accountState })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, 'ten_shark'), eq(schema.users.role, 'owner'), ne(schema.users.id, owner.id)))
      .all();
    try {
      for (const other of others) db.update(schema.users).set({ accountState: 'disabled' }).where(eq(schema.users.id, other.id)).run();
      const session = createSession(owner.id, 'ten_shark', '192.0.2.71', 'privacy-regression-owner');
      const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };

      const response = await app.request('/v1/me/deletion-request', { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/only owner/);

      expect(db.select({ state: schema.users.accountState }).from(schema.users).where(eq(schema.users.id, owner.id)).get()!.state).toBe('active');
      expect((await app.request('/v1/me', { headers })).status).toBe(200);
    } finally {
      for (const other of others) db.update(schema.users).set({ accountState: other.accountState }).where(eq(schema.users.id, other.id)).run();
      // Never leave the shared fixture locked out, whatever went wrong above.
      db.update(schema.users).set({ accountState: 'active' }).where(eq(schema.users.id, owner.id)).run();
    }
  });
});
