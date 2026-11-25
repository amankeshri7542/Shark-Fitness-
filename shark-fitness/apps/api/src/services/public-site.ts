import { and, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  PUBLIC_CLASSES_MAX_DAYS,
  PUBLIC_FORM_MIN_FILL_MS,
  channels,
  type PublicBranch,
  type PublicClass,
  type PublicClasses,
  type PublicDayHours,
  type PublicLead,
  type PublicPlan,
  type PublicSite,
  type PublicSpots,
  type PublicSubmissionReceipt,
  type PublicWeekday,
} from '@shark/contracts';
import { formatMoney, planSoldAt, ratePercent, taxOn } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { AppError, invalid } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id, normalizeEmail, normalizePhone } from '../lib/ids.js';
import { runIdempotently } from '../lib/idempotency.js';
import { log } from '../lib/observability.js';
import { HOUR, addDays, daysBetween, isoDate, localClockOnDay, localTime, now } from '../lib/time.js';
import { sessionQuery } from './booking.js';

/**
 * The public website's reads and writes (`routes/public.ts`).
 *
 * Everything here runs without a session, on behalf of a visitor nobody has
 * verified, so three rules hold throughout:
 *
 * - **Only published facts leave.** Active branches, active products an owner
 *   ticked "Show on website", class times and a coarse availability word.
 *   Never a member, a booking count, a staff surname or an internal note.
 * - **A submission never says what it matched.** New lead, existing lead,
 *   existing member, honeypot: the visitor gets the same 202 and the same
 *   sentence, so the form cannot be used to find out whether a phone number
 *   belongs to a member.
 * - **Nothing is sent and nothing is booked.** A trial request records what
 *   was asked for and gives staff a call-back deadline. Staff confirm the trial
 *   from the console; no seat is held and no message goes to the visitor.
 */

const PUBLIC_TENANT_STATUSES = new Set(['active', 'trial']);
const PUBLIC_BRANCH_STATES = ['active', 'temporarily_closed'] as const;
/** How long staff have, from the branch's next opening, to call a website lead back. */
export const WEBSITE_CALLBACK_WINDOW_MS = 2 * HOUR;
const WEEKDAYS: PublicWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type PublicTenant = typeof schema.tenants.$inferSelect;
type BranchRow = typeof schema.branches.$inferSelect;

/** Unknown, suspended, archived and platform tenants all look the same: absent. */
export function resolvePublicTenant(slug: string): PublicTenant {
  const tenant = /^[a-z0-9-]{1,64}$/.test(slug)
    ? db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug)).get()
    : undefined;
  if (!tenant || tenant.kind !== 'customer' || !PUBLIC_TENANT_STATUSES.has(tenant.status)) {
    throw new AppError('NOT_FOUND', 'That endpoint does not exist.');
  }
  return tenant;
}

function publicBranches(tenantId: string): BranchRow[] {
  return db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, tenantId), inArray(schema.branches.state, [...PUBLIC_BRANCH_STATES])))
    .orderBy(schema.branches.createdAt, schema.branches.name)
    .all();
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function dayHours(branch: BranchRow, day: PublicWeekday): { closed: boolean; open: number; close: number } {
  const override = branch.hours?.[day];
  if (override) return override;
  return { closed: false, open: branch.opensMinutes, close: branch.closesMinutes };
}

function weekdayOf(isoDay: string): PublicWeekday {
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(`${isoDay}T12:00:00Z`).getUTCDay() + 6) % 7]!;
}

/* ——— GET /site ————————————————————————————————————————————————— */

