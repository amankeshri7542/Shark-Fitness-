import { eq } from 'drizzle-orm';
import { resolvePolicy, type Resolved } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { isoDate, localDayIndex } from './time.js';

/**
 * Reading a policy value the way the settings screen writes it (PF-TEN-003).
 *
 * Every consumer used to load the tenant row and read the key off it, which
 * made a branch override a thing the console could store and nothing could
 * act on. This is the single read: the branch's value if it holds one, the
 * tenant's otherwise, the shipped default if neither has an opinion.
 *
 * Both rows are fetched per call rather than cached. The alternative is a
 * cache that has to be invalidated from the settings writer, and a door
 * deciding entry from a stale anti-passback window is a worse failure than one
 * extra indexed read on a table with a handful of rows.
 */
export function branchPolicy<T>(
  tenantId: string,
  branchId: string | null,
  key: string,
  fallback: T,
): Resolved<T> {
  const tenantPolicy = (db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.policy ??
    {}) as Record<string, unknown>;
  const branchOverrides = branchId
    ? ((db.select({ policy: schema.branches.policy }).from(schema.branches).where(eq(schema.branches.id, branchId)).get()
        ?.policy ?? {}) as Record<string, unknown>)
    : {};
  return resolvePolicy(key, tenantPolicy, branchOverrides, fallback);
}

/** The value alone, for a caller that does not need to say where it came from. */
export const policyValue = <T>(tenantId: string, branchId: string | null, key: string, fallback: T): T =>
  branchPolicy(tenantId, branchId, key, fallback).value;

/* ——— Opening hours ————————————————————————————————————— */

/** `localDayIndex` is Monday-first (0 = Mon), not the `Date.getDay()` order.
 *  Assuming Sunday-first here shifts every branch's hours by a day, which is
 *  the sort of thing that looks fine until a Sunday. */
const DAY_INDEX_TO_KEY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface OpenWindow {
  openMinutes: number;
  closeMinutes: number;
  /** True when the branch does not trade at all on this day. */
  closed: boolean;
  /** Why it is closed, for a denial a member can act on. */
  reason: 'holiday' | 'day_closed' | null;
}

/**
 * The hours in force at a branch on the local day containing `atMs`.
 *
 * Three sources, most specific first: a holiday closes the day outright, a
 * per-day entry in `hours` wins for that weekday, and the branch's
 * `opensMinutes`/`closesMinutes` pair is the typical day everything falls back
 * to. That fallback is why adding per-day hours did not change a single
 * existing decision — a branch with no `hours` set behaves exactly as it did
 * before the column existed.
 */
export function openWindow(
  branch: {
    timezone: string;
    opensMinutes: number;
    closesMinutes: number;
    hours?: Record<string, { open: number; close: number; closed: boolean }> | null;
    holidays?: string[] | null;
  },
  atMs: number,
): OpenWindow {
  const typical = { openMinutes: branch.opensMinutes, closeMinutes: branch.closesMinutes, closed: false, reason: null as null };

  if ((branch.holidays ?? []).includes(isoDate(atMs, branch.timezone))) {
    return { openMinutes: 0, closeMinutes: 0, closed: true, reason: 'holiday' };
  }

  const key = DAY_INDEX_TO_KEY[localDayIndex(atMs, branch.timezone)];
  const day = key ? branch.hours?.[key] : undefined;
  if (!day) return typical;
  if (day.closed) return { openMinutes: 0, closeMinutes: 0, closed: true, reason: 'day_closed' };
  return { openMinutes: day.open, closeMinutes: day.close, closed: false, reason: null };
}
