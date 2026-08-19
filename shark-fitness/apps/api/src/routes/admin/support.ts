import { Hono } from 'hono';
import { z } from 'zod';
import {
  FeedbackKind,
  InterventionAction,
  InterventionOutcome,
  TicketCategory,
  TicketPriority,
  TicketState,
} from '@shark/contracts';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  closeIntervention,
  createIntervention,
  createTicket,
  escalateTicket,
  feedbackSummary,
  recordFeedback,
  reopenTicket,
  replyToTicket,
  resolveTicket,
  retentionView,
  ticketDetail,
  ticketQueue,
  updateTicket,
} from '../../services/support.js';

/**
 * Support, feedback and retention (PF-SUP). A thin adapter: validate,
 * delegate, serialise. Permission and scope checks live in the service so
 * every caller gets them, not just the ones routed through here.
 *
 * Mounted by `app.ts` at `/v1/admin/support`.
 */
export const supportRoutes = new Hono();

const Flag = z.enum(['breached', 'unassigned', 'escalated', 'mine']);

const QueueQuery = z.object({
  branchId: z.string().min(1).optional(),
  state: TicketState.optional(),
  priority: TicketPriority.optional(),
  category: TicketCategory.optional(),
  assigneeId: z.string().min(1).optional(),
  flag: Flag.optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const TicketBody = z.object({
  memberId: z.string().min(1).nullable().default(null),
  branchId: z.string().min(1).nullable().default(null),
  category: TicketCategory,
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
  priority: TicketPriority.optional(),
});

const ReplyBody = z.object({
  body: z.string().trim().min(1).max(4000),
  internal: z.boolean().default(false),
});

const PatchBody = z.object({
  assigneeId: z.string().min(1).nullable().optional(),
  priority: TicketPriority.optional(),
  state: TicketState.optional(),
  vulnerabilityFlag: z.boolean().optional(),
});

const ReasonBody = z.object({ reason: z.string().trim().min(4).max(1000) });
const ResolveBody = z.object({ resolution: z.string().trim().min(4).max(1000) });

const FeedbackQuery = z.object({
  branchId: z.string().min(1).optional(),
  kind: FeedbackKind.optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const FeedbackBody = z.object({
  memberId: z.string().min(1).nullable().default(null),
  branchId: z.string().min(1).nullable().default(null),
  kind: FeedbackKind,
  score: z.coerce.number().int().min(0).max(10).nullable().default(null),
  comment: z.string().trim().max(2000).default(''),
  anonymous: z.boolean().default(false),
  subjectType: z.string().trim().max(40).nullable().default(null),
  subjectId: z.string().min(1).nullable().default(null),
  subjectLabel: z.string().trim().max(160).nullable().default(null),
});

const RetentionQuery = z.object({
  branchId: z.string().min(1).optional(),
  band: z.enum(['high', 'watch', 'low']).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

const InterventionBody = z.object({
  memberId: z.string().min(1),
  action: InterventionAction,
  note: z.string().trim().max(1000).default(''),
  assigneeId: z.string().min(1).nullable().default(null),
  dueInDays: z.coerce.number().int().min(1).max(60).default(3),
  ticketId: z.string().min(1).nullable().default(null),
});

const InterventionCloseBody = z.object({
  outcome: InterventionOutcome,
  outcomeNote: z.string().trim().max(1000).default(''),
  state: z.enum(['done', 'dismissed']).default('done'),
});

/* ------------------------------------------------------------------ reads */

supportRoutes.get('/tickets', validate('query', QueueQuery), (c) => {
  const q = c.req.valid('query');
  return c.json(
    ticketQueue(ctxOf(c), {
      branchId: q.branchId ?? null,
      state: q.state ?? null,
      priority: q.priority ?? null,
      category: q.category ?? null,
      assigneeId: q.assigneeId ?? null,
      flag: q.flag ?? null,
      search: q.q ?? null,
      limit: q.limit,
    }),
  );
});

supportRoutes.get('/tickets/:ticketId', (c) => c.json(ticketDetail(ctxOf(c), c.req.param('ticketId'))));

supportRoutes.get('/feedback', validate('query', FeedbackQuery), (c) => {
  const q = c.req.valid('query');
  return c.json(
    feedbackSummary(ctxOf(c), {
      branchId: q.branchId ?? null,
      kind: q.kind ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      limit: q.limit,
    }),
  );
});

supportRoutes.get('/retention', validate('query', RetentionQuery), (c) => {
  const q = c.req.valid('query');
  return c.json(retentionView(ctxOf(c), { branchId: q.branchId ?? null, band: q.band ?? null, limit: q.limit }));
});

/* ----------------------------------------------------------------- writes */

// A ticket raised from a phone with one bar must not become two tickets.
supportRoutes.post('/tickets', validate('json', TicketBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const result = runIdempotently(ctx, 'support.ticket.create', c.req.header('idempotency-key'), body, () =>
    createTicket(ctx, body),
  );
  return c.json(result, 201);
});

// Likewise a reply. The desk retries on a flaky connection, and the member must
// not be sent the same answer twice — a duplicate reply is visible to them.
supportRoutes.post('/tickets/:ticketId/reply', validate('json', ReplyBody), (c) => {
  const ctx = ctxOf(c);
  const ticketId = c.req.param('ticketId');
  const body = c.req.valid('json');
  const result = runIdempotently(
    ctx,
    'support.ticket.reply',
    c.req.header('idempotency-key'),
    { ticketId, ...body },
    () => replyToTicket(ctx, ticketId, body),
  );
  return c.json(result, 201);
});

supportRoutes.patch('/tickets/:ticketId', validate('json', PatchBody), (c) => {
  return c.json(updateTicket(ctxOf(c), c.req.param('ticketId'), c.req.valid('json')));
});

supportRoutes.post('/tickets/:ticketId/resolve', validate('json', ResolveBody), (c) => {
  return c.json(resolveTicket(ctxOf(c), c.req.param('ticketId'), c.req.valid('json').resolution));
});

supportRoutes.post('/tickets/:ticketId/reopen', validate('json', ReasonBody), (c) => {
  return c.json(reopenTicket(ctxOf(c), c.req.param('ticketId'), c.req.valid('json').reason));
});

supportRoutes.post('/tickets/:ticketId/escalate', validate('json', ReasonBody), (c) => {
  return c.json(escalateTicket(ctxOf(c), c.req.param('ticketId'), c.req.valid('json').reason));
});

supportRoutes.post('/feedback', validate('json', FeedbackBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const result = runIdempotently(ctx, 'support.feedback.record', c.req.header('idempotency-key'), body, () =>
    recordFeedback(ctx, body),
  );
  return c.json(result, 201);
});

supportRoutes.post('/interventions', validate('json', InterventionBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const result = runIdempotently(ctx, 'support.intervention.create', c.req.header('idempotency-key'), body, () =>
    createIntervention(ctx, body),
  );
  return c.json(result, 201);
});

supportRoutes.post('/interventions/:interventionId/close', validate('json', InterventionCloseBody), (c) => {
  return c.json(closeIntervention(ctxOf(c), c.req.param('interventionId'), c.req.valid('json')));
});
