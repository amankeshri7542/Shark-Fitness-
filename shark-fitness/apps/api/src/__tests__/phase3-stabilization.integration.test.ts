import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { hashToken, hashPassword } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
import { now, isoDate, addDays } from '../lib/time.js';
import { reconcileMembershipDates } from '../services/membership-dates.js';
import { membershipStanding } from '../services/booking.js';

it('downloads a scoped payment receipt and refuses unverified UPI references', async () => {
  const owner = await signIn('owner@sharkfitness.in');
  const payment = db.select().from(schema.payments).where(eq(schema.payments.tenantId, sharkTenantId())).all()
    .find((row) => row.state === 'succeeded' && row.invoiceId && row.branchId === 'br_ind')!;
  expect(payment).toBeTruthy();
  const path = `/v1/admin/billing/payments/${payment.id}/receipt`;
  const receipt = await app.request(path, { headers: headers(owner) });
  expect(receipt.status).toBe(200);
  expect(receipt.headers.get('content-disposition')).toContain(`receipt-${payment.id}.txt`);
  expect(receipt.headers.get('cache-control')).toContain('no-store');
  const content = await receipt.text();
  expect(content).toContain(`Receipt: ${payment.id}`);
  expect(content).toContain('not a tax invoice');
  expect(content).toContain('Refunded:');
  expect(content).toContain('Net received:');
  expect((await app.request(path)).status).toBe(401);
  const reception = await signIn('reception@sharkfitness.in');
  expect((await app.request(path, { headers: headers(reception) })).status).toBe(404);
  const member = await signIn('aman@sharkfitness.in');
  expect((await app.request(path, { headers: headers(member) })).status).toBe(403);
  const missingReference = await app.request(`/v1/admin/billing/invoices/${payment.invoiceId}/payments`, {
    method: 'POST', headers: headers(owner, true),
    body: JSON.stringify({ method: 'upi', amountMinor: 100, reference: '  ', idempotencyKey: unique('upi-proof') }),
  });
  expect(missingReference.status).toBe(422);
  expect(await missingReference.text()).toContain('UPI transaction reference');
});

interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

function sharkTenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

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

