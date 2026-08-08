import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { hashToken } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
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
  const raw = response.headers.get('set-cookie') ?? '';
  const token = raw.match(/shark_session=([^;,]+)/)?.[1];
  const session = {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
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

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeMember(branchId = 'br_kor', invited = true) {
  const userId = id('usr');
  const memberId = id('mbr');
  const email = `${unique('phase3')}@example.test`;
  db.insert(schema.users).values({
    id: userId,
    tenantId: 'tn_shark',
    email,
    phone: null,
    name: 'Phase Three Member',
    initials: 'PM',
    role: 'member',
    accountState: invited ? 'invited' : 'active',
    passwordHash: null,
    preferences: { register: 'predator', theme: 'dark', unitSystem: 'metric', haptics: true, reducedMotion: false },
    lastSeenAt: null,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
  }).run();
  db.insert(schema.members).values({
    id: memberId,
    tenantId: 'tn_shark',
    userId,
    homeBranchId: branchId,
    memberNo: `SF-${Math.floor(50000 + Math.random() * 40000)}`,
    firstName: 'Phase',
    lastName: 'Member',
    initials: 'PM',
    email,
    phone: null,
    phoneNormalized: null,
    emailNormalized: email,
    dob: null,
    gender: null,
    addressLine: null,
    emergencyContact: null,
    lifecycle: 'trial',
    tags: [],
    trainerId: null,
    guardianId: null,
    corporateSponsorId: null,
    memberNotes: null,
    staffNotes: null,
    riskScore: null,
    riskReasons: null,
    joinedOn: '2026-08-08',
    lastVisitAt: null,
    mergedIntoId: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
  }).run();
  return { userId, memberId, email };
}

async function assign(owner: Session, memberId: string, productId = 'prd_daypass') {
  const response = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, {
    method: 'POST',
    headers: headers(owner, true),
    body: JSON.stringify({ productId }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { invoiceId: string; membershipId: string; totalMinor: number };
}

async function pay(owner: Session, invoiceId: string, amountMinor: number, key = unique('pay')) {
  return app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, {
    method: 'POST',
    headers: headers(owner, true),
    body: JSON.stringify({ method: 'cash', amountMinor, idempotencyKey: key, note: 'stabilization' }),
  });
}

function makeProduct(kind = 'membership', eligibility = { minAge: null as number | null, maxAge: null as number | null, corporateOnly: false }) {
  const productId = id('prd');
  db.insert(schema.products).values({
    id: productId,
    tenantId: 'tn_shark',
    kind,
    name: productId,
    description: 'Stabilization product',
    version: 1,
    priceMinor: 10000,
    currency: 'INR',
    taxRateBp: 0,
    cadence: 'monthly',
    durationDays: 30,
    credits: null,
    creditsExpireDays: null,
    access: { allBranches: true, branchIds: [], windowStartMin: null, windowEndMin: null, visitsPerWeek: null, guestPassesPerMonth: 0, classPriorityTier: 0, bookingWindowHours: 24 },
    freeze: { allowed: false, maxDaysPerTerm: 0, minDaysPerFreeze: 0, extendsExpiry: false, feeMinor: 0 },
    cancellation: { noticeDays: 0, commitmentMonths: 0, earlyExitFeeMinor: 0, refundable: true, description: 'Test' },
    eligibility: { ...eligibility, requiresApproval: false },
    branchIds: [],
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  }).run();
  return productId;
}

describe('phase 3 stabilization', () => {
  it('rejects an idempotency key reused with a different payload', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const purchase = await assign(owner, makeMember().memberId);
    const key = unique('idem');
    expect((await pay(owner, purchase.invoiceId, Math.floor(purchase.totalMinor / 2), key)).status).toBe(200);
    expect((await pay(owner, purchase.invoiceId, purchase.totalMinor, key)).status).toBe(409);
  });

  it('voids the invoice and cancels its pending membership together', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const purchase = await assign(owner, makeMember().memberId);
    const response = await app.request(`/v1/admin/billing/invoices/${purchase.invoiceId}/void`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Member selected another plan' }),
    });
    expect(response.status).toBe(200);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()?.state).toBe('cancelled');
    expect(db.select().from(schema.invoices).where(eq(schema.invoices.id, purchase.invoiceId)).get()?.state).toBe('void');
  });

  it('really reverses membership access when a refund requests it', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = makeMember();
    const purchase = await assign(owner, member.memberId);
    const paid = await pay(owner, purchase.invoiceId, purchase.totalMinor);
    const { paymentId } = (await paid.json()) as { paymentId: string };
    const response = await app.request(`/v1/admin/billing/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ amountMinor: purchase.totalMinor, reason: 'Purchase reversed', entitlementReversed: true }),
    });
    expect(response.status).toBe(200);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()?.state).toBe('suspended');
    expect(db.select().from(schema.members).where(eq(schema.members.id, member.memberId)).get()?.lifecycle).toBe('suspended');
  });

  it('enforces branch scope on refunds', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const purchase = await assign(owner, makeMember('br_ind').memberId);
    const { paymentId } = (await (await pay(owner, purchase.invoiceId, purchase.totalMinor)).json()) as { paymentId: string };

    const source = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!;
    const userId = id('usr');
    const email = `${unique('limited')}@example.test`;
    db.insert(schema.users).values({ ...source, id: userId, email, name: 'Limited Owner', initials: 'LO', createdAt: now(), updatedAt: now() }).run();
    db.insert(schema.staff).values({
      id: id('stf'), tenantId: 'tn_shark', userId, employmentStatus: 'active', branchIds: ['br_kor'],
      specialties: [], certifications: [], commissionRules: [], hourlyRateMinor: null, joinedOn: '2026-01-01',
      createdAt: now(), updatedAt: now(),
    }).run();

    const limited = await signIn(email);
    const response = await app.request(`/v1/admin/billing/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: headers(limited, true),
      body: JSON.stringify({ amountMinor: purchase.totalMinor, reason: 'Cross branch attempt' }),
    });
    expect(response.status).toBe(404);
  });

  it('enforces product-kind and member eligibility rules', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const ageRestricted = makeProduct('membership', { minAge: 30, maxAge: null, corporateOnly: false });
    const ageDenied = await app.request(`/v1/admin/billing/members/${makeMember().memberId}/assign-plan`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: ageRestricted }),
    });
    expect(ageDenied.status).toBe(422);

    const retail = makeProduct('retail_bundle');
    const kindDenied = await app.request(`/v1/admin/billing/members/${makeMember().memberId}/assign-plan`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: retail }),
    });
    expect(kindDenied.status).toBe(422);
  });

  it('creates a linked renewal for an expired membership', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = makeMember();
    const first = await assign(owner, member.memberId, 'prd_trial');
    db.update(schema.memberships).set({ state: 'expired', updatedAt: now() }).where(eq(schema.memberships.id, first.membershipId)).run();
    const response = await app.request(`/v1/admin/billing/members/${member.memberId}/renew`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { membershipId: string };
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, body.membershipId)).get()?.previousMembershipId).toBe(first.membershipId);
  });

  it('activates an invited account after verified OTP ownership', async () => {
    const member = makeMember();
    const challengeId = id('otp');
    const code = '654321';
    db.insert(schema.otpChallenges).values({
      id: challengeId, tenantId: 'tn_shark', identifier: member.email,
      codeHash: hashToken(`${challengeId}:${code}`), attempts: 0, createdAt: now(),
      expiresAt: now() + 600_000, consumedAt: null,
    }).run();
    const response = await app.request('/v1/auth/otp/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ challengeId, code }),
    });
    expect(response.status).toBe(200);
    expect(db.select().from(schema.users).where(eq(schema.users.id, member.userId)).get()?.accountState).toBe('active');
  });
});
