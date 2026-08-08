import { z } from 'zod';
import { AccessDecision, CheckInMethod } from '../enums.js';
import { Id, IsoDateTime } from './identity.js';

/** A rotating entry token. The client holds a short-lived secret and derives
 *  a code offline; the server validates the derivation and burns the nonce,
 *  so a screenshot is useless and a replay is detectable (PF-ATT-005). */
export const AccessToken = z.object({
  tokenId: Id,
  memberId: Id,
  /** Base32, shown as the QR payload. Rotates every `rotateSec`. */
  code: z.string(),
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  rotateSec: z.number().int(),
  /** Cached offline seed so the code still rotates without a network. */
  offlineSeed: z.string(),
  branchIds: z.array(Id),
});
export type AccessToken = z.infer<typeof AccessToken>;

export const ScanInput = z.object({
  code: z.string().min(6),
  branchId: Id,
  method: CheckInMethod.default('qr'),
  /** Staff override path. Reason is mandatory and audited (PF-ATT-004). */
  overrideReason: z.string().min(4).optional(),
});
export type ScanInput = z.infer<typeof ScanInput>;

export const ScanResult = z.object({
  decision: AccessDecision,
  granted: z.boolean(),
  memberId: Id.nullable(),
  memberName: z.string().nullable(),
  memberNo: z.string().nullable(),
  checkInId: Id.nullable(),
  at: IsoDateTime,
  visitNumber: z.number().int().nullable(),
  branchName: z.string(),
  occupancy: z.object({
    inside: z.number().int(),
    capacity: z.number().int(),
    label: z.enum(['quiet', 'steady', 'busy', 'peak']),
  }),
  /** Set when a denial can be resolved by the member themselves. */
  resolution: z
    .object({
      kind: z.enum(['pay_outstanding', 'contact_reception', 'renew', 'wait', 'other_branch']),
      amountMinor: z.number().int().nullable(),
      invoiceId: Id.nullable(),
      message: z.string(),
    })
    .nullable(),
  canOverride: z.boolean(),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const CheckIn = z.object({
  id: Id,
  memberId: Id,
  memberName: z.string(),
  memberNo: z.string(),
  branchId: Id,
  method: CheckInMethod,
  decision: AccessDecision,
  enteredAt: IsoDateTime,
  exitedAt: IsoDateTime.nullable(),
  durationMin: z.number().int().nullable(),
  overrideByName: z.string().nullable(),
  overrideReason: z.string().nullable(),
  autoClosed: z.boolean(),
});
export type CheckIn = z.infer<typeof CheckIn>;

export const Occupancy = z.object({
  branchId: Id,
  branchName: z.string(),
  inside: z.number().int(),
  capacity: z.number().int(),
  label: z.enum(['quiet', 'steady', 'busy', 'peak']),
  at: IsoDateTime,
  /** 24 buckets of today's occupancy, index = hour, branch-local. The
   *  Command Center's occupancy trace draws this. */
  hourly: z.array(z.number().int()).length(24),
  /** Which hour the `now` line sits on. */
  currentHour: z.number().int().min(0).max(23),
  areas: z.array(
    z.object({ name: z.string(), busy: z.enum(['free', 'steady', 'busy']), free: z.number().int().nullable() }),
  ),
});
export type Occupancy = z.infer<typeof Occupancy>;
