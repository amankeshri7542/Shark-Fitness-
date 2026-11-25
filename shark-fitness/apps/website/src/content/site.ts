import type { PublicBranch, PublicPlan, PublicSite, PublicWeekday } from '@shark/contracts';
import snapshotJson from './snapshot.json';

/**
 * Everything the website says, in one typed place.
 *
 * Two sources, deliberately separate:
 *
 * - `snapshot.json` is what the gym's own system publishes: branches, hours,
 *   holidays, published plans with GST-inclusive prices, and the weekly class
 *   pattern. Refresh it with `pnpm -F @shark/website sync-content -- --api <url>`;
 *   never edit it by hand. Plans and the timetable are re-fetched live in the
 *   browser, so the built copy is only the fallback.
 * - The rest of this file is copy and facts the system does not hold:
 *   postcodes and map positions, coach profiles, class descriptions, FAQs.
 *   Edit it here; docs/WEBSITE.md explains each block.
 */

export interface WeeklySlot {
  day: PublicWeekday;
  startTime: string;
  endTime: string;
  name: string;
  category: string;
  level: string;
  coach: string | null;
  durationMin: number;
}

export interface Snapshot {
  tenantSlug: string;
  syncedAt: string;
  site: PublicSite;
  timetable: Record<string, WeeklySlot[]>;
}

export const snapshot = snapshotJson as Snapshot;
export const site = snapshot.site;

/** The privacy notice version the forms record consent against. Raise it whenever privacy.astro changes. */
export const PRIVACY_NOTICE_VERSION = 'web-2026-11';
export const PRIVACY_NOTICE_UPDATED = '25 November 2026';

export const brand = {
  name: site.tenant.displayName,
  legalName: 'Shark Fitness Private Limited',
  city: 'Bengaluru',
  phone: site.branches[0]?.phone ?? '+91 80 4000 1000',
  email: 'hello@sharkfitness.in',
  privacyEmail: site.tenant.privacyContact ?? 'privacy@sharkfitness.in',
  /** Sameness across pages: one sentence the site can stand behind. */
  promise: 'Three gyms in south-east Bengaluru, coached classes every day, and a free first week to see if it fits.',
};

/* ——— Branches ———————————————————————————————————————————————— */

export interface BranchExtra {
  /** Shown in headings: the neighbourhood people search for. */
  area: string;
  postalCode: string;
  region: string;
  geo: { lat: number; lng: number };
  landmark: string;
  /** One honest paragraph about what is different here. */
  summary: string;
  gettingThere: string[];
  floor: string[];
}

export const branchExtras: Record<string, BranchExtra> = {
  koramangala: {
    area: 'Koramangala',
    postalCode: '560095',
    region: 'Karnataka',
    geo: { lat: 12.9352, lng: 77.6245 },
    landmark: 'On 80 Feet Road, a two-minute walk from Sony World Signal.',
    summary:
      'Our biggest floor and the original Depot: four power racks, two deadlift platforms, a full cable zone and the busiest class timetable. Strength Clinic was born here.',
    gettingThere: [
      'Bus stops on 80 Feet Road (Sony World) and Koramangala Water Tank are both under five minutes away.',
      'Basement parking for 30 cars and covered two-wheeler parking. Free for members.',
    ],
    floor: ['4 power racks and 2 deadlift platforms', 'Cable zone and plate-loaded machines', 'Cycle studio with 20 bikes', 'Sauna, lockers and showers'],
  },
  indiranagar: {
    area: 'Indiranagar',
    postalCode: '560008',
    region: 'Karnataka',
    geo: { lat: 12.9719, lng: 77.6412 },
    landmark: 'On 12th Main, HAL 2nd Stage, above the Indiranagar 100 Feet Road junction.',
    summary:
      'The Reef has the only pool in the group, so it is where the Open Water Swim sessions run. Quieter mornings, busy evenings, and a café that does a decent cold brew.',
    gettingThere: [
      'Indiranagar metro station (Purple Line) is a 12-minute walk.',
      'Street parking on 12th Main; two-wheeler parking in front.',
    ],
    floor: ['12-metre training pool', 'Free weights to 50 kg dumbbells', 'Two class studios', 'Café, lockers and showers'],
  },
  hsr: {
    area: 'HSR Layout',
    postalCode: '560102',
    region: 'Karnataka',
    geo: { lat: 12.9121, lng: 77.6446 },
    landmark: 'On 27th Main, Sector 2, opposite the BDA complex.',
    summary:
      'The Trench is our smallest and friendliest floor, popular with people training before work. Fewer machines, more coaching, and nobody waiting for a rack after 9 am.',
    gettingThere: [
      'Buses along 27th Main stop right outside; Agara Lake is five minutes away.',
      'Parking for 12 cars and plenty of two-wheeler space.',
    ],
    floor: ['2 power racks and a lifting platform', 'Rowers, air bikes and treadmills', 'Studio for classes up to 18', 'Sauna, lockers and showers'],
  },
};

