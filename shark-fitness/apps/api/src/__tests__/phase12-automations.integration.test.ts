import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Phase 12 — Automations (PF-COMM-003…006).

   The interesting thing about this module is not that it sends. It is
   everything that stops it: consent withdrawn, quiet hours, a variable the
   data does not have, a branch that closed, a quota used up, and the same
   logical event arriving twice.

   So the tests are mostly suppressions, and the two that matter most are the
   duplicate-send guard and the dry run — a dry run that can send is worse than
   no dry run at all, because somebody trusted it.
   ========================================================================= */

interface Session {
  cookie: string;
  csrfToken: string;
}

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
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

const headers = (s: Session, unsafe = false): Record<string, string> => ({
  cookie: s.cookie,
  origin: 'http://localhost:5173',
  ...(unsafe ? { 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' } : {}),
});

const get = (s: Session, path: string) => app.request(path, { headers: headers(s) });
const post = (s: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(s, true), body: JSON.stringify(body) });
const patch = (s: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(s, true), body: JSON.stringify(body) });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

let owner: Session;
let manager: Session;
let reception: Session;
let dedupeAutomationId: string;
const IN_APP_TEMPLATE = 'test.automation.in-app';

/**
 * A window that is never quiet.
 *
 * `from === to` is zero width, which `inQuietHours` reads as "no quiet hours
 * at all". Tests that need a send to actually happen set this first: the seed
 * runs 21:00–08:00 like a real gym, so a suite run at 21:01 would otherwise
 * watch every message held and call the engine broken.
 */
const NEVER_QUIET = { from: '00:00', to: '00:00' };

interface AutomationRow {
  id: string;
  name: string;
  state: string;
  dryRun: boolean;
  channel: string;
  trigger: string;
}

const listed = async (): Promise<AutomationRow[]> =>
  ((await (await get(owner, '/v1/admin/automations')).json()) as { items: AutomationRow[] }).items;

const byName = async (name: string): Promise<AutomationRow> => (await listed()).find((a) => a.name === name)!;

const runsFor = (automationId: string, outcome?: string) =>
  db
    .select()
    .from(schema.automationRuns)
    .where(
      and(
        eq(schema.automationRuns.automationId, automationId),
        ...(outcome ? [eq(schema.automationRuns.outcome, outcome)] : []),
      ),
    )
    .all();

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
  await post(owner, '/v1/admin/automations/templates', {
    code: IN_APP_TEMPLATE,
    channel: 'in_app',
    subject: 'Reminder',
    body: 'Hi {{firstName}}, this is your reminder from {{branchName}}.',
  });
});

/* ——— Permission ————————————————————————————————————————— */

describe('PF-COMM — automation.manage is owner and regional, nothing below', () => {
  it('opens the module for the owner', async () => {
    expect((await get(owner, '/v1/admin/automations')).status).toBe(200);
  });

  it('refuses a branch manager and reception, who send messages by hand', async () => {
    for (const session of [manager, reception]) {
      expect((await get(session, '/v1/admin/automations')).status).toBe(403);
      expect((await get(session, '/v1/admin/automations/templates')).status).toBe(403);
    }
  });

  it('refuses a branch manager a run, not merely the list', async () => {
    const automation = await byName('Renewal nudge');
    expect((await post(manager, `/v1/admin/automations/${automation.id}/run`, {})).status).toBe(403);
  });
});

/* ——— Rule building (PF-COMM-004) ————————————————————————— */

