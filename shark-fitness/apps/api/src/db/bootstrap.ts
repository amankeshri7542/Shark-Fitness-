import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { db, schema, sqlite, transact } from './client.js';
import { hashPassword } from '../lib/crypto.js';
import { id, initialsOf, normalizeEmail } from '../lib/ids.js';
import { isoDate } from '../lib/time.js';

const Name = z.string().trim().min(1).max(160);
const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const BootstrapInput = z.object({
  slug: Slug,
  legalName: Name,
  displayName: Name,
  timezone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Use an IANA timezone.'),
  owner: z.object({ name: Name, email: z.string().trim().email(), password: z.string().min(12).max(128) }).strict(),
  branch: z.object({
    name: Name, slug: Slug, addressLine: Name, city: Name,
    capacity: z.number().int().min(1).max(100_000),
    opensMinutes: z.number().int().min(0).max(1439),
    closesMinutes: z.number().int().min(1).max(1440),
  }).strict().refine((value) => value.closesMinutes > value.opensMinutes, 'Closing time must follow opening time.'),
}).strict();

/** Operator-only provisioning: no demo records, no existing tenant mutations. */
export function bootstrapGym(input: unknown) {
  const values = BootstrapInput.parse(input);
  const now = Date.now();
  const tenantId = id('ten');
  const branchId = id('br');
  const userId = id('usr');
  const passwordHash = hashPassword(values.owner.password);
  return transact(() => {
    db.insert(schema.tenants).values({
      id: tenantId, slug: values.slug, legalName: values.legalName, displayName: values.displayName,
      timezone: values.timezone, featureFlags: { classes: true, pos: true }, quotas: {},
      branding: {}, policy: { allowNegativeStock: false }, createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.branches).values({
      ...values.branch, id: branchId, tenantId, timezone: values.timezone,
      amenities: [], holidays: [], createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.users).values({
      id: userId, tenantId, email: normalizeEmail(values.owner.email), name: values.owner.name,
      initials: initialsOf(values.owner.name), role: 'owner', passwordHash,
      preferences: {}, createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.staff).values({
      id: id('stf'), tenantId, userId, branchIds: [branchId], specialties: [],
      certifications: [], commissionRules: [], joinedOn: isoDate(now, values.timezone),
      createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.auditLog).values({
      id: id('aud'), tenantId, branchId, actorId: userId, actorName: values.owner.name,
      actorRole: 'owner', action: 'tenant.provisioned', entityType: 'tenant', entityId: tenantId,
      entityLabel: values.displayName, reason: 'Operator bootstrap', changes: [], at: now,
    }).run();
    return { tenantId, tenantSlug: values.slug, branchId, ownerId: userId };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(bootstrapGym(JSON.parse(readFileSync(0, 'utf8')))));
  } finally {
    sqlite.close();
  }
}
