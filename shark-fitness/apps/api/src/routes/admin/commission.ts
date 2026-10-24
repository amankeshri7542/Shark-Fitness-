import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { ctxOf } from '../../middleware/index.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  approveCommission,
  calculateCommission,
  commissionReport,
  commissionRules,
  correctCommission,
  markCommissionPaid,
  pendingCommission,
} from '../../services/commission.js';

/**
 * Staff commission (PF-STAFF). A thin adapter over `services/commission.ts`.
 *
 * Its own router, and `app.ts` mounts it at `/v1/admin/staff/commission`
 * *before* `/v1/admin/staff` — otherwise the staff detail route `GET
 * /:staffId` matches `/commission` first and every read here 404s with
 * "That member of staff", which is exactly what happened the first time these
 * lived at the bottom of `staff.ts`.
 */
export const commissionRoutes = new Hono();


/* ============================================================================
   Commission (PF-STAFF).

   Viewing and approving are different permissions, and the split is the point:
   whoever reads a run does not sign it off. Nothing here moves money — marking
   a line paid records an external payroll settlement.
   ========================================================================= */

const PeriodQuery = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staffId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  state: z.enum(['pending', 'approved', 'paid', 'reversed']).optional(),
});

commissionRoutes.get('/rules', (c) => c.json(commissionRules(ctxOf(c))));

commissionRoutes.get('/pending', (c) => c.json(pendingCommission(ctxOf(c))));

commissionRoutes.get('/', validate('query', PeriodQuery), (c) =>
  c.json(commissionReport(ctxOf(c), c.req.valid('query'))),
);

const CalculateBody = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().min(1).optional(),
});

commissionRoutes.post('/calculate', validate('json', CalculateBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(
    ctx,
    '/admin/staff/commission/calculate',
    c.req.header('idempotency-key'),
    body,
    () => calculateCommission(ctx, body),
  );
  return c.json(response, 201);
});

const LineIdsBody = z.object({ lineIds: z.array(z.string().min(1)).min(1).max(500) });

commissionRoutes.post('/approve', validate('json', LineIdsBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(
    ctx,
    '/admin/staff/commission/approve',
    c.req.header('idempotency-key'),
    body,
    () => approveCommission(ctx, body.lineIds),
  );
  return c.json(response);
});

const PaidBody = LineIdsBody.extend({ reference: z.string().trim().min(3).max(80) });

commissionRoutes.post('/paid', validate('json', PaidBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(
    ctx,
    '/admin/staff/commission/paid',
    c.req.header('idempotency-key'),
    body,
    () => markCommissionPaid(ctx, body.lineIds, body.reference),
  );
  return c.json(response);
});

const CorrectBody = z.object({
  reason: z.string().trim().min(4).max(280),
  /** Omitted means a full reversal. */
  amountMinor: z.number().int().min(1).optional(),
});

commissionRoutes.post('/:lineId/correct', validate('json', CorrectBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(
    ctx,
    `/admin/staff/commission/${c.req.param('lineId')}/correct`,
    c.req.header('idempotency-key'),
    body,
    () =>
      correctCommission(ctx, c.req.param('lineId'), {
        reason: body.reason,
        ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
      }),
  );
  return c.json(response, 201);
});
