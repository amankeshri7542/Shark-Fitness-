import { z } from 'zod';

const Name = z.string().trim().min(1).max(100).refine((s) => [...s].every((char) => char.charCodeAt(0) >= 32), 'Use a single line.');
export const ContactPhone = z.string().trim().max(24).regex(/^[+()\d .-]+$/, 'Enter a phone number.').refine((s) => s.replace(/\D/g, '').length >= 10 && s.replace(/\D/g, '').length <= 15, 'Use 10–15 digits.');
const BirthDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s && s >= '1900-01-01' && date.getTime() <= Date.now();
}, 'Enter a valid birth date, not in the future.');
export const EmergencyContact = z.object({ name: Name, phone: ContactPhone, relationship: Name }).strict();
export const MemberProfileFields = z.object({
  firstName: Name,
  lastName: z.string().trim().max(100).refine((s) => [...s].every((char) => char.charCodeAt(0) >= 32), 'Use a single line.'),
  dob: BirthDate.nullable(),
  addressLine: z.string().trim().max(500).nullable(),
  emergencyContact: EmergencyContact.nullable(),
}).strict();
export const CorrectMemberProfile = MemberProfileFields.extend({ version: z.number().int().positive(), reason: z.string().trim().min(4).max(500) }).strict();
export const CorrectMemberIdentity = z.object({
  version: z.number().int().positive(), email: z.string().trim().email().max(254).nullable(), phone: ContactPhone.nullable(),
  currentPassword: z.string().min(1).max(200), identityVerified: z.literal(true), reason: z.string().trim().min(4).max(500),
}).strict().refine((s) => s.email !== null || s.phone !== null, 'Keep at least one contact. Email is required for password sign-in.');
export const RosterFields = ['firstName', 'lastName', 'email', 'phone', 'dob', 'addressLine', 'emergencyName', 'emergencyPhone', 'emergencyRelationship'] as const;
export type RosterField = typeof RosterFields[number];
export const RosterInput = z.object({
  branchId: z.string().min(1).max(100), csv: z.string().min(1).max(256_000),
  mapping: z.record(z.enum(RosterFields), z.string().max(100)).default({}),
}).strict();
export const CommitRoster = RosterInput.extend({ previewToken: z.string().min(1).max(300), confirmed: z.literal(true) }).strict();
export interface RosterRowResult { row: number; name: string; status: 'ready' | 'skipped' | 'rejected' | 'imported'; messages: string[]; memberId?: string; memberNo?: string }
export interface RosterPreview { headers: string[]; rows: RosterRowResult[]; ready: number; skipped: number; rejected: number; previewToken: string; expiresAt: string }
