import { z } from 'zod';

/* ============================================================================
   Staff security — MFA, step-up, sessions (PRD 04 ENT-IAM-001/003, PRD 02
   "Identity rules") and outbound webhooks (PF-INT-003, PRD 01 §4.23).
   ========================================================================= */

/* — MFA ——————————————————————————————————————————————————————— */

/**
 * Where a signed-in session stands with two-step sign-in.
 *
 * - `none`: MFA does not apply (members, or staff who are neither required
 *   nor enrolled). A full session.
 * - `verified`: the person proved a TOTP or recovery code. A full session.
 * - `challenge`: password accepted, code still owed. Partial.
 * - `enrol`: the role or the gym requires MFA and none is set up. Partial.
 *
 * A partial session can reach only `/auth/mfa/*`, `/auth/session` and
 * sign-out; everything else answers 401 `MFA_REQUIRED`.
 */
export const MfaState = z.enum(['none', 'verified', 'challenge', 'enrol']);
export type MfaState = z.infer<typeof MfaState>;

export const TotpCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');

export const RecoveryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, 'Recovery codes look like ABCDE-12345.');

export const MfaVerifyInput = z.union([
  z.object({ code: TotpCode }).strict(),
  z.object({ recoveryCode: RecoveryCode }).strict(),
]);
export type MfaVerifyInput = z.infer<typeof MfaVerifyInput>;

export const MfaStatus = z.object({
  enrolled: z.boolean(),
  /** Whether this person must use MFA, and why. */
  required: z.boolean(),
  requiredBy: z.enum(['role', 'gym', 'none']),
  enrolledAt: z.string().nullable(),
  recoveryCodesRemaining: z.number().int(),
  sessionState: MfaState,
});
export type MfaStatus = z.infer<typeof MfaStatus>;

export const MfaEnrolment = z.object({
  /** Base32, shown as the manual key. */
  secret: z.string(),
  /** `otpauth://totp/...` — rendered as a QR code by the console. */
  uri: z.string(),
  issuer: z.string(),
  account: z.string(),
});
export type MfaEnrolment = z.infer<typeof MfaEnrolment>;

export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

/* — Step-up ———————————————————————————————————————————————————— */

export const StepUpInput = z.object({
  password: z.string().min(1).max(256),
  code: TotpCode.optional(),
});
export type StepUpInput = z.infer<typeof StepUpInput>;

/** `details` of a `STEP_UP_REQUIRED` error. */
export const StepUpChallenge = z.object({
  /** Whether the re-check needs a TOTP code as well as the password. */
  mfa: z.boolean(),
  maxAgeSec: z.number().int(),
  action: z.string(),
});
export type StepUpChallenge = z.infer<typeof StepUpChallenge>;

/* — Sessions ————————————————————————————————————————————————————— */

/** Why a session stopped working, in the `details.reason` of a 401. */
export const SessionEndReason = z.enum(['idle', 'expired', 'revoked', 'signed_out']);
export type SessionEndReason = z.infer<typeof SessionEndReason>;

export const SessionTiming = z.object({
  kind: z.enum(['staff', 'member']),
  /** Null for members: their sessions slide and never idle out. */
  idleTimeoutSec: z.number().int().nullable(),
  idleExpiresAt: z.string().nullable(),
  expiresAt: z.string(),
  lastActiveAt: z.string(),
});
export type SessionTiming = z.infer<typeof SessionTiming>;

export const DeviceSession = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  userAgent: z.string(),
  /** "Chrome on Windows" — derived from the user agent, never trusted for security. */
  device: z.string(),
  ip: z.string(),
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/* — Tenant security settings ————————————————————————————————————— */

export const STAFF_IDLE_TIMEOUT_MINUTES = { min: 15, max: 240, default: 30 } as const;

export const SecuritySettings = z.object({
  requireMfaForStaff: z.boolean(),
  staffIdleTimeoutMinutes: z.number().int(),
  /** Roles that must use MFA whatever the gym decides (ENT-IAM-001). */
  mandatoryRoles: z.array(z.string()),
});
export type SecuritySettings = z.infer<typeof SecuritySettings>;