export function publicSite(tenant: PublicTenant): PublicSite {
  const branches = publicBranches(tenant.id);
  const today = isoDate(now(), tenant.timezone);
  const taxLabel = typeof tenant.taxProfile?.label === 'string' && tenant.taxProfile.label.trim() ? tenant.taxProfile.label.trim() : 'tax';

  const products = db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenant.id), eq(schema.products.status, 'active'), eq(schema.products.isPublic, true)))
    .orderBy(schema.products.priceMinor)
    .all();

  const branchIds = branches.map((b) => b.id);
  const plans: PublicPlan[] = [];
  for (const product of products) {
    const soldAt = branchIds.filter((branchId) => planSoldAt(product.access, branchId));
    if (soldAt.length === 0) continue;
    const taxMinor = taxOn(product.priceMinor, product.taxRateBp);
    const totalMinor = product.priceMinor + taxMinor;
    plans.push({
      id: product.id,
      name: product.name,
      description: product.description,
      kind: product.kind,
      cadence: product.cadence,
      durationDays: product.durationDays,
      credits: product.credits,
      currency: product.currency,
      priceMinor: product.priceMinor,
      taxMinor,
      totalMinor,
      taxRatePercent: ratePercent(product.taxRateBp),
      taxLabel,
      priceLabel: formatMoney(totalMinor, product.currency),
      taxNote: product.taxRateBp > 0 ? `incl. ${ratePercent(product.taxRateBp)} ${taxLabel}` : `no ${taxLabel}`,
      cadenceLabel: cadenceLabel(product.cadence, product.durationDays),
      allBranches: soldAt.length === branchIds.length && (product.access.allBranches || product.access.branchIds.length === 0),
      branchIds: soldAt,
    });
  }

  const privacyContact = tenant.dataProcessing?.privacyContact;
  return {
    tenant: {
      slug: tenant.slug,
      displayName: tenant.displayName,
      currency: tenant.currency,
      timezone: tenant.timezone,
      privacyContact: typeof privacyContact === 'string' ? privacyContact : null,
    },
    branches: branches.map((branch): PublicBranch => ({
      id: branch.id,
      slug: branch.slug,
      name: branch.name,
      state: branch.state as PublicBranch['state'],
      addressLine: branch.addressLine,
      city: branch.city,
      timezone: branch.timezone,
      phone: branch.phone,
      email: branch.email,
      amenities: branch.amenities,
      holidays: branch.holidays.filter((day) => day >= today).sort(),
      hours: Object.fromEntries(
        WEEKDAYS.map((day): [PublicWeekday, PublicDayHours] => {
          const hours = dayHours(branch, day);
          return [day, hours.closed ? { closed: true, opens: null, closes: null } : { closed: false, opens: clockOf(hours.open), closes: clockOf(hours.close) }];
        }),
      ) as Record<PublicWeekday, PublicDayHours>,
    })),
    plans,
  };
}

function cadenceLabel(cadence: string, durationDays: number | null): string {
  switch (cadence) {
    case 'monthly':
      return '/ month';
    case 'quarterly':
      return '/ quarter';
    case 'annual':
      return '/ year';
    case 'weekly':
      return '/ week';
    default:
      return durationDays === 1 ? 'one day' : 'one-time';
  }
}

/* ——— GET /classes ——————————————————————————————————————————————— */

/** "Few left" from this many open places, or a fifth of the room, whichever is larger. */
function spotsFor(capacity: number, booked: number): PublicSpots {
  const open = capacity - booked;
  if (open <= 0) return 'full';
  return open <= Math.max(3, Math.ceil(capacity * 0.2)) ? 'few_left' : 'available';
}

