import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { z, type ZodTypeAny } from 'zod';
import { db, schema } from '../db/client.js';
import { validatorSchemaOf } from '../middleware/validate.js';
import { chainFor, listRoutes, MUTATING_METHODS } from './helpers/routes.js';
import { call, signIn } from './helpers/session.js';

/**
 * [P09-SEC-MASS] Mass assignment (ASVS V5.1.2, PRD 04 ENT-SEC-002).
 *
 * Every JSON body is validated by a Zod object whose keys are an explicit
 * allowlist. Zod's default mode (`strip`) drops every undeclared key before the
 * handler sees the value, and `.strict()` refuses them; both are closed. What
 * would open it — `.passthrough()`, a `.catchall()`, a free-form record or
 * `z.any()` — is refused below unless listed with a reason, and no body may
 * declare a field the server owns (tenant, timestamps, authorship, hashes).
 *
 * Decision (P09): `strip` is kept rather than turning every body `.strict()`.
 * Both stop mass assignment; strict would additionally turn a client's harmless
 * extra field into a 400 for a person mid-task, across ~180 bodies the two
 * front ends build, with no security gain.
 */

const routes = listRoutes();

interface Finding {
  route: string;
  path: string;
  problem: string;
}

/** Open-ended values a body may carry, each bounded by its value type. */
const OPEN_FIELDS: Record<string, string> = {
  '.mapping': 'CSV column → roster field map; keys are refused unless a roster field (z.record(z.enum(RosterFields)))',
  '.terminology': 'owner-chosen labels; string values ≤ 40 chars, stored as display copy only',
  '.hours': 'opening hours keyed by weekday enum (WeekHours)',
  '.policy': 'branch policy overrides; keys checked by assertOverridable() before anything is written',
  '.featureFlags': 'platform operator only (platformOnly); boolean values',
  '.quotas': 'platform operator only (platformOnly); non-negative integers',
};

/** Fields only the server may set. A body that declares one is a bug. */
const SERVER_OWNED = new Set([
  'tenantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdBy',
  'createdByUserId',
  'passwordHash',
  'tokenHash',
  'secretHash',
  'permissions',
  'impersonatorId',
  'mfaState',
]);

function inspect(schema: ZodTypeAny, route: string, path: string, findings: Finding[]): void {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      if (def.unknownKeys === 'passthrough') findings.push({ route, path: path || '(body)', problem: 'passthrough() keeps undeclared keys' });
      if ((def.catchall as ZodTypeAny)._def.typeName !== z.ZodFirstPartyTypeKind.ZodNever) {
        findings.push({ route, path: path || '(body)', problem: 'catchall() accepts undeclared keys' });
      }
      for (const [key, field] of Object.entries((schema as z.AnyZodObject).shape as Record<string, ZodTypeAny>)) {
        if (SERVER_OWNED.has(key)) findings.push({ route, path: `${path}.${key}`, problem: 'declares a server-owned field' });
        inspect(field, route, `${path}.${key}`, findings);
      }
      return;
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
    case z.ZodFirstPartyTypeKind.ZodMap:
    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      if (!(path in OPEN_FIELDS)) findings.push({ route, path: path || '(body)', problem: `${def.typeName} accepts arbitrary keys` });
      return;
    case z.ZodFirstPartyTypeKind.ZodArray:
      inspect(def.type as ZodTypeAny, route, `${path}[]`, findings);
      return;
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      for (const option of Array.isArray(options) ? options : options.values()) inspect(option, route, path, findings);
      return;
    }
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      inspect(def.left as ZodTypeAny, route, path, findings);
      inspect(def.right as ZodTypeAny, route, path, findings);
      return;
    case z.ZodFirstPartyTypeKind.ZodTuple:
      for (const item of def.items as ZodTypeAny[]) inspect(item, route, path, findings);
      return;
    default:
      for (const inner of ['schema', 'innerType', 'in', 'type']) {
        const next = def[inner] as ZodTypeAny | undefined;
        if (next && typeof next === 'object' && '_def' in next) inspect(next, route, path, findings);
      }
  }
}

