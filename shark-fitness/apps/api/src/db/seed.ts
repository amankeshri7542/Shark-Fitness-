/**
 * Demo tenant seed.
 *
 * Deterministic: the same `pnpm db:reset` always builds the same gym, so a
 * screenshot, a test and a bug report all describe the same data. The shape is
 * deliberately awkward in places — a member in grace with a failed payment, a
 * class that is full, a lead past its SLA, an overdue service — because empty
 * happy-path data hides exactly the states the PRD asks us to build.
 */

import { sql } from 'drizzle-orm';
import type { AccessRules, CancellationPolicy, FreezeRules, Product } from '@shark/contracts';
import {
  computeStreak,
  estimate1rm,
  levelFor,
  retentionRisk,
  sessionVolumeKg,
  totalsFor,
  XP_AWARDS,
} from '@shark/domain';
import { db, schema, sqlite } from './client.js';
import { hashPassword } from '../lib/crypto.js';
import { id, initialsOf, normalizeEmail, normalizePhone, referralCode, token } from '../lib/ids.js';
import { DAY, HOUR, MINUTE, addDays, daysBetween, isoDate, startOfWeek } from '../lib/time.js';
import { EXERCISES } from './seed/exercises.js';
import { makeRandom } from './seed/random.js';
import {
  ACHIEVEMENTS_SEED,
  CLASS_TYPES,
  EQUIPMENT_SEED,
  MEDIA_SEED,
  MEMBER_NAMES,
  RETAIL,
  STAFF_SEED,
} from './seed/people.js';

const rng = makeRandom();
const TZ = 'Asia/Kolkata';
const NOW = Date.now();
const TODAY = isoDate(NOW, TZ);

/** Wipe in reverse dependency order so a reseed is clean. */
function wipe(): void {
  const tables = [
    'media_progress', 'media_assets', 'live_sessions', 'usage_meters',
    'messages', 'conversations', 'tickets',
    'reactions', 'comments', 'content_reports', 'blocks', 'posts',
    'challenge_participants', 'challenges', 'referrals', 'member_achievements', 'achievements',
    'streaks', 'xp_ledger',
    'weekly_check_ins', 'nutrition_targets', 'daily_metrics', 'habit_logs', 'habits',
    'progress_photos', 'assessments', 'goals', 'measurements',
    'adaptive_decisions', 'personal_records', 'workout_sets', 'workouts',
    'assignment_overrides', 'assignments', 'program_items', 'program_days', 'programs', 'exercises',
    'facility_tasks', 'work_orders', 'equipment',
    'pos_order_lines', 'pos_orders', 'stock_ledger', 'retail_products',
    'appointments', 'waitlist_entries', 'bookings', 'class_sessions', 'rooms', 'class_types',
    'used_access_windows', 'check_ins', 'access_tokens',
    'dunning_attempts', 'provider_events', 'refunds', 'payments', 'invoice_lines', 'invoices',
    'commission_lines', 'commission_rates', 'shifts', 'staff', 'lead_activities', 'leads',
    'credits', 'membership_events', 'memberships', 'products',
    'member_branches', 'members',
    'metric_rollups', 'automations', 'message_templates', 'notifications',
    'idempotency_keys', 'outbox_events', 'audit_log', 'consents', 'otp_challenges', 'sessions', 'users',
    'branches', 'tenants',
  ];
  sqlite.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) {
    try {
      sqlite.exec(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist on a partial schema */
    }
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
}

console.log('seeding…');
wipe();

/* ============================================================================
   Tenant and branches
   ========================================================================= */

const tenantId = 'ten_shark';

db.insert(schema.tenants)
  .values({
    id: tenantId,
    slug: 'shark',
    legalName: 'Shark Fitness Clubs Private Limited',
    displayName: 'Shark Fitness',
    plan: 'growth',
    locale: 'en-IN',
    currency: 'INR',
    timezone: TZ,
    unitSystem: 'metric',
    status: 'active',
    featureFlags: {
      classes: true,
      community: true,
      challenges: true,
      nutrition: true,
      liveVideo: false,
      whatsapp: false,
      sms: true,
      pos: true,
      adaptiveTraining: true,
    },
    quotas: { smsPerMonth: 2000, videoMinutesPerMonth: 0, aiCallsPerMonth: 500, storageMb: 5000 },
    branding: { accent: '#46c8dd', wordmark: 'SHARK' },
    policy: {
      graceDays: 7,
      graceAllowsEntry: false,
      antiPassbackSeconds: 90,
      quietHoursFrom: '21:00',
      quietHoursTo: '08:00',
      waitlistOfferMinutes: 15,
      holdSeconds: 120,
    },
    createdAt: NOW - 900 * DAY,
    updatedAt: NOW,
  })
  .run();

const BRANCHES = [
  { id: 'br_kor', name: 'Koramangala Depot', slug: 'koramangala', address: '80 Feet Road, 5th Block', capacity: 120 },
  { id: 'br_ind', name: 'Indiranagar Reef', slug: 'indiranagar', address: '12th Main, HAL 2nd Stage', capacity: 90 },
  { id: 'br_hsr', name: 'HSR Trench', slug: 'hsr', address: '27th Main, Sector 2', capacity: 75 },
];

for (const b of BRANCHES) {
  db.insert(schema.branches)
    .values({
      id: b.id,
      tenantId,
      name: b.name,
      slug: b.slug,
      addressLine: b.address,
      city: 'Bengaluru',
      timezone: TZ,
      capacity: b.capacity,
      opensMinutes: 5 * 60,
      closesMinutes: 23 * 60,
      state: 'active',
      amenities: ['Showers', 'Lockers', 'Parking', 'Cafe', b.id === 'br_ind' ? 'Pool' : 'Sauna'],
      holidays: ['2026-08-15', '2026-10-02'],
      phone: '+91 80 4000 1000',
      createdAt: NOW - 900 * DAY,
      updatedAt: NOW,
    })
    .run();
}

/* ============================================================================
   Staff
   ========================================================================= */

const staffByEmail = new Map<string, { userId: string; staffId: string; name: string }>();

for (const s of STAFF_SEED) {
  const userId = id('usr');
  const staffId = id('stf');
  db.insert(schema.users)
    .values({
      id: userId,
      tenantId,
      email: s.email,
      phone: `+91 98${rng.int(10000000, 99999999)}`,
      name: s.name,
      initials: initialsOf(s.name),
      role: s.role,
      accountState: 'active',
      // Every demo staff account: shark1234
      passwordHash: hashPassword('shark1234'),
      preferences: { register: 'plain', theme: 'dark', unitSystem: 'metric', haptics: true },
      lastSeenAt: NOW - rng.int(1, 300) * MINUTE,
      createdAt: NOW - 800 * DAY,
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.staff)
    .values({
      id: staffId,
      tenantId,
      userId,
      employmentStatus: 'active',
      branchIds: s.role === 'branch_manager' || s.role === 'reception' ? ['br_kor'] : BRANCHES.map((b) => b.id),
      specialties: [...s.specialties],
      certifications:
        s.role === 'trainer'
          ? [
              { name: 'NASM-CPT', expiresOn: '2027-04-30' },
              { name: 'First aid & CPR', expiresOn: s.name === 'Nikhil Rao' ? '2026-09-15' : '2027-11-02' },
            ]
          : [],
      commissionRules:
        s.role === 'trainer'
          ? [{ kind: 'session', ratePct: 40 }, { kind: 'package', ratePct: 12 }]
          : s.role === 'reception'
            ? [{ kind: 'sale', ratePct: 5 }]
            : [],
      hourlyRateMinor: s.role === 'trainer' ? 90_000 : null,
      joinedOn: addDays(TODAY, -rng.int(200, 800)),
      createdAt: NOW - 800 * DAY,
      updatedAt: NOW,
    })
    .run();

  staffByEmail.set(s.email, { userId, staffId, name: s.name });
}

const coachRehan = staffByEmail.get('rehan@sharkfitness.in')!;
const coachNikhil = staffByEmail.get('nikhil@sharkfitness.in')!;
const coachPriya = staffByEmail.get('priya@sharkfitness.in')!;
const reception = staffByEmail.get('reception@sharkfitness.in')!;
const owner = staffByEmail.get('owner@sharkfitness.in')!;
const TRAINERS = [coachRehan, coachNikhil, coachPriya];

db.insert(schema.commissionRates)
  .values([
    { id: id('cmr'), tenantId, kind: 'session', ratePct: 40, version: 'v2', effectiveFrom: '2026-01-01' },
    { id: id('cmr'), tenantId, kind: 'package', ratePct: 12, version: 'v2', effectiveFrom: '2026-01-01' },
    { id: id('cmr'), tenantId, kind: 'sale', ratePct: 5, version: 'v2', effectiveFrom: '2026-01-01' },
  ])
  .run();

/* ============================================================================
   Catalogue
   ========================================================================= */

const allBranchAccess = (over: Partial<AccessRules> = {}): AccessRules => ({
  allBranches: true,
  branchIds: BRANCHES.map((b) => b.id),
  windowStartMin: null,
  windowEndMin: null,
  visitsPerWeek: null,
  guestPassesPerMonth: 2,
  classPriorityTier: 1,
  bookingWindowHours: 168,
  ...over,
});

const freeze = (over: Partial<FreezeRules> = {}): FreezeRules => ({
  allowed: true,
  maxDaysPerTerm: 30,
  minDaysPerFreeze: 7,
  extendsExpiry: true,
  feeMinor: 0,
  ...over,
});

const cancellation = (over: Partial<CancellationPolicy> = {}): CancellationPolicy => ({
  noticeDays: 30,
  commitmentMonths: 0,
  earlyExitFeeMinor: 0,
  refundable: false,
  description: 'Cancel any time with 30 days notice. The remaining term stays usable.',
  ...over,
});

interface ProductSeed {
  id: string;
  kind: Product['kind'];
  name: string;
  description: string;
  price: number;
  cadence: Product['cadence'];
  durationDays: number | null;
  credits: number | null;
  creditsExpireDays: number | null;
  access: AccessRules;
  freeze: FreezeRules;
  cancellation: CancellationPolicy;
}

const PRODUCTS: ProductSeed[] = [
  {
    id: 'prd_elite_annual',
    kind: 'membership',
    name: 'Elite Annual',
    description: 'Every branch, every class included, priority booking, two guest passes a month.',
    price: 2_499_00,
    cadence: 'annual',
    durationDays: 365,
    credits: null,
    creditsExpireDays: null,
    access: allBranchAccess({ classPriorityTier: 3, guestPassesPerMonth: 2, bookingWindowHours: 336 }),
    freeze: freeze({ maxDaysPerTerm: 60 }),
    cancellation: cancellation({ commitmentMonths: 12, earlyExitFeeMinor: 500_00 }),
  },
  {
    id: 'prd_monthly',
    kind: 'membership',
    name: 'Depot Monthly',
    description: 'Your home branch, gym floor access, classes charged separately.',
    price: 299_900,
    cadence: 'monthly',
    durationDays: 30,
    credits: null,
    creditsExpireDays: null,
    access: allBranchAccess({ allBranches: false, branchIds: ['br_kor'], classPriorityTier: 1, guestPassesPerMonth: 0 }),
    freeze: freeze({ maxDaysPerTerm: 14 }),
    cancellation: cancellation({ noticeDays: 7 }),
  },
  {
    id: 'prd_offpeak',
    kind: 'membership',
    name: 'Off-Peak Monthly',
    description: 'Weekdays between 10am and 4pm. The quiet floor, at a quiet price.',
    price: 199_900,
    cadence: 'monthly',
    durationDays: 30,
    credits: null,
    creditsExpireDays: null,
    access: allBranchAccess({
      allBranches: false,
      branchIds: ['br_kor', 'br_hsr'],
      windowStartMin: 10 * 60,
      windowEndMin: 16 * 60,
      classPriorityTier: 1,
      guestPassesPerMonth: 0,
    }),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ noticeDays: 7 }),
  },
  {
    id: 'prd_class_10',
    kind: 'class_pack',
    name: 'Class Pack — 10',
    description: 'Ten class credits, good for six months across any branch.',
    price: 599_900,
    cadence: 'one_time',
    durationDays: 180,
    credits: 10,
    creditsExpireDays: 180,
    access: allBranchAccess({ classPriorityTier: 2 }),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ noticeDays: 0, description: 'Unused credits are refundable within 14 days.', refundable: true }),
  },
  {
    id: 'prd_pt_10',
    kind: 'pt_credits',
    name: 'Personal Training — 10 sessions',
    description: 'Ten one-to-one sessions with your assigned coach.',
    price: 2_200_00,
    cadence: 'one_time',
    durationDays: 120,
    credits: 10,
    creditsExpireDays: 120,
    access: allBranchAccess(),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ description: 'Unused sessions are refundable, less any already delivered.', refundable: true }),
  },
  {
    id: 'prd_trial',
    kind: 'trial',
    name: '7-Day Trial',
    description: 'A week on the floor, one class included.',
    price: 0,
    cadence: 'one_time',
    durationDays: 7,
    credits: 1,
    creditsExpireDays: 7,
    access: allBranchAccess({ allBranches: false, branchIds: ['br_kor'], guestPassesPerMonth: 0, bookingWindowHours: 48 }),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ noticeDays: 0, description: 'Ends automatically after seven days.' }),
  },
  {
    id: 'prd_daypass',
    kind: 'day_pass',
    name: 'Day Pass',
    description: 'One visit, any branch.',
    price: 79_900,
    cadence: 'one_time',
    durationDays: 1,
    credits: null,
    creditsExpireDays: null,
    access: allBranchAccess({ guestPassesPerMonth: 0, bookingWindowHours: 24 }),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ noticeDays: 0, description: 'Valid on the day of purchase.' }),
  },
  {
    id: 'prd_digital',
    kind: 'digital',
    name: 'Digital Only',
    description: 'Programming, tracking and the on-demand library. No floor access.',
    price: 99_900,
    cadence: 'monthly',
    durationDays: 30,
    credits: null,
    creditsExpireDays: null,
    access: allBranchAccess({ allBranches: false, branchIds: [], guestPassesPerMonth: 0 }),
    freeze: freeze({ allowed: false, maxDaysPerTerm: 0 }),
    cancellation: cancellation({ noticeDays: 0 }),
  },
];