export function publicClasses(tenant: PublicTenant, query: { branchId: string; from?: string; to?: string }): PublicClasses {
  const branch = publicBranches(tenant.id).find((b) => b.id === query.branchId);
  if (!branch) throw invalid('Choose one of our branches.', [{ path: 'branchId', code: 'custom', message: 'Choose one of our branches.' }]);

  const tz = branch.timezone;
  const nowMs = now();
  const today = isoDate(nowMs, tz);
  // The past is not on offer, and the window is capped rather than refused:
  // a page asking for "the next month" gets the next fortnight.
  const from = query.from && query.from > today ? query.from : today;
  const requestedTo = query.to && query.to >= from ? query.to : addDays(from, 6);
  const to = daysBetween(from, requestedTo) >= PUBLIC_CLASSES_MAX_DAYS ? addDays(from, PUBLIC_CLASSES_MAX_DAYS - 1) : requestedTo;

  const startMs = Math.max(nowMs, localClockOnDay(from, '00:00', tz));
  const endMs = localClockOnDay(addDays(to, 1), '00:00', tz);

  const rows = sessionQuery()
    .where(
      and(
        eq(schema.classSessions.tenantId, tenant.id),
        eq(schema.classSessions.branchId, branch.id),
        eq(schema.classSessions.state, 'scheduled'),
        gte(schema.classSessions.startsAt, startMs),
        lt(schema.classSessions.startsAt, endMs),
      ),
    )
    .orderBy(schema.classSessions.startsAt)
    .all();

  const items = rows.map((row): PublicClass => ({
    id: row.id,
    name: row.name,
    category: row.category,
    level: row.intensity,
    coach: row.trainerName ? (row.trainerName.trim().split(/\s+/)[0] ?? null) : null,
    date: isoDate(row.startsAt, tz),
    startTime: localTime(row.startsAt, tz),
    endTime: localTime(row.endsAt, tz),
    startsAt: new Date(row.startsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
    durationMin: Math.round((row.endsAt - row.startsAt) / 60_000),
    spots: spotsFor(row.capacity, row.booked),
  }));

  return { branchId: branch.id, timezone: tz, from, to, items };
}

/* ——— POST /leads and /trial-requests ————————————————————————————— */

export type EnquiryKind = 'contact' | 'trial';

const RECEIPT: Record<EnquiryKind, PublicSubmissionReceipt> = {
  contact: { received: true, message: 'Thanks. Someone from the team will call you, usually within a few hours of opening.' },
  trial: { received: true, message: 'Thanks. Someone from the team will call you to confirm your free trial, usually within a few hours of opening.' },
};

/** Audit rows need an actor; the visitor is not a user, and no staff member did this. */
function websiteContext(tenantId: string, branchId: string, requestId: string, ip: string, userAgent: string): RequestContext {
  return {
    requestId,
    sessionId: 'public',
    authMethod: 'bearer',
    tenantId,
    userId: 'system:website',
    memberId: null,
    staffId: null,
    role: 'platform_admin',
    name: 'Website form',
    branchIds: [branchId],
    activeBranchId: branchId,
    permissions: [],
    ip,
    userAgent: userAgent.slice(0, 200),
    impersonatorId: null,
  };
}

export interface SubmissionMeta {
  kind: EnquiryKind;
  requestId: string;
  ip: string;
  userAgent: string;
  idempotencyKey: string | undefined;
}

/**
 * Bots fill every field and submit at once. Either signal drops the
 * submission silently: the bot sees the same receipt a person sees, and the
 * security log records why without recording what was submitted.
 *
 * The fill time compares the page's clock with the server's. A visitor whose
 * clock runs ahead produces a negative interval, which says nothing about
 * speed, so it is not held against them.
 */
export function spamReason(input: Pick<PublicLead, 'website' | 'formStartedAt'>, atMs: number): 'honeypot' | 'too_fast' | null {
  if (input.website && input.website.trim() !== '') return 'honeypot';
  const elapsed = atMs - input.formStartedAt;
  if (elapsed >= 0 && elapsed < PUBLIC_FORM_MIN_FILL_MS) return 'too_fast';
  return null;
}

/** When a website lead must have been called: two hours after the branch next opens (or now, if open). */
export function callbackDueAt(branch: BranchRow, atMs: number): number {
  const tz = branch.timezone;
  const today = isoDate(atMs, tz);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = addDays(today, offset);
    const hours = dayHours(branch, weekdayOf(day));
    if (hours.closed) continue;
    const opens = localClockOnDay(day, clockOf(hours.open), tz);
    const closes = hours.close >= 24 * 60 ? localClockOnDay(addDays(day, 1), '00:00', tz) : localClockOnDay(day, clockOf(hours.close), tz);
    if (atMs >= closes) continue;
    return Math.max(atMs, opens) + WEBSITE_CALLBACK_WINDOW_MS;
  }
  return atMs + WEBSITE_CALLBACK_WINDOW_MS;
}

const GOAL_LABEL: Record<string, string> = {
  get_stronger: 'Get stronger',
  lose_weight: 'Lose weight',
  get_fitter: 'Get fitter',
  classes: 'Group classes',
  sport: 'Train for a sport',
  getting_back: 'Getting back into training',
  other: 'Something else',
};
const TIME_LABEL: Record<string, string> = {
  early_morning: 'Early morning (5–8 am)',
  morning: 'Morning (8–11 am)',
  midday: 'Midday (11 am–4 pm)',
  evening: 'Evening (4–8 pm)',
  late_evening: 'Late evening (after 8 pm)',
  weekend: 'Weekends',
};
export const goalLabel = (goal: string | null): string | null => (goal ? (GOAL_LABEL[goal] ?? goal) : null);
export const preferredTimeLabel = (time: string | null): string | null => (time ? (TIME_LABEL[time] ?? time) : null);

