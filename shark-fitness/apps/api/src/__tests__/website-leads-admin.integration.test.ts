import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClasses, PublicSite } from '@shark/contracts';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { signInRequest } from './helpers/mfa.js';

/**
 * The console's side of the website: publishing a plan, seeing website leads
 * with their campaign and trial request, and confirming the trial.
 */

const ORIGIN = 'http://localhost:5173';
interface BrowserSession {
  cookie: string;
  csrfToken: string;
}
const sessions = new Map<string, BrowserSession>();

async function signIn(email: string): Promise<BrowserSession> {
  const cached = sessions.get(email);
  if (cached) return cached;
  const response = await signInRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${csrfToken}`, csrfToken };
  sessions.set(email, session);
  return session;
}

function admin(session: BrowserSession, path: string, method = 'GET', body?: unknown) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      origin: ORIGIN,
      ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let seq = 0;
function phone(): string {
  seq += 1;
  return `8${String(Date.now() % 1_000_000).padStart(6, '0')}${String(seq).padStart(3, '0')}`;
}

async function websiteTrial(overrides: Record<string, unknown> = {}): Promise<string> {
  const body = {
    name: 'Ishaan Menon',
    phone: phone(),
    branchId: 'br_kor',
    preferredTime: 'evening',
    consent: { processing: true, marketing: true, noticeVersion: 'web-2026-11' },
    utm: { source: 'qr', medium: 'flyer', campaign: 'hsr-society-nov' },
    formStartedAt: Date.now() - 30_000,
    ...overrides,
  };
  const response = await app.request('/v1/public/shark/trial-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  return db.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.phoneNormalized, String(body.phone).slice(-10))).get()!.id;
}

beforeEach(() => {
  resetRateLimitsForTest();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  resetRateLimitsForTest();
  vi.restoreAllMocks();
});

describe('Show on website', () => {
  it('lets an owner publish and unpublish a plan, audited, and the site follows', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const listed = async () => ((await (await app.request('/v1/public/shark/site')).json()) as PublicSite).plans.map((p) => p.id);

    const products = (await (await admin(owner, '/billing/products')).json()) as { items: Array<{ id: string; public: boolean }> };
    expect(products.items.find((p) => p.id === 'prd_offpeak')?.public).toBe(true);
    expect(products.items.find((p) => p.id === 'prd_trial')?.public).toBe(false);

    const off = await admin(owner, '/billing/products/prd_offpeak/website', 'PUT', { public: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, public: false, listed: false });
    expect(await listed()).not.toContain('prd_offpeak');
    expect(
      db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, 'prd_offpeak'), eq(schema.auditLog.action, 'product.unpublished'))).get(),
    ).toBeTruthy();

    const on = await admin(owner, '/billing/products/prd_offpeak/website', 'PUT', { public: true });
    expect(await on.json()).toEqual({ ok: true, public: true, listed: true });
    expect(await listed()).toContain('prd_offpeak');
    // Publishing is not a change of terms.
    expect(db.select().from(schema.products).where(eq(schema.products.id, 'prd_offpeak')).get()!.version).toBe(1);
  });

  it('is refused to a role without product.manage and 404s for another tenant’s product', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    expect((await admin(reception, '/billing/products/prd_monthly/website', 'PUT', { public: false })).status).toBe(403);
    const owner = await signIn('owner@sharkfitness.in');
    expect((await admin(owner, '/billing/products/prd_not_ours/website', 'PUT', { public: true })).status).toBe(404);
  });
});

describe('website leads in the console', () => {
  it('lists website leads with campaign and trial request under the Website filter', async () => {
    const leadId = await websiteTrial();
    const owner = await signIn('owner@sharkfitness.in');
    const response = await admin(owner, '/leads?source=website&limit=500');
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.every((item) => item.source === 'website')).toBe(true);
    const item = body.items.find((x) => x.id === leadId)!;
    expect(item).toMatchObject({
      source: 'website',
      campaign: 'hsr-society-nov',
      utm: { source: 'qr', medium: 'flyer', campaign: 'hsr-society-nov', term: null, content: null },
      trial: { preferredTime: 'Evening (4–8 pm)', sessionId: null, confirmedAt: null },
    });
    expect((item.trial as { requestedAt: string }).requestedAt).toBeTruthy();
  });

  it('shows consent, goal and the requested class on the detail', async () => {
    const classes = (await (await app.request('/v1/public/shark/classes?branchId=br_kor')).json()) as PublicClasses;
    const session = classes.items.find((c) => c.spots !== 'full')!;
    const leadId = await websiteTrial({ classSessionId: session.id, goal: 'classes', preferredTime: undefined, planId: 'prd_elite_annual' });
    const owner = await signIn('owner@sharkfitness.in');
    const { lead } = (await (await admin(owner, `/leads/${leadId}`)).json()) as { lead: Record<string, unknown> };
    expect(lead).toMatchObject({
      goal: 'Group classes',
      interestedPlan: { id: 'prd_elite_annual', name: 'Elite Annual' },
      trial: { sessionId: session.id, sessionLabel: `${session.name} · ${session.date} ${session.startTime}` },
    });
    expect(lead.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'processing', granted: true, noticeVersion: 'web-2026-11', source: 'website:trial' }),
        expect.objectContaining({ purpose: 'marketing', granted: true }),
      ]),
    );
  });

  it('confirms a trial: stage trial_booked with the chosen session, activity, audit and no booking', async () => {
    const leadId = await websiteTrial();
    const owner = await signIn('owner@sharkfitness.in');
    const options = (await (await admin(owner, `/leads/${leadId}/trial/options`)).json()) as { items: Array<{ id: string; label: string }> };
    expect(options.items.length).toBeGreaterThan(0);
    const chosen = options.items[0]!;
    const before = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, chosen.id)).get()!;

    const response = await admin(owner, `/leads/${leadId}/trial/confirm`, 'POST', { sessionId: chosen.id, note: 'Bring trainers and a towel.' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stage: 'trial_booked', sessionLabel: chosen.label });

    const lead = db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).get()!;
    expect(lead).toMatchObject({ stage: 'trial_booked', trialConfirmedSessionId: chosen.id, nextActionLabel: `Free trial: ${chosen.label}` });
    const activity = db.select().from(schema.leadActivities).where(and(eq(schema.leadActivities.leadId, leadId), eq(schema.leadActivities.kind, 'trial'))).get()!;
    expect(activity).toMatchObject({ fromStage: 'new', toStage: 'trial_booked' });
    expect(activity.body).toContain('Bring trainers');
    expect(db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, leadId), eq(schema.auditLog.action, 'lead.trial_confirmed'))).get()).toBeTruthy();
    expect(db.select().from(schema.classSessions).where(eq(schema.classSessions.id, chosen.id)).get()!.booked).toBe(before.booked);

    const detail = (await (await admin(owner, `/leads/${leadId}`)).json()) as { lead: { trial: { confirmedSessionLabel: string } } };
    expect(detail.lead.trial.confirmedSessionLabel).toBe(chosen.label);
  });

  it('refuses a class at another branch and a lead that is already closed', async () => {
    const leadId = await websiteTrial();
    const owner = await signIn('owner@sharkfitness.in');
    const elsewhere = db
      .select()
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.branchId, 'br_ind'), eq(schema.classSessions.state, 'scheduled')))
      .all()
      .find((s) => s.startsAt > Date.now())!;
    const wrong = await admin(owner, `/leads/${leadId}/trial/confirm`, 'POST', { sessionId: elsewhere.id });
    expect(wrong.status).toBe(422);

    db.update(schema.leads).set({ stage: 'lost' }).where(eq(schema.leads.id, leadId)).run();
    const options = (await (await admin(owner, `/leads/${leadId}/trial/options`)).json()) as { items: Array<{ id: string }> };
    const closed = await admin(owner, `/leads/${leadId}/trial/confirm`, 'POST', { sessionId: options.items[0]!.id });
    expect(closed.status).toBe(409);
  });

  it('hides a website lead at another branch from a single-branch receptionist', async () => {
    const leadId = await websiteTrial({ branchId: 'br_ind' });
    const reception = await signIn('reception@sharkfitness.in');
    expect((await admin(reception, `/leads/${leadId}`)).status).toBe(404);
    expect((await admin(reception, `/leads/${leadId}/trial/options`)).status).toBe(404);
    const list = (await (await admin(reception, '/leads?source=website&limit=500')).json()) as { items: Array<{ id: string }> };
    expect(list.items.some((item) => item.id === leadId)).toBe(false);
  });
});