const productRows = new Map<string, Product>();

for (const p of PRODUCTS) {
  const row: Product = {
    id: p.id,
    kind: p.kind,
    name: p.name,
    description: p.description,
    version: 1,
    priceMinor: p.price,
    currency: 'INR',
    taxRateBp: 1800,
    cadence: p.cadence,
    durationDays: p.durationDays,
    credits: p.credits,
    creditsExpireDays: p.creditsExpireDays,
    access: p.access,
    freeze: p.freeze,
    cancellation: p.cancellation,
    eligibility: { minAge: 16, maxAge: null, corporateOnly: false, requiresApproval: false },
    status: 'active',
    branchIds: p.access.branchIds,
  };
  productRows.set(p.id, row);

  db.insert(schema.products)
    .values({
      id: p.id,
      tenantId,
      kind: p.kind,
      name: p.name,
      description: p.description,
      version: 1,
      priceMinor: p.price,
      currency: 'INR',
      taxRateBp: 1800,
      cadence: p.cadence,
      durationDays: p.durationDays,
      credits: p.credits,
      creditsExpireDays: p.creditsExpireDays,
      access: p.access,
      freeze: p.freeze,
      cancellation: p.cancellation,
      eligibility: row.eligibility,
      branchIds: p.access.branchIds,
      status: 'active',
      createdAt: NOW - 700 * DAY,
      updatedAt: NOW - 40 * DAY,
    })
    .run();
}

/* ============================================================================
   Exercises
   ========================================================================= */

const exerciseIdBySlug = new Map<string, string>();
for (const ex of EXERCISES) exerciseIdBySlug.set(ex.slug, `exr_${ex.slug.replace(/-/g, '_')}`);

for (const ex of EXERCISES) {
  db.insert(schema.exercises)
    .values({
      id: exerciseIdBySlug.get(ex.slug)!,
      tenantId: null,
      slug: ex.slug,
      name: ex.name,
      aliases: ex.aliases,
      equipment: ex.equipment,
      primaryMuscles: ex.primary,
      secondaryMuscles: ex.secondary,
      difficulty: ex.difficulty,
      instructions: ex.instructions,
      cues: ex.cues,
      contraindications: ex.contraindications,
      substitutionIds: ex.subs.map((s) => exerciseIdBySlug.get(s)!).filter(Boolean),
      isUnilateral: ex.isUnilateral,
      usesBarbell: ex.usesBarbell,
      defaultRestSec: ex.restSec,
      loadStepKg: ex.stepKg,
      mediaUrl: null,
      archived: false,
    })
    .run();
}

console.log(`  ${EXERCISES.length} exercises`);

/* ============================================================================
   Members
   ========================================================================= */

interface SeededMember {
  memberId: string;
  userId: string;
  name: string;
  firstName: string;
  branchId: string;
  trainerId: string | null;
  lifecycle: string;
  membershipState: string;
  productId: string;
  joinedOn: string;
  endsOn: string;
  isDemo: boolean;
}

const membersSeeded: SeededMember[] = [];

/** The demo account. Matches the prototype: Aman M · SF-40219. */
const DEMO = {
  first: 'Aman',
  last: 'Mehra',
  memberNo: 'SF-40219',
  email: 'aman@sharkfitness.in',
};

