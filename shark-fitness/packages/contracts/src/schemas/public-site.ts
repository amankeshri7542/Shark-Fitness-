import { z } from 'zod';

/**
 * The public website's API (`/v1/public/:tenantSlug`). No session, no cookies.
 *
 * The website imports only the *types* from here, so zod never reaches the
 * visitor's browser; the API validates with these schemas and answers with
 * field paths the form maps back onto its inputs.
 */

/* ——— Phone numbers ———————————————————————————————————————————— */

/**
 * A phone number as typed by a visitor, to E.164, or null when it cannot be
 * one. Default country India (+91), the only market the product sells in.
 *
 * Accepted: `98450 12345`, `098450 12345`, `+91 98450 12345`,
 * `0091 9845012345`, `919845012345`, `080 4000 1000` (a landline with its STD
 * code), and any other country written with `+` or `00` and 8–15 digits.
 * Refused: anything with letters, too short or too long, and an Indian
 * national number starting with 0 after the trunk prefix is removed.
 */
export function toE164Phone(raw: string, defaultCountryCode = '91'): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  let international: string;
  if (trimmed.startsWith('+')) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);
  else if (defaultCountryCode === '91' && digits.length === 12 && digits.startsWith('91')) international = digits;
  else if (digits.length === 11 && digits.startsWith('0')) international = defaultCountryCode + digits.slice(1);
  else if (digits.length === 10) international = defaultCountryCode + digits;
  else return null;

  if (international.startsWith('91')) {
    const national = international.slice(2);
    return /^[1-9]\d{9}$/.test(national) ? `+91${national}` : null;
  }
  return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
}

/* ——— Lead and trial request input ——————————————————————————————— */

export const PUBLIC_LEAD_GOALS = ['get_stronger', 'lose_weight', 'get_fitter', 'classes', 'sport', 'getting_back', 'other'] as const;
export type PublicLeadGoal = (typeof PUBLIC_LEAD_GOALS)[number];

export const PUBLIC_PREFERRED_TIMES = ['early_morning', 'morning', 'midday', 'evening', 'late_evening', 'weekend'] as const;
export type PublicPreferredTime = (typeof PUBLIC_PREFERRED_TIMES)[number];

/** Submissions faster than this, from first keystroke to send, are bots. */
export const PUBLIC_FORM_MIN_FILL_MS = 3_000;
export const PUBLIC_MESSAGE_MAX = 1_000;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const Utm = z
  .object({
    source: optionalText(100),
    medium: optionalText(100),
    campaign: optionalText(100),
    term: optionalText(100),
    content: optionalText(100),
  })
  .partial()
  .default({});

export const PublicLeadInput = z.object({
  name: z.string().trim().min(2, 'Enter your name.').max(80, 'Keep your name under 80 characters.'),
  phone: z
    .string()
    .max(32, 'Enter a phone number we can call.')
    .transform((value, ctx) => {
      const e164 = toE164Phone(value);
      if (!e164) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a 10-digit mobile number, or include the country code.' });
        return z.NEVER;
      }
      return e164;
    }),
  email: z
    .union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address, or leave it empty.').max(160)])
    .optional()
    .transform((value) => (value ? value : undefined)),
  branchId: z.string().min(1, 'Choose a branch.').max(64),
  goal: z.enum(PUBLIC_LEAD_GOALS).optional(),
  preferredTime: z.enum(PUBLIC_PREFERRED_TIMES).optional(),
  /** A specific class the visitor would like to try (trial requests). */
  classSessionId: z.string().max(64).optional(),
  /** The plan they were looking at when they asked. */
  planId: z.string().max(64).optional(),
  message: optionalText(PUBLIC_MESSAGE_MAX),
  consent: z.object({
    processing: z.literal(true, {
      errorMap: () => ({ message: 'We need your permission to use these details to call you back.' }),
    }),
    marketing: z.boolean().default(false),
    noticeVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'Unknown privacy notice version.'),
  }),
  utm: Utm,
  referralCode: optionalText(40),
  /** Honeypot. A person never sees this field; anything in it is a bot. */
  website: z.string().max(500).optional(),
  /** When the visitor started filling the form, epoch ms, from the page. */
  formStartedAt: z.number().int().nonnegative(),
});
export type PublicLeadInput = z.input<typeof PublicLeadInput>;
export type PublicLead = z.output<typeof PublicLeadInput>;

export const PublicTrialRequestInput = PublicLeadInput.superRefine((value, ctx) => {
  if (!value.classSessionId && !value.preferredTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preferredTime'],
      message: 'Pick a class or tell us when you would like to come in.',
    });
  }
});

/** Every accepted submission gets the same answer, so the response never
 *  says whether this person was already a lead or a member. */
export interface PublicSubmissionReceipt {
  received: true;
  message: string;
}

/* ——— GET /site ————————————————————————————————————————————— */

export interface PublicDayHours {
  closed: boolean;
  /** Branch-local wall clock, `HH:mm`. */
  opens: string | null;
  closes: string | null;
}

export type PublicWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface PublicBranch {
  id: string;
  slug: string;
  name: string;
  state: 'active' | 'temporarily_closed';
  addressLine: string;
  city: string;
  timezone: string;
  phone: string | null;
  email: string | null;
  amenities: string[];
  /** Upcoming closure dates, branch-local `YYYY-MM-DD`. */
  holidays: string[];
  hours: Record<PublicWeekday, PublicDayHours>;
}

export interface PublicPlan {
  id: string;
  name: string;
  description: string;
  kind: string;
  cadence: string;
  durationDays: number | null;
  credits: number | null;
  currency: string;
  /** Catalogue price before tax, minor units. */
  priceMinor: number;
  taxMinor: number;
  /** What the member pays, minor units. */
  totalMinor: number;
  taxRatePercent: string;
  taxLabel: string;
  /** `₹3,539` — the total, formatted. */
  priceLabel: string;
  /** `incl. 18% GST`. */
  taxNote: string;
  /** `/ month`, `/ year`, `one-time`. */
  cadenceLabel: string;
  allBranches: boolean;
  branchIds: string[];
}

export interface PublicSite {
  tenant: { slug: string; displayName: string; currency: string; timezone: string; privacyContact: string | null };
  branches: PublicBranch[];
  plans: PublicPlan[];
}

/* ——— GET /classes ———————————————————————————————————————————— */

export const PUBLIC_CLASSES_MAX_DAYS = 14;

/** A real calendar day (`2026-02-30` is not), in a range date arithmetic can handle. */
const CalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const parsed = new Date(`${value}T00:00:00Z`);
    return year >= 2000 && year <= 2999 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Use a real date, YYYY-MM-DD.');

export const PublicClassesQuery = z.object({
  branchId: z.string().min(1).max(64),
  from: CalendarDay.optional(),
  to: CalendarDay.optional(),
});

export type PublicSpots = 'available' | 'few_left' | 'full';

export interface PublicClass {
  id: string;
  name: string;
  category: string;
  level: string;
  /** First name only. */
  coach: string | null;
  /** Branch-local date and times. */
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  spots: PublicSpots;
}

export interface PublicClasses {
  branchId: string;
  timezone: string;
  from: string;
  to: string;
  items: PublicClass[];
}
