import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema, transact } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requirePermission } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';

/**
 * "Show on website" for a plan (Plans screen). Mounted at
 * `/v1/admin/billing/products`, beside the catalogue routes it belongs to.
 *
 * Publishing is not an edit of the plan's terms, so it neither bumps the
 * product version nor touches memberships already sold. The website still
 * shows only *active* plans: ticking this on a draft makes it appear the
 * moment the draft is activated, and retiring a plan takes it off the site
 * without anyone having to remember to untick it.
 */
export const productWebsiteRoutes = new Hono();

const Body = z.object({ public: z.boolean() });

productWebsiteRoutes.put('/:productId/website', validate('json', Body), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'product.manage');
  const productId = c.req.param('productId');
  const { public: isPublic } = c.req.valid('json');

  const product = db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId)))
    .get();
  if (!product) throw notFound('That product');

  if (product.isPublic !== isPublic) {
    transact(() => {
      db.update(schema.products).set({ isPublic, updatedAt: now() }).where(eq(schema.products.id, productId)).run();
      audit(ctx, {
        action: isPublic ? 'product.published' : 'product.unpublished',
        entityType: 'product',
        entityId: productId,
        entityLabel: product.name,
        before: { public: product.isPublic },
        after: { public: isPublic },
      });
    });
  }
  return c.json({ ok: true, public: isPublic, listed: isPublic && product.status === 'active' });
});