export function submitWebsiteEnquiry(tenant: PublicTenant, input: PublicLead, meta: SubmissionMeta): PublicSubmissionReceipt {
  const atMs = now();
  const spam = spamReason(input, atMs);
  if (spam) {
    log('warn', 'security_public_form_rejected', {
      requestId: meta.requestId,
      tenantId: tenant.id,
      form: meta.kind,
      reason: spam,
    });
    return RECEIPT[meta.kind];
  }

  const branch = publicBranches(tenant.id).find((b) => b.id === input.branchId);
  if (!branch) {
    throw invalid('Choose one of our branches.', [{ path: 'branchId', code: 'custom', message: 'Choose one of our branches.' }]);
  }

  const session = input.classSessionId ? sessionQuery().where(and(eq(schema.classSessions.tenantId, tenant.id), eq(schema.classSessions.id, input.classSessionId))).get() : undefined;
  if (input.classSessionId) {
    const usable =
      session &&
      session.branchId === branch.id &&
      session.state === 'scheduled' &&
      session.startsAt > atMs &&
      session.startsAt < atMs + PUBLIC_CLASSES_MAX_DAYS * 24 * HOUR;
    if (!usable) {
      throw invalid('That class is no longer available. Pick another time.', [
        { path: 'classSessionId', code: 'custom', message: 'That class is no longer available. Pick another time.' },
      ]);
    }
    if (spotsFor(session.capacity, session.booked) === 'full') {
      throw invalid('That class is full. Pick another time.', [{ path: 'classSessionId', code: 'custom', message: 'That class is full. Pick another time.' }]);
    }
  }

  // Interest in a plan is a hint for the call, not a purchase: a plan that has
  // since been unpublished is dropped rather than refusing the whole enquiry.
  const plan = input.planId
    ? db
        .select({ id: schema.products.id, name: schema.products.name, priceMinor: schema.products.priceMinor, taxRateBp: schema.products.taxRateBp })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenant.id), eq(schema.products.id, input.planId), eq(schema.products.status, 'active'), eq(schema.products.isPublic, true)))
        .get()
    : undefined;

  const ctx = websiteContext(tenant.id, branch.id, meta.requestId, meta.ip, meta.userAgent);
  const key = meta.idempotencyKey ? `public:${tenant.id}:${meta.kind}:${meta.idempotencyKey}` : undefined;
  const { formStartedAt: _startedAt, website: _honeypot, ...fingerprint } = input;

  const outcome = runIdempotently(ctx, `public.${meta.kind}`, key, fingerprint, () =>
    transact(() => recordEnquiry({ tenant, branch, input, meta, ctx, atMs, session, plan })),
  );

  if (outcome.leadId) {
    emit({
      tenantId: tenant.id,
      branchId: outcome.branchId,
      channel: channels.branch(outcome.branchId),
      topic: 'lead.captured',
      payload: { leadId: outcome.leadId, source: 'website', trial: meta.kind === 'trial' },
    });
  }
  return RECEIPT[meta.kind];
}

interface EnquiryContext {
  tenant: PublicTenant;
  branch: BranchRow;
  input: PublicLead;
  meta: SubmissionMeta;
  ctx: RequestContext;
  atMs: number;
  session: ReturnType<ReturnType<typeof sessionQuery>['get']> | undefined;
  plan: { id: string; name: string; priceMinor: number; taxRateBp: number } | undefined;
}

