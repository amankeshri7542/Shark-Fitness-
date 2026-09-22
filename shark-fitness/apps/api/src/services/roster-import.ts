import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CommitRoster, ContactPhone, MemberProfileFields, RosterFields, RosterInput, type RosterPreview, type RosterRowResult } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { runtimeConfig } from '../lib/config.js';
import { constantTimeEqual, requestHash } from '../lib/crypto.js';
import { conflict, invalid } from '../lib/errors.js';
import { id, normalizeEmail, normalizePhone } from '../lib/ids.js';
import { runIdempotently } from '../lib/idempotency.js';
import { now } from '../lib/time.js';
import { contactConflict, enrollmentBranch, enrollMember } from './member-enrollment.js';
import { profileChanged } from './member-operations.js';

/** Bounded RFC4180-style CSV: quoted commas/newlines/escaped quotes, CRLF and BOM. */
export function parseRosterCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv, 'utf8') > 256_000) throw invalid('CSV is limited to 256 KB.');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 30) throw invalid('Use at most 30 CSV columns.'); };
  const finishRow = () => { finishCell(); rows.push(row); row = []; if (rows.length > 201) throw invalid('Import at most 200 people at a time.'); };
  const source = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && source[i + 1] === '\n') i += 1; finishRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed || char === '"') throw invalid('Malformed CSV quoting. Use the template or save the file as CSV again.'); cell += char; }
    if (cell.length > 2_000) throw invalid('A CSV field exceeds 2,000 characters.');
  }
  if (quoted) throw invalid('CSV contains an unfinished quoted field.');
  if (cell || row.length || closed) finishRow();
  if (rows.length < 2) throw invalid('Include a header and at least one person.');
  return rows;
}

const Enrollment = MemberProfileFields.extend({ email: z.string().email().max(254).nullable(), phone: ContactPhone.nullable() }).refine((s) => s.email || s.phone, 'Provide an email or phone; email is needed for private password activation.');
type Enrollment = z.infer<typeof Enrollment>;
type Input = z.infer<typeof RosterInput>;

function inspect(ctx: RequestContext, input: Input) {
  enrollmentBranch(ctx, input.branchId);
  const [rawHeaders = [], ...data] = parseRosterCsv(input.csv);
  const headers = rawHeaders.map((s) => s.trim());
  if (headers.some((s) => !s || s.length > 100) || new Set(headers).size !== headers.length) throw invalid('CSV column names must be unique, nonempty and at most 100 characters.');
  const selected = RosterFields.map((field) => input.mapping[field] ?? (headers.includes(field) ? field : '')).filter(Boolean);
  if (new Set(selected).size !== selected.length || selected.some((h) => !headers.includes(h))) throw invalid('Map each CSV column at most once, using a column in this file.');
  const people: Array<Enrollment | null> = [];
  const rows: RosterRowResult[] = data.map((cells, index) => {
    const values = Object.fromEntries(RosterFields.map((field) => [field, cells[headers.indexOf(input.mapping[field] ?? field)]?.trim() ?? '']));
    const base = { row: index + 2, name: `${values.firstName} ${values.lastName}`.trim() };
    if (cells.every((s) => !s.trim())) { people.push(null); return { ...base, status: 'skipped', messages: ['Empty row.'] }; }
    const emergency = values.emergencyName || values.emergencyPhone || values.emergencyRelationship;
    const parsed = Enrollment.safeParse({ firstName: values.firstName, lastName: values.lastName, email: normalizeEmail(values.email), phone: values.phone || null, dob: values.dob || null, addressLine: values.addressLine || null,
      emergencyContact: emergency ? { name: values.emergencyName, phone: values.emergencyPhone, relationship: values.emergencyRelationship } : null });
    if (cells.length !== headers.length || !parsed.success) {
      people.push(null); return { ...base, status: 'rejected', messages: cells.length !== headers.length ? ['Column count does not match the header.'] : !parsed.success ? parsed.error.issues.map((issue) => `${issue.path.join('.') || 'Contact'}: ${issue.message}`) : [] };
    }
    people.push(parsed.data);
    if (contactConflict(ctx.tenantId, parsed.data.email, parsed.data.phone)) return { ...base, status: 'skipped', messages: ['Contact already reserved in this gym; no account will be merged or changed.'] };
    return { ...base, status: 'ready', messages: [parsed.data.email ? 'Invited contact only; verify identity and issue private activation separately. No financial history imported.' : 'Contact only; owner must verify/add an email before password activation. No financial history imported.'] };
  });
  const counts = new Map<string, number>();
  for (const person of people) if (person) for (const key of [person.email && `e:${person.email}`, person.phone && `p:${normalizePhone(person.phone)}`]) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  people.forEach((person, index) => {
    if (person && [person.email && `e:${person.email}`, person.phone && `p:${normalizePhone(person.phone)}`].some((key) => key && (counts.get(key) ?? 0) > 1)) {
      rows[index] = { ...rows[index]!, status: 'rejected', messages: ['Duplicate contact within this file. Resolve every conflicting row before importing it.'] };
    }
  });
  return { headers, rows, people };
}

