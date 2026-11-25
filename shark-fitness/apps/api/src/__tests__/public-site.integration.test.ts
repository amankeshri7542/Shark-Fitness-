import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClasses, PublicSite } from '@shark/contracts';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { PUBLIC_FORM_IP_MAX } from '../routes/public.js';
import { callbackDueAt, WEBSITE_CALLBACK_WINDOW_MS } from '../services/public-site.js';
import { leadSlaBreached } from '../services/leads.js';
import { DAY, HOUR, addDays, isoDate, localClockOnDay } from '../lib/time.js';

const ORIGIN = 'http://localhost:5173';
const NOTICE = 'web-2026-11';

let phoneCounter = 0;
/** A fresh, valid Indian mobile per call, so tests never dedupe against each other. */
function freshPhone(): string {
  phoneCounter += 1;
  return `9${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phoneCounter).padStart(3, '0')}`;
}

function lead(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Kavya Rao',
    phone: freshPhone(),
    branchId: 'br_kor',
    goal: 'get_stronger',
    preferredTime: 'evening',
    message: 'I have not trained in a year and would like to start slowly.',
    consent: { processing: true, marketing: false, noticeVersion: NOTICE },
    utm: {},
    website: '',
    formStartedAt: Date.now() - 20_000,
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, tenant = 'shark') {
  return app.request(`/v1/public/${tenant}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const leadsByPhone = (phone: string) =>
  db.select().from(schema.leads).where(and(eq(schema.leads.tenantId, 'ten_shark'), eq(schema.leads.phoneNormalized, phone.slice(-10)))).all();

const total = (table: typeof schema.notifications | typeof schema.automationDeliveries | typeof schema.otpChallenges | typeof schema.leads) =>
  db.select({ n: count() }).from(table).get()!.n;

const SUSPENDED_TENANT = 'ten_public_suspended';
const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;

beforeAll(() => {
  const at = Date.now();
  db.insert(schema.tenants)
    .values({
      id: SUSPENDED_TENANT,
      slug: 'closed-gym',
      legalName: 'Closed Gym LLP',
      displayName: 'Closed Gym',
      status: 'suspended',
      featureFlags: {},
      quotas: {},
      branding: {},
      policy: {},
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .run();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetRateLimitsForTest();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // No outbound request of any kind may leave while a lead is captured.
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetRateLimitsForTest();
  vi.restoreAllMocks();
});

describe('GET /v1/public/:tenant/site', () => {
  it('publishes active branches with hours and only active, public, branch-eligible plans with a GST label', async () => {
    const response = await app.request('/v1/public/shark/site');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const site = (await response.json()) as PublicSite;

    expect(site.tenant.displayName).toBe('Shark Fitness');
    expect(site.branches.map((b) => b.id).sort()).toEqual(['br_hsr', 'br_ind', 'br_kor']);
    const kor = site.branches.find((b) => b.id === 'br_kor')!;
    // Other suites edit branch hours; compare with what the database holds now.
    const row = db.select().from(schema.branches).where(eq(schema.branches.id, 'br_kor')).get()!;
    const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const day of ['mon', 'sun'] as const) {
      const hours = row.hours?.[day] ?? { closed: false, open: row.opensMinutes, close: row.closesMinutes };
      expect(kor.hours[day]).toEqual(hours.closed ? { closed: true, opens: null, closes: null } : { closed: false, opens: clock(hours.open), closes: clock(hours.close) });
    }
    expect(kor.phone).toBe(row.phone);

    const monthly = site.plans.find((p) => p.id === 'prd_monthly')!;
    expect(monthly).toMatchObject({ priceMinor: 299_900, taxMinor: 53_982, totalMinor: 353_882, taxNote: 'incl. 18% GST', cadenceLabel: '/ month' });
    expect(monthly.priceLabel).toBe('₹3,538.82');
    expect(monthly.branchIds).toEqual(['br_kor']);
    // The free trial is not published; the website's trial request replaces it.
    expect(site.plans.some((p) => p.id === 'prd_trial')).toBe(false);
  });

  it('never lists an unpublished, retired or draft product', async () => {
    const at = Date.now();
    const base = db.select().from(schema.products).where(eq(schema.products.id, 'prd_monthly')).get()!;
    const variants = [
      { id: 'prd_test_hidden', name: 'Corporate Hidden', isPublic: false, status: 'active' },
      { id: 'prd_test_retired', name: 'Retired Public', isPublic: true, status: 'retired' },
      { id: 'prd_test_draft', name: 'Draft Public', isPublic: true, status: 'draft' },
    ];
    for (const v of variants) {
      db.insert(schema.products).values({ ...base, ...v, createdAt: at, updatedAt: at }).onConflictDoNothing().run();
    }
    const site = (await (await app.request('/v1/public/shark/site')).json()) as PublicSite;
    const ids = site.plans.map((p) => p.id);
    for (const v of variants) expect(ids).not.toContain(v.id);
    db.delete(schema.products).where(inArray(schema.products.id, variants.map((v) => v.id))).run();
  });

  it('answers an unknown and a suspended tenant with the same generic 404', async () => {
    const unknown = await app.request('/v1/public/no-such-gym/site');
    const suspended = await app.request('/v1/public/closed-gym/site');
    expect(unknown.status).toBe(404);
    expect(suspended.status).toBe(404);
    const a = (await unknown.json()) as { error: { code: string; message: string } };
    const b = (await suspended.json()) as { error: { code: string; message: string } };
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.code).toBe('NOT_FOUND');
    expect((await post('/leads', lead(), {}, 'closed-gym')).status).toBe(404);
  });

  it("does not show one tenant's branches or plans on another tenant's site", async () => {
    const site = (await (await app.request('/v1/public/reef/site')).json()) as PublicSite;
    expect(site.tenant.displayName).toBe('Reef Athletic');
    expect(site.branches.every((b) => !b.id.startsWith('br_'))).toBe(true);
    expect(JSON.stringify(site)).not.toMatch(/Koramangala|Shark|prd_monthly/);
  });
});

describe('GET /v1/public/:tenant/classes', () => {
  it('lists classes without member data, with coarse availability and first names only', async () => {
    const response = await app.request('/v1/public/shark/classes?branchId=br_kor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as PublicClasses;
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['category', 'coach', 'date', 'durationMin', 'endTime', 'endsAt', 'id', 'level', 'name', 'spots', 'startTime', 'startsAt'].sort(),
      );
      expect(['available', 'few_left', 'full']).toContain(item.spots);
      expect(item.coach ?? '').not.toMatch(/\s/);
      expect(Date.parse(item.startsAt)).toBeGreaterThan(Date.now() - 60_000);
    }
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\b(mem|usr|stf|bkg|bk)_[a-z0-9]+/);
    const memberNames = db.select({ last: schema.members.lastName }).from(schema.members).where(eq(schema.members.tenantId, 'ten_shark')).limit(20).all();
    for (const { last } of memberNames) expect(text).not.toContain(`"${last}"`);
  });

  it('caps the range at 14 days and never starts in the past', async () => {
    const today = isoDate(Date.now(), 'Asia/Kolkata');
    const response = await app.request(`/v1/public/shark/classes?branchId=br_kor&from=${addDays(today, -5)}&to=${addDays(today, 40)}`);
    const body = (await response.json()) as PublicClasses;
    expect(body.from).toBe(today);
    expect(body.to).toBe(addDays(today, 13));
    const last = localClockOnDay(addDays(today, 14), '00:00', 'Asia/Kolkata');
    expect(body.items.every((item) => Date.parse(item.startsAt) < last)).toBe(true);
  });

  it("refuses another tenant's branch", async () => {
    const response = await app.request('/v1/public/reef/classes?branchId=br_kor');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { fields: Array<{ path: string }> } };
    expect(body.error.fields[0]!.path).toBe('branchId');
  });
});

describe('POST /v1/public/:tenant/leads', () => {
  it('creates a website lead with attribution, consent and a call-back deadline, and answers 202', async () => {
    const stamp = Date.now();
    const body = lead({
      email: `Kavya.Rao.${stamp}@Example.in`,
      planId: 'prd_monthly',
      consent: { processing: true, marketing: true, noticeVersion: NOTICE },
      utm: { source: 'qr', medium: 'poster', campaign: 'diwali-2026' },
      referralCode: 'AMAN-2041',
    });
    const response = await post('/leads', body);
    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ received: true, message: expect.stringContaining('call you') });

    const [row] = leadsByPhone(body.phone as string);
    expect(row).toMatchObject({
      source: 'website',
      campaign: 'diwali-2026',
      stage: 'new',
      phone: `+91${body.phone}`,
      email: `kavya.rao.${stamp}@example.in`,
      goal: 'get_stronger',
      interestedProductId: 'prd_monthly',
      referralCode: 'AMAN-2041',
      utm: { source: 'qr', medium: 'poster', campaign: 'diwali-2026', term: null, content: null },
      trialRequestedAt: null,
      nextActionLabel: 'Call back about the website enquiry',
    });
    expect(row!.nextActionAt).toBeGreaterThan(Date.now());

    const consents = db.select().from(schema.leadConsents).where(eq(schema.leadConsents.leadId, row!.id)).all();
    expect(consents.map((c) => [c.purpose, c.granted, c.noticeVersion, c.source]).sort()).toEqual([
      ['marketing', true, NOTICE, 'website:contact'],
      ['processing', true, NOTICE, 'website:contact'],
    ]);

    const activity = db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, row!.id)).all();
    expect(activity).toHaveLength(1);
    expect(activity[0]!.body).toContain('I have not trained in a year');
    expect(activity[0]!.body).toContain('Campaign: qr / poster / diwali-2026');

    const auditRow = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, row!.id), eq(schema.auditLog.action, 'lead.website_enquiry'))).get();
    expect(auditRow?.actorName).toBe('Website form');

    const event = db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.topic, 'lead.captured')).orderBy(desc(schema.outboxEvents.seq)).get();
    expect(event?.payload).toMatchObject({ leadId: row!.id, source: 'website' });
  });

  it('records marketing consent as refused unless ticked', async () => {
    const body = lead({ consent: { processing: true, noticeVersion: NOTICE } });
    expect((await post('/leads', body)).status).toBe(202);
    const [row] = leadsByPhone(body.phone as string);
    const marketing = db.select().from(schema.leadConsents).where(and(eq(schema.leadConsents.leadId, row!.id), eq(schema.leadConsents.purpose, 'marketing'))).get();
    expect(marketing).toMatchObject({ granted: false, noticeVersion: NOTICE });
  });

  it('deduplicates by phone: a second submission adds to the same lead and keeps first-touch attribution', async () => {
    const phone = freshPhone();
    expect((await post('/leads', lead({ phone: `+91 ${phone}`, utm: { campaign: 'first' } }))).status).toBe(202);
    expect((await post('/leads', lead({ phone: `0${phone}`, name: 'Kavya R', utm: { campaign: 'second' } }))).status).toBe(202);
    const rows = leadsByPhone(phone);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaign).toBe('first');
    const notes = db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, rows[0]!.id)).all();
    expect(notes).toHaveLength(2);
    expect(notes.some((n) => n.body.includes('again') && n.body.includes('second'))).toBe(true);
    expect(db.select().from(schema.leadConsents).where(eq(schema.leadConsents.leadId, rows[0]!.id)).all()).toHaveLength(4);
  });

  it('deduplicates by email across different phone numbers', async () => {
    const email = `dedupe-${Date.now()}@example.in`;
    const first = lead({ email });
    expect((await post('/leads', first)).status).toBe(202);
    const second = lead({ email: email.toUpperCase() });
    expect((await post('/leads', second)).status).toBe(202);
    const rows = db.select().from(schema.leads).where(eq(schema.leads.emailNormalized, email)).all();
    expect(rows).toHaveLength(1);
    expect(leadsByPhone(second.phone as string)).toHaveLength(0);
  });

  it('reopens a lost lead instead of creating another', async () => {
    const body = lead();
    await post('/leads', body);
    const [row] = leadsByPhone(body.phone as string);
    db.update(schema.leads).set({ stage: 'lost', lossReason: 'Price' }).where(eq(schema.leads.id, row!.id)).run();
    await post('/leads', lead({ phone: body.phone }));
    const rows = leadsByPhone(body.phone as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'reopened', lossReason: null });
  });

  it('links a converted member who submits again to that member, with a note and no duplicate', async () => {
    const member = db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, 'ten_shark'), eq(schema.members.email, 'aman@sharkfitness.in')))
      .get()!;
    expect(member.phoneNormalized).toBeTruthy();
    const leadsBefore = total(schema.leads);
    const membersBefore = db.select({ n: count() }).from(schema.members).get()!.n;
    const notesBefore = db.select({ id: schema.leadActivities.id }).from(schema.leadActivities).all().map((row) => row.id);

    const first = await post('/trial-requests', lead({ name: 'Aman', phone: member.phone, email: 'someone-else@example.in' }));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ received: true, message: expect.stringContaining('call you') });
    const second = await post('/leads', lead({ name: 'Aman', phone: `+91${member.phoneNormalized}` }));
    expect(second.status).toBe(202);

    const linked = db.select().from(schema.leads).where(eq(schema.leads.convertedMemberId, member.id)).all();
    expect(linked).toHaveLength(1);
    expect(linked[0]!.stage).toBe('won');
    expect(total(schema.leads)).toBeLessThanOrEqual(leadsBefore + 1);
    expect(db.select({ n: count() }).from(schema.members).get()!.n).toBe(membersBefore);
    const notes = db
      .select()
      .from(schema.leadActivities)
      .where(eq(schema.leadActivities.leadId, linked[0]!.id))
      .all()
      .filter((n) => !notesBefore.includes(n.id));
    expect(notes.filter((n) => n.body.includes(`Existing member ${member.memberNo}`))).toHaveLength(2);
    expect(linked[0]!.trialRequestedAt).not.toBeNull();
  });

  it('drops honeypot and too-fast submissions with a 202, creates nothing and logs a security event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leadsBefore = total(schema.leads);
    const honeypot = lead({ website: 'https://cheap-followers.example' });
    const tooFast = lead({ formStartedAt: Date.now() - 1_200 });

    for (const body of [honeypot, tooFast]) {
      const response = await post('/trial-requests', { ...body, preferredTime: 'morning' });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ received: true, message: expect.stringContaining('call you') });
    }
    expect(total(schema.leads)).toBe(leadsBefore);
    expect(leadsByPhone(honeypot.phone as string)).toHaveLength(0);
    const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('security_public_form_rejected'));
    expect(logged.some((line) => line.includes('honeypot'))).toBe(true);
    expect(logged.some((line) => line.includes('too_fast'))).toBe(true);
    // The log names the reason, never what was submitted.
    expect(logged.join('\n')).not.toContain(honeypot.phone as string);
  });

  it('does not hold a visitor whose clock runs ahead against them', async () => {
    const body = lead({ formStartedAt: Date.now() + 5 * 60_000 });
    expect((await post('/leads', body)).status).toBe(202);
    expect(leadsByPhone(body.phone as string)).toHaveLength(1);
  });

  it('refuses an invalid phone with 422 and a field path', async () => {
    const response = await post('/leads', lead({ phone: '12345' }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; fields: Array<{ path: string; message: string }> } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields).toEqual([expect.objectContaining({ path: 'phone', message: expect.stringContaining('10-digit') })]);
  });

  it('refuses a message over 1,000 characters and a missing processing consent', async () => {
    const long = await post('/leads', lead({ message: 'x'.repeat(1_001) }));
    expect(long.status).toBe(422);
    expect(((await long.json()) as { error: { fields: Array<{ path: string }> } }).error.fields[0]!.path).toBe('message');
    const noConsent = await post('/leads', lead({ consent: { processing: false, noticeVersion: NOTICE } }));
    expect(((await noConsent.json()) as { error: { fields: Array<{ path: string }> } }).error.fields[0]!.path).toBe('consent.processing');
  });

  it("cannot write into another tenant's branch", async () => {
    const body = lead();
    const response = await post('/leads', body, {}, 'reef');
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { fields: Array<{ path: string }> } }).error.fields[0]!.path).toBe('branchId');
    expect(leadsByPhone(body.phone as string)).toHaveLength(0);
  });

  it('keeps leads with the same phone in different tenants apart', async () => {
    const reefBranch = db.select().from(schema.branches).where(eq(schema.branches.tenantId, 'ten_reef')).get()!;
    const body = lead();
    expect((await post('/leads', body)).status).toBe(202);
    expect((await post('/leads', { ...body, branchId: reefBranch.id }, {}, 'reef')).status).toBe(202);
    const rows = db.select().from(schema.leads).where(eq(schema.leads.phoneNormalized, (body.phone as string).slice(-10))).all();
    expect(rows.map((r) => r.tenantId).sort()).toEqual(['ten_reef', 'ten_shark']);
  });

  it('requires a known Origin and sets no cookie', async () => {
    const missing = await app.request('/v1/public/shark/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lead()),
    });
    expect(missing.status).toBe(403);
    expect((await post('/leads', lead(), { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('accepts a public form from a visitor who also holds a member session cookie', async () => {
    const body = lead();
    const response = await post('/leads', body, { cookie: 'shark_session=stale-or-live; shark_csrf=x' });
    expect(response.status).toBe(202);
    expect(leadsByPhone(body.phone as string)).toHaveLength(1);
  });

  it('refuses an oversized body with 413', async () => {
    const response = await post('/leads', lead({ message: 'x'.repeat(20_000) }));
    expect(response.status).toBe(413);
  });

  it(`rate-limits each form to ${PUBLIC_FORM_IP_MAX} submissions per IP per ten minutes`, async () => {
    for (let i = 0; i < PUBLIC_FORM_IP_MAX; i += 1) {
      expect((await post('/leads', lead())).status).toBe(202);
    }
    const limited = await post('/leads', lead());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // The trial form has its own budget.
    expect((await post('/trial-requests', lead())).status).toBe(202);
  });

  it('replays an Idempotency-Key and refuses it for a different body', async () => {
    const body = lead();
    const key = `idem-${Date.now()}`;
    expect((await post('/leads', body, { 'idempotency-key': key })).status).toBe(202);
    expect((await post('/leads', body, { 'idempotency-key': key })).status).toBe(202);
    const [row] = leadsByPhone(body.phone as string);
    expect(db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, row!.id)).all()).toHaveLength(1);
    expect((await post('/leads', { ...body, message: 'different' }, { 'idempotency-key': key })).status).toBe(409);
    expect((await post('/leads', body, { 'idempotency-key': 'bad key!' })).status).toBe(422);
  });

  it('sends nothing to the visitor: no notification, delivery, OTP or outbound request', async () => {
    const before = [total(schema.notifications), total(schema.automationDeliveries), total(schema.otpChallenges)];
    expect((await post('/leads', lead({ email: `quiet-${Date.now()}@example.in` }))).status).toBe(202);
    expect((await post('/trial-requests', lead())).status).toBe(202);
    expect([total(schema.notifications), total(schema.automationDeliveries), total(schema.otpChallenges)]).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /v1/public/:tenant/trial-requests', () => {
  it('records the requested class on the lead, sets an SLA deadline and books nothing', async () => {
    const classes = (await (await app.request('/v1/public/shark/classes?branchId=br_kor')).json()) as PublicClasses;
    const open = classes.items.find((item) => item.spots !== 'full')!;
    const sessionBefore = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, open.id)).get()!;
    const bookingsBefore = db.select({ n: count() }).from(schema.bookings).where(eq(schema.bookings.sessionId, open.id)).get()!.n;

    const body = lead({ classSessionId: open.id, preferredTime: undefined });
    const response = await post('/trial-requests', body);
    expect(response.status).toBe(202);

    const [row] = leadsByPhone(body.phone as string);
    expect(row).toMatchObject({ source: 'website', stage: 'new', trialSessionId: open.id, nextActionLabel: 'Call back to confirm the free trial' });
    expect(row!.trialRequestedAt).not.toBeNull();
    expect(row!.trialConfirmedAt).toBeNull();
    const note = db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, row!.id)).get()!;
    expect(note.body).toContain(`Trial: ${open.name}, ${open.date} at ${open.startTime}`);

    const sessionAfter = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, open.id)).get()!;
    expect(sessionAfter.booked).toBe(sessionBefore.booked);
    expect(db.select({ n: count() }).from(schema.bookings).where(eq(schema.bookings.sessionId, open.id)).get()!.n).toBe(bookingsBefore);

    // The existing lead-SLA alert fires once the call-back deadline passes.
    expect(leadSlaBreached({ ...row!, stage: 'new' }, row!.nextActionAt! - 1)).toBe(false);
    expect(leadSlaBreached({ ...row!, stage: 'new' }, row!.nextActionAt! + 1)).toBe(true);
  });

  it('records a preferred time when no class is chosen, and needs one or the other', async () => {
    const body = lead({ preferredTime: 'early_morning' });
    expect((await post('/trial-requests', body)).status).toBe(202);
    expect(leadsByPhone(body.phone as string)[0]).toMatchObject({ trialPreferredTime: 'early_morning', trialSessionId: null });

    const neither = await post('/trial-requests', lead({ preferredTime: undefined }));
    expect(neither.status).toBe(422);
    expect(((await neither.json()) as { error: { fields: Array<{ path: string }> } }).error.fields[0]!.path).toBe('preferredTime');
  });

  it("refuses a class from another branch, the past or another tenant", async () => {
    const past = db
      .select()
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.branchId, 'br_kor'), gt(schema.classSessions.startsAt, Date.now() - 7 * DAY)))
      .all()
      .find((s) => s.startsAt < Date.now())!;
    const otherBranch = db
      .select()
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.branchId, 'br_ind'), gt(schema.classSessions.startsAt, Date.now() + HOUR)))
      .get()!;
    for (const sessionId of [past.id, otherBranch.id, 'cls_does_not_exist']) {
      const response = await post('/trial-requests', lead({ classSessionId: sessionId }));
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { fields: Array<{ path: string }> } }).error.fields[0]!.path).toBe('classSessionId');
    }
  });
});

describe('callbackDueAt', () => {
  // A fixed timetable, so other suites' edits to the seeded branch cannot move it.
  const branch = () => ({
    ...db.select().from(schema.branches).where(eq(schema.branches.id, 'br_kor')).get()!,
    timezone: 'Asia/Kolkata',
    opensMinutes: 5 * 60,
    closesMinutes: 23 * 60,
    hours: {
      mon: { open: 5 * 60, close: 23 * 60, closed: false },
      tue: { open: 5 * 60, close: 23 * 60, closed: false },
      wed: { open: 5 * 60, close: 23 * 60, closed: false },
      thu: { open: 5 * 60, close: 23 * 60, closed: false },
      fri: { open: 5 * 60, close: 23 * 60, closed: false },
      sat: { open: 6 * 60, close: 22 * 60, closed: false },
      sun: { open: 6 * 60, close: 22 * 60, closed: false },
    },
  });

  it('is two hours away while the branch is open', () => {
    const at = localClockOnDay('2026-11-23', '10:00', 'Asia/Kolkata'); // a Monday
    expect(callbackDueAt(branch(), at)).toBe(at + WEBSITE_CALLBACK_WINDOW_MS);
  });

  it('counts from the next opening when the request arrives after closing', () => {
    const at = localClockOnDay('2026-11-23', '23:30', 'Asia/Kolkata');
    expect(callbackDueAt(branch(), at)).toBe(localClockOnDay('2026-11-24', '05:00', 'Asia/Kolkata') + WEBSITE_CALLBACK_WINDOW_MS);
  });

  it('skips a closed day', () => {
    const closedTuesday = { ...branch(), hours: { ...branch().hours, tue: { open: 0, close: 0, closed: true } } };
    const at = localClockOnDay('2026-11-23', '23:30', 'Asia/Kolkata');
    expect(callbackDueAt(closedTuesday, at)).toBe(localClockOnDay('2026-11-25', '05:00', 'Asia/Kolkata') + WEBSITE_CALLBACK_WINDOW_MS);
  });

  it('uses the weekend hours on a Sunday morning', () => {
    const at = localClockOnDay('2026-11-29', '05:30', 'Asia/Kolkata');
    expect(callbackDueAt(branch(), at)).toBe(localClockOnDay('2026-11-29', '06:00', 'Asia/Kolkata') + WEBSITE_CALLBACK_WINDOW_MS);
  });
});