/** Returns plain data only: it is stored as the idempotent replay. */
function recordEnquiry(e: EnquiryContext): { leadId: string; branchId: string; outcome: 'created' | 'existing_lead' | 'existing_member' } {
  const { tenant, branch, input, meta, ctx, atMs, session, plan } = e;
  const phoneNormalized = normalizePhone(input.phone);
  const emailNormalized = normalizeEmail(input.email);
  const tz = branch.timezone;
  const sessionLabel = session ? `${session.name}, ${isoDate(session.startsAt, tz)} at ${localTime(session.startsAt, tz)}` : null;
  const dueAt = callbackDueAt(branch, atMs);
  const nextActionLabel = meta.kind === 'trial' ? 'Call back to confirm the free trial' : 'Call back about the website enquiry';

  const trialFields =
    meta.kind === 'trial'
      ? {
          trialRequestedAt: atMs,
          trialSessionId: session?.id ?? null,
          trialPreferredTime: input.preferredTime ?? null,
          trialConfirmedSessionId: null,
          trialConfirmedAt: null,
        }
      : {};

  const summary = enquirySummary(e, sessionLabel);

  // PF-CRM edge case: a converted member submits another trial form. No second
  // member and no open duplicate: the enquiry is recorded against the lead
  // that became that member, or a won lead linked to them when they joined
  // some other way.
  const member = findMember(tenant.id, phoneNormalized, emailNormalized);
  let leadId: string;
  let outcome: 'created' | 'existing_lead' | 'existing_member';
  let leadBranchId = branch.id;

  if (member) {
    const linked = db
      .select()
      .from(schema.leads)
      .where(and(eq(schema.leads.tenantId, tenant.id), eq(schema.leads.convertedMemberId, member.id)))
      .orderBy(desc(schema.leads.createdAt))
      .get();
    outcome = 'existing_member';
    if (linked) {
      leadId = linked.id;
      leadBranchId = linked.branchId;
      db.update(schema.leads)
        .set({ ...trialFields, nextActionAt: dueAt, nextActionLabel, updatedAt: atMs })
        .where(eq(schema.leads.id, linked.id))
        .run();
    } else {
      leadId = id('lead');
      insertLead(e, { leadId, stage: 'won', convertedMemberId: member.id, phoneNormalized, emailNormalized, dueAt, nextActionLabel, trialFields });
    }
    addActivity(tenant.id, leadId, `Existing member ${member.memberNo} (${member.name}) sent the website ${meta.kind === 'trial' ? 'free-trial' : 'contact'} form. Linked to the member; no new lead or member was created.\n${summary}`, atMs);
  } else {
    const existing = findOpenOrClosedLead(tenant.id, phoneNormalized, emailNormalized);
    if (existing) {
      outcome = 'existing_lead';
      leadId = existing.id;
      leadBranchId = existing.branchId;
      const reopen = existing.stage === 'lost' || existing.stage === 'disqualified';
      db.update(schema.leads)
        .set({
          ...trialFields,
          ...(reopen ? { stage: 'reopened', lossReason: null } : {}),
          // Keep what staff already know; fill only what is missing.
          email: existing.email ?? input.email ?? null,
          emailNormalized: existing.emailNormalized ?? emailNormalized,
          goal: input.goal ?? existing.goal,
          preferredTime: input.preferredTime ?? existing.preferredTime,
          interestedProductId: plan?.id ?? existing.interestedProductId,
          nextActionAt: dueAt,
          nextActionLabel,
          updatedAt: atMs,
        })
        .where(eq(schema.leads.id, existing.id))
        .run();
      if (reopen) {
        db.insert(schema.leadActivities)
          .values({
            id: id('lac'),
            tenantId: tenant.id,
            leadId,
            kind: 'stage_change',
            body: 'Reopened: the person contacted the gym again through the website.',
            actorId: null,
            actorName: 'Website form',
            fromStage: existing.stage,
            toStage: 'reopened',
            at: atMs,
          })
          .run();
      }
      const otherBranch = existing.branchId !== branch.id ? ` They asked about ${branch.name}; the lead stays with its current branch.` : '';
      addActivity(tenant.id, leadId, `Sent the website ${meta.kind === 'trial' ? 'free-trial' : 'contact'} form again.${otherBranch}\n${summary}`, atMs);
    } else {
      outcome = 'created';
      leadId = id('lead');
      insertLead(e, { leadId, stage: 'new', convertedMemberId: null, phoneNormalized, emailNormalized, dueAt, nextActionLabel, trialFields });
      addActivity(tenant.id, leadId, `Lead captured from the website ${meta.kind === 'trial' ? 'free-trial' : 'contact'} form.\n${summary}`, atMs);
    }
  }

  for (const [purpose, granted] of [
    ['processing', true],
    ['marketing', input.consent.marketing],
  ] as const) {
    db.insert(schema.leadConsents)
      .values({
        id: id('lcn'),
        tenantId: tenant.id,
        leadId,
        purpose,
        granted,
        noticeVersion: input.consent.noticeVersion,
        source: `website:${meta.kind}`,
        requestId: meta.requestId,
        capturedAt: atMs,
      })
      .run();
  }

  audit(ctx, {
    action: meta.kind === 'trial' ? 'lead.trial_requested' : 'lead.website_enquiry',
    entityType: 'lead',
    entityId: leadId,
    entityLabel: input.name,
    branchId: leadBranchId,
    after: { outcome, source: 'website', campaign: input.utm.campaign ?? null, trialSessionId: session?.id ?? null },
  });

  return { leadId, branchId: leadBranchId, outcome };
}

