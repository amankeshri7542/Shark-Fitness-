import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type {
  BranchDetail,
  BranchInput,
  BranchPatch,
  BranchStateInput,
  BusinessProfile,
  BusinessProfilePatch,
  Consequence,
  ResolvedSetting,
  RoomInput,
  SetupChecklist,
  WeekHours,
} from '@shark/contracts';
import { BranchState } from '@shark/contracts';
import {
  BRANCH_POLICY_KEYS,
  BRANCH_STATES,
  assertOverridable,
  branchStateConsequences,
  canTransitionBranch,
  currencyChangeConsequences,
  nextBranchStates,
  resolvePolicy,
  setupChecklist,
  timezoneChangeConsequences,
  validateHours,
} from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';
import { requirePermission } from '../lib/context.js';

/**
 * Tenant and branch configuration (PF-TEN-001…006).
 *
 * Route files are thin adapters; every rule below lives here or in
 * `@shark/domain`.
 *
 * Four decisions shape the module.
 *
 * **A setting change is prospective or it is refused.** A gym's configuration
 * is read by invoices, doors and rosters that already happened. Changing the
 * tenant currency must not re-price a paid invoice; changing a branch timezone
 * must not move a stored instant; archiving a branch must not delete a single
 * historical row. Where a change would reach backwards, this module either
 * makes it prospective or blocks it — it never rewrites the past to agree with
 * the new answer.
 *
 * **A consequence has to be seen before it is accepted.** Anything that
 * surprises somebody answers 409 with a list of consequences, and is applied
 * only when the client echoes each `code` back in `acknowledge`. That echo is
 * the point: a client cannot acknowledge a warning it never rendered, so a
 * scripted call cannot skip the dialog a person would have read.
 *
 * **An override is a key that is present.** A branch either holds a value or
 * inherits the tenant's, and the absence of the key is what "inherited" means.
 * No `inherited` flag sits beside the value to drift out of step with it, and
 * no `null` stands in for "unset" — `false` and "not set" are different
 * answers, and collapsing them is how a door ends up open.
 *
 * **The setup checklist is counted, never stored.** A stored tick survives the
 * deletion of the thing it was ticked for, and "setup complete" over a gym
 * with no plans to sell is worse than no checklist at all.
 */

