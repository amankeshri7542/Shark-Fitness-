import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  createAutomation,
  listAutomations,
  listTemplates,
  previewRun,
  runAutomation,
  runHistory,
  saveTemplate,
  updateAutomation,
} from '../../services/automations.js';

/**
 * Automations (PF-COMM). A thin adapter: validate, delegate, serialise.
 *
 * There is no "send now" endpoint that bypasses the rules. `POST /:id/run`
 * runs the automation exactly as the scheduler does, through the same plan and
 * the same suppression checks — an operator pressing a button and a job firing
 * at 06:00 get the same answer, which is the only way the run log means
 * anything.
 *
 * Mounted by `app.ts` at `/v1/admin/automations`.
 */
export const automationRoutes = new Hono();

const ConditionInput = z.object({
  field: z.string().trim().min(1).max(40),
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains']),
  value: z.string().trim().max(120),
});

const AutomationBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  trigger: z.string().trim().min(1).max(60),
  conditions: z.array(ConditionInput).max(10).default([]),
  channel: z.enum(['in_app', 'push', 'email', 'sms', 'whatsapp']),
  templateCode: z.string().trim().max(60).nullable(),
  delayMin: z.number().int().min(0).max(7 * 24 * 60).optional(),
  branchIds: z.array(z.string().trim().min(1)).min(1).max(100).nullable().optional(),
  quietHours: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).nullable().optional(),
});

automationRoutes.get('/', (c) => c.json(listAutomations(ctxOf(c))));

automationRoutes.post('/', validate('json', AutomationBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const response = runIdempotently(ctx, '/admin/automations', c.req.header('idempotency-key'), body, () =>
    createAutomation(ctx, { ...body, delayMin: body.delayMin ?? 0 }),
  );
  return c.json(response, 201);
});

automationRoutes.patch(
  '/:automationId',
  validate('json', AutomationBody.partial().extend({
    state: z.enum(['draft', 'active', 'paused']).optional(),
    dryRun: z.boolean().optional(),
  })),
  (c) => c.json(updateAutomation(ctxOf(c), c.req.param('automationId'), c.req.valid('json'))),
);

/** What this would do, recording nothing (PF-COMM-004). */
automationRoutes.get('/:automationId/preview', (c) => c.json(previewRun(ctxOf(c), c.req.param('automationId'))));

/**
 * Runs it. Sends only if the automation is active *and* out of dry run —
 * decided in the service, so this endpoint cannot be the way somebody
 * accidentally goes live.
 */
automationRoutes.post(
  '/:automationId/run',
  rateLimit(10, 60_000, { identity: 'actor', bucket: 'automation-manual-run' }),
  (c) => c.json(runAutomation(ctxOf(c), c.req.param('automationId'))),
);

automationRoutes.get(
  '/runs',
  validate('query', z.object({
    automationId: z.string().optional(),
    outcome: z.enum(['sent', 'queued', 'suppressed', 'failed', 'dry_run']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })),
  (c) => c.json(runHistory(ctxOf(c), c.req.valid('query'))),
);

/* — Templates ————————————————————————————————————————————— */

automationRoutes.get('/templates', (c) => c.json(listTemplates(ctxOf(c))));

automationRoutes.post(
  '/templates',
  validate('json', z.object({
    code: z.string().trim().min(1).max(60).regex(/^[a-z0-9_.-]+$/, 'lowercase letters, numbers, dots, dashes'),
    channel: z.enum(['in_app', 'push', 'email', 'sms', 'whatsapp']),
    subject: z.string().trim().max(160).nullable(),
    body: z.string().trim().min(1).max(2000),
  })),
  (c) => {
    const ctx = ctxOf(c);
    const body = c.req.valid('json');
    return c.json(
      runIdempotently(ctx, '/admin/automations/templates', c.req.header('idempotency-key'), body, () => saveTemplate(ctx, body)),
      201,
    );
  },
);
