import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

/* ============================================================================
   A PATCH with nothing in it.

   Found by sending every route an empty body: these five reached the database
   as an update with no columns, which Drizzle refuses by throwing, and the
   caller saw a 500. A request that changes nothing is the caller's mistake,
   and the answer should say so.
   ========================================================================= */

async function ownerSession(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

describe('an empty PATCH is refused, not a server error', () => {
  it('answers 422 and names what is missing on every PATCH that used to fail', async () => {
    const owner = await ownerSession();
    const tenantId = db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
    const product = db.select({ id: schema.retailProducts.id }).from(schema.retailProducts).where(eq(schema.retailProducts.tenantId, tenantId)).get()!;
    const equipment = db.select({ id: schema.equipment.id }).from(schema.equipment).where(and(eq(schema.equipment.tenantId, tenantId), eq(schema.equipment.branchId, 'br_kor'))).get()!;
    const workOrder = db.select({ id: schema.workOrders.id }).from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, tenantId), eq(schema.workOrders.branchId, 'br_kor'))).get()!;
    const task = db.select({ id: schema.facilityTasks.id }).from(schema.facilityTasks).where(and(eq(schema.facilityTasks.tenantId, tenantId), eq(schema.facilityTasks.branchId, 'br_kor'))).get()!;

    for (const path of [
      `/v1/admin/store/products/${product.id}`,
      `/v1/admin/facility/equipment/${equipment.id}`,
      `/v1/admin/facility/work-orders/${workOrder.id}`,
      `/v1/admin/facility/tasks/${task.id}`,
      `/v1/admin/facility/facility-tasks/${task.id}`,
    ]) {
      const res = await app.request(path, {
        method: 'PATCH',
        headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, path).toBe(422);
      expect(((await res.json()) as { error: { message: string } }).error.message, path).toMatch(/at least one field/);
    }
  });
});