export function branchExtra(branch: PublicBranch): BranchExtra {
  return (
    branchExtras[branch.slug] ?? {
      area: branch.name,
      postalCode: '',
      region: 'Karnataka',
      geo: { lat: 12.97, lng: 77.59 },
      landmark: branch.addressLine,
      summary: `${branch.name} in ${branch.city}.`,
      gettingThere: [],
      floor: branch.amenities,
    }
  );
}

/** Koramangala first: it is the flagship, then the others by name. */
export const branches: PublicBranch[] = [...site.branches].sort((a, b) =>
  a.slug === 'koramangala' ? -1 : b.slug === 'koramangala' ? 1 : a.name.localeCompare(b.name),
);

/* ——— Plans ———————————————————————————————————————————————————— */

export const plans: PublicPlan[] = site.plans;

/** What each published plan is *for*, in a line. Keyed by product id; plans without a line still render. */
export const planNotes: Record<string, { bestFor: string; includes: string[] }> = {
  prd_elite_annual: {
    bestFor: 'Training four or more times a week, at more than one branch.',
    includes: ['Every branch, every day', 'All classes included', 'Priority class booking', 'Two guest passes a month', 'Freeze up to 60 days'],
  },
  prd_monthly: {
    bestFor: 'One home gym and the freedom to stop after any month.',
    includes: ['Gym floor at Koramangala', 'Classes booked separately', 'Freeze up to 14 days', '7 days’ notice to cancel'],
  },
  prd_offpeak: {
    bestFor: 'Flexible days and a quieter floor.',
    includes: ['Weekdays, 10 am to 4 pm', 'Koramangala and HSR Layout', '7 days’ notice to cancel'],
  },
  prd_class_10: {
    bestFor: 'Coming mainly for classes.',
    includes: ['Ten class credits', 'Any branch', 'Valid for six months', 'Unused credits refundable within 14 days'],
  },
  prd_pt_10: {
    bestFor: 'A plan built around you, with a coach every session.',
    includes: ['Ten one-to-one sessions', 'With your assigned coach', 'Valid for four months'],
  },
  prd_daypass: {
    bestFor: 'Visiting Bengaluru, or bringing a friend.',
    includes: ['One visit', 'Any branch', 'Valid on the day you buy it'],
  },
  prd_digital: {
    bestFor: 'Training at home or on the road.',
    includes: ['Programmes and tracking in the app', 'On-demand library', 'No gym floor access'],
  },
};

/* ——— Classes ——————————————————————————————————————————————————— */

export interface ClassInfo {
  name: string;
  level: 'low' | 'moderate' | 'high';
  summary: string;
  whoFor: string;
}

export const classInfo: ClassInfo[] = [
  { name: 'Foundations', level: 'low', summary: 'Squat, hinge, push and pull, taught slowly in a small group.', whoFor: 'Your first eight weeks in a gym, or your first in a long time.' },
  { name: 'Strength Clinic', level: 'moderate', summary: 'Coached barbell technique: one lift per session, worked in small groups.', whoFor: 'Anyone who wants to lift heavier with good form.' },
  { name: 'Apex HIIT', level: 'high', summary: 'Interval conditioning in blocks of four, scaled to where you are today.', whoFor: 'People who like to finish out of breath.' },
  { name: 'Spin Sprint', level: 'high', summary: 'Sprint intervals on the bikes, with music loud enough to help.', whoFor: 'Cardio without the impact on knees.' },
  { name: 'Cage Boxing', level: 'high', summary: 'Pad work, footwork and combinations. Gloves and wraps provided.', whoFor: 'Stress relief and coordination. No sparring.' },
  { name: 'Deep Mobility', level: 'low', summary: 'Thirty minutes on hips, upper back and ankles. Bring socks.', whoFor: 'Desk workers and lifters who feel stiff.' },
  { name: 'Reef Yoga', level: 'low', summary: 'A slow flow that ends with a long hold.', whoFor: 'Winding down after work.' },
  { name: 'Open Water Swim', level: 'moderate', summary: 'Technique and endurance sets in the pool at Indiranagar.', whoFor: 'Swimmers who can already do two lengths.' },
];

