import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

/**
 * The zone a branch's business dates are computed in.
 *
 * `lib/time.ts` is pure — it takes a zone and formats. This is the one place
 * that answers *which* zone, so a handler never has to reach for a literal.
 * Before this existed the answer was inlined in four modules and hard-coded in
 * a fifth, which is how a receipt ended up dated by UTC while the invoice it
 * raised was dated by Asia/Kolkata: the same sale, two different days.
 *
 * The fallbacks are ordered by how much they know:
 *
 * 1. the branch, because a sale happens at a counter in a city;
 * 2. the tenant, when a figure spans branches and no single counter owns it;
 * 3. `Asia/Kolkata`, matching the column default in `core.ts` — reached only
 *    when neither row exists, which in practice means a caller passed an id
 *    from another tenant.
 *
 * Presentation only. Stored timestamps stay epoch milliseconds UTC, so
 * changing a branch's zone re-dates what is shown and never moves a row
 * (Engineering PRD §"Times stored in UTC; branch timezone retained for
 * presentation and scheduling rules").
 */
export function branchTimeZone(tenantId: string, branchId: string | null): string {
  if (branchId) {
    const branch = db
      .select({ timezone: schema.branches.timezone })
      .from(schema.branches)
      .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
      .get();
    if (branch) return branch.timezone;
  }
  const tenant = db
    .select({ timezone: schema.tenants.timezone })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .get();
  return tenant?.timezone ?? 'Asia/Kolkata';
}