describe('PF-COMM-004 — the rule builder refuses a rule that could never work', () => {
  it('lists the triggers with the variables and fields each provides', async () => {
    const body = (await (await get(owner, '/v1/admin/automations')).json()) as {
      triggers: Array<{ key: string; variables: string[]; fields: string[]; window: string }>;
    };
    const expiring = body.triggers.find((t) => t.key === 'membership.expiring')!;
    expect(expiring.variables).toContain('endsOn');
    expect(expiring.fields).toContain('daysLeft');
    expect(expiring.window).toBe('per_day');
  });

  it('refuses a condition on a field the trigger does not have', async () => {
    // A rule written against a field that does not exist silently never
    // matches, which is the worst way for it to fail.
    const res = await post(owner, '/v1/admin/automations', {
      name: 'Nonsense', trigger: 'member.joined', channel: 'in_app', templateCode: null,
      conditions: [{ field: 'daysSinceVisit', op: 'gt', value: '30' }],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/nothing called daysSinceVisit/);
  });

  it('refuses a template using a variable the trigger never provides', async () => {
    await post(owner, '/v1/admin/automations/templates', {
      code: 'bad.template', channel: 'in_app', subject: null,
      body: 'Hi {{firstName}}, your invoice {{invoiceNumber}} is due.',
    });
    const res = await post(owner, '/v1/admin/automations', {
      name: 'Mismatched', trigger: 'member.joined', channel: 'in_app', templateCode: 'bad.template', conditions: [],
    });
    expect(res.status).toBe(422);
    // Caught at save time, not a month later when every run was suppressed.
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/invoiceNumber/);
  });

  it('creates a valid automation, and starts it rehearsing', async () => {
    const res = await post(owner, '/v1/admin/automations', {
      name: 'Test welcome', trigger: 'member.joined', channel: 'in_app', templateCode: 'member.welcome', conditions: [],
    });
    expect(res.status).toBe(201);
    const { automation } = (await res.json()) as { automation: AutomationRow };
    // An automation that starts messaging the moment it is saved is one
    // nobody got to check.
    expect(automation.state).toBe('draft');
    expect(automation.dryRun).toBe(true);
  });

  it('will not go live in the same breath as changing the rule', async () => {
    // An operator turns off dry run because they read the preview. If the same
    // call also moves the conditions, the audience they approved is not the
    // audience that gets messaged — and they find out when the members do.
    const automation = await byName('Test welcome');
    const res = await patch(owner, `/v1/admin/automations/${automation.id}`, {
      conditions: [{ field: 'branchId', op: 'eq', value: 'br_kor' }],
      dryRun: false,
      state: 'active',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/look at who it reaches/);
  });

  it('goes live on its own, once the rule is settled', async () => {
    const automation = await byName('Test welcome');
    await patch(owner, `/v1/admin/automations/${automation.id}`, { conditions: [] });
    const res = await patch(owner, `/v1/admin/automations/${automation.id}`, { dryRun: false, state: 'active' });
    expect(res.status).toBe(200);
    await patch(owner, `/v1/admin/automations/${automation.id}`, { dryRun: true, state: 'paused' });
  });
});

/* ——— Audience preview (PF-COMM-004) ————————————————————— */

describe('PF-COMM-004 — audience preview, before anything is recorded', () => {
  it('shows who would receive it, with the message they would read', async () => {
    const automation = await byName('Renewal nudge');
    const body = (await (await get(owner, `/v1/admin/automations/${automation.id}/preview`)).json()) as {
      summary: { considered: number; suppressed: number };
      recipients: Array<{ name: string; preview: string }>;
      suppressed: Array<{ code: string; reason: string }>;
      estimatedCostMinor: number;
      metered: boolean;
    };
    expect(body.summary.considered).toBeGreaterThan(0);
    if (body.recipients.length > 0) {
      // The real message, rendered against the real member.
      expect(body.recipients[0]!.preview).not.toContain('{{');
      expect(body.recipients[0]!.preview.length).toBeGreaterThan(10);
    }
    // PF-COMM-006: the cost is stated before a large send.
    expect(body.metered).toBe(true);
    expect(body.estimatedCostMinor).toBeGreaterThanOrEqual(0);
  });

  it('records nothing — a preview is a look, not a rehearsal', async () => {
    const automation = await byName('Win back the lapsed');
    const before = runsFor(automation.id).length;
    await get(owner, `/v1/admin/automations/${automation.id}/preview`);
    expect(runsFor(automation.id).length).toBe(before);
  });

  it('says why each suppressed member was suppressed', async () => {
    const automation = await byName('Renewal nudge');
    const body = (await (await get(owner, `/v1/admin/automations/${automation.id}/preview`)).json()) as {
      suppressed: Array<{ code: string; reason: string }>;
    };
    for (const entry of body.suppressed) {
      expect(entry.code).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });
});

/* ——— Dry run ————————————————————————————————————————— */

describe('PF-COMM-004 — a dry run cannot send', () => {
  it('records what it would have done and creates no notification', async () => {
    const automation = await byName('Failed payment recovery');
    expect(automation.dryRun).toBe(true);

    const notificationsBefore =
      db.select({ n: sql<number>`count(*)` }).from(schema.notifications).where(eq(schema.notifications.kind, 'automation')).get()!.n;

    const res = await post(owner, `/v1/admin/automations/${automation.id}/run`, {});
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { dryRun: boolean; sent: number; considered: number };
    expect(summary.dryRun).toBe(true);
    expect(summary.sent).toBe(0);

    const notificationsAfter =
      db.select({ n: sql<number>`count(*)` }).from(schema.notifications).where(eq(schema.notifications.kind, 'automation')).get()!.n;
    // The whole requirement: structurally incapable of sending.
    expect(notificationsAfter).toBe(notificationsBefore);
    expect(runsFor(automation.id, 'dry_run').length).toBeGreaterThan(0);
    expect(runsFor(automation.id, 'sent')).toHaveLength(0);
  });

  it('consumes no dedupe key, so turning it on afterwards still sends', async () => {
    const automation = await byName('Failed payment recovery');
    const rehearsedKeys = runsFor(automation.id, 'dry_run').map((r) => r.eventKey);
    expect(rehearsedKeys.length).toBeGreaterThan(0);

    await patch(owner, `/v1/admin/automations/${automation.id}`, {
      channel: 'in_app', templateCode: IN_APP_TEMPLATE, quietHours: NEVER_QUIET,
    });
    await patch(owner, `/v1/admin/automations/${automation.id}`, { dryRun: false, state: 'active' });
    const res = await post(owner, `/v1/admin/automations/${automation.id}/run`, {});
    const summary = (await res.json()) as { dryRun: boolean; sent: number };
    expect(summary.dryRun).toBe(false);
    expect(summary.sent).toBeGreaterThan(0);

    // Put it back so the rest of the suite is not messaging people.
    await patch(owner, `/v1/admin/automations/${automation.id}`, { channel: 'sms', templateCode: 'payment.failed' });
    await patch(owner, `/v1/admin/automations/${automation.id}`, { dryRun: true, state: 'paused' });
  });

  it('a paused automation rehearses rather than sends, whatever the dry-run flag says', async () => {
    const automation = await byName('Win back the lapsed');
    const res = await post(owner, `/v1/admin/automations/${automation.id}/run`, {});
    const summary = (await res.json()) as { dryRun: boolean; sent: number };
    expect(summary.dryRun).toBe(true);
    expect(summary.sent).toBe(0);
  });
});

/* ——— Duplicate sends ————————————————————————————————— */

describe('PF-COMM-004 — the same logical event never sends twice', () => {
  it('sends once, then suppresses the repeat', async () => {
    const created = await post(owner, '/v1/admin/automations', {
      name: 'Dedupe probe', trigger: 'membership.expiring', channel: 'in_app',
      templateCode: IN_APP_TEMPLATE, conditions: [], quietHours: NEVER_QUIET,
    });
    dedupeAutomationId = ((await created.json()) as { automation: AutomationRow }).automation.id;
    await patch(owner, `/v1/admin/automations/${dedupeAutomationId}`, { state: 'active' });
    await patch(owner, `/v1/admin/automations/${dedupeAutomationId}`, { dryRun: false });
    const first = (await (await post(owner, `/v1/admin/automations/${dedupeAutomationId}/run`, {})).json()) as { sent: number };
    const second = (await (await post(owner, `/v1/admin/automations/${dedupeAutomationId}/run`, {})).json()) as {
      sent: number;
      bySuppression: Array<{ code: string; count: number }>;
    };

    expect(first.sent).toBeGreaterThan(0);
    expect(second.sent).toBe(0);
    expect(second.bySuppression.some((s) => s.code === 'already_sent')).toBe(true);
  });

  it('produces exactly one notification per member per event', async () => {
    const sent = runsFor(dedupeAutomationId, 'sent');
    const keys = sent.map((r) => r.eventKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is refused by the database, not only by the service', () => {
    // The guard that survives a race between two scheduler ticks.
    const automation = db.select().from(schema.automations).where(eq(schema.automations.tenantId, tenantId())).limit(1).get()!;
    const existing = runsFor(automation.id, 'sent')[0];
    if (!existing) return;
    expect(() =>
      db.insert(schema.automationRuns).values({ ...existing, id: id('aur') }).run(),
    ).toThrow(/UNIQUE/);
  });

  it('leaves a failed run’s key free to retry', () => {
    const automation = db.select().from(schema.automations).where(eq(schema.automations.tenantId, tenantId())).limit(1).get()!;
    const row = {
      id: id('aur'), tenantId: tenantId(), automationId: automation.id, branchId: 'br_kor',
      memberId: null, userId: null, trigger: automation.trigger, eventKey: `retry-probe-${Date.now()}`,
      outcome: 'failed', reason: 'provider timeout', channel: 'sms', templateCode: null, notificationId: null, at: now(),
    };
    db.insert(schema.automationRuns).values(row).run();
    // A second failure, and then a success, on the same key.
    expect(() => db.insert(schema.automationRuns).values({ ...row, id: id('aur') }).run()).not.toThrow();
    expect(() => db.insert(schema.automationRuns).values({ ...row, id: id('aur'), outcome: 'sent' }).run()).not.toThrow();
    db.delete(schema.automationRuns).where(eq(schema.automationRuns.eventKey, row.eventKey)).run();
  });
});

/* ——— Suppressions ————————————————————————————————————— */

describe('PF-COMM — the reasons not to send', () => {
  it('suppresses a member who withdrew consent, after the automation was built', async () => {
    // The PRD edge case: opting out after a job is queued. Consent is read at
    // send time, never cached into the plan.
    const automation = await byName('Renewal nudge');
    const preview = (await (await get(owner, `/v1/admin/automations/${automation.id}/preview`)).json()) as {
      suppressed: Array<{ code: string }>;
    };
    expect(preview.suppressed.some((s) => s.code === 'no_consent')).toBe(true);
  });

  it('holds during quiet hours rather than dropping the message', async () => {
    // Its own automation, with no send history: `already_sent` is checked
    // before quiet hours, so testing this on a rule that has already run would
    // assert the wrong suppression and pass for the wrong reason.
    const created = await post(owner, '/v1/admin/automations', {
      name: 'Quiet hours probe', trigger: 'membership.expiring', channel: 'in_app',
      templateCode: IN_APP_TEMPLATE, conditions: [{ field: 'daysLeft', op: 'lte', value: '30' }],
    });
    const { automation } = (await created.json()) as { automation: AutomationRow };

    // Active so the state check passes, in dry run so it can never send, and a
    // window covering all but one minute of the day so every subject is inside
    // it whatever hour the suite runs at.
    await patch(owner, `/v1/admin/automations/${automation.id}`, {
      state: 'active',
      quietHours: { from: '00:01', to: '00:00' },
    });

    const body = (await (await get(owner, `/v1/admin/automations/${automation.id}/preview`)).json()) as {
      summary: { considered: number; bySuppression: Array<{ code: string; reason: string }> };
    };
    expect(body.summary.considered).toBeGreaterThan(0);
    const quiet = body.summary.bySuppression.find((s) => s.code === 'quiet_hours');
    expect(quiet).toBeDefined();
    expect(quiet!.reason).toMatch(/Held until/);
  });

  it('suppresses a member whose branch has stopped trading', async () => {
    const automation = await byName('Renewal nudge');
    db.update(schema.branches).set({ state: 'temporarily_closed' }).where(eq(schema.branches.id, 'br_hsr')).run();
    try {
      const body = (await (await get(owner, `/v1/admin/automations/${automation.id}/preview`)).json()) as {
        suppressed: Array<{ code: string }>;
        summary: { bySuppression: Array<{ code: string }> };
      };
      expect(body.summary.bySuppression.some((s) => s.code === 'branch_not_trading')).toBe(true);
    } finally {
      db.update(schema.branches).set({ state: 'active' }).where(eq(schema.branches.id, 'br_hsr')).run();
    }
  });

  it('records every decision, including the ones not to send', async () => {
    const automation = await byName('Renewal nudge');
    await post(owner, `/v1/admin/automations/${automation.id}/run`, {});
    const body = (await (await get(owner, `/v1/admin/automations/runs?automationId=${automation.id}&limit=200`)).json()) as {
      items: Array<{ outcome: string; reason: string; memberName: string | null }>;
    };
    // "Why did my member not get the reminder" is the question this module
    // gets asked. A log of successes cannot answer it.
    expect(body.items.some((i) => i.outcome === 'suppressed')).toBe(true);
    for (const item of body.items.filter((i) => i.outcome === 'suppressed')) {
      expect(item.reason.length).toBeGreaterThan(5);
    }
  });

  it('filters the log by outcome', async () => {
    const body = (await (await get(owner, '/v1/admin/automations/runs?outcome=suppressed&limit=50')).json()) as {
      items: Array<{ outcome: string }>;
    };
    expect(body.items.every((i) => i.outcome === 'suppressed')).toBe(true);
  });
});

/* ——— Templates (PF-COMM-003) ————————————————————————————— */

describe('PF-COMM-003 — templates are versioned, never edited in place', () => {
  it('saves a new version rather than rewriting the old one', async () => {
    const before = (await (await get(owner, '/v1/admin/automations/templates')).json()) as {
      items: Array<{ code: string; version: number }>;
    };
    const original = before.items
      .filter((template) => template.code === 'member.welcome')
      .sort((left, right) => right.version - left.version)[0]!;

    await post(owner, '/v1/admin/automations/templates', {
      code: 'member.welcome', channel: 'in_app', subject: 'Welcome',
      body: 'Welcome {{firstName}}. Your first session at {{branchName}} is on us.',
    });

    const versions = db
      .select({ version: schema.messageTemplates.version })
      .from(schema.messageTemplates)
      .where(and(eq(schema.messageTemplates.tenantId, tenantId()), eq(schema.messageTemplates.code, 'member.welcome')))
      .all();
    // A message already sent was sent under the words that existed then.
    expect(versions.length).toBeGreaterThan(1);
    expect(Math.max(...versions.map((v) => v.version))).toBe(original.version + 1);

    const pinnedAutomation = await byName('Test welcome');
    const pinned = db.select().from(schema.automations).where(eq(schema.automations.id, pinnedAutomation.id)).get()!;
    expect(pinned.actions[0]?.templateVersion).toBe(original.version);
  });

  it('reports the variables a template uses', async () => {
    const body = (await (await get(owner, '/v1/admin/automations/templates')).json()) as {
      items: Array<{ code: string; variables: string[] }>;
    };
    const expiring = body.items.find((t) => t.code === 'membership.expiring')!;
    expect(expiring.variables).toContain('endsOn');
    expect(expiring.variables).toContain('daysLeft');
  });

  it('refuses a template code that is not a code', async () => {
    const res = await post(owner, '/v1/admin/automations/templates', {
      code: 'Not A Code!', channel: 'sms', subject: null, body: 'hi',
    });
    expect(res.status).toBe(422);
  });
});

/* ——— Isolation ————————————————————————————————————————— */

describe('PF-COMM — automations never cross a tenant boundary', () => {
  it('keeps one gym’s automations invisible to another', async () => {
    const reef = await (async () => {
      const r = await app.request('/v1/auth/password', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({ tenantSlug: 'reef', email: 'owner@reefathletic.in', password: 'shark1234' }),
      });
      const b = (await r.json()) as { csrfToken: string };
      const t = (r.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
      return { cookie: `shark_session=${t}; shark_csrf=${b.csrfToken}`, csrfToken: b.csrfToken };
    })();

    const body = (await (await get(reef, '/v1/admin/automations')).json()) as { items: AutomationRow[] };
    expect(body.items).toHaveLength(0);

    const sharkAutomation = await byName('Renewal nudge');
    expect((await post(reef, `/v1/admin/automations/${sharkAutomation.id}/run`, {})).status).toBe(404);
  });
});