function fingerprint(ctx: RequestContext, input: Input, rows: RosterRowResult[], expiry: number): string {
  return createHmac('sha256', runtimeConfig.passSecret).update(requestHash({ tenant: ctx.tenantId, actor: ctx.userId, input, rows, expiry })).digest('hex');
}

export function previewRoster(ctx: RequestContext, raw: Input): RosterPreview {
  const input = RosterInput.parse(raw); const { headers, rows } = inspect(ctx, input); const expiry = now() + 30 * 60_000;
  return { headers, rows, ready: rows.filter((r) => r.status === 'ready').length, skipped: rows.filter((r) => r.status === 'skipped').length, rejected: rows.filter((r) => r.status === 'rejected').length,
    previewToken: `${expiry}.${fingerprint(ctx, input, rows, expiry)}`, expiresAt: new Date(expiry).toISOString() };
}

export function commitRoster(ctx: RequestContext, raw: z.infer<typeof CommitRoster>, key: string | undefined) {
  const body = CommitRoster.parse(raw); enrollmentBranch(ctx, body.branchId);
  if (!key || key.length > 200) throw invalid('An idempotency key is required for roster confirmation.');
  // Actor is part of the replay namespace; authorization above also precedes cached replies.
  return runIdempotently(ctx, `members.import:${ctx.userId}`, key, body, () => {
    const input = RosterInput.parse({ branchId: body.branchId, csv: body.csv, mapping: body.mapping });
    const { rows, people } = inspect(ctx, input);
    const [expiryText, signature, extra] = body.previewToken.split('.'); const expiry = Number(expiryText);
    if (extra || !Number.isSafeInteger(expiry) || expiry <= now() || !signature || !constantTimeEqual(signature, fingerprint(ctx, input, rows, expiry))) throw conflict('The preview expired, changed or belongs to another operator. Preview again before confirming.');
    const importId = id('imp');
    const results = rows.map((row, index): RosterRowResult => {
      if (row.status !== 'ready') return row;
      const person = people[index]!;
      const created = enrollMember(ctx, { branchId: input.branchId, name: `${person.firstName} ${person.lastName}`.trim(), email: person.email, phone: person.phone });
      db.update(schema.members).set({ firstName: person.firstName, lastName: person.lastName, dob: person.dob, addressLine: person.addressLine, emergencyContact: person.emergencyContact }).where(eq(schema.members.id, created.memberId)).run();
      audit(ctx, { action: 'member.imported', entityType: 'member', entityId: created.memberId, entityLabel: created.memberNo, after: { importId, row: row.row, contactsOnly: true, activationReady: Boolean(person.email) } });
      return { ...row, status: 'imported', memberId: created.memberId, memberNo: created.memberNo };
    });
    const result = { importId, rows: results, imported: results.filter((r) => r.status === 'imported').length, skipped: results.filter((r) => r.status === 'skipped').length, rejected: results.filter((r) => r.status === 'rejected').length };
    audit(ctx, { action: 'roster.imported', entityType: 'import', entityId: importId, entityLabel: 'Contact roster', after: result });
    for (const row of results) if (row.memberId) profileChanged(ctx, row.memberId, input.branchId);
    return result;
  });
}
