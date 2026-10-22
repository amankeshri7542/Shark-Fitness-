import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { csvCell, normalizeTag } from '../services/member-bulk.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

// One sign-in per account per run: the login limiter is shared process-wide.
const sessionCache = new Map<string, BrowserSession>();

async function signIn(email: string): Promise<BrowserSession> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const session = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const result = { cookie: `shark_session=${session}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  sessionCache.set(email, result);
  return result;
}

const reception = () => signIn('reception@sharkfitness.in');
const owner = () => signIn('owner@sharkfitness.in');
const trainerAccount = () => signIn('rehan@sharkfitness.in');

async function post(session: BrowserSession, path: string, body: unknown): Promise<Response> {
  return await app.request(`/v1/admin/members${path}`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:5173',
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function get(session: BrowserSession, path: string): Promise<Response> {
  return await app.request(`/v1/admin/members${path}`, {
    headers: { cookie: session.cookie, origin: 'http://localhost:5173' },
  });
}

function tenantId(): string {
  return db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

function makeMember(overrides: Partial<typeof schema.members.$inferInsert> = {}): string {
  const memberId = id('mem');
  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId: tenantId(),
      userId: null,
      homeBranchId: 'br_kor',
      memberNo: `BLK-${memberId.slice(-6)}`,
      firstName: 'Bulk',
      lastName: 'Member',
      initials: 'BM',
      email: `${memberId}@example.test`,
      phone: '+91 98450 12345',
      phoneNormalized: null,
      emailNormalized: null,
      dob: null,
      gender: null,
      addressLine: null,
      emergencyContact: null,
      lifecycle: 'active',
      tags: [],
      trainerId: null,
      guardianId: null,
      corporateSponsorId: null,
      memberNotes: null,
      staffNotes: null,
      riskScore: null,
      riskReasons: null,
      joinedOn: '2026-09-01',
      lastVisitAt: null,
      mergedIntoId: null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      ...overrides,
    })
    .run();
  return memberId;
}

function member(memberId: string) {
  return db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
}

function otherBranch(): string {
  return db.select().from(schema.branches).all().find((b) => b.id !== 'br_kor')!.id;
}

describe('members bulk: tag', () => {
  it('adds a normalised tag once, bumps the version and audits each change', async () => {
    const a = makeMember();
    const b = makeMember({ tags: ['pt-client'] });

    const res = await post(await reception(), '/bulk/tag', { memberIds: [a, b], tag: '  PT Client ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tag: string; changed: number; unchanged: number };
    expect(body).toMatchObject({ tag: 'pt-client', changed: 1, unchanged: 1 });

    expect(member(a).tags).toEqual(['pt-client']);
    expect(member(a).version).toBe(2);
    expect(member(b).tags).toEqual(['pt-client']);
    expect(member(b).version).toBe(1);

    const audits = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, a), eq(schema.auditLog.action, 'member.tag_added')))
      .all();
    expect(audits).toHaveLength(1);
  });

  it('makes the tag a directory filter', async () => {
    const a = makeMember();
    await post(await reception(), '/bulk/tag', { memberIds: [a], tag: 'filter-me' });
    const res = await get(await reception(), '?tag=filter-me');
    const body = (await res.json()) as { items: Array<{ id: string; tags: string[] }> };
    expect(body.items.map((m) => m.id)).toEqual([a]);
  });

  it('removes a tag', async () => {
    const a = makeMember({ tags: ['corporate', 'early-bird'] });
    const res = await post(await reception(), '/bulk/tag', { memberIds: [a], tag: 'corporate', mode: 'remove' });
    expect(res.status).toBe(200);
    expect(member(a).tags).toEqual(['early-bird']);
  });

  it('rejects a tag that is not a slug', async () => {
    const a = makeMember();
    const res = await post(await reception(), '/bulk/tag', { memberIds: [a], tag: '!!!' });
    expect(res.status).toBe(422);
    expect(member(a).tags).toEqual([]);
  });

  it('refuses the whole batch when one member is outside the caller’s branches (404, not 403)', async () => {
    const mine = makeMember();
    const theirs = makeMember({ homeBranchId: otherBranch() });
    const res = await post(await reception(), '/bulk/tag', { memberIds: [mine, theirs], tag: 'vip' });
    expect(res.status).toBe(404);
    expect(member(mine).tags).toEqual([]);
    expect(member(theirs).tags).toEqual([]);
  });

  it('is refused to a trainer, who cannot edit members', async () => {
    const a = makeMember();
    const res = await post(await trainerAccount(), '/bulk/tag', { memberIds: [a], tag: 'vip' });
    expect(res.status).toBe(403);
  });
});

describe('members bulk: assign trainer', () => {
  it('lists assignable trainers to reception', async () => {
    const res = await get(await reception(), '/trainers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; name: string; memberCount: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((t) => t.name === 'Rehan Ahmed')).toBe(true);
  });

  it('assigns and then clears a coach', async () => {
    const trainers = (await (await get(await reception(), '/trainers')).json()) as { items: Array<{ id: string }> };
    const trainerId = trainers.items[0]!.id;
    const a = makeMember();
    const b = makeMember();

    const assign = await post(await reception(), '/bulk/trainer', { memberIds: [a, b], trainerId });
    expect(assign.status).toBe(200);
    expect(((await assign.json()) as { changed: number }).changed).toBe(2);
    expect(member(a).trainerId).toBe(trainerId);
    expect(member(b).trainerId).toBe(trainerId);

    const clear = await post(await reception(), '/bulk/trainer', { memberIds: [a], trainerId: null });
    expect(clear.status).toBe(200);
    expect(member(a).trainerId).toBeNull();
    expect(member(b).trainerId).toBe(trainerId);
  });

  it('refuses a staff id that is not a trainer', async () => {
    const receptionStaff = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.role, 'reception'))
      .get()!;
    const a = makeMember();
    const res = await post(await reception(), '/bulk/trainer', { memberIds: [a], trainerId: receptionStaff.id });
    expect(res.status).toBe(404);
    expect(member(a).trainerId).toBeNull();
  });
});

describe('members bulk: message', () => {
  it('posts into an existing reception thread or opens one, and tells the member', async () => {
    const withThread = makeMember();
    const withoutThread = makeMember();
    const existing = id('cnv');
    db.insert(schema.conversations)
      .values({
        id: existing,
        tenantId: tenantId(),
        kind: 'reception',
        title: 'Koramangala reception',
        memberId: withThread,
        staffId: null,
        ticketId: null,
        state: 'open',
        muted: false,
        lastMessageAt: now() - 1000,
        createdAt: now() - 1000,
      })
      .run();

    const res = await post(await reception(), '/bulk/message', {
      memberIds: [withThread, withoutThread],
      body: 'The pool is closed on Sunday for maintenance.',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; conversationsCreated: number; withoutApp: number };
    expect(body).toMatchObject({ sent: 2, conversationsCreated: 1, withoutApp: 2 });

    const inExisting = db.select().from(schema.messages).where(eq(schema.messages.conversationId, existing)).all();
    expect(inExisting).toHaveLength(1);
    expect(inExisting[0]!.body).toBe('The pool is closed on Sunday for maintenance.');
    expect(inExisting[0]!.senderRole).toBe('reception');

    const opened = db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.memberId, withoutThread), eq(schema.conversations.kind, 'reception')))
      .all();
    expect(opened).toHaveLength(1);
    expect(db.select().from(schema.messages).where(eq(schema.messages.conversationId, opened[0]!.id)).all()).toHaveLength(1);
  });

  it('rejects an empty message', async () => {
    const a = makeMember();
    const res = await post(await reception(), '/bulk/message', { memberIds: [a], body: '   ' });
    expect(res.status).toBe(422);
  });
});

describe('members bulk: export', () => {
  it('returns a CSV of exactly the selection, with balances for a role that can see them', async () => {
    const a = makeMember({ firstName: 'Zoë', lastName: 'Comma, Jr', tags: ['vip', 'corporate'] });
    const b = makeMember({ firstName: '=HYPERLINK("x")', lastName: 'Injected' });

    const res = await post(await owner(), '/bulk/export', { memberIds: [a, b] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"/);

    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Member no,First name,Last name');
    expect(lines[0]).toContain('Balance due');
    expect(lines[1]).toContain('Zoë,"Comma, Jr"');
    expect(lines[1]).toContain('vip; corporate');
    expect(lines[1]).toContain('+91 98450 12345');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);

    const audit = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'member.exported'))
      .all()
      .at(-1);
    expect(audit).toBeDefined();
  });

  it('lets reception export, with balances since their role can see them', async () => {
    const a = makeMember();
    const res = await post(await reception(), '/bulk/export', { memberIds: [a] });
    expect(res.status).toBe(200);
    const header = (await res.text()).split('\r\n')[0]!;
    expect(header).toContain('Member no');
    expect(header).toContain('Balance due');
  });

  it('is refused to a trainer', async () => {
    const res = await post(await trainerAccount(), '/bulk/export', { memberIds: [makeMember()] });
    expect(res.status).toBe(403);
  });

  it('validates the selection size', async () => {
    const res = await post(await owner(), '/bulk/export', { memberIds: [] });
    expect(res.status).toBe(422);
  });
});

describe('member bulk helpers', () => {
  it('normalises tags', () => {
    expect(normalizeTag(' Early Bird ')).toBe('early-bird');
    expect(() => normalizeTag('-leading')).toThrow();
    expect(() => normalizeTag('a'.repeat(33))).toThrow();
  });

  it('escapes CSV cells and defuses formulas without mangling phones', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
    expect(csvCell('+91 98450 12345')).toBe('+91 98450 12345');
    expect(csvCell(42)).toBe('42');
  });
});