export const SecuritySettingsPatch = z
  .object({
    requireMfaForStaff: z.boolean().optional(),
    staffIdleTimeoutMinutes: z
      .number()
      .int()
      .min(STAFF_IDLE_TIMEOUT_MINUTES.min)
      .max(STAFF_IDLE_TIMEOUT_MINUTES.max)
      .optional(),
  })
  .strict();
export type SecuritySettingsPatch = z.infer<typeof SecuritySettingsPatch>;

export const StaffMfaRow = z.object({
  staffId: z.string(),
  userId: z.string(),
  name: z.string(),
  role: z.string(),
  enrolled: z.boolean(),
  required: z.boolean(),
  enrolledAt: z.string().nullable(),
  lockedUntil: z.string().nullable(),
});
export type StaffMfaRow = z.infer<typeof StaffMfaRow>;

export const MfaResetInput = z.object({ reason: z.string().trim().min(8).max(500) }).strict();
export type MfaResetInput = z.infer<typeof MfaResetInput>;

/* — Outbound webhooks ——————————————————————————————————————————— */

export const WEBHOOK_EVENT_TYPES = [
  'member.created',
  'member.updated',
  'membership.activated',
  'membership.cancelled',
  'payment.succeeded',
  'payment.failed',
  'attendance.checked_in',
  'attendance.checked_out',
  'class.booked',
  'class.cancelled',
  'class.waitlist_promoted',
  'workout.completed',
  'lead.created',
  'lead.converted',
] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/** The envelope version consumers pin to. Bumped only for breaking changes. */
export const WEBHOOK_ENVELOPE_VERSION = 1;

export const WebhookEnvelope = z.object({
  id: z.string(),
  type: WebhookEventType,
  version: z.literal(WEBHOOK_ENVELOPE_VERSION),
  tenant: z.object({ id: z.string(), slug: z.string() }),
  occurredAt: z.string(),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

export const WebhookEndpointState = z.enum(['active', 'paused', 'disabled']);
export type WebhookEndpointState = z.infer<typeof WebhookEndpointState>;

export const WebhookEndpoint = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string(),
  events: z.array(WebhookEventType),
  state: WebhookEndpointState,
  disabledReason: z.string().nullable(),
  disabledAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  /** Last four characters only; the secret itself is shown once. */
  secretHint: z.string(),
  /** Set during a rotation: the old secret still signs until then. */
  previousSecretExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastDelivery: z
    .object({ at: z.string(), ok: z.boolean(), statusCode: z.number().int().nullable() })
    .nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const WebhookEndpointInput = z
  .object({
    url: z.string().trim().min(1).max(2_000),
    description: z.string().trim().max(200).default(''),
    events: z.array(WebhookEventType).min(1, 'Choose at least one event.'),
  })
  .strict();
export type WebhookEndpointInput = z.infer<typeof WebhookEndpointInput>;

export const WebhookEndpointPatch = z
  .object({
    url: z.string().trim().min(1).max(2_000).optional(),
    description: z.string().trim().max(200).optional(),
    events: z.array(WebhookEventType).min(1, 'Choose at least one event.').optional(),
    state: z.enum(['active', 'paused']).optional(),
  })
  .strict();
export type WebhookEndpointPatch = z.infer<typeof WebhookEndpointPatch>;

export const WebhookDeliveryState = z.enum(['pending', 'succeeded', 'failed']);
export type WebhookDeliveryState = z.infer<typeof WebhookDeliveryState>;

export const WebhookAttempt = z.object({
  attempt: z.number().int(),
  at: z.string(),
  statusCode: z.number().int().nullable(),
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  /** First 1 KB of the receiver's answer, for debugging. */
  responseExcerpt: z.string().nullable(),
});
export type WebhookAttempt = z.infer<typeof WebhookAttempt>;

export const WebhookDelivery = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string(),
  eventType: WebhookEventType,
  state: WebhookDeliveryState,
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  replayOf: z.string().nullable(),
  test: z.boolean(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  log: z.array(WebhookAttempt),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;