/* ——— Reading ————————————————————————————————————————————— */

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const minutes = (clockValue: string): number => {
  const [h, m] = clockValue.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function tenantRow(tenantId: string) {
  const row = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  if (!row) throw notFound('That gym');
  return row;
}

/**
 * A branch inside the caller's tenant.
 *
 * Settings deliberately reads across **every** branch of the tenant rather
 * than through `branchScope`: `settings.manage` is an owner-level permission
 * and the whole point of the screen is the estate. A branch manager does not
 * hold the permission at all, so there is no narrower caller to protect here —
 * but the tenant condition is not optional, and it is the only thing standing
 * between one gym's configuration and another's.
 */
function branchInTenant(ctx: RequestContext, branchId: string) {
  const row = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That branch');
  return row;
}

/** The settings a branch may differ on, with their labels and current source. */
const POLICY_META: Record<
  string,
  { label: string; help: string; kind: 'boolean' | 'number' | 'time'; fallback: boolean | number | string }
> = {
  graceAllowsEntry: {
    label: 'Let members in during grace',
    help: 'A member whose payment failed can still train while the grace period runs.',
    kind: 'boolean',
    fallback: false,
  },
  antiPassbackSeconds: {
    label: 'Anti-passback window',
    help: 'Seconds before the same member may scan in again. Stops one pass letting two people through.',
    kind: 'number',
    fallback: 90,
  },
  holdSeconds: {
    label: 'Booking hold',
    help: 'Seconds a seat is held while a member finishes booking it.',
    kind: 'number',
    fallback: 120,
  },
  waitlistOfferMinutes: {
    label: 'Waitlist offer window',
    help: 'Minutes the next member on the waitlist has to claim a freed seat.',
    kind: 'number',
    fallback: 15,
  },
  allowNegativeStock: {
    label: 'Sell stock you do not have',
    help: 'Off means the till refuses a sale that would take on-hand below zero.',
    kind: 'boolean',
    fallback: false,
  },
  quietHoursFrom: {
    label: 'Quiet hours start',
    help: 'Automated messages wait until quiet hours end. Read in this branch’s own timezone.',
    kind: 'time',
    fallback: '21:00',
  },
  quietHoursTo: {
    label: 'Quiet hours end',
    help: 'When automated messages may resume.',
    kind: 'time',
    fallback: '08:00',
  },
};

const TENANT_ONLY_META: Record<string, { label: string; help: string; kind: 'number'; fallback: number }> = {
  graceDays: {
    label: 'Grace period',
    help: 'Days a failed payment has before the membership lapses. One promise for the whole gym.',
    kind: 'number',
    fallback: 7,
  },
};

function resolveSettings(
  tenantPolicy: Record<string, unknown>,
  branchPolicy: Record<string, unknown> | null,
): ResolvedSetting[] {
  const out: ResolvedSetting[] = [];
  for (const key of BRANCH_POLICY_KEYS) {
    const meta = POLICY_META[key]!;
    const resolved = resolvePolicy(key, tenantPolicy, branchPolicy, meta.fallback);
    out.push({
      key,
      label: meta.label,
      help: meta.help,
      kind: meta.kind,
      value: resolved.value as boolean | number | string,
      source: resolved.source,
      tenantValue: (tenantPolicy[key] ?? meta.fallback) as boolean | number | string,
      overridable: true,
    });
  }
  for (const [key, meta] of Object.entries(TENANT_ONLY_META)) {
    const value = (tenantPolicy[key] ?? meta.fallback) as number;
    out.push({
      key,
      label: meta.label,
      help: meta.help,
      kind: meta.kind,
      value,
      source: Object.prototype.hasOwnProperty.call(tenantPolicy, key) ? 'tenant' : 'default',
      tenantValue: value,
      overridable: false,
    });
  }
  return out;
}

/** Live counts. A stale number must never be what justifies archiving a branch. */
function branchCounts(tenantId: string, branchId: string) {
  const one = <T>(v: T | undefined, fallback: T): T => v ?? fallback;
  const members = one(
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.tenantId, tenantId),
          eq(schema.members.homeBranchId, branchId),
          isNull(schema.members.deletedAt),
        ),
      )
      .get()?.n,
    0,
  );
  const grantedMembers = one(
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.memberBranches)
      .where(and(eq(schema.memberBranches.tenantId, tenantId), eq(schema.memberBranches.branchId, branchId)))
      .get()?.n,
    0,
  );
  const futureBookings = one(
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.bookings)
      .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
      .where(
        and(
          eq(schema.classSessions.tenantId, tenantId),
          eq(schema.classSessions.branchId, branchId),
          gt(schema.classSessions.startsAt, now()),
          sql`${schema.bookings.state} in ('held','confirmed')`,
        ),
      )
      .get()?.n,
    0,
  );
  const staff = db
    .select({ branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .where(and(eq(schema.staff.tenantId, tenantId), ne(schema.staff.employmentStatus, 'former')))
    .all()
    .filter((s) => s.branchIds.includes(branchId)).length;
  const openTickets = one(
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.tenantId, tenantId),
          eq(schema.tickets.branchId, branchId),
          sql`${schema.tickets.state} not in ('resolved','closed')`,
        ),
      )
      .get()?.n,
    0,
  );
  return { members, grantedMembers, futureBookings, staff, openTickets };
}