export const LEVEL_LABEL: Record<string, string> = { low: 'Easy-going', moderate: 'Steady', high: 'Hard' };

/* ——— Coaches ———————————————————————————————————————————————————— */

export interface Coach {
  /** First name only, matching what the timetable shows. */
  name: string;
  surname: string;
  role: string;
  branches: string[];
  specialties: string[];
  bio: string;
  credentials: string[];
  classes: string[];
}

export const coaches: Coach[] = [
  {
    name: 'Rehan',
    surname: 'Ahmed',
    role: 'Head of strength',
    branches: ['koramangala', 'hsr'],
    specialties: ['Strength', 'Powerlifting', 'Muscle gain'],
    bio: 'Rehan competed in powerlifting for six years before he started coaching it. He runs Strength Clinic and Cage Boxing, and he will happily spend a whole session fixing one squat.',
    credentials: ['NSCA Certified Strength and Conditioning Specialist', 'Powerlifting India Level 1 coach'],
    classes: ['Strength Clinic', 'Cage Boxing'],
  },
  {
    name: 'Nikhil',
    surname: 'Rao',
    role: 'Conditioning coach',
    branches: ['koramangala', 'indiranagar'],
    specialties: ['HIIT', 'Conditioning', 'Fat loss'],
    bio: 'Nikhil designs the Apex HIIT and Spin Sprint sessions. He believes a hard workout should still leave you able to come back on Thursday, and programmes them that way.',
    credentials: ['ACE Certified Personal Trainer', 'Precision Nutrition Level 1'],
    classes: ['Apex HIIT', 'Spin Sprint'],
  },
  {
    name: 'Priya',
    surname: 'Sharma',
    role: 'Mobility and beginners coach',
    branches: ['indiranagar', 'hsr'],
    specialties: ['Mobility', 'Beginners', 'Pre- and post-natal'],
    bio: 'Priya coaches most of our members through their first two months. She leads Foundations, Deep Mobility, Reef Yoga and the pool sessions, and she remembers everyone’s name.',
    credentials: ['ACSM Certified Exercise Physiologist', 'Registered Yoga Teacher (RYT-500)', 'Pre- and post-natal exercise specialist'],
    classes: ['Foundations', 'Deep Mobility', 'Reef Yoga', 'Open Water Swim'],
  },
];

/* ——— FAQ ——————————————————————————————————————————————————————— */

export interface Faq {
  q: string;
  a: string;
}

export const faqs: Faq[] = [
  {
    q: 'What does the free trial include?',
    a: 'Seven days of gym floor access at one branch and one coached class of your choice. A coach shows you around on your first visit. There is nothing to pay and no card to give.',
  },
  {
    q: 'How do I book the free trial?',
    a: 'Fill in the free trial form with a class or a time that suits you. Someone from that branch calls you, usually within a few hours of opening, to confirm the day. We do not send automatic messages.',
  },
  {
    q: 'Are prices inclusive of GST?',
    a: 'Yes. Every price on this website includes 18% GST. Your invoice shows the price before tax and the GST separately, with our GSTIN.',
  },
  {
    q: 'Can I pause my membership?',
    a: 'Most memberships can be frozen: up to 60 days a year on Elite Annual and up to 14 days a term on Depot Monthly. Off-Peak and passes cannot be frozen. Ask at reception or use the member app.',
  },
  {
    q: 'How do I cancel?',
    a: 'Monthly plans need 7 days’ notice and end at the end of the paid month. Elite Annual has a 12-month commitment; leaving early costs ₹500. Tell reception or write to us and we confirm in writing.',
  },
  {
    q: 'What are the opening hours?',
    a: 'Monday to Friday 5 am to 11 pm, Saturday and Sunday 6 am to 10 pm, at all three branches. We close on Independence Day and Gandhi Jayanti; each branch page lists upcoming closures.',
  },
  {
    q: 'Do I need to book classes?',
    a: 'Yes. Members book in the Shark Fitness app, up to two weeks ahead on Elite Annual. Booking keeps the studio safe and the coach prepared. Free trial guests are booked in by the team.',
  },
  {
    q: 'I have an injury or a health condition. Can I still train?',
    a: 'Usually, yes. Tell us on the form or on the call, and check with your doctor first if you are unsure. A coach will adapt the session; nobody will push you through pain.',
  },
  {
    q: 'Is there parking?',
    a: 'Koramangala has basement parking for cars, HSR Layout has a small car park, and all three branches have two-wheeler parking. Indiranagar is 12 minutes on foot from the metro.',
  },
  {
    q: 'I am already a member. Where do I renew or book?',
    a: 'In the member app at sharkfitness.in/app, where you can book classes, see your pass and renew your plan. Reception can help too.',
  },
];