function seedMember(args: {
  firstName: string;
  lastName: string;
  memberNo: string;
  branchId: string;
  productId: string;
  membershipState: string;
  lifecycle: string;
  joinedDaysAgo: number;
  trainerId: string | null;
  email?: string;
  isDemo?: boolean;
}): SeededMember {
  const userId = id('usr');
  const memberId = id('mbr');
  const name = `${args.firstName} ${args.lastName}`;
  const email = args.email ?? `${args.firstName.toLowerCase()}.${args.lastName.toLowerCase()}@example.com`;
  const phone = `+91 9${rng.int(100000000, 899999999)}`;
  const joinedOn = addDays(TODAY, -args.joinedDaysAgo);
  const product = productRows.get(args.productId)!;
  // An entitled member's term has to end in the *future*, so the current period
  // is rolled forward from the join date rather than taken as the first one. A
  // member who joined 420 days ago on an annual plan has renewed since; dating
  // their membership from the first term leaves it `active` with an end date in
  // the past, and every screen that reads the term — the home banner above all
  // — then tells a paying member their membership has ended.
  const durationDays = product.durationDays ?? 365;
  const termsElapsed = Math.floor(Math.max(0, daysBetween(joinedOn, TODAY)) / durationDays) + 1;
  const endsOn =
    args.membershipState === 'grace'
      ? addDays(TODAY, -4)
      : args.membershipState === 'expired'
        ? addDays(TODAY, -40)
        : addDays(joinedOn, durationDays * termsElapsed);

  db.insert(schema.users)
    .values({
      id: userId,
      tenantId,
      email: normalizeEmail(email),
      phone,
      name,
      initials: initialsOf(name),
      role: 'member',
      accountState: 'active',
      passwordHash: args.isDemo ? hashPassword('shark1234') : null,
      preferences: {
        register: 'predator',
        theme: 'dark',
        unitSystem: 'metric',
        haptics: true,
        reducedMotion: false,
      },
      lastSeenAt: NOW - rng.int(5, 4000) * MINUTE,
      createdAt: NOW - args.joinedDaysAgo * DAY,
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId,
      userId,
      homeBranchId: args.branchId,
      memberNo: args.memberNo,
      firstName: args.firstName,
      lastName: args.lastName,
      initials: initialsOf(name),
      email: normalizeEmail(email),
      phone,
      phoneNormalized: normalizePhone(phone),
      emailNormalized: normalizeEmail(email),
      dob: `19${rng.int(85, 99)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      gender: rng.pick(['female', 'male', 'unspecified']),
      addressLine: `${rng.int(1, 200)}, ${rng.pick(['5th Block', '12th Main', 'Sector 2', '7th Cross'])}, Bengaluru`,
      emergencyContact: { name: 'Emergency contact', phone: `+91 9${rng.int(100000000, 899999999)}`, relationship: rng.pick(['Spouse', 'Parent', 'Sibling', 'Friend']) },
      lifecycle: args.lifecycle,
      tags: rng.chance(0.3) ? [rng.pick(['corporate', 'referred', 'early-bird', 'pt-client'])] : [],
      trainerId: args.trainerId,
      guardianId: null,
      corporateSponsorId: null,
      memberNotes: null,
      staffNotes: rng.chance(0.2) ? 'Prefers a call over a message.' : null,
      riskScore: null,
      riskReasons: null,
      joinedOn,
      lastVisitAt: null,
      mergedIntoId: null,
      version: 1,
      createdAt: NOW - args.joinedDaysAgo * DAY,
      updatedAt: NOW,
    })
    .run();

  if (product.access.allBranches) {
    for (const b of BRANCHES) {
      if (b.id === args.branchId) continue;
      db.insert(schema.memberBranches).values({ memberId, branchId: b.id, tenantId }).run();
    }
  }

  const membershipId = id('msh');
  db.insert(schema.memberships)
    .values({
      id: membershipId,
      tenantId,
      memberId,
      productId: args.productId,
      productName: product.name,
      productSnapshot: product,
      state: args.membershipState,
      startedOn: joinedOn,
      endsOn,
      autoRenew: args.membershipState !== 'grace' && rng.chance(0.8),
      priceMinor: product.priceMinor,
      currency: 'INR',
      freezeDaysUsed: 0,
      freezeStartedOn: null,
      graceEndsOn: args.membershipState === 'grace' ? addDays(TODAY, 3) : null,
      cancelEffectiveOn: null,
      previousMembershipId: null,
      version: 1,
      createdAt: NOW - args.joinedDaysAgo * DAY,
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.membershipEvents)
    .values({
      id: id('mev'),
      tenantId,
      membershipId,
      fromState: 'pending_payment',
      toState: 'active',
      reason: 'Payment received',
      actorId: null,
      actorName: 'System',
      source: 'provider',
      effectiveAt: NOW - args.joinedDaysAgo * DAY,
    })
    .run();

  if (args.membershipState === 'grace') {
    db.insert(schema.membershipEvents)
      .values({
        id: id('mev'),
        tenantId,
        membershipId,
        fromState: 'active',
        toState: 'grace',
        reason: 'Renewal payment failed',
        actorId: null,
        actorName: 'System',
        source: 'system',
        effectiveAt: NOW - 4 * DAY,
      })
      .run();
  }

  const seeded: SeededMember = {
    memberId,
    userId,
    name,
    firstName: args.firstName,
    branchId: args.branchId,
    trainerId: args.trainerId,
    lifecycle: args.lifecycle,
    membershipState: args.membershipState,
    productId: args.productId,
    joinedOn,
    endsOn,
    isDemo: args.isDemo ?? false,
  };
  membersSeeded.push(seeded);
  return seeded;
}

const demoMember = seedMember({
  firstName: DEMO.first,
  lastName: DEMO.last,
  memberNo: DEMO.memberNo,
  branchId: 'br_kor',
  productId: 'prd_elite_annual',
  membershipState: 'active',
  lifecycle: 'active',
  joinedDaysAgo: 420,
  trainerId: coachRehan.staffId,
  email: DEMO.email,
  isDemo: true,
});

/** A second demo login that lands on a denial, so the grace/outstanding path
 *  is walkable without editing data by hand. */
const graceMember = seedMember({
  firstName: 'Rohit',
  lastName: 'Bhaskar',
  memberNo: 'SF-40188',
  branchId: 'br_kor',
  productId: 'prd_monthly',
  membershipState: 'grace',
  lifecycle: 'grace',
  joinedDaysAgo: 210,
  trainerId: coachNikhil.staffId,
  email: 'rohit@sharkfitness.in',
  isDemo: true,
});

const STATE_MIX: Array<{ state: string; lifecycle: string; weight: number }> = [
  { state: 'active', lifecycle: 'active', weight: 30 },
  { state: 'active', lifecycle: 'trial', weight: 3 },
  { state: 'frozen', lifecycle: 'frozen', weight: 2 },
  { state: 'grace', lifecycle: 'grace', weight: 2 },
  { state: 'expired', lifecycle: 'expired', weight: 3 },
];

const weighted = STATE_MIX.flatMap((s) => Array<typeof s>(s.weight).fill(s));

MEMBER_NAMES.forEach(([first, last], index) => {
  if (last === 'Bhaskar') return; // already seeded as the grace demo
  const mix = weighted[index % weighted.length]!;
  const productId =
    mix.lifecycle === 'trial'
      ? 'prd_trial'
      : rng.pick(['prd_elite_annual', 'prd_monthly', 'prd_monthly', 'prd_offpeak', 'prd_digital']);
  seedMember({
    firstName: first,
    lastName: last,
    memberNo: `SF-${40220 + index}`,
    branchId: rng.pick(['br_kor', 'br_kor', 'br_ind', 'br_hsr']),
    productId,
    membershipState: mix.state,
    lifecycle: mix.lifecycle,
    joinedDaysAgo: rng.int(12, 700),
    trainerId: rng.chance(0.45) ? rng.pick(TRAINERS).staffId : null,
  });
});

console.log(`  ${membersSeeded.length} members`);

/* ============================================================================
   Credits
   ========================================================================= */

for (const m of membersSeeded) {
  const product = productRows.get(m.productId)!;
  if (product.credits) {
    db.insert(schema.credits)
      .values({
        id: id('crd'),
        tenantId,
        memberId: m.memberId,
        kind: product.kind === 'pt_credits' ? 'pt' : 'class',
        delta: product.credits,
        reason: `Purchased ${product.name}`,
        refType: 'product',
        refId: product.id,
        expiresOn: addDays(m.joinedOn, product.creditsExpireDays ?? 180),
        createdAt: Date.parse(`${m.joinedOn}T10:00:00Z`),
      })
      .run();
  }
}

// The demo member holds class credits and PT credits, so the booking screen
// can show both the "included" and the "needs a credit" paths.
db.insert(schema.credits)
  .values([
    {
      id: id('crd'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'class',
      delta: 10,
      reason: 'Purchased Class Pack — 10',
      refType: 'product',
      refId: 'prd_class_10',
      expiresOn: addDays(TODAY, 120),
      createdAt: NOW - 60 * DAY,
    },
    {
      id: id('crd'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'class',
      delta: -6,
      reason: 'Class bookings',
      refType: 'bookings',
      refId: null,
      expiresOn: null,
      createdAt: NOW - 20 * DAY,
    },
    {
      id: id('crd'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'pt',
      delta: 10,
      reason: 'Purchased Personal Training — 10 sessions',
      refType: 'product',
      refId: 'prd_pt_10',
      expiresOn: addDays(TODAY, 70),
      createdAt: NOW - 50 * DAY,
    },
    {
      id: id('crd'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'pt',
      delta: -4,
      reason: 'Sessions delivered',
      refType: 'appointments',
      refId: null,
      expiresOn: null,
      createdAt: NOW - 10 * DAY,
    },
  ])
  .run();

/* ============================================================================
   Billing
   ========================================================================= */

let invoiceCounter = 1;

function seedInvoice(args: {
  memberId: string;
  branchId: string;
  productId: string;
  issuedDaysAgo: number;
  paid: boolean;
  failed?: boolean;
}): string {
  const product = productRows.get(args.productId)!;
  const invoiceId = id('inv');
  const number = `SF-2026-${String(invoiceCounter++).padStart(5, '0')}`;
  const issuedOn = addDays(TODAY, -args.issuedDaysAgo);
  const dueOn = addDays(issuedOn, 7);
  const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);

  const state = args.paid ? 'paid' : dueOn < TODAY ? 'overdue' : 'open';

  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId,
      branchId: args.branchId,
      memberId: args.memberId,
      number,
      state,
      issuedOn,
      dueOn,
      currency: 'INR',
      subtotalMinor: totals.subtotalMinor,
      discountMinor: 0,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      paidMinor: args.paid ? totals.totalMinor : 0,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType: 'membership',
      refId: args.productId,
      createdAt: Date.parse(`${issuedOn}T09:00:00Z`),
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.invoiceLines)
    .values({
      id: id('inl'),
      tenantId,
      invoiceId,
      description: product.name,
      quantity: 1,
      unitMinor: product.priceMinor,
      discountMinor: 0,
      taxRateBp: product.taxRateBp,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      productId: args.productId,
    })
    .run();

  if (args.paid) {
    db.insert(schema.payments)
      .values({
        id: id('pay'),
        tenantId,
        branchId: args.branchId,
        invoiceId,
        memberId: args.memberId,
        method: rng.pick(['upi', 'card', 'upi', 'cash', 'bank_transfer']),
        state: 'succeeded',
        amountMinor: totals.totalMinor,
        currency: 'INR',
        provider: 'razorpay',
        providerRef: `pay_${token(8)}`,
        idempotencyKey: `seed-${invoiceId}`,
        recordedById: null,
        recordedByName: null,
        failureReason: null,
        note: null,
        createdAt: Date.parse(`${issuedOn}T09:05:00Z`),
        settledAt: Date.parse(`${issuedOn}T09:06:00Z`),
      })
      .run();
  } else if (args.failed) {
    db.insert(schema.payments)
      .values({
        id: id('pay'),
        tenantId,
        branchId: args.branchId,
        invoiceId,
        memberId: args.memberId,
        method: 'card',
        state: 'failed',
        amountMinor: totals.totalMinor,
        currency: 'INR',
        provider: 'razorpay',
        providerRef: `pay_${token(8)}`,
        idempotencyKey: `seed-fail-${invoiceId}`,
        recordedById: null,
        recordedByName: null,
        failureReason: 'Card declined by issuing bank',
        note: null,
        createdAt: Date.parse(`${issuedOn}T09:05:00Z`),
        settledAt: null,
      })
      .run();

    [0, 3, 7].forEach((offset, attempt) => {
      db.insert(schema.dunningAttempts)
        .values({
          id: id('dun'),
          tenantId,
          invoiceId,
          attempt: attempt + 1,
          channel: ['email', 'sms', 'in_app'][attempt] ?? 'in_app',
          scheduledFor: Date.parse(`${addDays(issuedOn, offset)}T10:00:00Z`),
          state: offset <= args.issuedDaysAgo ? 'sent' : 'scheduled',
          sentAt: offset <= args.issuedDaysAgo ? Date.parse(`${addDays(issuedOn, offset)}T10:00:00Z`) : null,
          stopReason: null,
        })
        .run();
    });
  }

  return invoiceId;
}

for (const m of membersSeeded) {
  const history = rng.int(1, 4);
  for (let n = history; n >= 1; n--) {
    seedInvoice({
      memberId: m.memberId,
      branchId: m.branchId,
      productId: m.productId,
      issuedDaysAgo: n * 30 + rng.int(0, 5),
      paid: true,
    });
  }
}

// Takings inside the current calendar month. Without these the revenue KPI
// reads zero on any day early in a month, which looks like a broken metric
// rather than a quiet month.
const daysIntoMonth = Number(TODAY.slice(8, 10));
for (const m of rng.shuffle(membersSeeded.filter((x) => x.membershipState === 'active')).slice(0, 14)) {
  seedInvoice({
    memberId: m.memberId,
    branchId: m.branchId,
    productId: m.productId,
    issuedDaysAgo: rng.int(0, Math.max(0, daysIntoMonth - 1)),
    paid: true,
  });
}

// The grace member's failed renewal — the one the denial screen refers to.
const graceInvoiceId = seedInvoice({
  memberId: graceMember.memberId,
  branchId: graceMember.branchId,
  productId: graceMember.productId,
  issuedDaysAgo: 5,
  paid: false,
  failed: true,
});

// A handful of other unpaid invoices so the billing board is not empty.
for (const m of rng.shuffle(membersSeeded.filter((x) => x.membershipState === 'active')).slice(0, 5)) {
  seedInvoice({
    memberId: m.memberId,
    branchId: m.branchId,
    productId: m.productId,
    issuedDaysAgo: rng.int(2, 20),
    paid: false,
    failed: rng.chance(0.5),
  });
}

console.log(`  ${invoiceCounter - 1} invoices`);

/* ============================================================================
   Programme: Apex Hypertrophy
   ========================================================================= */

const programId = 'prg_apex_hypertrophy';

db.insert(schema.programs)
  .values({
    id: programId,
    tenantId,
    name: 'Apex Hypertrophy',
    version: 4,
    goal: 'hypertrophy',
    daysPerWeek: 4,
    weeks: 6,
    authorId: coachRehan.staffId,
    authorName: coachRehan.name,
    description:
      'Four days a week across six weeks. Two upper, two lower, with the top set progressing when the previous week came in clean.',
    state: 'published',
    createdAt: NOW - 120 * DAY,
    updatedAt: NOW - 12 * DAY,
  })
  .run();

interface DayPlan {
  dayIndex: number;
  label: string;
  focus: string;
  minutes: number;
  items: Array<{
    slug: string;
    sets: number;
    repLow: number;
    repHigh: number;
    rpe: number;
    load: number;
    rest: number;
    rationale?: string;
    locked?: boolean;
    superset?: string;
  }>;
}

const WEEK_PLAN: DayPlan[] = [
  {
    dayIndex: 0,
    label: 'Pull · Back & Biceps',
    focus: 'pull',
    minutes: 55,
    items: [
      { slug: 'pull-up', sets: 4, repLow: 5, repHigh: 8, rpe: 8, load: 0, rest: 150, rationale: 'Your strongest vertical pull — it leads the day.' },
      { slug: 'barbell-row', sets: 4, repLow: 6, repHigh: 8, rpe: 8, load: 70, rest: 150 },
      { slug: 'lat-pulldown', sets: 3, repLow: 10, repHigh: 12, rpe: 8, load: 60, rest: 90 },
      { slug: 'face-pull', sets: 3, repLow: 12, repHigh: 15, rpe: 7, load: 25, rest: 60, superset: 'A' },
      { slug: 'barbell-curl', sets: 3, repLow: 8, repHigh: 12, rpe: 8, load: 30, rest: 60, superset: 'A' },
    ],
  },
  {
    dayIndex: 1,
    label: 'Lower · Squat focus',
    focus: 'lower',
    minutes: 60,
    items: [
      { slug: 'barbell-back-squat', sets: 4, repLow: 5, repHigh: 8, rpe: 8, load: 110, rest: 180, rationale: 'The main lift of the block. Everything else supports it.' },
      { slug: 'leg-press', sets: 3, repLow: 10, repHigh: 12, rpe: 8, load: 180, rest: 120 },
      { slug: 'seated-leg-curl', sets: 3, repLow: 10, repHigh: 12, rpe: 8, load: 45, rest: 75 },
      { slug: 'standing-calf-raise', sets: 4, repLow: 10, repHigh: 15, rpe: 8, load: 60, rest: 60 },
      { slug: 'cable-crunch', sets: 3, repLow: 12, repHigh: 15, rpe: 8, load: 35, rest: 60 },
    ],
  },
  {
    dayIndex: 3,
    label: 'Push · Chest & Shoulders',
    focus: 'push',
    minutes: 48,
    items: [
      { slug: 'barbell-bench-press', sets: 4, repLow: 6, repHigh: 8, rpe: 8, load: 62.5, rest: 150, rationale: 'Top set drives the whole push day. Keep the last rep clean.' },
      { slug: 'incline-dumbbell-press', sets: 3, repLow: 8, repHigh: 10, rpe: 8, load: 24, rest: 120 },
      { slug: 'seated-shoulder-press', sets: 3, repLow: 8, repHigh: 10, rpe: 8, load: 40, rest: 120 },
      { slug: 'cable-fly', sets: 3, repLow: 12, repHigh: 15, rpe: 8, load: 15, rest: 75, superset: 'B' },
      { slug: 'triceps-rope-pushdown', sets: 3, repLow: 12, repHigh: 15, rpe: 8, load: 30, rest: 60, superset: 'B' },
    ],
  },
  {
    dayIndex: 5,
    label: 'Lower · Hinge focus',
    focus: 'lower',
    minutes: 58,
    items: [
      { slug: 'romanian-deadlift', sets: 4, repLow: 6, repHigh: 8, rpe: 8, load: 92.5, rest: 150, locked: true, rationale: 'Locked while we clean up the lockout. Do not add load yet.' },
      { slug: 'hip-thrust', sets: 3, repLow: 8, repHigh: 12, rpe: 8, load: 100, rest: 120 },
      { slug: 'bulgarian-split-squat', sets: 3, repLow: 8, repHigh: 10, rpe: 8, load: 20, rest: 120 },
      { slug: 'seated-leg-curl', sets: 3, repLow: 12, repHigh: 15, rpe: 8, load: 40, rest: 75 },
      { slug: 'farmers-carry', sets: 3, repLow: 1, repHigh: 1, rpe: 7, load: 32, rest: 90 },
    ],
  },
];

const programDayIds = new Map<string, string>(); // `${week}:${dayIndex}`

for (let week = 1; week <= 6; week++) {
  for (const day of WEEK_PLAN) {
    const dayId = id('pdy');
    programDayIds.set(`${week}:${day.dayIndex}`, dayId);

    db.insert(schema.programDays)
      .values({
        id: dayId,
        tenantId,
        programId,
        week,
        dayIndex: day.dayIndex,
        label: day.label,
        focus: day.focus,
        isRest: false,
        estimatedMin: day.minutes,
      })
      .run();

    day.items.forEach((item, order) => {
      // Load creeps up across the block; deload in week 4.
      const factor = week === 4 ? 0.85 : 1 + (week - 1) * 0.025;
      const load = item.load > 0 ? Math.round(item.load * factor * 4) / 4 : 0;

      db.insert(schema.programItems)
        .values({
          id: id('pit'),
          tenantId,
          programDayId: dayId,
          orderIndex: order,
          exerciseId: exerciseIdBySlug.get(item.slug)!,
          sets: Array.from({ length: item.sets }, (_, i) => ({
            setIndex: i,
            targetWeightKg: load || null,
            repLow: item.repLow,
            repHigh: item.repHigh,
            targetRpe: item.rpe,
            restSec: item.rest,
            isWarmup: false,
          })),
          targetLabel:
            item.repLow === item.repHigh
              ? `${item.sets} × ${item.repLow} @ RPE ${item.rpe}`
              : `${item.sets} × ${item.repLow}-${item.repHigh} @ RPE ${item.rpe}`,
          supersetGroup: item.superset ?? null,
          tempo: null,
          notes: null,
          rationale: item.rationale ?? null,
          trainerLocked: item.locked ?? false,
          allowedSubstitutionIds: (EXERCISES.find((e) => e.slug === item.slug)?.subs ?? []).map(
            (s) => exerciseIdBySlug.get(s)!,
          ),
        })
        .run();
    });
  }

  // Rest days, so the week view has a shape rather than gaps.
  for (const restDay of [2, 4, 6]) {
    db.insert(schema.programDays)
      .values({
        id: id('pdy'),
        tenantId,
        programId,
        week,
        dayIndex: restDay,
        label: restDay === 6 ? 'Rest · optional mobility' : 'Rest',
        focus: 'rest',
        isRest: true,
        estimatedMin: 0,
      })
      .run();
  }
}

/** Everyone with a trainer gets the programme; the demo member is on week 3. */
const assignmentByMember = new Map<string, string>();

for (const m of membersSeeded) {
  if (!m.trainerId && !m.isDemo) continue;
  const assignmentId = id('asg');
  assignmentByMember.set(m.memberId, assignmentId);
  const week = m.isDemo ? 3 : rng.int(1, 6);
  db.insert(schema.assignments)
    .values({
      id: assignmentId,
      tenantId,
      memberId: m.memberId,
      programId,
      programVersion: 4,
      trainerId: m.trainerId ?? coachRehan.staffId,
      startsOn: addDays(TODAY, -(week - 1) * 7 - 3),
      currentWeek: week,
      currentBlock: week <= 3 ? 'A' : 'B',
      state: 'active',
      createdAt: NOW - (week * 7 + 3) * DAY,
      updatedAt: NOW,
    })
    .run();
}

console.log(`  programme with ${WEEK_PLAN.length * 6} training days, ${assignmentByMember.size} assignments`);

/* ============================================================================
   Workout history
   ========================================================================= */

const benchId = exerciseIdBySlug.get('barbell-bench-press')!;
const squatId = exerciseIdBySlug.get('barbell-back-squat')!;
const rdlId = exerciseIdBySlug.get('romanian-deadlift')!;

interface HistoryResult {
  sessionDates: string[];
  volumeByWeek: number[];
}

function seedHistoryFor(m: SeededMember, weeks: number): HistoryResult {
  const sessionDates: string[] = [];
  const volumeByWeek: number[] = [];
  const assignmentId = assignmentByMember.get(m.memberId) ?? null;

  for (let w = weeks; w >= 1; w--) {
    let weekVolume = 0;
    // Two missed weeks in June for the demo member, so attendance has a story.
    const skipWeek = m.isDemo && (w === 8 || w === 9);
    const daysThisWeek = skipWeek ? [] : rng.shuffle(WEEK_PLAN).slice(0, rng.int(m.isDemo ? 3 : 2, 4));

    for (const day of daysThisWeek) {
      const daysAgo = w * 7 - day.dayIndex;
      if (daysAgo <= 0) continue;
      const onDate = addDays(TODAY, -daysAgo);
      const startedAt = Date.parse(`${onDate}T${String(rng.int(6, 19)).padStart(2, '0')}:${rng.chance(0.5) ? '15' : '45'}:00Z`);
      const workoutId = id('wko');
      const clientId = `seed-${m.memberId}-${onDate}-${day.dayIndex}`;

      const setsForVolume: Array<{ weightKg: number; reps: number; isWarmup: boolean }> = [];
      let totalSets = 0;

      day.items.forEach((item, order) => {
        const exerciseId = exerciseIdBySlug.get(item.slug)!;
        // Load trends up as the weeks come forward.
        const progress = 1 + (weeks - w) * 0.012;
        const base = item.load > 0 ? Math.round(item.load * progress * 4) / 4 : 0;

        for (let s = 0; s < item.sets; s++) {
          const reps = rng.int(item.repLow, item.repHigh);
          const weightKg = base;
          setsForVolume.push({ weightKg, reps, isWarmup: false });
          totalSets++;

          db.insert(schema.workoutSets)
            .values({
              id: id('wst'),
              tenantId,
              workoutId,
              memberId: m.memberId,
              clientId: `${clientId}-${order}-${s}`,
              exerciseId,
              orderIndex: order,
              setIndex: s,
              weightKg,
              reps,
              rpe: rng.pick([7, 7.5, 8, 8, 8.5, 9]),
              isWarmup: false,
              doneAt: startedAt + (order * 8 + s * 2) * MINUTE,
            })
            .run();
        }
      });

      const volume = sessionVolumeKg(setsForVolume);
      weekVolume += volume;
      const durationSec = rng.int(38, 68) * 60;

      db.insert(schema.workouts)
        .values({
          id: workoutId,
          tenantId,
          branchId: m.branchId,
          memberId: m.memberId,
          assignmentId,
          programDayId: programDayIds.get(`${Math.min(6, Math.max(1, 7 - (w % 6)))}:${day.dayIndex}`) ?? null,
          clientId,
          title: day.label,
          state: 'completed',
          startedAt,
          finishedAt: startedAt + durationSec * 1000,
          durationSec,
          volumeKg: volume,
          totalSets,
          notes: null,
          sessionRpe: rng.pick([7, 7.5, 8, 8.5]),
          substitutions: [],
          coachNote: null,
          reviewedByTrainerAt: rng.chance(0.3) ? startedAt + 2 * DAY : null,
          syncedAt: startedAt + durationSec * 1000 + MINUTE,
        })
        .run();

      sessionDates.push(onDate);
    }
    volumeByWeek.unshift(weekVolume);
  }

  return { sessionDates, volumeByWeek };
}

const demoHistory = seedHistoryFor(demoMember, 12);
for (const m of membersSeeded) {
  if (m.isDemo) continue;
  if (m.membershipState === 'expired') continue;
  seedHistoryFor(m, rng.int(3, 10));
}

/* — Personal records for the demo member ————————————————————— */

const DEMO_PRS = [
  { exerciseId: exerciseIdBySlug.get('conventional-deadlift')!, value: 182.5, display: '182.5 kg', prev: 175, prevDisplay: '175 kg', daysAgo: 9 },
  { exerciseId: squatId, value: 145, display: '145 kg', prev: 140, prevDisplay: '140 kg', daysAgo: 16 },
  { exerciseId: benchId, value: 102.5, display: '102.5 kg', prev: 100, prevDisplay: '100 kg', daysAgo: 23 },
  { exerciseId: exerciseIdBySlug.get('rowing-machine')!, value: 432, display: '7:12 / 2 km', prev: 450, prevDisplay: '7:30 / 2 km', daysAgo: 30 },
];

for (const pr of DEMO_PRS) {
  db.insert(schema.personalRecords)
    .values({
      id: id('prc'),
      tenantId,
      memberId: demoMember.memberId,
      exerciseId: pr.exerciseId,
      kind: pr.exerciseId === exerciseIdBySlug.get('rowing-machine') ? 'time' : 'weight',
      value: pr.value,
      display: pr.display,
      previousValue: pr.prev,
      previousDisplay: pr.prevDisplay,
      workoutSetId: null,
      achievedAt: NOW - pr.daysAgo * DAY,
      shared: pr.daysAgo < 12,
      retiredAt: null,
    })
    .run();
}

/* — One adaptive decision waiting on the demo member ————————— */

db.insert(schema.adaptiveDecisions)
  .values({
    id: id('adp'),
    tenantId,
    memberId: demoMember.memberId,
    assignmentId: assignmentByMember.get(demoMember.memberId)!,
    programItemId: null,
    rulesVersion: 'v4.2',
    headline: 'Bench top set moved 62.5 → 65 kg',
    explanation:
      'Two sessions at RPE 7 or lower with every set completed, and you hit the top of the rep range both times. One step up.',
    inputs: ['last 3 Barbell Bench Press sessions', 'logged RPE', 'set completion', 'recovery estimate (88%)'],
    changes: [{ exerciseName: 'Barbell Bench Press', field: 'Top set load', from: '62.5 kg', to: '65 kg' }],
    confidence: 'high',
    limitations:
      'Estimates from what you logged. They do not know how you slept, ate or feel. Tell your coach if anything hurts.',
    reviewedById: coachRehan.staffId,
    reviewedByName: coachRehan.name,
    reviewedAt: NOW - 2 * DAY,
    memberDecision: 'pending',
    createdAt: NOW - 2 * DAY,
  })
  .run();

console.log('  workout history + records');

/* ============================================================================
   Schedule
   ========================================================================= */

const classTypeIds = new Map<string, string>();
for (const ct of CLASS_TYPES) {
  const ctId = id('clt');
  classTypeIds.set(ct.name, ctId);
  db.insert(schema.classTypes)
    .values({
      id: ctId,
      tenantId,
      name: ct.name,
      category: ct.category,
      description: ct.desc,
      durationMin: ct.duration,
      intensity: ct.intensity,
      createdAt: NOW - 400 * DAY,
    })
    .run();
}

const roomsByBranch = new Map<string, Array<{ id: string; name: string; capacity: number }>>();
for (const b of BRANCHES) {
  const list = [
    { id: id('rom'), name: 'Studio 1', capacity: 24 },
    { id: id('rom'), name: 'Studio 2', capacity: 18 },
    { id: id('rom'), name: 'Cycle Studio', capacity: 20 },
    ...(b.id === 'br_ind' ? [{ id: id('rom'), name: 'Pool', capacity: 12 }] : []),
  ];
  roomsByBranch.set(b.id, list);
  for (const r of list) {
    db.insert(schema.rooms).values({ id: r.id, tenantId, branchId: b.id, name: r.name, capacity: r.capacity }).run();
  }
}

/** Same weekly grid every day, so the date strip is never empty. */
const DAILY_GRID = [
  { time: 6.5, type: 'Apex HIIT', trainer: coachNikhil, room: 'Studio 1' },
  { time: 7.75, type: 'Open Water Swim', trainer: coachPriya, room: 'Pool', branchOnly: 'br_ind' },
  { time: 8.0, type: 'Foundations', trainer: coachPriya, room: 'Studio 2' },
  { time: 12.0, type: 'Deep Mobility', trainer: coachPriya, room: 'Studio 2' },
  { time: 18.25, type: 'Strength Clinic', trainer: coachRehan, room: 'Studio 1' },
  { time: 19.0, type: 'Apex HIIT', trainer: coachNikhil, room: 'Studio 2' },
  { time: 20.0, type: 'Spin Sprint', trainer: coachNikhil, room: 'Cycle Studio' },
  { time: 20.0, type: 'Cage Boxing', trainer: coachRehan, room: 'Studio 1' },
  { time: 21.0, type: 'Reef Yoga', trainer: coachPriya, room: 'Studio 2' },
];

const sessionsSeeded: Array<{ id: string; branchId: string; startsAt: number; capacity: number; name: string }> = [];

for (let dayOffset = -7; dayOffset <= 14; dayOffset++) {
  const date = addDays(TODAY, dayOffset);
  for (const b of BRANCHES) {
    for (const slot of DAILY_GRID) {
      if (slot.branchOnly && slot.branchOnly !== b.id) continue;
      const rooms = roomsByBranch.get(b.id)!;
      const room = rooms.find((r) => r.name === slot.room);
      if (!room) continue;

      const ct = CLASS_TYPES.find((c) => c.name === slot.type)!;
      const hh = Math.floor(slot.time);
      const mm = Math.round((slot.time - hh) * 60);
      // Branch-local time expressed as UTC (IST is +5:30).
      const startsAt = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
      const sessionId = id('ses');

      sessionsSeeded.push({ id: sessionId, branchId: b.id, startsAt, capacity: room.capacity, name: ct.name });

      db.insert(schema.classSessions)
        .values({
          id: sessionId,
          tenantId,
          branchId: b.id,
          classTypeId: classTypeIds.get(ct.name)!,
          roomId: room.id,
          trainerId: slot.trainer.staffId,
          seriesId: `series_${b.id}_${ct.name.replace(/\s+/g, '_')}_${slot.time}`,
          startsAt,
          endsAt: startsAt + ct.duration * MINUTE,
          capacity: room.capacity,
          booked: 0,
          state: dayOffset === 3 && ct.name === 'Reef Yoga' && b.id === 'br_kor' ? 'cancelled' : dayOffset < 0 ? 'completed' : 'scheduled',
          bookingOpensAt: startsAt - 14 * DAY,
          cancelDeadlineAt: startsAt - 2 * HOUR,
          creditsRequired: ['Deep Mobility', 'Reef Yoga', 'Cage Boxing'].includes(ct.name) ? 1 : 0,
          dropInPriceMinor: ['Deep Mobility', 'Reef Yoga', 'Cage Boxing'].includes(ct.name) ? 35_000 : null,
          lateCancelFeeMinor: 0,
          waitlistEnabled: true,
          cancelledReason:
            dayOffset === 3 && ct.name === 'Reef Yoga' && b.id === 'br_kor'
              ? 'Studio 2 floor work. Members were notified and credits returned.'
              : null,
          substituteFor: null,
          notes: null,
          version: 1,
          createdAt: NOW - 30 * DAY,
          updatedAt: NOW,
        })
        .run();
    }
  }
}

/** Fill seats. One evening class is deliberately full with a waitlist. */
const bookableMembers = membersSeeded.filter((m) => m.membershipState === 'active' || m.membershipState === 'frozen');

for (const s of sessionsSeeded) {
  const isFuture = s.startsAt > NOW;
  const eligible = bookableMembers.filter((m) => m.branchId === s.branchId);
  if (eligible.length === 0) continue;

  const fillTarget = rng.int(Math.floor(s.capacity * 0.3), s.capacity);
  const attendees = rng.shuffle(eligible).slice(0, Math.min(fillTarget, eligible.length));

  let seat = 0;
  for (const m of attendees) {
    seat++;
    db.insert(schema.bookings)
      .values({
        id: id('bkg'),
        tenantId,
        sessionId: s.id,
        memberId: m.memberId,
        state: isFuture ? 'confirmed' : rng.chance(0.85) ? 'attended' : 'no_show',
        seatNo: seat,
        bookedAt: s.startsAt - rng.int(1, 96) * HOUR,
        cancelledAt: null,
        heldUntil: null,
        creditsUsed: 0,
        chargeMinor: 0,
        cameFromWaitlist: false,
        idempotencyKey: `seed-${s.id}-${m.memberId}`,
        attendedAt: isFuture ? null : s.startsAt,
      })
      .run();
  }

  db.update(schema.classSessions)
    .set({ booked: seat })
    .where(sql`${schema.classSessions.id} = ${s.id}`)
    .run();
}

/** The demo member's evening booking today — the one Home surfaces. */
const todayEvening = sessionsSeeded.find(
  (s) => s.branchId === 'br_kor' && s.name === 'Apex HIIT' && isoDate(s.startsAt, TZ) === TODAY && s.startsAt > NOW,
);

if (todayEvening) {
  const already = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bookings)
    .where(sql`${schema.bookings.sessionId} = ${todayEvening.id} and ${schema.bookings.memberId} = ${demoMember.memberId}`)
    .get();

  if ((already?.n ?? 0) === 0) {
    db.insert(schema.bookings)
      .values({
        id: id('bkg'),
        tenantId,
        sessionId: todayEvening.id,
        memberId: demoMember.memberId,
        state: 'confirmed',
        seatNo: 6,
        bookedAt: NOW - 20 * HOUR,
        cancelledAt: null,
        heldUntil: null,
        creditsUsed: 0,
        chargeMinor: 0,
        cameFromWaitlist: false,
        idempotencyKey: `seed-demo-${todayEvening.id}`,
        attendedAt: null,
      })
      .run();
    db.update(schema.classSessions)
      .set({ booked: sql`${schema.classSessions.booked} + 1` })
      .where(sql`${schema.classSessions.id} = ${todayEvening.id}`)
      .run();
  }
}

/** A full class with a live waitlist, so that path is demonstrable. */
const fullSession = sessionsSeeded.find(
  (s) => s.branchId === 'br_kor' && s.name === 'Spin Sprint' && isoDate(s.startsAt, TZ) === TODAY,
);

if (fullSession) {
  db.update(schema.classSessions)
    .set({ booked: fullSession.capacity })
    .where(sql`${schema.classSessions.id} = ${fullSession.id}`)
    .run();

  const waiters = rng.shuffle(bookableMembers.filter((m) => m.memberId !== demoMember.memberId)).slice(0, 2);
  waiters.forEach((m, index) => {
    db.insert(schema.waitlistEntries)
      .values({
        id: id('wtl'),
        tenantId,
        sessionId: fullSession.id,
        memberId: m.memberId,
        position: index + 1,
        state: 'waiting',
        joinedAt: NOW - (index + 1) * HOUR,
        offeredAt: null,
        offerExpiresAt: null,
        resolvedAt: null,
      })
      .run();
  });
}

console.log(`  ${sessionsSeeded.length} class sessions`);

/* ============================================================================
   Attendance
   ========================================================================= */

for (const m of membersSeeded) {
  db.insert(schema.accessTokens)
    .values({
      id: id('atk'),
      tenantId,
      memberId: m.memberId,
      seed: token(16),
      issuedAt: NOW,
      expiresAt: NOW + 30 * DAY,
      revokedAt: null,
    })
    .run();
}

const visitCounter = new Map<string, number>();

for (let dayOffset = 90; dayOffset >= 0; dayOffset--) {
  const date = addDays(TODAY, -dayOffset);
  for (const m of membersSeeded) {
    if (m.membershipState === 'expired' && dayOffset < 40) continue;
    if (!rng.chance(m.isDemo ? 0.55 : 0.32)) continue;

    const hour = rng.pick([6, 7, 7, 8, 12, 17, 18, 19, 19, 20]);
    const enteredAt = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00+05:30`);
    if (enteredAt > NOW) continue;

    const n = (visitCounter.get(m.memberId) ?? 0) + 1;
    visitCounter.set(m.memberId, n);
    const durationMin = rng.int(42, 95);

    db.insert(schema.checkIns)
      .values({
        id: id('chk'),
        tenantId,
        branchId: m.branchId,
        memberId: m.memberId,
        method: rng.pick(['qr', 'qr', 'qr', 'staff', 'kiosk']),
        decision: 'granted',
        enteredAt,
        exitedAt: dayOffset === 0 && rng.chance(0.35) ? null : enteredAt + durationMin * MINUTE,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber: n,
      })
      .run();

    db.update(schema.members)
      .set({ lastVisitAt: enteredAt })
      .where(sql`${schema.members.id} = ${m.memberId}`)
      .run();
  }
}