function insertLead(
  e: EnquiryContext,
  values: {
    leadId: string;
    stage: 'new' | 'won';
    convertedMemberId: string | null;
    phoneNormalized: string | null;
    emailNormalized: string | null;
    dueAt: number;
    nextActionLabel: string;
    trialFields: Record<string, unknown>;
  },
): void {
  const { tenant, branch, input, atMs, plan } = e;
  const utm = input.utm;
  const hasUtm = Object.values(utm).some(Boolean);
  db.insert(schema.leads)
    .values({
      id: values.leadId,
      tenantId: tenant.id,
      branchId: branch.id,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      phoneNormalized: values.phoneNormalized,
      emailNormalized: values.emailNormalized,
      source: 'website',
      campaign: utm.campaign ?? null,
      stage: values.stage,
      ownerId: null,
      expectedValueMinor: plan ? plan.priceMinor + taxOn(plan.priceMinor, plan.taxRateBp) : 0,
      nextActionAt: values.dueAt,
      nextActionLabel: values.nextActionLabel,
      lastTouchedAt: null,
      lossReason: null,
      convertedMemberId: values.convertedMemberId,
      duplicateOfId: null,
      tags: [],
      goal: input.goal ?? null,
      preferredTime: input.preferredTime ?? null,
      interestedProductId: plan?.id ?? null,
      utm: hasUtm
        ? { source: utm.source ?? null, medium: utm.medium ?? null, campaign: utm.campaign ?? null, term: utm.term ?? null, content: utm.content ?? null }
        : null,
      referralCode: input.referralCode ?? null,
      ...values.trialFields,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
}

function addActivity(tenantId: string, leadId: string, body: string, atMs: number): void {
  db.insert(schema.leadActivities)
    .values({
      id: id('lac'),
      tenantId,
      leadId,
      kind: 'note',
      body: body.trim(),
      actorId: null,
      actorName: 'Website form',
      fromStage: null,
      toStage: null,
      at: atMs,
    })
    .run();
}

/** What staff need on the call, in the order they need it. The visitor's own words last. */
function enquirySummary(e: EnquiryContext, sessionLabel: string | null): string {
  const { input, branch, plan, meta } = e;
  const lines = [
    `Branch: ${branch.name}`,
    meta.kind === 'trial' ? `Trial: ${sessionLabel ?? preferredTimeLabel(input.preferredTime ?? null) ?? 'any time'}` : null,
    input.goal ? `Goal: ${goalLabel(input.goal)}` : null,
    meta.kind !== 'trial' && input.preferredTime ? `Best time: ${preferredTimeLabel(input.preferredTime)}` : null,
    plan ? `Interested in: ${plan.name}` : null,
    input.utm.campaign || input.utm.source ? `Campaign: ${[input.utm.source, input.utm.medium, input.utm.campaign].filter(Boolean).join(' / ')}` : null,
    input.referralCode ? `Referral code: ${input.referralCode}` : null,
    `Marketing messages: ${input.consent.marketing ? 'yes' : 'no'}`,
    input.message ? `Message: ${input.message}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function findMember(tenantId: string, phoneNormalized: string | null, emailNormalized: string | null) {
  const matches = [
    phoneNormalized ? eq(schema.members.phoneNormalized, phoneNormalized) : null,
    emailNormalized ? eq(schema.members.emailNormalized, emailNormalized) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  if (matches.length === 0) return null;
  const row = db
    .select({ id: schema.members.id, memberNo: schema.members.memberNo, firstName: schema.members.firstName, lastName: schema.members.lastName })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), or(...matches), isNull(schema.members.mergedIntoId), isNull(schema.members.deletedAt)))
    .get();
  return row ? { id: row.id, memberNo: row.memberNo, name: `${row.firstName} ${row.lastName}`.trim() } : null;
}

/**
 * PF-CRM-002: the same person is one lead. Prefers an open lead, then the most
 * recent closed one (which a new enquiry reopens). A lead that already became a
 * member is handled by the member path above, never here.
 */
function findOpenOrClosedLead(tenantId: string, phoneNormalized: string | null, emailNormalized: string | null) {
  const matches = [
    phoneNormalized ? eq(schema.leads.phoneNormalized, phoneNormalized) : null,
    emailNormalized ? eq(schema.leads.emailNormalized, emailNormalized) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  if (matches.length === 0) return null;
  const candidates = db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.tenantId, tenantId), or(...matches), isNull(schema.leads.convertedMemberId)))
    .orderBy(desc(schema.leads.createdAt))
    .all()
    .filter((lead) => lead.stage !== 'won');
  return candidates.find((lead) => lead.stage !== 'lost' && lead.stage !== 'disqualified') ?? candidates[0] ?? null;
}