/* ——— Copy shared by the forms ——————————————————————————————————— */

export const GOALS: Array<{ value: string; label: string }> = [
  { value: 'get_stronger', label: 'Get stronger' },
  { value: 'lose_weight', label: 'Lose weight' },
  { value: 'get_fitter', label: 'Get fitter' },
  { value: 'classes', label: 'Join group classes' },
  { value: 'sport', label: 'Train for a sport' },
  { value: 'getting_back', label: 'Get back into training' },
  { value: 'other', label: 'Something else' },
];

export const PREFERRED_TIMES: Array<{ value: string; label: string }> = [
  { value: 'early_morning', label: 'Early morning (5–8 am)' },
  { value: 'morning', label: 'Morning (8–11 am)' },
  { value: 'midday', label: 'Midday (11 am–4 pm)' },
  { value: 'evening', label: 'Evening (4–8 pm)' },
  { value: 'late_evening', label: 'Late evening (after 8 pm)' },
  { value: 'weekend', label: 'Weekends' },
];

/* ——— Helpers ———————————————————————————————————————————————————— */

export const WEEKDAY_LABEL: Record<PublicWeekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
export const WEEKDAYS: PublicWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "05:00" → "5 am", "18:30" → "6:30 pm". */
export function clock12(time: string | null): string {
  if (!time) return '';
  const [h = 0, m = 0] = time.split(':').map(Number);
  const suffix = h >= 12 && h < 24 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Collapses identical days: "Mon–Fri 5 am–11 pm", "Sat–Sun 6 am–10 pm". */
export function hoursSummary(branch: PublicBranch): Array<{ days: string; hours: string }> {
  const short: Record<PublicWeekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const rows: Array<{ from: PublicWeekday; to: PublicWeekday; hours: string }> = [];
  for (const day of WEEKDAYS) {
    const h = branch.hours[day];
    const label = h.closed ? 'Closed' : `${clock12(h.opens)}–${clock12(h.closes)}`;
    const last = rows.at(-1);
    if (last && last.hours === label) last.to = day;
    else rows.push({ from: day, to: day, hours: label });
  }
  return rows.map((r) => ({ days: r.from === r.to ? short[r.from] : `${short[r.from]}–${short[r.to]}`, hours: r.hours }));
}

/** "15 Aug 2026". */
export function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function branchBySlug(slug: string): PublicBranch | undefined {
  return site.branches.find((b) => b.slug === slug);
}

export function plansAt(branchId: string): PublicPlan[] {
  return plans.filter((p) => p.branchIds.includes(branchId));
}

export function plansWhere(plan: PublicPlan): string {
  if (plan.allBranches) return 'All branches';
  return plan.branchIds
    .map((id) => site.branches.find((b) => b.id === id))
    .filter((b): b is PublicBranch => Boolean(b))
    .map((b) => branchExtra(b).area)
    .join(' and ');
}

/* ——— Weekly pattern ——————————————————————————————————————————————— */

export interface PatternRow {
  startTime: string;
  endTime: string;
  name: string;
  level: string;
  coach: string | null;
  /** "Every day", "Mon–Fri", "Tue, Thu". */
  days: string;
}

/** Folds a branch's weekly slots into one row per class and time, with the days it runs. */
export function weeklyPattern(branchId: string): PatternRow[] {
  const slots = snapshot.timetable[branchId] ?? [];
  const rows = new Map<string, PatternRow & { dayset: Set<PublicWeekday> }>();
  for (const slot of slots) {
    const key = `${slot.startTime}|${slot.name}|${slot.coach ?? ''}`;
    const row = rows.get(key) ?? { startTime: slot.startTime, endTime: slot.endTime, name: slot.name, level: slot.level, coach: slot.coach, days: '', dayset: new Set() };
    row.dayset.add(slot.day);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ dayset, ...row }) => ({ ...row, days: describeDays(dayset) }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
}

function describeDays(days: Set<PublicWeekday>): string {
  const short: Record<PublicWeekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const list = WEEKDAYS.filter((d) => days.has(d));
  if (list.length === 7) return 'Every day';
  if (list.join() === 'mon,tue,wed,thu,fri') return 'Mon–Fri';
  if (list.join() === 'sat,sun') return 'Weekends';
  return list.map((d) => short[d]).join(', ');
}

/** Classes a week across the whole group, for the headline number. */
export function classesPerWeek(): number {
  return Object.values(snapshot.timetable).reduce((n, list) => n + list.length, 0);
}
