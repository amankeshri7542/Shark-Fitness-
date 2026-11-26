import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { requirePermission } from '../../lib/context.js';
import { requireFreshAuth } from '../../lib/step-up.js';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { ctxOf } from '../../middleware/index.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  applyErasure,
  generateExportPackage,
  listLegalHolds,
  listPrivacyRequests,
  placeLegalHold,
  privacyRequestDetail,
  readExportPackage,
  releaseLegalHold,
  reviewPrivacyRequest,
  submitPrivacyRequest,
} from '../../services/privacy.js';

/**
 * Data-subject requests and legal holds (PF-COMP).
 *
 * Mounted at `/v1/admin/privacy`. Every verb here is gated on
 * `settings.manage` inside the service — erasure and legal holds are not
 * things a branch manager does on a busy afternoon.
 */
export const privacyRoutes = new Hono();

privacyRoutes.get(
  '/requests',
  validate('query', z.object({ state: z.enum(['submitted', 'in_review', 'on_hold', 'completed', 'refused']).optional() })),
  (c) => c.json(listPrivacyRequests(ctxOf(c), c.req.valid('query'))),
);

privacyRoutes.get('/requests/:id', (c) => c.json(privacyRequestDetail(ctxOf(c), c.req.param('id'))));

const SubmitBody = z.object({
  subjectUserId: z.string().min(1),
  kind: z.enum(['export', 'deletion']),
  reason: z.string().max(500).nullable().default(null),
});

/** Raising a request on a member's behalf — they phoned, or wrote in. */
privacyRoutes.post('/requests', validate('json', SubmitBody), (c) => {
  const ctx = ctxOf(c);
  // The service is shared with members' own requests, which need no staff
  // permission, so the staff gate lives here (P08: any role could raise a
  // deletion request for anyone in the gym).
  requirePermission(ctx, 'settings.manage');
  const body = c.req.valid('json');
  const response = runIdempotently(ctx, '/admin/privacy/requests', c.req.header('idempotency-key'), body, () =>
    submitPrivacyRequest(ctx, body),
  );
  return c.json(response, 201);
});

const ReviewBody = z.object({
  decision: z.enum(['accept', 'refuse']),
  note: z.string().trim().min(4).max(500),
});

privacyRoutes.post('/requests/:id/review', validate('json', ReviewBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  // Accepting a deletion request is the approval to erase someone (PRD 01 §2.4).
  if (body.decision === 'accept') {
    requirePermission(ctx, 'settings.manage');
    const request = db
      .select({ kind: schema.privacyRequests.kind })
      .from(schema.privacyRequests)
      .where(and(eq(schema.privacyRequests.id, c.req.param('id')), eq(schema.privacyRequests.tenantId, ctx.tenantId)))
      .get();
    if (request?.kind === 'deletion') requireFreshAuth(ctx, 'privacy.deletion_approve');
  }
  return c.json(reviewPrivacyRequest(ctx, c.req.param('id'), body));
});

/** Builds the package into `privacy_artifacts`. Sends nothing anywhere, and
 *  says so in the response. */
privacyRoutes.post('/requests/:id/export', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'settings.manage');
  requireFreshAuth(ctx, 'privacy.export');
  const requestId = c.req.param('id');
  const response = runIdempotently(
    ctx,
    `/admin/privacy/requests/${requestId}/export`,
    c.req.header('idempotency-key'),
    {},
    () => generateExportPackage(ctx, requestId),
  );
  return c.json(response, 201);
});

privacyRoutes.get('/requests/:id/export', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'settings.manage');
  requireFreshAuth(ctx, 'privacy.export');
  return c.json(readExportPackage(ctx, c.req.param('id')));
});

/** Executes the anonymisation plan. Refused while a legal hold or the tenant's
 *  own retention window is in the way, with the reason. */
privacyRoutes.post('/requests/:id/erase', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'settings.manage');
  requireFreshAuth(ctx, 'privacy.erase');
  const requestId = c.req.param('id');
  const response = runIdempotently(
    ctx,
    `/admin/privacy/requests/${requestId}/erase`,
    c.req.header('idempotency-key'),
    {},
    () => applyErasure(ctx, requestId),
  );
  return c.json(response);
});

privacyRoutes.get('/holds', (c) => c.json(listLegalHolds(ctxOf(c))));

const HoldBody = z.object({
  subjectUserId: z.string().min(1),
  reason: z.string().trim().min(4).max(500),
  reference: z.string().max(120).nullable().default(null),
});

privacyRoutes.post('/holds', validate('json', HoldBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(ctx, '/admin/privacy/holds', c.req.header('idempotency-key'), body, () =>
    placeLegalHold(ctx, body),
  );
  return c.json(response, 201);
});

privacyRoutes.post(
  '/holds/:id/release',
  validate('json', z.object({ reason: z.string().trim().min(4).max(500) })),
  (c) => c.json(releaseLegalHold(ctxOf(c), c.req.param('id'), c.req.valid('json').reason)),
);
