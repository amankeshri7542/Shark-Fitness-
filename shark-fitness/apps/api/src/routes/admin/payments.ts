import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { requireIdempotencyKey } from '../../services/payments/checkout.js';
import { createInvoicePaymentLink } from '../../services/payments/payment-links.js';
import { listReconciliationExceptions, resolveReconciliationException } from '../../services/payments/reconciliation.js';

/** Razorpay operations for staff (P02): payment links and the
 *  reconciliation queue. Mounted under /v1/admin/billing. */
export const paymentAdminRoutes = new Hono();

paymentAdminRoutes.post('/invoices/:invoiceId/payment-link', async (c) => {
  const ctx = ctxOf(c);
  const key = requireIdempotencyKey(c.req.header('idempotency-key'));
  return c.json(await createInvoicePaymentLink(ctx, c.req.param('invoiceId'), key), 201);
});

paymentAdminRoutes.get(
  '/reconciliation',
  validate('query', z.object({ state: z.enum(['open', 'resolved', 'ignored', 'all']).default('open') })),
  (c) => c.json(listReconciliationExceptions(ctxOf(c), c.req.valid('query').state)),
);

paymentAdminRoutes.post(
  '/reconciliation/:exceptionId/resolve',
  validate('json', z.object({ action: z.enum(['resolve', 'ignore']), reason: z.string().trim().min(4, 'Give a reason of at least 4 characters.').max(500) })),
  (c) => {
    const body = c.req.valid('json');
    return c.json(resolveReconciliationException(ctxOf(c), c.req.param('exceptionId'), body.action, body.reason));
  },
);