function toBranchDetail(ctx: RequestContext, row: typeof schema.branches.$inferSelect): BranchDetail {
  const tenant = tenantRow(ctx.tenantId);
  const state = row.state as BranchState;
  const rooms = db
    .select({ id: schema.rooms.id, name: schema.rooms.name, capacity: schema.rooms.capacity })
    .from(schema.rooms)
    .where(and(eq(schema.rooms.tenantId, ctx.tenantId), eq(schema.rooms.branchId, row.id)))
    .all();

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    addressLine: row.addressLine,
    city: row.city,
    timezone: row.timezone,
    capacity: row.capacity,
    opensAt: clock(row.opensMinutes),
    closesAt: clock(row.closesMinutes),
    hours: (row.hours as WeekHours | null) ?? null,
    holidays: row.holidays ?? [],
    amenities: row.amenities ?? [],
    phone: row.phone,
    email: row.email,
    state,
    stateMeaning: BRANCH_STATES[state].meaning,
    trades: BRANCH_STATES[state].trades,
    stateChangedAt: row.stateChangedAt ? new Date(row.stateChangedAt).toISOString() : null,
    stateNote: row.stateNote,
    nextStates: nextBranchStates(state),
    rooms,
    settings: resolveSettings(tenant.policy, row.policy ?? {}),
    counts: branchCounts(ctx.tenantId, row.id),
  };
}

export function businessProfile(ctx: RequestContext): BusinessProfile & { slug: string; plan: string; status: string } {
  requirePermission(ctx, 'settings.manage');
  const tenant = tenantRow(ctx.tenantId);
  return {
    slug: tenant.slug,
    plan: tenant.plan,
    status: tenant.status,
    legalName: tenant.legalName,
    displayName: tenant.displayName,
    locale: tenant.locale,
    currency: tenant.currency,
    timezone: tenant.timezone,
    unitSystem: tenant.unitSystem as 'metric',
    terminology: (tenant.branding?.terminology as unknown as Record<string, string>) ?? {},
    taxProfile: (tenant.taxProfile as BusinessProfile['taxProfile']) ?? null,
    dataProcessing: (tenant.dataProcessing as BusinessProfile['dataProcessing']) ?? null,
  };
}

export function listBranches(ctx: RequestContext): { items: BranchDetail[] } {
  requirePermission(ctx, 'settings.manage');
  const rows = db
    .select()
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, ctx.tenantId))
    .orderBy(schema.branches.name)
    .all();
  return { items: rows.map((row) => toBranchDetail(ctx, row)) };
}

export function branchDetail(ctx: RequestContext, branchId: string): BranchDetail {
  requirePermission(ctx, 'settings.manage');
  return toBranchDetail(ctx, branchInTenant(ctx, branchId));
}

export function setup(ctx: RequestContext): SetupChecklist {
  requirePermission(ctx, 'settings.manage');
  const tenant = tenantRow(ctx.tenantId);
  const branches = db.select().from(schema.branches).where(eq(schema.branches.tenantId, ctx.tenantId)).all();
  const n = (v: number | undefined): number => v ?? 0;

  const result = setupChecklist({
    branches: branches.length,
    activeBranches: branches.filter((b) => b.state === 'active').length,
    // A branch counts as "has hours" when it carries a per-day week. The
    // opens/closes pair every branch has is a default, not a decision.
    branchesWithHours: branches.filter((b) => b.hours && Object.keys(b.hours).length > 0).length,
    rooms: n(db.select({ n: sql<number>`count(*)` }).from(schema.rooms).where(eq(schema.rooms.tenantId, ctx.tenantId)).get()?.n),
    staff: n(db.select({ n: sql<number>`count(*)` }).from(schema.staff).where(eq(schema.staff.tenantId, ctx.tenantId)).get()?.n),
    products: n(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.status, 'active')))
        .get()?.n,
    ),
    hasTaxProfile: tenant.taxProfile !== null && tenant.taxProfile !== undefined,
    hasDataProcessing: tenant.dataProcessing !== null && tenant.dataProcessing !== undefined,
    members: n(db.select({ n: sql<number>`count(*)` }).from(schema.members).where(eq(schema.members.tenantId, ctx.tenantId)).get()?.n),
  });

  return { ...result, readyToOpen: result.items.every((i) => !i.blocking || i.done) };
}

/* ——— Consequences ————————————————————————————————————— */

/**
 * Refuse a change until its consequences have been seen.
 *
 * Blocking consequences cannot be acknowledged at all. Non-blocking ones are
 * cleared by echoing their `code`, which a client can only do after rendering
 * them — that is the whole mechanism, and it is why the codes are stable
 * strings rather than indexes.
 */