// People on the floor right now. Seeded relative to the current clock rather
// than to a fixed hour, so the occupancy trace and the live door feed have
// something real in them whenever the seed is run.
const insideNow = rng.shuffle(membersSeeded.filter((m) => m.membershipState === 'active')).slice(0, rng.int(14, 26));
for (const m of insideNow) {
  const enteredAt = NOW - rng.int(8, 150) * MINUTE;
  const n = (visitCounter.get(m.memberId) ?? 0) + 1;
  visitCounter.set(m.memberId, n);

  db.insert(schema.checkIns)
    .values({
      id: id('chk'),
      tenantId,
      branchId: m.branchId,
      memberId: m.memberId,
      method: rng.pick(['qr', 'qr', 'qr', 'staff']),
      decision: 'granted',
      enteredAt,
      exitedAt: null,
      autoClosed: false,
      overrideById: null,
      overrideByName: null,
      overrideReason: null,
      visitNumber: n,
    })
    .run();

  db.update(schema.members)
    .set({ lastVisitAt: enteredAt })
    .where(sql`${schema.members.id} = ${m.memberId}`)
    .run();
}

// Completed visits earlier today, so today's occupancy trace has a shape and
// not a single spike at the current hour.
for (let hoursBack = 14; hoursBack >= 2; hoursBack--) {
  const arrivals = hoursBack >= 11 && hoursBack <= 13 ? rng.int(3, 7) : hoursBack <= 5 ? rng.int(4, 9) : rng.int(0, 3);
  for (let i = 0; i < arrivals; i++) {
    const m = rng.pick(membersSeeded.filter((x) => x.membershipState === 'active'));
    const enteredAt = NOW - hoursBack * HOUR - rng.int(0, 55) * MINUTE;
    const n = (visitCounter.get(m.memberId) ?? 0) + 1;
    visitCounter.set(m.memberId, n);
    db.insert(schema.checkIns)
      .values({
        id: id('chk'),
        tenantId,
        branchId: m.branchId,
        memberId: m.memberId,
        method: rng.pick(['qr', 'qr', 'kiosk', 'staff']),
        decision: 'granted',
        enteredAt,
        exitedAt: enteredAt + rng.int(38, 92) * MINUTE,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber: n,
      })
      .run();
  }
}

