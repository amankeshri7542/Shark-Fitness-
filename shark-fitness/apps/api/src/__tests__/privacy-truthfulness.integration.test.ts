import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
});