function makeMember(branchId = 'br_kor', invited = true, dob: string | null = null) {
  const tenantId = sharkTenantId();
  const userId = id('usr');
  const memberId = id('mbr');
  const email = `${unique('phase3')}@example.test`;
  db.insert(schema.users).values({
    id: userId,
    tenantId,
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
    tenantId,
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
    dob,
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
  return { userId, memberId, email, tenantId };
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
    tenantId: sharkTenantId(),
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
    const paid = await pay(owner, purchase.invoiceId, purchase.totalMinor);
    const { paymentId } = (await paid.json()) as { paymentId: string };

    const source = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!;
    const userId = id('usr');
    const email = `${unique('limited')}@example.test`;
    db.insert(schema.users).values({ ...source, id: userId, email, name: 'Limited Owner', initials: 'LO', createdAt: now(), updatedAt: now() }).run();
    db.insert(schema.staff).values({
      id: id('stf'), tenantId: source.tenantId, userId, employmentStatus: 'active', branchIds: ['br_kor'],
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

  it('enforces product-kind and known-age eligibility rules', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const ageRestricted = makeProduct('membership', { minAge: 30, maxAge: null, corporateOnly: false });
    const underage = makeMember('br_kor', true, '2010-01-01');
    const ageDenied = await app.request(`/v1/admin/billing/members/${underage.memberId}/assign-plan`, {
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
      id: challengeId, tenantId: member.tenantId, identifier: member.email,
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


describe('pilot financial balances', () => {
  it('keeps unpaid principal after a partial-payment refund and accepts the remaining payment', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = makeMember();
    const purchase = await assign(owner, member.memberId);
    const partial = Math.floor(purchase.totalMinor / 2);
    const paid = await pay(owner, purchase.invoiceId, partial, unique('principal'));
    const { paymentId } = await paid.json() as { paymentId: string };
    const refund = await app.request(`/v1/admin/billing/payments/${paymentId}/refund`, {
      method: 'POST', headers: headers(owner, true),
      body: JSON.stringify({ amountMinor: partial, reason: 'Return received partial payment' }),
    });
    expect(refund.status).toBe(200);
    const list = await app.request(`/v1/admin/billing/invoices?state=outstanding&memberId=${member.memberId}`,  { headers: headers(owner) });
    const body = await list.json() as { items: { id: string; dueMinor: number }[] };
    expect(body.items.find(i => i.id === purchase.invoiceId)?.dueMinor).toBe(purchase.totalMinor - partial);
    const profile = await app.request(`/v1/admin/members/${member.memberId}`, { headers: headers(owner) });
    const detail = await profile.json() as { billing: { outstandingMinor: number } };
    expect(detail.billing.outstandingMinor).toBe(purchase.totalMinor - partial);
    const invoiceDetail = await app.request(`/v1/admin/billing/invoices/${purchase.invoiceId}`, { headers: headers(owner) });
    expect((await invoiceDetail.json() as { invoice: { dueMinor: number } }).invoice.dueMinor).toBe(purchase.totalMinor - partial);
    expect((await pay(owner, purchase.invoiceId, purchase.totalMinor - partial, unique('remainder'))).status).toBe(200);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()?.state).toBe('active');
  });

  it('sums all invoices even when only the latest twelve appear on the profile', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = makeMember();
    const purchase = await assign(owner, member.memberId);
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, purchase.invoiceId)).get()!;
    for (let i = 0; i < 26; i++) db.insert(schema.invoices).values({ ...invoice, id: id('inv'), number: unique('INV') }).run();
    const response = await app.request(`/v1/admin/members/${member.memberId}`, { headers: headers(owner) });
    const detail = await response.json() as { billing: { outstandingMinor: number } };
    expect(detail.billing.outstandingMinor).toBe(27 * purchase.totalMinor);
    db.update(schema.users).set({ accountState: 'active', passwordHash: hashPassword('shark1234') }).where(eq(schema.users.id, member.userId)).run();
    const signedInMember = await signIn(member.email);
    const memberResponse = await app.request('/v1/member/billing', { headers: headers(signedInMember) });
    const memberBilling = await memberResponse.json() as { outstandingMinor: number; invoices: unknown[] };
    expect(memberBilling.outstandingMinor).toBe(detail.billing.outstandingMinor);
    expect(memberBilling.invoices).toHaveLength(24);
  });
});


describe('pilot membership dates', () => {
  it('stores freeze duration and resumes exactly once; cancellation honors its notice date', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = makeMember();
    const purchase = await assign(owner, member.memberId);
    await pay(owner, purchase.invoiceId, purchase.totalMinor, unique('freeze-paid'));
    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()!;
    db.update(schema.memberships).set({ endsOn: '2099-12-31', productSnapshot: {
      ...membership.productSnapshot,
      freeze: { allowed: true, minDaysPerFreeze: 1, maxDaysPerTerm: 30, extendsExpiry: false, feeMinor: 0 },
      cancellation: { ...membership.productSnapshot.cancellation, noticeDays: 2 },
    } }).where(eq(schema.memberships.id, membership.id)).run();
    const frozen = await app.request(`/v1/admin/members/${member.memberId}/freeze`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ days: 2, reason: 'Away for two days' }),
    });
    expect(frozen.status).toBe(200);
    const today = isoDate(now(), 'Asia/Kolkata');
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membership.id)).get()?.freezeEndsOn).toBe(addDays(today, 2));
    expect(membershipStanding(member.memberId).entitled).toBe(false);
    // Simulate the persisted deadline arriving, independent of host wall clock.
    db.update(schema.memberships).set({ freezeEndsOn: today }).where(eq(schema.memberships.id, membership.id)).run();
    expect(reconcileMembershipDates(member.memberId)).toBe(1);
    expect(reconcileMembershipDates(member.memberId)).toBe(0);
    expect(membershipStanding(member.memberId).entitled).toBe(true);
    const cancelled = await app.request(`/v1/admin/members/${member.memberId}/cancel`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ reason: 'Moving to another city' }),
    });
    expect(cancelled.status).toBe(200);
    expect(membershipStanding(member.memberId).entitled).toBe(true);
    db.update(schema.memberships).set({ cancelEffectiveOn: today }).where(eq(schema.memberships.id, membership.id)).run();
    expect(membershipStanding(member.memberId).entitled).toBe(false);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membership.id)).get()?.state).toBe('cancelled');
    const renewal = await app.request(`/v1/admin/billing/members/${member.memberId}/renew`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }),
    });
    expect(renewal.status).toBe(201);
  });
});


it('replays a refund retry once and rejects a changed amount with the same key', async () => {
  const owner = await signIn('owner@sharkfitness.in');
  const purchase = await assign(owner, makeMember().memberId);
  const payment = await pay(owner, purchase.invoiceId, purchase.totalMinor, unique('refund-retry-payment'));
  const { paymentId } = await payment.json() as { paymentId: string };
  const key = unique('refund-retry');
  const refund = (amountMinor: number) => app.request(`/v1/admin/billing/payments/${paymentId}/refund`, {
    method: 'POST', headers: { ...headers(owner, true), 'idempotency-key': key },
    body: JSON.stringify({ amountMinor, reason: 'Partial refund retry test' }),
  });
  const first = await refund(100);
  const again = await refund(100);
  expect(await again.json()).toEqual(await first.json());
  expect(db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, paymentId)).all()).toHaveLength(1);
  expect((await refund(200)).status).toBe(409);
});