// Every branch keeps at least two entitled members off the floor.
//
// The occupancy picks above draw from the whole tenant at random, and the
// smaller branches hold few enough entitled members that a run can put every
// one of them inside at once. A branch where nobody is left to check in is not
// a state the front desk can ever reach in real life, and it strands the desk
// screens (and the tests covering them) with no member to act on. Repairing it
// here rather than biasing the picks keeps the occupancy trace honest.
const DESK_READY = `
  select m.id
  from members m
  join memberships ms on ms.member_id = m.id
  where m.home_branch_id = ?
    and m.deleted_at is null
    and ms.state = 'active'
    and (json_extract(ms.product_snapshot, '$.access.windowStartMin') is null
         or json_extract(ms.product_snapshot, '$.access.windowStartMin') = 'null')
    and not exists (
      select 1 from invoices i
      where i.member_id = m.id
        and i.state in ('open', 'partially_paid', 'overdue')
        and i.total_minor > i.paid_minor)
    and not exists (select 1 from member_branches mb where mb.member_id = m.id)
`;
const IDLE_PER_BRANCH = 2;

for (const b of BRANCHES) {
  const idle = sqlite
    .prepare(`${DESK_READY} and not exists (
        select 1 from check_ins c
        where c.member_id = m.id and c.decision = 'granted' and c.exited_at is null)`)
    .all(b.id) as Array<{ id: string }>;

  let shortfall = IDLE_PER_BRANCH - idle.length;
  if (shortfall <= 0) continue;

  // Send the longest-standing visitors home first: they are the ones whose
  // session would plausibly have ended by now anyway.
  const inside = sqlite
    .prepare(`${DESK_READY} and exists (
        select 1 from check_ins c
        where c.member_id = m.id and c.decision = 'granted' and c.exited_at is null)
      order by (select min(c.entered_at) from check_ins c
                where c.member_id = m.id and c.decision = 'granted' and c.exited_at is null) asc`)
    .all(b.id) as Array<{ id: string }>;

  for (const m of inside) {
    if (shortfall <= 0) break;
    sqlite
      .prepare(
        `update check_ins set exited_at = min(entered_at + ?, ?)
         where member_id = ? and decision = 'granted' and exited_at is null`,
      )
      .run(55 * MINUTE, NOW, m.id);
    shortfall -= 1;
  }
}

// A handful of denials so the Floor screen has exceptions to show.
for (let i = 0; i < 6; i++) {
  const m = rng.pick(membersSeeded.filter((x) => x.membershipState !== 'active'));
  db.insert(schema.checkIns)
    .values({
      id: id('chk'),
      tenantId,
      branchId: m.branchId,
      memberId: m.memberId,
      method: 'qr',
      decision: m.membershipState === 'grace' ? 'denied_grace_outstanding' : 'denied_membership_inactive',
      enteredAt: NOW - rng.int(1, 40) * HOUR,
      exitedAt: null,
      autoClosed: false,
      overrideById: i === 0 ? reception.staffId : null,
      overrideByName: i === 0 ? reception.name : null,
      overrideReason: i === 0 ? 'Member paying at the desk now — receipt SF-2026-00291' : null,
      visitNumber: null,
    })
    .run();
}

