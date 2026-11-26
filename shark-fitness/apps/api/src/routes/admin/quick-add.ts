import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import { findDuplicate, quickAddMember } from '../../services/quick-add.js';
import { requirePermission } from '../../lib/context.js';

/**
 * Quick add for walk-ins (P07). Mounted by `app.ts` at
 * `/v1/admin/members/quick-add`, ahead of the member routes.
 */
export const quickAddRoutes = new Hono();
const quickAddLimit = rateLimit(60, 60_000, { identity: 'actor', bucket: 'admin-quick-add' });

const Phone = z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/, 'Enter a phone number with at least 8 digits.');

quickAddRoutes.get('/check', validate('query', z.object({ phone: z.string().max(30).optional(), email: z.string().max(200).optional() })), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'member.edit');
  const { phone, email } = c.req.valid('query');
  const duplicate = findDuplicate(ctx, phone ?? null, email ?? null);
  return c.json({ duplicate: duplicate ? (duplicate.visible ? duplicate.member : { hidden: true }) : null });
});

quickAddRoutes.post(
  '/',
  quickAddLimit,
  validate(
    'json',
    z
      .object({
        name: z.string().trim().min(2).max(120),
        phone: Phone,
        email: z.string().trim().email().max(200).nullable().optional(),
        branchId: z.string().min(1),
        productId: z.string().min(1).nullable().optional(),
      })
      .strict(),
  ),
  (c) => {
    const ctx = ctxOf(c);
    const body = c.req.valid('json');
    return c.json(runIdempotently(ctx, '/admin/members/quick-add', c.req.header('idempotency-key'), body, () => quickAddMember(ctx, body)), 201);
  },
);
