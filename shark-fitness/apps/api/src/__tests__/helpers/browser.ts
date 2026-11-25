import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { app } from '../../app.js';
import { bootstrapGym } from '../../db/bootstrap.js';
import { db, schema } from '../../db/client.js';
import { hashPassword } from '../../lib/crypto.js';
import { id, initialsOf } from '../../lib/ids.js';
import { now } from '../../lib/time.js';

export const ORIGIN = 'http://localhost:5173';

/**
 * A browser for the security suites: it keeps the session and CSRF cookies the
 * way a real one does, so a test reads as the sequence of requests a person
 * makes (sign in → challenged → code → full session) rather than as header
 * plumbing.
 */
export class Browser {
  session: string | null = null;
  csrf: string | null = null;
  readonly userAgent: string;

  constructor(userAgent = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36') {
    this.userAgent = userAgent;
  }

  async request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const cookies = [this.session ? `shark_session=${this.session}` : null, this.csrf ? `shark_csrf=${this.csrf}` : null].filter(Boolean);
    const response = await app.request(`/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        'user-agent': this.userAgent,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
        ...(method !== 'GET' && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const setCookie = response.headers.get('set-cookie') ?? '';
    const session = setCookie.match(/shark_session=([^;,]*)/)?.[1];
    if (session !== undefined) this.session = session || null;
    if (response.headers.get('content-type')?.includes('application/json')) {
      const body = (await response.clone().json()) as { csrfToken?: unknown };
      if (typeof body?.csrfToken === 'string') this.csrf = body.csrfToken;
    }
    return response;
  }

  async json<T = Record<string, unknown>>(path: string, init: Parameters<Browser['request']>[1] = {}): Promise<{ status: number; body: T }> {
    const response = await this.request(path, init);
    return { status: response.status, body: (await response.json()) as T };
  }

  signIn(tenantSlug: string, email: string, password: string) {
    return this.json<{ viewer: { userId: string; role: string }; csrfToken: string; mfa: { state: string } }>('/auth/password', {
      body: { tenantSlug, email, password },
    });
  }
}

export interface TestGym {
  slug: string;
  tenantId: string;
  branchId: string;
  owner: { email: string; password: string; userId: string };
}

export function newGym(label = 'security'): TestGym {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const owner = { email: `owner@${slug}.test`, password: 'owner-password-for-tests' };
  const gym = bootstrapGym({
    slug,
    legalName: `${label} gym`,
    displayName: `${label} gym`,
    timezone: 'Asia/Kolkata',
    owner: { name: 'Test Owner', ...owner },
    branch: { name: 'Main', slug: 'main', addressLine: '1 Test Road', city: 'Test', capacity: 80, opensMinutes: 0, closesMinutes: 1440 },
  });
  return { slug, tenantId: gym.tenantId, branchId: gym.branchId, owner: { ...owner, userId: gym.ownerId } };
}

export function addStaff(tenantId: string, branchIds: string[], role: string, password = 'staff-password-for-tests') {
  const userId = id('usr');
  const staffId = id('stf');
  const email = `${role}-${userId}@staff.test`;
  const at = now();
  db.insert(schema.users)
    .values({
      id: userId, tenantId, email, phone: null, name: `Test ${role}`, initials: initialsOf(`Test ${role}`), role,
      accountState: 'active', passwordHash: hashPassword(password), preferences: {}, lastSeenAt: null, createdAt: at, updatedAt: at,
    })
    .run();
  db.insert(schema.staff)
    .values({
      id: staffId, tenantId, userId, employmentStatus: 'active', branchIds, specialties: [], certifications: [],
      commissionRules: [], hourlyRateMinor: null, joinedOn: '2026-01-01', createdAt: at, updatedAt: at,
    })
    .run();
  return { userId, staffId, email, password };
}

/** Audit actions recorded for one tenant (optionally one entity), oldest first. */
export function auditActions(tenantId: string, entityId?: string): string[] {
  return db
    .select({ action: schema.auditLog.action, entityId: schema.auditLog.entityId, at: schema.auditLog.at })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.tenantId, tenantId))
    .all()
    .filter((row) => entityId === undefined || row.entityId === entityId)
    .sort((a, b) => a.at - b.at)
    .map((row) => row.action);
}