console.log('  attendance history');

/* ============================================================================
   Progress, habits, nutrition
   ========================================================================= */

for (let w = 12; w >= 0; w--) {
  const takenOn = addDays(TODAY, -w * 7);
  db.insert(schema.measurements)
    .values({
      id: id('mea'),
      tenantId,
      memberId: demoMember.memberId,
      takenOn,
      weightKg: Math.round((80.2 - (12 - w) * 0.15) * 10) / 10,
      bodyFatPct: Math.round((16.4 - (12 - w) * 0.19) * 10) / 10,
      leanMassKg: Math.round((66.1 + (12 - w) * 0.1) * 10) / 10,
      chestCm: 104 + (12 - w) * 0.05,
      waistCm: Math.round((86 - (12 - w) * 0.25) * 10) / 10,
      hipsCm: 98,
      armCm: 36.5 + (12 - w) * 0.03,
      thighCm: 60,
      source: w % 4 === 0 ? 'assessment' : 'self',
      outlier: false,
      createdAt: Date.parse(`${takenOn}T07:00:00Z`),
    })
    .run();
}

db.insert(schema.goals)
  .values([
    {
      id: id('gol'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'lift',
      title: 'Bench press 110 kg',
      baseline: 95,
      target: 110,
      unit: 'kg',
      targetDate: addDays(TODAY, 55),
      state: 'active',
      coachId: coachRehan.staffId,
      refExerciseId: benchId,
      createdAt: NOW - 60 * DAY,
      updatedAt: NOW,
    },
    {
      id: id('gol'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'attendance',
      title: 'Four sessions a week',
      baseline: 2,
      target: 4,
      unit: 'sessions/week',
      targetDate: addDays(TODAY, 30),
      state: 'active',
      coachId: coachRehan.staffId,
      refExerciseId: null,
      createdAt: NOW - 90 * DAY,
      updatedAt: NOW,
    },
    {
      id: id('gol'),
      tenantId,
      memberId: demoMember.memberId,
      kind: 'bodyweight',
      title: 'Reach 77 kg',
      baseline: 80.2,
      target: 77,
      unit: 'kg',
      targetDate: addDays(TODAY, 70),
      state: 'active',
      coachId: coachRehan.staffId,
      refExerciseId: null,
      createdAt: NOW - 84 * DAY,
      updatedAt: NOW,
    },
  ])
  .run();

db.insert(schema.assessments)
  .values({
    id: id('ass'),
    tenantId,
    memberId: demoMember.memberId,
    template: 'Quarterly review',
    trainerId: coachRehan.staffId,
    values: [
      { label: 'Weight', value: '78.4', unit: 'kg' },
      { label: 'Body fat', value: '14.1', unit: '%' },
      { label: 'Lean mass', value: '67.3', unit: 'kg' },
      { label: 'Resting heart rate', value: '58', unit: 'bpm' },
      { label: 'Overhead squat screen', value: 'Good, slight heel lift', unit: null },
    ],
    trainerOnly: [
      { label: 'Coaching note', value: 'Left hip shifts under fatigue on squats. Watch it in week 5.' },
    ],
    memberNote: 'Feeling stronger on pressing. Sleep has been the limiter.',
    takenAt: NOW - 2 * DAY,
  })
  .run();

const HABITS = [
  { name: 'Protein target', icon: 'protein', target: 150, unit: 'g' },
  { name: 'Water', icon: 'water', target: 3000, unit: 'ml' },
  { name: 'Sleep 7h+', icon: 'sleep', target: 7, unit: 'h' },
  { name: '8,000 steps', icon: 'steps', target: 8000, unit: 'steps' },
  { name: 'Mobility 10 min', icon: 'mobility', target: 10, unit: 'min' },
];

const demoHabitIds: string[] = [];
for (const h of HABITS) {
  const habitId = id('hbt');
  demoHabitIds.push(habitId);
  db.insert(schema.habits)
    .values({
      id: habitId,
      tenantId,
      memberId: demoMember.memberId,
      name: h.name,
      icon: h.icon,
      cadence: 'daily',
      target: h.target,
      unit: h.unit,
      active: true,
      createdAt: NOW - 120 * DAY,
    })
    .run();

  for (let d = 30; d >= 0; d--) {
    if (!rng.chance(0.72)) continue;
    const onDate = addDays(TODAY, -d);
    db.insert(schema.habitLogs)
      .values({
        id: id('hbl'),
        tenantId,
        habitId,
        memberId: demoMember.memberId,
        onDate,
        value: h.target * (rng.chance(0.8) ? 1 : 0.6),
        clientId: `seed-${habitId}-${onDate}`,
        loggedAt: Date.parse(`${onDate}T21:00:00Z`),
      })
      .run();
  }
}

for (let d = 30; d >= 0; d--) {
  const onDate = addDays(TODAY, -d);
  db.insert(schema.dailyMetrics)
    .values({
      id: id('dmt'),
      tenantId,
      memberId: demoMember.memberId,
      onDate,
      waterMl: rng.int(1500, 3600),
      sleepMin: rng.int(330, 500),
      steps: rng.int(4200, 13500),
      kcal: rng.int(2100, 2900),
      proteinG: rng.int(110, 175),
      carbsG: rng.int(180, 320),
      fatG: rng.int(55, 95),
      mood: rng.int(3, 5),
      energy: rng.int(2, 5),
      soreness: rng.int(1, 4),
      lastSource: rng.chance(0.4) ? 'health_connect' : 'manual',
      duplicateSource: null,
      updatedAt: Date.parse(`${onDate}T22:00:00Z`),
    })
    .run();
}

db.insert(schema.nutritionTargets)
  .values({
    id: id('ntr'),
    tenantId,
    memberId: demoMember.memberId,
    enabled: true,
    kcal: 2600,
    proteinG: 150,
    carbsG: 280,
    fatG: 80,
    waterTargetMl: 3000,
    setById: coachRehan.staffId,
    setByName: coachRehan.name,
    safetyFlag: null,
    exclusions: ['beef'],
    allergies: ['shellfish'],
    updatedAt: NOW - 20 * DAY,
  })
  .run();

for (let w = 5; w >= 0; w--) {
  const weekStart = startOfWeek(addDays(TODAY, -w * 7));
  db.insert(schema.weeklyCheckIns)
    .values({
      id: id('wci'),
      tenantId,
      memberId: demoMember.memberId,
      weekStart,
      adherence: w === 0 ? null : rng.int(3, 5),
      energy: w === 0 ? null : rng.int(2, 5),
      hunger: w === 0 ? null : rng.int(2, 4),
      sleep: w === 0 ? null : rng.int(2, 5),
      soreness: w === 0 ? null : rng.int(2, 4),
      mood: w === 0 ? null : rng.int(3, 5),
      note: w === 0 ? '' : rng.pick([
        'Good week. Sleep was the weak point.',
        'Travel Thursday and Friday, made up Saturday.',
        'Legs felt heavy all week but the sessions went in.',
        'Best week in a while.',
      ]),
      submittedAt: w === 0 ? null : Date.parse(`${addDays(weekStart, 6)}T19:00:00Z`),
      coachReply: w > 1 && rng.chance(0.6) ? 'Noted — keeping volume where it is and we push again next week.' : null,
      coachRepliedAt: w > 1 ? Date.parse(`${addDays(weekStart, 7)}T09:00:00Z`) : null,
      safetyEscalated: false,
      safetySignals: [],
    })
    .run();
}

console.log('  progress, habits, nutrition');

/* ============================================================================
   Gamification
   ========================================================================= */

for (const a of ACHIEVEMENTS_SEED) {
  db.insert(schema.achievements)
    .values({
      id: `ach_${a.code}`,
      code: a.code,
      name: a.name,
      description: a.description,
      tier: a.tier,
      criteria: {},
    })
    .run();
}

for (const m of membersSeeded) {
  const dates = db
    .select({ startedAt: schema.workouts.startedAt })
    .from(schema.workouts)
    .where(sql`${schema.workouts.memberId} = ${m.memberId}`)
    .all()
    .map((r) => isoDate(r.startedAt, TZ));

  const streak = computeStreak({ sessionDates: dates, today: TODAY, weeklyTarget: 4, restDaysAllowed: 2 });

  db.insert(schema.streaksTable)
    .values({
      memberId: m.memberId,
      tenantId,
      current: streak.current,
      longest: streak.longest,
      weeklyTarget: 4,
      restDaysAllowed: 2,
      lastSessionOn: streak.lastSessionOn,
      updatedAt: NOW,
    })
    .run();

  // XP from the sessions that actually happened, so the ledger reconciles.
  dates.forEach((d, index) => {
    db.insert(schema.xpLedger)
      .values({
        id: id('xpl'),
        tenantId,
        memberId: m.memberId,
        delta: XP_AWARDS.workout_completed,
        reason: 'workout_completed',
        refType: 'workout',
        refId: `${m.memberId}-${d}-${index}`,
        isCorrection: false,
        at: Date.parse(`${d}T20:00:00Z`),
      })
      .onConflictDoNothing()
      .run();
  });

  for (const code of ['first_session', 'ten_sessions'] as const) {
    if (dates.length >= (code === 'first_session' ? 1 : 10)) {
      db.insert(schema.memberAchievements)
        .values({
          id: id('mac'),
          tenantId,
          memberId: m.memberId,
          achievementId: `ach_${code}`,
          earnedAt: NOW - rng.int(20, 300) * DAY,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

// Top the demo member up so the level sits at Tiger, matching the prototype.
db.insert(schema.xpLedger)
  .values({
    id: id('xpl'),
    tenantId,
    memberId: demoMember.memberId,
    delta: 3200,
    reason: 'historical_import',
    refType: 'import',
    refId: 'legacy-2025',
    isCorrection: false,
    at: NOW - 200 * DAY,
  })
  .run();

const challengeId = id('chl');
db.insert(schema.challenges)
  .values({
    id: challengeId,
    tenantId,
    branchId: 'br_kor',
    name: 'Deep Water Challenge',
    description: 'A team target across the whole month. Ranked on sessions attended — not on what you lifted.',
    metric: 'team_sessions',
    metricLabel: 'sessions',
    startsOn: addDays(TODAY, -26),
    endsOn: addDays(TODAY, 4),
    visibility: 'branch',
    teamMode: true,
    teamTarget: 180,
    rules: [
      'Every logged session at Koramangala counts once.',
      'Ranked on sessions attended. Volume lifted and body metrics are never ranked.',
      'Join at any point — scores are compared on rate, so a late start is not a loss.',
      'You can keep your name off the board and still take part.',
    ],
    rewardLabel: '₹1,000 store credit each for the winning squad',
    createdAt: NOW - 30 * DAY,
  })
  .run();

const contenders = rng.shuffle(membersSeeded.filter((m) => m.branchId === 'br_kor')).slice(0, 22);
const boardScores = new Map<string, number>([
  [demoMember.memberId, 4610],
]);

for (const m of contenders) {
  if (m.memberId === demoMember.memberId) continue;
  boardScores.set(m.memberId, rng.int(2100, 4900));
}
boardScores.set(contenders[0]?.memberId ?? demoMember.memberId, 4820);

for (const [memberId, score] of boardScores) {
  db.insert(schema.challengeParticipants)
    .values({
      id: id('chp'),
      tenantId,
      challengeId,
      memberId,
      teamId: rng.pick(['team_reef', 'team_trench', 'team_depot']),
      rawCount: Math.round(score / 260),
      score,
      joinedAt: NOW - rng.int(5, 26) * DAY,
      anonymous: rng.chance(0.12),
      flagged: false,
    })
    .onConflictDoNothing()
    .run();
}

db.insert(schema.referrals)
  .values([
    {
      id: id('ref'),
      tenantId,
      memberId: demoMember.memberId,
      code: referralCode(demoMember.firstName),
      inviteeName: 'Karan S.',
      inviteeContact: 'karan@example.com',
      state: 'joined',
      rewardMinor: 50_000,
      rewardPaidAt: NOW - 40 * DAY,
      expiresOn: addDays(TODAY, 60),
      deviceFingerprint: null,
      suspiciousReason: null,
      createdAt: NOW - 50 * DAY,
    },
    {
      id: id('ref'),
      tenantId,
      memberId: demoMember.memberId,
      code: referralCode(demoMember.firstName),
      inviteeName: 'Ritu P.',
      inviteeContact: 'ritu@example.com',
      state: 'joined',
      rewardMinor: 50_000,
      rewardPaidAt: null,
      expiresOn: addDays(TODAY, 60),
      deviceFingerprint: null,
      suspiciousReason: null,
      createdAt: NOW - 18 * DAY,
    },
    {
      id: id('ref'),
      tenantId,
      memberId: demoMember.memberId,
      code: referralCode(demoMember.firstName),
      inviteeName: 'Sahil M.',
      inviteeContact: '+91 98765 43210',
      state: 'invited',
      rewardMinor: 50_000,
      rewardPaidAt: null,
      expiresOn: addDays(TODAY, 60),
      deviceFingerprint: null,
      suspiciousReason: null,
      createdAt: NOW - 4 * DAY,
    },
  ])
  .run();

console.log('  gamification');

/* ============================================================================
   Community, messaging, media
   ========================================================================= */

const FEED = [
  {
    member: membersSeeded.find((m) => m.name.startsWith('Meera'))!,
    kind: 'pr',
    badge: 'PR',
    body: 'Deadlift 120 kg × 5. Took four months to get back here after the knee thing.',
    hoursAgo: 0.7,
    kudos: 24,
  },
  {
    member: membersSeeded.find((m) => m.name.startsWith('Rhea'))!,
    kind: 'text',
    badge: null,
    body: 'Six weeks of the 6:30 HIIT and I no longer want to lie down afterwards. Progress.',
    hoursAgo: 5,
    kudos: 11,
  },
  {
    member: membersSeeded.find((m) => m.name.startsWith('Siddharth'))!,
    kind: 'workout',
    badge: null,
    body: 'First full pull day without dropping a set. Rows finally clicking.',
    hoursAgo: 26,
    kudos: 8,
  },
  {
    member: membersSeeded.find((m) => m.name.startsWith('Nikita'))!,
    kind: 'text',
    badge: null,
    body: 'Anyone else find the 8pm boxing class the best hour of the week?',
    hoursAgo: 40,
    kudos: 15,
  },
];

for (const post of FEED) {
  if (!post.member) continue;
  const postId = id('pst');
  db.insert(schema.posts)
    .values({
      id: postId,
      tenantId,
      branchId: post.member.branchId,
      memberId: post.member.memberId,
      staffId: null,
      authorKind: 'member',
      kind: post.kind,
      body: post.body,
      badge: post.badge,
      refType: null,
      refId: null,
      visibility: 'branch',
      state: 'visible',
      kudosCount: post.kudos,
      commentCount: post.kind === 'pr' ? 3 : 0,
      createdAt: NOW - post.hoursAgo * HOUR,
      deletedAt: null,
    })
    .run();

  if (post.kind === 'pr') {
    for (const body of [
      'That is a proper comeback. Well done.',
      'Strong. What did the rehab block look like?',
      'Four months of doing the boring bits right.',
    ]) {
      db.insert(schema.comments)
        .values({
          id: id('cmt'),
          tenantId,
          postId,
          memberId: rng.pick(membersSeeded).memberId,
          body,
          state: 'visible',
          createdAt: NOW - post.hoursAgo * HOUR + rng.int(5, 90) * MINUTE,
          deletedAt: null,
        })
        .run();
    }
  }
}

db.insert(schema.posts)
  .values({
    id: id('pst'),
    tenantId,
    branchId: 'br_kor',
    memberId: null,
    staffId: owner.staffId,
    authorKind: 'gym',
    kind: 'announcement',
    body: 'Cycle studio is closed Sunday 10 August for floor work. Spin classes move to Studio 2 at the same times.',
    badge: null,
    refType: null,
    refId: null,
    visibility: 'branch',
    state: 'visible',
    kudosCount: 4,
    commentCount: 0,
    createdAt: NOW - 30 * HOUR,
    deletedAt: null,
  })
  .run();

const coachConversationId = id('cnv');
db.insert(schema.conversations)
  .values({
    id: coachConversationId,
    tenantId,
    kind: 'coach',
    title: coachRehan.name,
    memberId: demoMember.memberId,
    staffId: coachRehan.staffId,
    ticketId: null,
    state: 'open',
    muted: false,
    lastMessageAt: NOW - 2 * HOUR,
    createdAt: NOW - 300 * DAY,
  })
  .run();

const THREAD: Array<[string, 'coach' | 'member', number]> = [
  ['How did the squat session land on Tuesday?', 'coach', 72],
  ['Solid. Last set was an honest 8, no grinding.', 'member', 71],
  ['Good. Leaving the load there one more week then.', 'coach', 70],
  [
    'Bench felt easy last week — I have moved sets 3 and 4 to 65 kg. Keep the last rep clean and tell me the RPE.',
    'coach',
    2,
  ],
];

for (const [body, who, hoursAgo] of THREAD) {
  db.insert(schema.messages)
    .values({
      id: id('msg'),
      tenantId,
      conversationId: coachConversationId,
      senderUserId: who === 'coach' ? coachRehan.userId : demoMember.userId,
      senderName: who === 'coach' ? coachRehan.name : demoMember.name,
      senderRole: who === 'coach' ? 'trainer' : 'member',
      body,
      attachments: [],
      state: 'read',
      clientId: null,
      createdAt: NOW - hoursAgo * HOUR,
      readAt: NOW - hoursAgo * HOUR + 20 * MINUTE,
      safetyFlagged: false,
    })
    .run();
}

const receptionConversationId = id('cnv');
db.insert(schema.conversations)
  .values({
    id: receptionConversationId,
    tenantId,
    kind: 'reception',
    title: 'Koramangala reception',
    memberId: demoMember.memberId,
    staffId: reception.staffId,
    ticketId: null,
    state: 'open',
    muted: false,
    lastMessageAt: NOW - 5 * DAY,
    createdAt: NOW - 30 * DAY,
  })
  .run();

db.insert(schema.messages)
  .values({
    id: id('msg'),
    tenantId,
    conversationId: receptionConversationId,
    senderUserId: reception.userId,
    senderName: reception.name,
    senderRole: 'reception',
    body: 'Your guest pass for Saturday is on the system. Just bring them to the desk.',
    attachments: [],
    state: 'read',
    clientId: null,
    createdAt: NOW - 5 * DAY,
    readAt: NOW - 5 * DAY + HOUR,
    safetyFlagged: false,
  })
  .run();

db.insert(schema.tickets)
  .values([
    {
      id: id('tkt'),
      tenantId,
      branchId: 'br_kor',
      memberId: demoMember.memberId,
      reference: 'SUP-1042',
      category: 'facility',
      subject: 'Shower 3 running cold',
      priority: 'normal',
      state: 'resolved',
      assigneeId: reception.staffId,
      slaDueAt: NOW - 8 * DAY,
      resolution: 'Thermostat replaced on 30 July.',
      anonymous: false,
      escalated: false,
      openedAt: NOW - 10 * DAY,
      lastUpdateAt: NOW - 8 * DAY,
      closedAt: NOW - 8 * DAY,
    },
    {
      id: id('tkt'),
      tenantId,
      branchId: 'br_kor',
      memberId: rng.pick(membersSeeded).memberId,
      reference: 'SUP-1051',
      category: 'billing',
      subject: 'Charged twice in July',
      priority: 'high',
      state: 'open',
      assigneeId: null,
      slaDueAt: NOW + 4 * HOUR,
      resolution: null,
      anonymous: false,
      escalated: false,
      openedAt: NOW - 20 * HOUR,
      lastUpdateAt: NOW - 20 * HOUR,
      closedAt: null,
    },
    {
      id: id('tkt'),
      tenantId,
      branchId: 'br_ind',
      memberId: null,
      reference: 'SUP-1053',
      category: 'complaint',
      subject: 'Conduct in the free weights area',
      priority: 'urgent',
      state: 'open',
      assigneeId: owner.staffId,
      slaDueAt: NOW + 2 * HOUR,
      resolution: null,
      anonymous: true,
      escalated: true,
      openedAt: NOW - 6 * HOUR,
      lastUpdateAt: NOW - 6 * HOUR,
      closedAt: null,
    },
  ])
  .run();

for (const asset of MEDIA_SEED) {
  db.insert(schema.mediaAssets)
    .values({
      id: id('med'),
      tenantId,
      title: asset.title,
      category: asset.category,
      trainerName: asset.trainer,
      durationSec: asset.min * 60,
      level: asset.level,
      equipment: rng.pick([[], ['Dumbbells'], ['Mat'], ['Rower']]),
      posterColor: rng.pick(['#0b2331', '#123243', '#0e2c3c', '#102a38']),
      hasCaptions: rng.chance(0.8),
      requiredProductKinds: rng.chance(0.3) ? ['membership', 'digital'] : [],
      // Video quota is zero on this plan; the library still lists and explains.
      playbackUrl: null,
      publishedAt: NOW - rng.int(5, 200) * DAY,
      expiresAt: null,
    })
    .run();
}

db.insert(schema.usageMeters)
  .values([
    { id: id('usg'), tenantId, meter: 'video_minutes', period: TODAY.slice(0, 7), used: 0, limitValue: 0, updatedAt: NOW },
    { id: id('usg'), tenantId, meter: 'sms', period: TODAY.slice(0, 7), used: 418, limitValue: 2000, updatedAt: NOW },
    { id: id('usg'), tenantId, meter: 'ai_calls', period: TODAY.slice(0, 7), used: 62, limitValue: 500, updatedAt: NOW },
  ])
  .run();

console.log('  community, messaging, media');

/* ============================================================================
   Leads, store, facility, notifications
   ========================================================================= */

const LEAD_SOURCES = ['walk_in', 'web_form', 'referral', 'campaign', 'trial', 'call'] as const;
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'trial_booked', 'trial_completed', 'nurture', 'won', 'lost'] as const;

for (let i = 0; i < 34; i++) {
  const stage = rng.pick(LEAD_STAGES);
  const createdAt = NOW - rng.int(1, 60) * DAY;
  const lastTouched = rng.chance(0.75) ? createdAt + rng.int(1, 40) * HOUR : null;
  const leadId = id('led');
  const name = `${rng.pick(['Aarav', 'Isha', 'Kabir', 'Myra', 'Reyansh', 'Saanvi', 'Vivaan', 'Diya', 'Advik', 'Anika'])} ${rng.pick(['Sharma', 'Rao', 'Nair', 'Patel', 'Bose', 'Khanna', 'Jain'])}`;
  const phone = `+91 9${rng.int(100000000, 899999999)}`;

  db.insert(schema.leads)
    .values({
      id: leadId,
      tenantId,
      branchId: rng.pick(BRANCHES).id,
      name,
      phone,
      email: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
      phoneNormalized: normalizePhone(phone),
      emailNormalized: normalizeEmail(`${name.split(' ')[0]!.toLowerCase()}@example.com`),
      source: rng.pick(LEAD_SOURCES),
      campaign: rng.chance(0.4) ? rng.pick(['aug-transformation', 'google-search', 'insta-reels']) : null,
      stage,
      ownerId: rng.chance(0.8) ? rng.pick([reception.staffId, ...TRAINERS.map((t) => t.staffId)]) : null,
      expectedValueMinor: rng.pick([299_900, 2_499_00, 599_900]),
      nextActionAt: stage === 'won' || stage === 'lost' ? null : NOW + rng.int(-72, 96) * HOUR,
      nextActionLabel: stage === 'won' || stage === 'lost' ? null : rng.pick(['Call back', 'Send plan options', 'Book a tour', 'Follow up on trial']),
      lastTouchedAt: lastTouched,
      lossReason: stage === 'lost' ? rng.pick(['Price', 'Moved away', 'Chose another gym', 'No response']) : null,
      convertedMemberId: null,
      duplicateOfId: null,
      tags: [],
      createdAt,
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.leadActivities)
    .values({
      id: id('lac'),
      tenantId,
      leadId,
      kind: 'note',
      body: rng.pick([
        'Walked in asking about evening classes.',
        'Wants to start after their exams finish.',
        'Comparing us with the place across the road.',
        'Referred by an existing member.',
      ]),
      actorId: reception.staffId,
      actorName: reception.name,
      fromStage: null,
      toStage: null,
      at: createdAt + HOUR,
    })
    .run();
}

for (const p of RETAIL) {
  const productId = id('rtl');
  db.insert(schema.retailProducts)
    .values({
      id: productId,
      tenantId,
      name: p.name,
      sku: p.sku,
      barcode: `890${rng.int(1000000000, 9999999999)}`,
      category: p.category,
      priceMinor: p.price,
      costMinor: p.cost,
      taxRateBp: 1800,
      reorderAt: 6,
      active: true,
      createdAt: NOW - 200 * DAY,
    })
    .run();

  for (const b of BRANCHES) {
    db.insert(schema.stockLedger)
      .values({
        id: id('stk'),
        tenantId,
        branchId: b.id,
        productId,
        delta: rng.int(12, 45),
        reason: 'purchase',
        refType: null,
        refId: null,
        actorName: reception.name,
        note: 'Opening stock',
        at: NOW - 200 * DAY,
      })
      .run();

    // Sales, so a couple of lines fall under the reorder threshold.
    const sold = rng.int(8, 40);
    db.insert(schema.stockLedger)
      .values({
        id: id('stk'),
        tenantId,
        branchId: b.id,
        productId,
        delta: -sold,
        reason: 'sale',
        refType: null,
        refId: null,
        actorName: reception.name,
        note: null,
        at: NOW - rng.int(1, 60) * DAY,
      })
      .run();
  }
}

for (const b of BRANCHES) {
  EQUIPMENT_SEED.forEach((e, index) => {
    const equipmentId = id('eqp');
    const lastServiced = addDays(TODAY, -rng.int(20, 160));
    db.insert(schema.equipment)
      .values({
        id: equipmentId,
        tenantId,
        branchId: b.id,
        name: e.name,
        assetTag: `${b.slug.slice(0, 3).toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
        area: e.area,
        model: e.model,
        serial: `SN${rng.int(100000, 999999)}`,
        vendor: e.vendor,
        warrantyUntil: addDays(TODAY, rng.int(-120, 600)),
        status: rng.chance(0.08) ? 'in_maintenance' : 'available',
        lastServicedOn: lastServiced,
        serviceIntervalDays: 90,
        linkedExerciseId: exerciseIdBySlug.get(e.exercise) ?? null,
        createdAt: NOW - 400 * DAY,
      })
      .run();

    if (b.id === 'br_kor' && index < 3) {
      db.insert(schema.workOrders)
        .values({
          id: id('wrk'),
          tenantId,
          branchId: b.id,
          reference: `WO-${1200 + index}`,
          equipmentId,
          title: rng.pick(['Cable fraying at the pulley', 'Bench pad torn', 'Bearing noise under load']),
          description: 'Reported from the floor. Taped off until it is looked at.',
          severity: index === 0 ? 'safety' : 'medium',
          state: index === 0 ? 'assigned' : 'open',
          reportedById: index === 0 ? demoMember.userId : reception.userId,
          reportedByName: index === 0 ? demoMember.name : reception.name,
          reportedByKind: index === 0 ? 'member' : 'staff',
          assigneeId: index === 0 ? reception.staffId : null,
          costMinor: 0,
          duplicateOfId: null,
          openedAt: NOW - rng.int(2, 40) * HOUR,
          closedAt: null,
        })
        .run();
    }
  });

  db.insert(schema.facilityTasks)
    .values([
      {
        id: id('fct'),
        tenantId,
        branchId: b.id,
        title: 'Opening checks',
        cadence: 'daily',
        nextDueAt: NOW + 6 * HOUR,
        assigneeId: reception.staffId,
        state: 'open',
        checklist: ['Floor walk', 'Sanitiser stations', 'Music and AC', 'Reception float'],
        lastCompletedAt: NOW - 18 * HOUR,
      },
      {
        id: id('fct'),
        tenantId,
        branchId: b.id,
        title: 'Deep clean — changing rooms',
        cadence: 'weekly',
        nextDueAt: NOW - 12 * HOUR,
        assigneeId: null,
        state: 'open',
        checklist: ['Showers', 'Lockers', 'Drains', 'Restock'],
        lastCompletedAt: NOW - 8 * DAY,
      },
    ])
    .run();
}

db.insert(schema.notifications)
  .values([
    {
      id: id('ntf'),
      tenantId,
      userId: demoMember.userId,
      channel: 'in_app',
      kind: 'coach',
      title: 'Rehan updated your bench',
      body: 'Top set moved to 65 kg for this week. Tap to see why.',
      link: '/train',
      templateCode: null,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: NOW - 2 * HOUR,
      readAt: null,
    },
    {
      id: id('ntf'),
      tenantId,
      userId: demoMember.userId,
      channel: 'in_app',
      kind: 'class',
      title: 'Apex HIIT tonight at 19:00',
      body: 'Studio 2 with Nikhil. Free cancellation until 17:00.',
      link: '/book',
      templateCode: null,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: NOW - 9 * HOUR,
      readAt: null,
    },
    {
      id: id('ntf'),
      tenantId,
      userId: demoMember.userId,
      channel: 'in_app',
      kind: 'challenge',
      title: 'Four days left in Deep Water',
      body: 'Your squad is 12 sessions short of the target.',
      link: '/pack',
      templateCode: null,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: NOW - 26 * HOUR,
      readAt: NOW - 20 * HOUR,
    },
    {
      id: id('ntf'),
      tenantId,
      userId: graceMember.userId,
      channel: 'in_app',
      kind: 'payment',
      title: 'A payment did not go through',
      body: 'Your renewal of ₹2,999 failed on 1 August. Entry needs this settled.',
      link: '/billing',
      templateCode: null,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: NOW - 4 * DAY,
      readAt: null,
    },
  ])
  .run();

db.insert(schema.automations)
  .values([
    {
      id: id('aut'),
      tenantId,
      name: 'Welcome sequence',
      trigger: 'member.joined',
      description: 'Three messages over the first two weeks, then stop.',
      conditions: [{ field: 'lifecycle', op: 'eq', value: 'active' }],
      actions: [
        { kind: 'message', templateCode: 'welcome_day0', delayMin: 0 },
        { kind: 'message', templateCode: 'welcome_day3', delayMin: 4320 },
        { kind: 'task', templateCode: null, delayMin: 20160 },
      ],
      quietHours: { from: '21:00', to: '08:00' },
      state: 'active',
      dryRun: false,
      runsLast30: 12,
      lastRunAt: NOW - 2 * DAY,
      createdAt: NOW - 200 * DAY,
      updatedAt: NOW - 30 * DAY,
    },
    {
      id: id('aut'),
      tenantId,
      name: 'Quiet member check-in',
      trigger: 'member.absent_14d',
      description: 'One message from their own coach. Never automated twice.',
      conditions: [
        { field: 'riskBand', op: 'in', value: 'watch,high' },
        { field: 'hasOpenComplaint', op: 'eq', value: 'false' },
      ],
      actions: [{ kind: 'task', templateCode: null, delayMin: 0 }],
      quietHours: { from: '21:00', to: '08:00' },
      state: 'active',
      dryRun: false,
      runsLast30: 7,
      lastRunAt: NOW - 20 * HOUR,
      createdAt: NOW - 120 * DAY,
      updatedAt: NOW - 12 * DAY,
    },
    {
      id: id('aut'),
      tenantId,
      name: 'Renewal reminder',
      trigger: 'membership.expiring_14d',
      description: 'Draft — not sending yet.',
      conditions: [{ field: 'autoRenew', op: 'eq', value: 'false' }],
      actions: [{ kind: 'message', templateCode: 'renewal_14d', delayMin: 0 }],
      quietHours: { from: '21:00', to: '08:00' },
      state: 'draft',
      dryRun: true,
      runsLast30: 0,
      lastRunAt: null,
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 10 * DAY,
    },
  ])
  .run();

db.insert(schema.messageTemplates)
  .values([
    {
      id: id('tpl'), tenantId, code: 'welcome_day0', channel: 'email', version: 1, locale: 'en',
      subject: 'Welcome to Shark Fitness, {{firstName}}',
      body: 'Your membership is live. Your entry code lives in the app — open it at the door and you are in.',
      variables: ['firstName'], updatedAt: NOW - 200 * DAY,
    },
    {
      id: id('tpl'), tenantId, code: 'welcome_day3', channel: 'in_app', version: 1, locale: 'en',
      subject: null,
      body: 'Three days in. Want a coach to put a plan together? Reply here and we will sort it.',
      variables: [], updatedAt: NOW - 200 * DAY,
    },
    {
      id: id('tpl'), tenantId, code: 'payment_failed', channel: 'email', version: 2, locale: 'en',
      subject: 'A payment did not go through',
      body: 'Your payment of {{amount}} on {{date}} did not go through. You can settle it in the app or at reception. Your bookings are kept until {{graceEnds}}.',
      variables: ['amount', 'date', 'graceEnds'], updatedAt: NOW - 60 * DAY,
    },
    {
      id: id('tpl'), tenantId, code: 'renewal_14d', channel: 'email', version: 1, locale: 'en',
      subject: 'Your membership ends on {{endsOn}}',
      body: 'Nothing to do if you want to carry on — auto-renew is off, so it will simply end. Renew in the app whenever suits.',
      variables: ['endsOn'], updatedAt: NOW - 10 * DAY,
    },
  ])
  .run();

/* ============================================================================
   Derived risk scores
   ========================================================================= */

for (const m of membersSeeded) {
  const visits = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(sql`${schema.checkIns.memberId} = ${m.memberId} and ${schema.checkIns.decision} = 'granted'`)
    .all();

  const weekly: [number, number, number, number] = [0, 0, 0, 0];
  for (const v of visits) {
    const weeksAgo = Math.floor((NOW - v.enteredAt) / (7 * DAY));
    if (weeksAgo >= 0 && weeksAgo < 4) weekly[weeksAgo as 0]! += 1;
  }
  const older = visits.filter((v) => NOW - v.enteredAt >= 28 * DAY && NOW - v.enteredAt < 84 * DAY).length;
  const lastVisit = visits.length ? Math.max(...visits.map((v) => v.enteredAt)) : null;

  const failed = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.payments)
    .where(sql`${schema.payments.memberId} = ${m.memberId} and ${schema.payments.state} = 'failed'`)
    .get();

  const risk = retentionRisk({
    weeklySessions: weekly,
    baselineWeekly: older / 8,
    daysSinceLastVisit: lastVisit ? Math.floor((NOW - lastVisit) / DAY) : null,
    hasFailedPayment: (failed?.n ?? 0) > 0,
    daysUntilExpiry: Math.round((Date.parse(`${m.endsOn}T00:00:00Z`) - NOW) / DAY),
    autoRenew: true,
    unansweredCoachMessages: 0,
    openComplaints: 0,
    branchClosedWeeks: 0,
    daysSinceJoined: Math.floor((NOW - Date.parse(`${m.joinedOn}T00:00:00Z`)) / DAY),
  });

  db.update(schema.members)
    .set({ riskScore: risk.score, riskReasons: risk.reasons })
    .where(sql`${schema.members.id} = ${m.memberId}`)
    .run();
}

/* ============================================================================
   Summary
   ========================================================================= */

const level = levelFor(
  db
    .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
    .from(schema.xpLedger)
    .where(sql`${schema.xpLedger.memberId} = ${demoMember.memberId}`)
    .get()?.total ?? 0,
);

const benchBest = Math.max(
  ...db
    .select({ w: schema.workoutSets.weightKg, r: schema.workoutSets.reps })
    .from(schema.workoutSets)
    .where(sql`${schema.workoutSets.memberId} = ${demoMember.memberId} and ${schema.workoutSets.exerciseId} = ${benchId}`)
    .all()
    .map((s) => estimate1rm(s.w, s.r) ?? 0),
  0,
);

console.log('');
console.log('seed complete');
console.log(`  tenant       Shark Fitness (${BRANCHES.length} branches)`);
console.log(`  members      ${membersSeeded.length}`);
console.log(`  sessions     ${sessionsSeeded.length} classes over 21 days`);
console.log(`  demo member  ${demoMember.name} · ${DEMO.memberNo} · ${DEMO.email}`);
console.log(`               level ${level.level} ${level.name}, ${demoHistory.sessionDates.length} sessions logged, est. bench 1RM ${benchBest.toFixed(1)} kg`);
console.log(`  grace demo   ${graceMember.name} · rohit@sharkfitness.in (failed payment ${graceInvoiceId})`);
console.log(`  staff logins owner@ / manager@ / reception@ / rehan@ / nikhil@ / priya@ / accounts@ sharkfitness.in`);
console.log(`  password     shark1234 (staff + demo members); everyone else is OTP-only`);
console.log(`  rdl exercise ${rdlId}`);
console.log('');

sqlite.close();
