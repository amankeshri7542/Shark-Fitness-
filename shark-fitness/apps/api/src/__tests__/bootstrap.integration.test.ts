import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootstrapGym } from '../db/bootstrap.js';
import { sqlite } from '../db/client.js';
import { verifyPassword } from '../lib/crypto.js';
import { app } from '../app.js';

describe('operator gym bootstrap', () => {
  it('creates an empty gym with a usable owner and rejects duplicate or invalid provisioning atomically', async () => {
    const input = {
      slug: `fresh-${randomUUID()}`, legalName: 'Fresh Gym Limited', displayName: 'Fresh Gym', timezone: 'Asia/Kolkata',
      owner: { name: 'Fresh Owner', email: 'OWNER@example.test', password: 'bootstrap-proof-password' },
      branch: { name: 'Main', slug: 'main', addressLine: '1 Test Road', city: 'Test City', capacity: 25, opensMinutes: 360, closesMinutes: 1320 },
    };
    const result = bootstrapGym(input);
    const user = sqlite.prepare('select email, password_hash, role from users where id = ?').get(result.ownerId) as { email: string; password_hash: string; role: string };
    expect(user.email).toBe('owner@example.test');
    expect(user.role).toBe('owner');
    expect(verifyPassword(input.owner.password, user.password_hash)).toBe(true);
    expect(sqlite.prepare('select count(*) as n from members where tenant_id = ?').get(result.tenantId)).toEqual({ n: 0 });
    expect(sqlite.prepare('select count(*) as n from staff where tenant_id = ?').get(result.tenantId)).toEqual({ n: 1 });
    expect(() => bootstrapGym(input)).toThrow();
    expect(() => bootstrapGym({ ...input, slug: `${input.slug}-bad`, owner: { ...input.owner, password: 'weak' } })).toThrow();
    expect(sqlite.prepare('select count(*) as n from tenants where slug = ?').get(`${input.slug}-bad`)).toEqual({ n: 0 });
    expect(sqlite.prepare('select count(*) as n from users where tenant_id = ?').get(result.tenantId)).toEqual({ n: 1 });
    const signIn = await app.request('/v1/auth/password', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ tenantSlug: input.slug, email: input.owner.email, password: input.owner.password }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const dashboard = await app.request('/v1/admin/dashboard', { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json()) as unknown).toBeTruthy();
  });
});
