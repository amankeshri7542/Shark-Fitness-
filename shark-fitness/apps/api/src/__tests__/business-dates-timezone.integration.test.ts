import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { createInvoiceForProduct } from '../services/billing.js';
import type { RequestContext } from '../lib/context.js';
import type { Product } from '@shark/contracts';

/* ============================================================================
   Business dates are the branch's, not India's.

   `lib/branch-time.ts` exists because this exact mistake had already been made
   once: "a receipt ended up dated by UTC while the invoice it raised was dated
   by Asia/Kolkata — the same sale, two different days." The helper was added
   and fifteen call sites were not converted. Invoice issue dates, membership
   start and end dates, cancellation effective dates and freeze start dates
   were all still computed with a hard-coded `'Asia/Kolkata'`.

   For the seeded Indian tenant that is invisible. For a gym anywhere else it
   is wrong every day, and near midnight it is wrong by a whole day — which for
   an invoice date, a membership end date or a notice period is not cosmetic.

   The reproduction is deterministic rather than hopeful: two branches 26 hours
   apart (`Etc/GMT-14` at UTC+14 and `Etc/GMT+12` at UTC-12) are *never* on the
   same calendar date, so an invoice raised at each must carry a different
   `issuedOn`. Under the bug both carried Kolkata's date and were equal.
   ========================================================================= */

const TENANT = 'ten_shark';
const EAST = 'br_tz_east';
const WEST = 'br_tz_west';

const memberIds: string[] = [];
const invoiceIds: string[] = [];

const PRODUCT = {
  id: 'prd_tz_probe',
  kind: 'membership',
  name: 'Timezone probe plan',
  description: '',
  version: 1,
  priceMinor: 100_000,
  currency: 'INR',
  taxRateBp: 0,
  cadence: 'monthly',
  durationDays: 30,
} as unknown as Product;

function makeBranch(branchId: string, timezone: string): void {
  db.insert(schema.branches)
    .values({
      id: branchId,
      tenantId: TENANT,
      name: `TZ probe ${timezone}`,
      slug: branchId,
      addressLine: '1 Test Way',
      city: 'Nowhere',
      timezone,
      capacity: 10,
      opensMinutes: 0,
      closesMinutes: 24 * 60 - 1,
      state: 'active',
      amenities: [],
      holidays: [],
      phone: null,
      email: null,
      hours: null,
      policy: {},
      stateChangedAt: null,
      stateNote: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function makeMember(branchId: string): string {
  const memberId = id('mem');
  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId: TENANT,
      userId: null,
      homeBranchId: branchId,
      memberNo: `TZ-${memberId.slice(-6)}`,
      firstName: 'Timezone',
      lastName: 'Probe',
      initials: 'TP',
      email: null,
      phone: null,
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
      joinedOn: '2024-01-01',
      lastVisitAt: null,
      mergedIntoId: null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    })
    .run();
  memberIds.push(memberId);
  return memberId;
}

function ctxFor(branchId: string): RequestContext {
  return {
    requestId: `test:${id('req')}`,
    sessionId: 'test',
    authMethod: 'bearer',
    tenantId: TENANT,
    userId: 'usr_test_tz',
    memberId: null,
    staffId: null,
    role: 'owner',
    name: 'Timezone test',
    branchIds: [branchId],
    activeBranchId: branchId,
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    impersonatorId: null,
  };
}

beforeAll(() => {
  makeBranch(EAST, 'Etc/GMT-14');
  makeBranch(WEST, 'Etc/GMT+12');
});

afterAll(() => {
  if (invoiceIds.length > 0) {
    db.delete(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, invoiceIds)).run();
    db.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)).run();
  }
  if (memberIds.length > 0) {
    db.delete(schema.members).where(inArray(schema.members.id, memberIds)).run();
  }
  db.delete(schema.branches).where(inArray(schema.branches.id, [EAST, WEST])).run();
});

describe('an invoice is dated by the branch that raised it', () => {
  it('gives two branches 26 hours apart two different issue dates', () => {
    const east = makeMember(EAST);
    const west = makeMember(WEST);

    const eastInvoice = createInvoiceForProduct({
      ctx: ctxFor(EAST),
      memberId: east,
      branchId: EAST,
      product: PRODUCT,
      refType: 'test',
      refId: 'tz-east',
    });
    const westInvoice = createInvoiceForProduct({
      ctx: ctxFor(WEST),
      memberId: west,
      branchId: WEST,
      product: PRODUCT,
      refType: 'test',
      refId: 'tz-west',
    });
    invoiceIds.push(eastInvoice.invoiceId, westInvoice.invoiceId);

    const eastRow = db.select().from(schema.invoices).where(eq(schema.invoices.id, eastInvoice.invoiceId)).get()!;
    const westRow = db.select().from(schema.invoices).where(eq(schema.invoices.id, westInvoice.invoiceId)).get()!;

    // UTC+14 and UTC-12 are never on the same calendar date, so this holds
    // whatever hour the suite runs at. Under the bug both carried Kolkata's
    // date and this assertion failed.
    expect(eastRow.issuedOn).not.toBe(westRow.issuedOn);

    // And each is its own branch's date, not the server's and not India's.
    expect(eastRow.issuedOn).toBe(isoDate(now(), 'Etc/GMT-14'));
    expect(westRow.issuedOn).toBe(isoDate(now(), 'Etc/GMT+12'));

    // The due date is derived from the issue date, so it travels with it.
    expect(eastRow.dueOn).not.toBe(westRow.dueOn);
  });

  it('resolves the branch zone through the one helper that answers that question', () => {
    // Guards the fix itself: these must not drift back to a literal.
    expect(branchTimeZone(TENANT, EAST)).toBe('Etc/GMT-14');
    expect(branchTimeZone(TENANT, WEST)).toBe('Etc/GMT+12');
    // A branch that is not ours falls back to the tenant, never to a constant
    // picked at the call site.
    expect(branchTimeZone(TENANT, null)).toBe('Asia/Kolkata');
  });
});
