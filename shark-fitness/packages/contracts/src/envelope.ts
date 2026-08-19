import { z } from 'zod';

/* ============================================================================
   Error envelope — Engineering PRD §9.2. Every non-2xx response is this shape.
   ========================================================================= */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'RATE_LIMITED',
  'IDEMPOTENCY_MISMATCH',
  'CAPACITY_EXHAUSTED',
  'ENTITLEMENT_MISSING',
  'BOOKING_WINDOW_CLOSED',
  'PAYMENT_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'TENANT_SUSPENDED',
  'LEGAL_HOLD',
  'STALE_VERSION',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FieldError = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof FieldError>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    /** Safe to show a member. Never contains security-sensitive detail. */
    message: z.string(),
    fields: z.array(FieldError).optional(),
    /** Correlates the client report with server logs. */
    requestId: z.string(),
    /** Present on RATE_LIMITED and PROVIDER_UNAVAILABLE. */
    retryAfterSec: z.number().int().optional(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const HTTP_STATUS_FOR: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 409,
  CAPACITY_EXHAUSTED: 409,
  ENTITLEMENT_MISSING: 402,
  BOOKING_WINDOW_CLOSED: 409,
  PAYMENT_REQUIRED: 402,
  PROVIDER_UNAVAILABLE: 503,
  QUOTA_EXCEEDED: 429,
  TENANT_SUSPENDED: 403,
  LEGAL_HOLD: 423,
  STALE_VERSION: 409,
  INTERNAL: 500,
};

/* ============================================================================
   Pagination — cursor based, stable under insert.
   ========================================================================= */

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/* ============================================================================
   Realtime event envelope — Engineering PRD §9.4.
   ========================================================================= */

export const EVENT_TOPICS = [
  'attendance.checked_in',
  'attendance.checked_out',
  'attendance.denied',
  'occupancy.changed',
  'booking.confirmed',
  'booking.cancelled',
  'booking.seat_changed',
  'waitlist.offered',
  'waitlist.promoted',
  'session.updated',
  'session.cancelled',
  'membership.state_changed',
  'payment.succeeded',
  'payment.failed',
  'invoice.updated',
  'workout.synced',
  'pr.achieved',
  'message.created',
  'notification.created',
  'post.created',
  'challenge.score_changed',
  'lead.stage_changed',
  'alert.raised',
  /* Store — PF-POS. Branch-channel topics: a till, a stockroom and a manager's
     console are all looking at the same shelf.

     These are deliberately not `payment.*`. A `payment.succeeded` event means a
     billing payment moved against an invoice, and everything downstream of it —
     dunning, reconciliation, membership activation — is entitled to assume so.
     A counter sale settling in cash satisfies none of that, so reusing the
     topic to get a free refresh would put a lie on the wire. The one POS tender
     that does raise a receivable emits `invoice.updated` as well, because in
     that case an invoice really was created. */
  'pos.sale_completed',
  'pos.return_completed',
  'pos.order_voided',
  /** On-hand moved for a reason the viewing client did not cause. */
  'stock.changed',
  /** On-hand crossed the reorder threshold. Actionable, unlike the above. */
  'stock.low',
  'transfer.updated',
  /* Support — PF-SUP. A ticket queue is watched by several people at once, and
     an assignment or a state change made at one desk has to reach the others
     before two of them answer the same complaint.

     There is deliberately no `ticket.replied` topic. A member-visible reply is
     already a `message.created` on the member's channel — the same event the
     member app listens to — and publishing a second topic for the same fact
     would create two histories of one message, which is exactly what the
     conversation model exists to prevent. Staff consoles learn about it from
     `ticket.updated`, which they need anyway because the SLA clock stopped. */
  'ticket.updated',
] as const;

export const EventTopic = z.enum(EVENT_TOPICS);
export type EventTopic = z.infer<typeof EventTopic>;

export const EventEnvelope = z.object({
  /** Monotonic per channel. Clients resume with `?since=`. */
  seq: z.number().int(),
  id: z.string(),
  topic: EventTopic,
  tenantId: z.string(),
  branchId: z.string().nullable(),
  /** ISO-8601 UTC. */
  at: z.string(),
  version: z.literal(1),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Channel names. A socket may only subscribe to channels its token allows. */
export const channels = {
  branch: (branchId: string) => `branch:${branchId}`,
  member: (memberId: string) => `member:${memberId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  tenant: (tenantId: string) => `tenant:${tenantId}`,
} as const;

/* ============================================================================
   Offline outbox — Engineering PRD §"Mobile offline outbox".
   ========================================================================= */

export const OutboxStatus = z.enum(['queued', 'sending', 'synced', 'failed', 'conflict']);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

export const OutboxEntry = z.object({
  /** Client-generated, stable across retries. Doubles as the idempotency key. */
  clientId: z.string(),
  kind: z.string(),
  method: z.enum(['POST', 'PATCH', 'DELETE']),
  path: z.string(),
  body: z.unknown(),
  createdAt: z.string(),
  attempts: z.number().int().default(0),
  status: OutboxStatus.default('queued'),
  lastError: z.string().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntry>;
