import { describe, expect, it } from 'vitest';
import { get, createMember, signInMember } from './support/fixtures.js';
import { verifyPassToken } from '../lib/pass-token.js';

/**
 * GET /v1/member/pass (P05): which states carry an entry code, the branch
 * selector, and that live credentials are never cached.
 */

interface PassBody {
  state: string;
  notice: { title: string; action: string | null } | null;
  code: { rotateSec: number; serverEpoch: number; passes: Array<{ token: string; window: number }> } | null;
  branch: { id: string };
  branches: Array<{ id: string; home: boolean }>;
}

async function passFor(state: string | null, extraBranchIds: string[] = [], query = '') {
  const member = createMember({ state, extraBranchIds, withLogin: true, firstName: 'Pass' });
  const session = await signInMember(member);
  const response = await get(session, `/v1/member/pass${query}`);
  return { member, response, body: (await response.json()) as PassBody };
}

describe('GET /v1/member/pass', () => {
  it('issues a short run of genuine single-use codes for an active member, never cached', async () => {
    const { response, body, member } = await passFor('active');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.state).toBe('active');
    expect(body.notice).toBeNull();
    expect(body.code?.rotateSec).toBe(30);
    expect(body.code?.passes).toHaveLength(6);
    const first = verifyPassToken(body.code!.passes[0]!.token);
    expect(first.valid && first.payload.memberId).toBe(member.memberId);
    const windows = body.code!.passes.map((p) => p.window);
    expect(windows).toEqual(windows.map((_, i) => windows[0]! + i));
  });

  it('grace keeps the code where the branch lets members in during grace', async () => {
    const { db, schema } = await import('../db/client.js');
    const { eq } = await import('drizzle-orm');
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, 'ten_shark')).get()!;
    db.update(schema.tenants).set({ policy: { ...(tenant.policy as object), graceAllowsEntry: true } }).where(eq(schema.tenants.id, 'ten_shark')).run();
    try {
      const { body } = await passFor('grace');
      expect(body.state).toBe('grace');
      expect(body.code).not.toBeNull();
      expect(body.notice).toMatchObject({ title: 'Payment overdue', action: 'billing' });
    } finally {
      db.update(schema.tenants).set({ policy: tenant.policy }).where(eq(schema.tenants.id, 'ten_shark')).run();
    }
  });

  it('grace with entry refused shows no code a desk would turn away, and says how to get it back', async () => {
    const { body } = await passFor('grace');
    expect(body.state).toBe('grace');
    expect(body.code).toBeNull();
    expect(body.notice).toMatchObject({ title: 'Payment overdue', action: 'billing' });
  });

  it.each([
    ['frozen', 'Membership frozen', 'billing'],
    ['expired', 'Membership ended', 'billing'],
    ['suspended', 'Access on hold', 'reception'],
    ['cancelled', 'Membership cancelled', 'billing'],
    ['pending_payment', 'Membership not started', 'billing'],
  ])('%s issues no code and says what to do', async (state, title, action) => {
    const { body } = await passFor(state);
    expect(body.code).toBeNull();
    expect(body.notice).toMatchObject({ title, action });
  });

  it('a member with no membership gets no code', async () => {
    const { body } = await passFor(null);
    expect(body.state).toBe('none');
    expect(body.code).toBeNull();
  });

  it('lists every entitled branch and switches to one on request; others are not found', async () => {
    const { body, member } = await passFor('active', ['br_ind']);
    expect(body.branches.map((b) => b.id).sort()).toEqual(['br_ind', 'br_kor']);
    expect(body.branches[0]).toMatchObject({ id: 'br_kor', home: true });
    const session = await signInMember(member);
    const switched = (await (await get(session, '/v1/member/pass?branchId=br_ind')).json()) as PassBody;
    expect(switched.branch.id).toBe('br_ind');
    expect((await get(session, '/v1/member/pass?branchId=br_hsr')).status).toBe(404);
  });
});
