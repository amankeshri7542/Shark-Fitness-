import { z } from 'zod';
import { BookingState, SessionState, WaitlistState } from '../enums.js';
import { Id, IsoDate, IsoDateTime, Money } from './identity.js';

export const ClassType = z.object({
  id: Id,
  name: z.string(),
  category: z.enum(['strength', 'cardio', 'mobility', 'combat', 'aquatic', 'mind_body', 'other']),
  description: z.string(),
  durationMin: z.number().int(),
  intensity: z.enum(['low', 'moderate', 'high']),
});
export type ClassType = z.infer<typeof ClassType>;

/** Why a member can or cannot take this seat. Computed server-side so the
 *  button and its explanation can never disagree (PF-SCH, UX-M04). */
export const BookingEligibility = z.object({
  canBook: z.boolean(),
  action: z.enum(['book', 'waitlist', 'cancel', 'pay', 'blocked', 'closed']),
  /** Member-facing. Explains the action or the block in plain language. */
  reason: z.string(),
  creditsRequired: z.number().int(),
  creditsHeld: z.number().int(),
  dropInPriceMinor: Money.nullable(),
  bookingOpensAt: IsoDateTime.nullable(),
  cancelDeadlineAt: IsoDateTime.nullable(),
  lateCancelFeeMinor: Money.nullable(),
  conflictsWithSessionId: Id.nullable(),
});
export type BookingEligibility = z.infer<typeof BookingEligibility>;

export const ClassSession = z.object({
  id: Id,
  branchId: Id,
  branchName: z.string(),
  classTypeId: Id,
  name: z.string(),
  category: ClassType.shape.category,
  trainerId: Id.nullable(),
  trainerName: z.string(),
  roomName: z.string(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  /** Branch-local wall clock, precomputed so the client never guesses a zone. */
  localDate: IsoDate,
  localTime: z.string(),
  durationMin: z.number().int(),
  capacity: z.number().int(),
  booked: z.number().int(),
  seatsLeft: z.number().int(),
  waitlistCount: z.number().int(),
  state: SessionState,
  cancelledReason: z.string().nullable(),
  substituteFor: z.string().nullable(),
  myBooking: z
    .object({ id: Id, state: BookingState, seatNo: z.number().int().nullable() })
    .nullable(),
  myWaitlist: z
    .object({ id: Id, position: z.number().int(), state: WaitlistState, offerExpiresAt: IsoDateTime.nullable() })
    .nullable(),
  eligibility: BookingEligibility,
});
export type ClassSession = z.infer<typeof ClassSession>;

export const BookInput = z.object({
  sessionId: Id,
  /** Stable across retries; the last-seat race resolves on this. */
  idempotencyKey: z.string().min(8),
  acceptDropInCharge: z.boolean().default(false),
});
export type BookInput = z.infer<typeof BookInput>;

export const Booking = z.object({
  id: Id,
  sessionId: Id,
  memberId: Id,
  memberName: z.string().optional(),
  state: BookingState,
  seatNo: z.number().int().nullable(),
  bookedAt: IsoDateTime,
  cancelledAt: IsoDateTime.nullable(),
  creditsUsed: z.number().int(),
  chargeMinor: Money,
  cameFromWaitlist: z.boolean(),
});
export type Booking = z.infer<typeof Booking>;

export const WaitlistEntry = z.object({
  id: Id,
  sessionId: Id,
  memberId: Id,
  memberName: z.string().optional(),
  position: z.number().int(),
  state: WaitlistState,
  joinedAt: IsoDateTime,
  offeredAt: IsoDateTime.nullable(),
  offerExpiresAt: IsoDateTime.nullable(),
});
export type WaitlistEntry = z.infer<typeof WaitlistEntry>;

export const Appointment = z.object({
  id: Id,
  memberId: Id,
  trainerId: Id,
  trainerName: z.string(),
  kind: z.enum(['pt', 'assessment', 'consult', 'physio']),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  branchId: Id,
  state: z.enum(['requested', 'confirmed', 'completed', 'cancelled', 'no_show']),
  creditsUsed: z.number().int(),
  notes: z.string().nullable(),
});
export type Appointment = z.infer<typeof Appointment>;