function jsonBodies(): Array<{ route: string; schema: ZodTypeAny }> {
  const bodies: Array<{ route: string; schema: ZodTypeAny }> = [];
  for (const route of routes) {
    for (const entry of chainFor(route).map(validatorSchemaOf)) {
      if (entry?.target === 'json') bodies.push({ route: `${route.method} ${route.path}`, schema: entry.schema as ZodTypeAny });
    }
  }
  return bodies;
}

describe('[P09-SEC-MASS] every JSON body is a closed allowlist', () => {
  const bodies = jsonBodies();

  it('finds the validated bodies through the route table', () => {
    expect(bodies.length).toBeGreaterThan(150);
    // Every validated body only ever arrives on a state-changing method.
    for (const body of bodies) expect(MUTATING_METHODS.has(body.route.split(' ')[0]!), body.route).toBe(true);
  });

  it('has no passthrough, catchall, free-form record or any() outside the listed fields', () => {
    const findings: Finding[] = [];
    for (const body of bodies) inspect(body.schema, body.route, '', findings);
    expect(findings.filter((finding) => !finding.problem.includes('server-owned'))).toEqual([]);
  });

  it('never lets a body name a field the server owns', () => {
    const findings: Finding[] = [];
    for (const body of bodies) inspect(body.schema, body.route, '', findings);
    expect(findings.filter((finding) => finding.problem.includes('server-owned'))).toEqual([]);
  });

  it('keeps the open-field list honest: each listed field still exists', () => {
    const seen = new Set<string>();
    const collect = (schema: ZodTypeAny, path: string): void => {
      const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
      if (def.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
        for (const [key, field] of Object.entries((schema as z.AnyZodObject).shape as Record<string, ZodTypeAny>)) collect(field, `${path}.${key}`);
        return;
      }
      if (def.typeName === z.ZodFirstPartyTypeKind.ZodRecord) seen.add(path);
      for (const inner of ['schema', 'innerType', 'in', 'type']) {
        const next = def[inner] as ZodTypeAny | undefined;
        if (next && typeof next === 'object' && '_def' in next) collect(next, path);
      }
    };
    for (const body of bodies) collect(body.schema, '');
    for (const field of Object.keys(OPEN_FIELDS)) expect(seen.has(field), field).toBe(true);
  });

  it('drops an undeclared tenantId instead of acting on it', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const lead = db.select().from(schema.leads).where(eq(schema.leads.tenantId, 'ten_shark')).get()!;
    const response = await call(owner, 'PATCH', `/v1/admin/leads/${lead.id}`, { nextActionLabel: 'P09 mass-assignment probe', tenantId: 'ten_reef', createdAt: 0 });
    expect(response.status).toBe(200);
    const after = db.select().from(schema.leads).where(and(eq(schema.leads.id, lead.id))).get()!;
    expect(after.tenantId).toBe('ten_shark');
    expect(after.createdAt).toBe(lead.createdAt);
    expect(after.nextActionLabel).toBe('P09 mass-assignment probe');
  });
});

/**
 * Bodies read without `validate()`. Each is a raw-body boundary with its own
 * checks; a new one has to be reviewed and added here.
 */
const RAW_BODY_READERS: Record<string, string> = {
  'routes/webhooks.ts': 'Razorpay webhook: HMAC over the exact raw bytes, size-capped before parsing',
  'routes/csp-reports.ts': 'CSP reports: streamed with a byte cap, parsed defensively, nothing stored verbatim',
  'routes/client-errors.ts': 'browser error reports: streamed with a byte cap, then validated with Zod',
  'routes/member/messages.ts': 'attachment upload: multipart under bodyLimit, bytes sniffed and re-encoded',
  'routes/member/photos.ts': 'progress photo upload: multipart under bodyLimit, bytes sniffed and re-encoded',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : name.endsWith('.ts') ? [full] : [];
  });
}

describe('[P09-SEC-MASS] bodies are read through validate() except reviewed raw-body boundaries', () => {
  it('lists every route file that reads a body directly', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const readers = sourceFiles(join(src, 'routes'))
      .filter((file) => /c\.req\.(json|text|parseBody|arrayBuffer|blob|formData)\(|c\.req\.raw\.body/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file).split('\\').join('/'))
      .sort();
    expect(readers).toEqual(Object.keys(RAW_BODY_READERS).sort());
  });
});