function gate(consequences: Consequence[], acknowledged: string[] | undefined): void {
  if (consequences.length === 0) return;
  const seen = new Set(acknowledged ?? []);
  const blocking = consequences.filter((c) => c.blocking);
  const unacknowledged = consequences.filter((c) => !c.blocking && !seen.has(c.code));
  if (blocking.length === 0 && unacknowledged.length === 0) return;

  throw conflict(
    blocking.length > 0
      ? blocking[0]!.message
      : 'This change affects records that already exist. Review what it does, then confirm.',
    { consequences: [...blocking, ...unacknowledged] },
  );
}

/* ——— Writing ————————————————————————————————————————— */

export function updateBusinessProfile(ctx: RequestContext, patch: BusinessProfilePatch): BusinessProfile & { slug: string; plan: string; status: string } {
  requirePermission(ctx, 'settings.manage');
  const tenant = tenantRow(ctx.tenantId);

  const consequences: Consequence[] = [];
  if (patch.currency && patch.currency !== tenant.currency) {
    const invoices =
      db.select({ n: sql<number>`count(*)` }).from(schema.invoices).where(eq(schema.invoices.tenantId, ctx.tenantId)).get()?.n ?? 0;
    consequences.push(...currencyChangeConsequences(tenant.currency, patch.currency, invoices));
  }
  gate(consequences, patch.acknowledge);

  const branding = { ...(tenant.branding ?? {}) } as Record<string, unknown>;
  if (patch.terminology !== undefined) branding.terminology = patch.terminology;

  const next = {
    legalName: patch.legalName ?? tenant.legalName,
    displayName: patch.displayName ?? tenant.displayName,
    locale: patch.locale ?? tenant.locale,
    currency: patch.currency ?? tenant.currency,
    timezone: patch.timezone ?? tenant.timezone,
    unitSystem: patch.unitSystem ?? tenant.unitSystem,
    taxProfile: patch.taxProfile !== undefined ? patch.taxProfile : (tenant.taxProfile as never),
    dataProcessing: patch.dataProcessing !== undefined ? patch.dataProcessing : (tenant.dataProcessing as never),
  };

  transact(() => {
    db.update(schema.tenants)
      .set({ ...next, branding: branding as never, updatedAt: now() })
      .where(eq(schema.tenants.id, ctx.tenantId))
      .run();
    audit(ctx, {
      action: 'tenant.updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      entityLabel: next.displayName,
      before: {
        legalName: tenant.legalName, displayName: tenant.displayName, currency: tenant.currency,
        timezone: tenant.timezone, locale: tenant.locale, unitSystem: tenant.unitSystem,
        taxProfile: tenant.taxProfile ?? null, dataProcessing: tenant.dataProcessing ?? null,
      },
      after: next as unknown as Record<string, unknown>,
    });
  });

  return businessProfile(ctx);
}