it('reconciles dates before freeze and assignment and does not revive an expired term on manual unfreeze', async () => {
  const owner = await signIn('owner@sharkfitness.in');
  const member = makeMember();
  const purchase = await assign(owner, member.memberId);
  await pay(owner, purchase.invoiceId, purchase.totalMinor, unique('mutation-dates'));
  const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()!;
  const expiredOn = addDays(isoDate(now(), 'Asia/Kolkata'), -30);
  db.update(schema.memberships).set({ endsOn: expiredOn, productSnapshot: { ...membership.productSnapshot,
    freeze: { allowed: true, minDaysPerFreeze: 1, maxDaysPerTerm: 60, extendsExpiry: true, feeMinor: 0 },
  } }).where(eq(schema.memberships.id, membership.id)).run();
  const freeze = await app.request(`/v1/admin/members/${member.memberId}/freeze`, {
    method: 'POST', headers: headers(owner, true), body: JSON.stringify({ days: 60, reason: 'Cannot rescue an expired term' }),
  });
  expect(freeze.status).toBe(404);
  expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membership.id)).get()?.endsOn).toBe(expiredOn);
  // Recreate a missed-scheduler stale row to verify assignment itself owns reconciliation.
  db.update(schema.memberships).set({ state: 'active' }).where(eq(schema.memberships.id, membership.id)).run();
  const replacement = await assign(owner, member.memberId);
  expect(replacement.membershipId).not.toBe(membership.id);
  db.update(schema.memberships).set({ state: 'frozen', endsOn: expiredOn,
    freezeEndsOn: addDays(isoDate(now(), 'Asia/Kolkata'), 3),
  }).where(eq(schema.memberships.id, replacement.membershipId)).run();
  const unfreeze = await app.request(`/v1/admin/members/${member.memberId}/unfreeze`, {
    method: 'POST', headers: headers(owner, true), body: JSON.stringify({ reason: 'End the hold early' }),
  });
  expect(unfreeze.status).toBe(200);
  expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, replacement.membershipId)).get()?.state).toBe('expired');
  expect((await unfreeze.json() as { message: string }).message).toContain('expired');
});


it('returns reconciled lifecycle on the first profile read and marks immediate cancellation former', async () => {
  const owner = await signIn('owner@sharkfitness.in');
  const member = makeMember();
  const purchase = await assign(owner, member.memberId);
  await pay(owner, purchase.invoiceId, purchase.totalMinor, unique('lifecycle-date'));
  db.update(schema.memberships).set({ endsOn: addDays(isoDate(now(), 'Asia/Kolkata'), -30) })
    .where(eq(schema.memberships.id, purchase.membershipId)).run();
  const response = await app.request(`/v1/admin/members/${member.memberId}`, { headers: headers(owner) });
  expect((await response.json() as { member: { lifecycle: string } }).member.lifecycle).toBe('former');
  const renewed = await assign(owner, member.memberId);
  await pay(owner, renewed.invoiceId, renewed.totalMinor, unique('lifecycle-renew'));
  const cancelled = await app.request(`/v1/admin/members/${member.memberId}/cancel`, {
    method: 'POST', headers: headers(owner, true), body: JSON.stringify({ immediate: true, reason: 'Immediate cancellation requested' }),
  });
  expect(cancelled.status).toBe(200);
  expect(db.select().from(schema.members).where(eq(schema.members.id, member.memberId)).get()?.lifecycle).toBe('former');
});


it('does not upgrade grace access by scheduling cancellation around an unpaid balance', async () => {
  const owner = await signIn('owner@sharkfitness.in');
  const member = makeMember();
  const purchase = await assign(owner, member.memberId);
  await pay(owner, purchase.invoiceId, purchase.totalMinor, unique('grace-access'));
  const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, purchase.membershipId)).get()!;
  db.update(schema.memberships).set({ endsOn: addDays(isoDate(now(), 'Asia/Kolkata'), -1),
    productSnapshot: { ...membership.productSnapshot, cancellation: { ...membership.productSnapshot.cancellation, noticeDays: 7 } },
  }).where(eq(schema.memberships.id, membership.id)).run();
  const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, purchase.invoiceId)).get()!;
  db.insert(schema.invoices).values({ ...invoice, id: id('inv'), number: unique('GRACE-DUE'), state: 'open', paidMinor: 0, refType: null, refId: null }).run();
  const cancellation = await app.request(`/v1/admin/members/${member.memberId}/cancel`, {
    method: 'POST', headers: headers(owner, true), body: JSON.stringify({ reason: 'Request notice while in grace' }),
  });
  expect(cancellation.status).toBe(412);
  expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membership.id)).get()?.state).toBe('grace');
  const immediate = await app.request(`/v1/admin/members/${member.memberId}/cancel`, {
    method: 'POST', headers: headers(owner, true), body: JSON.stringify({ immediate: true, reason: 'Cancel immediately instead' }),
  });
  expect(immediate.status).toBe(200);
});