export function createBranch(ctx: RequestContext, input: BranchInput): BranchDetail {
  requirePermission(ctx, 'settings.manage');
  assertTimezone(input.timezone);
  if (minutes(input.closesAt) <= minutes(input.opensAt)) {
    throw invalid('A branch closes after it opens. For a site that trades past midnight, close at 24:00.');
  }

  const clash = db
    .select({ id: schema.branches.id })
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, ctx.tenantId), eq(schema.branches.slug, input.slug)))
    .get();
  if (clash) throw conflict('Another branch already uses that short name.');

  const branchId = id('brn');
  const atMs = now();

  transact(() => {
    db.insert(schema.branches)
      .values({
        id: branchId,
        tenantId: ctx.tenantId,
        name: input.name,
        slug: input.slug,
        addressLine: input.addressLine,
        city: input.city,
        timezone: input.timezone,
        capacity: input.capacity,
        opensMinutes: minutes(input.opensAt),
        closesMinutes: minutes(input.closesAt),
        // New branches start as drafts. A branch that takes bookings the
        // instant it is typed in is a branch nobody checked.
        state: 'draft',
        amenities: input.amenities ?? [],
        holidays: [],
        phone: input.phone ?? null,
        email: input.email ?? null,
        hours: null,
        policy: {},
        stateChangedAt: atMs,
        stateNote: 'Created',
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    audit(ctx, {
      action: 'branch.created',
      entityType: 'branch',
      entityId: branchId,
      entityLabel: input.name,
      branchId,
      after: { name: input.name, city: input.city, timezone: input.timezone, state: 'draft' },
    });
  });

  return branchDetail(ctx, branchId);
}

export function updateBranch(ctx: RequestContext, branchId: string, patch: BranchPatch): BranchDetail {
  requirePermission(ctx, 'settings.manage');
  const branch = branchInTenant(ctx, branchId);

  if (patch.timezone) assertTimezone(patch.timezone);
  if (patch.hours) {
    const outcome = validateHours(patch.hours as never);
    if (!outcome.ok) throw invalid(outcome.message);
  }
  if (patch.policy) {
    const outcome = assertOverridable(Object.keys(patch.policy));
    if (!outcome.ok) throw invalid(outcome.message);
  }

  const opensAt = patch.opensAt ? minutes(patch.opensAt) : branch.opensMinutes;
  const closesAt = patch.closesAt ? minutes(patch.closesAt) : branch.closesMinutes;
  if (closesAt <= opensAt) {
    throw invalid('A branch closes after it opens. For a site that trades past midnight, close at 24:00.');
  }

  if (patch.slug && patch.slug !== branch.slug) {
    const clash = db
      .select({ id: schema.branches.id })
      .from(schema.branches)
      .where(
        and(
          eq(schema.branches.tenantId, ctx.tenantId),
          eq(schema.branches.slug, patch.slug),
          ne(schema.branches.id, branchId),
        ),
      )
      .get();
    if (clash) throw conflict('Another branch already uses that short name.');
  }

  const consequences: Consequence[] = [];
  if (patch.timezone && patch.timezone !== branch.timezone) {
    consequences.push(
      ...timezoneChangeConsequences(branch.timezone, patch.timezone, branchCounts(ctx.tenantId, branchId).futureBookings),
    );
  }
  gate(consequences, patch.acknowledge);

  // An override of `null` removes the key and re-inherits. Storing null would
  // make "explicitly off" and "not set" the same value.
  const nextPolicy: Record<string, unknown> = { ...(branch.policy ?? {}) };
  for (const [key, value] of Object.entries(patch.policy ?? {})) {
    if (value === null) delete nextPolicy[key];
    else nextPolicy[key] = value;
  }

  const after = {
    name: patch.name ?? branch.name,
    slug: patch.slug ?? branch.slug,
    addressLine: patch.addressLine ?? branch.addressLine,
    city: patch.city ?? branch.city,
    timezone: patch.timezone ?? branch.timezone,
    capacity: patch.capacity ?? branch.capacity,
    opensMinutes: opensAt,
    closesMinutes: closesAt,
    phone: patch.phone !== undefined ? patch.phone : branch.phone,
    email: patch.email !== undefined ? patch.email : branch.email,
    amenities: patch.amenities ?? branch.amenities,
    holidays: patch.holidays ?? branch.holidays,
    hours: patch.hours !== undefined ? (patch.hours as never) : branch.hours,
    policy: nextPolicy as never,
  };

  transact(() => {
    db.update(schema.branches)
      .set({ ...after, updatedAt: now() })
      .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
      .run();
    audit(ctx, {
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      entityLabel: after.name,
      branchId,
      before: {
        name: branch.name, timezone: branch.timezone, capacity: branch.capacity,
        opensMinutes: branch.opensMinutes, closesMinutes: branch.closesMinutes,
        hours: branch.hours ?? null, policy: branch.policy ?? {}, holidays: branch.holidays,
      },
      after: after as unknown as Record<string, unknown>,
    });
  });

  return branchDetail(ctx, branchId);
}

export function changeBranchState(ctx: RequestContext, branchId: string, input: BranchStateInput): BranchDetail {
  requirePermission(ctx, 'settings.manage');
  const branch = branchInTenant(ctx, branchId);
  const from = branch.state as BranchState;

  const transition = canTransitionBranch(from, input.state);
  if (!transition.ok) throw precondition(transition.message);

  const counts = branchCounts(ctx.tenantId, branchId);
  gate(
    branchStateConsequences(input.state, {
      futureBookings: counts.futureBookings,
      // `members` is the branch's roster; the rule cares specifically about
      // members who would be left pointing at a branch no picker offers.
      homeMembers: counts.members,
      grantedMembers: counts.grantedMembers,
      openTickets: counts.openTickets,
    }),
    input.acknowledge,
  );

  transact(() => {
    db.update(schema.branches)
      .set({ state: input.state, stateChangedAt: now(), stateNote: input.note, updatedAt: now() })
      .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
      .run();
    audit(ctx, {
      action: `branch.${input.state}`,
      entityType: 'branch',
      entityId: branchId,
      entityLabel: branch.name,
      branchId,
      reason: input.note,
      before: { state: from },
      after: { state: input.state, futureBookings: counts.futureBookings, homeMembers: counts.members },
    });
  });

  return branchDetail(ctx, branchId);
}

/* ——— Rooms ——————————————————————————————————————————— */

export function createRoom(ctx: RequestContext, branchId: string, input: RoomInput) {
  requirePermission(ctx, 'settings.manage');
  branchInTenant(ctx, branchId);
  const roomId = id('rom');
  transact(() => {
    db.insert(schema.rooms)
      .values({ id: roomId, tenantId: ctx.tenantId, branchId, name: input.name, capacity: input.capacity })
      .run();
    audit(ctx, {
      action: 'room.created', entityType: 'room', entityId: roomId, entityLabel: input.name, branchId,
      after: { name: input.name, capacity: input.capacity },
    });
  });
  return { room: { id: roomId, name: input.name, capacity: input.capacity } };
}

export function deleteRoom(ctx: RequestContext, roomId: string) {
  requirePermission(ctx, 'settings.manage');
  const room = db
    .select()
    .from(schema.rooms)
    .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.tenantId, ctx.tenantId)))
    .get();
  if (!room) throw notFound('That room');

  // A room named on a session that has already run is part of that session's
  // record. Removing it would leave the timetable pointing at nothing, so a
  // room in use is kept and the operator is told why.
  const used =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.tenantId, ctx.tenantId), eq(schema.classSessions.roomId, roomId)))
      .get()?.n ?? 0;
  if (used > 0) {
    throw precondition(
      `${used} ${used === 1 ? 'class has' : 'classes have'} been scheduled in this room. Rename it instead — removing it would leave those classes pointing at a room that no longer exists.`,
    );
  }

  transact(() => {
    db.delete(schema.rooms).where(eq(schema.rooms.id, roomId)).run();
    audit(ctx, {
      action: 'room.deleted', entityType: 'room', entityId: roomId, entityLabel: room.name,
      branchId: room.branchId, before: { name: room.name, capacity: room.capacity },
    });
  });
  return { ok: true };
}

/* ——— Helpers ————————————————————————————————————————— */

/**
 * Reject a timezone the runtime cannot resolve.
 *
 * `Intl` is the authority rather than a hard-coded list: a list goes stale the
 * next time a country changes its rules, and a branch stored with a zone the
 * server cannot resolve makes every date on that branch throw at read time.
 */
function assertTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw invalid(`${zone} is not a timezone this system knows. Use an IANA name such as Asia/Kolkata.`);
  }
}

/**
 * Zones this tenant already stores, so a picker can always offer a branch its
 * own current value. See the route note: Node's ICU reports legacy names for
 * several zones and would otherwise omit the one the row is saved under.
 */
export function inUseTimezones(tenantId: string): string[] {
  const tenant = db.select({ timezone: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  const branches = db
    .select({ timezone: schema.branches.timezone })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, tenantId))
    .all();
  return [...new Set([tenant?.timezone, ...branches.map((b) => b.timezone)].filter((z): z is string => Boolean(z)))];
}
