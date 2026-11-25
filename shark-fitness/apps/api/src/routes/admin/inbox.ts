import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import {
  addInboxNote,
  assignInbox,
  inboxThread,
  listInbox,
  markInboxRead,
  replyInInbox,
  setInboxState,
} from '../../services/inbox.js';

/**
 * The staff Inbox (P07). Thin adapter over services/inbox.ts.
 * Mounted by `app.ts` at `/v1/admin/inbox`.
 */
export const inboxRoutes = new Hono();
const inboxWriteLimit = rateLimit(60, 60_000, { identity: 'actor', bucket: 'admin-inbox-write' });

const ListQuery = z.object({
  filter: z.enum(['all', 'mine', 'unassigned', 'unread', 'closed']).optional().default('all'),
  q: z.string().trim().max(80).optional(),
});

inboxRoutes.get('/', validate('query', ListQuery), (c) => {
  const { filter, q } = c.req.valid('query');
  return c.json(listInbox(ctxOf(c), filter, q || undefined));
});

inboxRoutes.get('/:conversationId', (c) => c.json(inboxThread(ctxOf(c), c.req.param('conversationId'))));

inboxRoutes.post('/:conversationId/read', (c) => c.json(markInboxRead(ctxOf(c), c.req.param('conversationId'))));

inboxRoutes.post(
  '/:conversationId/reply',
  inboxWriteLimit,
  validate('json', z.object({ body: z.string().trim().min(1).max(4000), clientId: z.string().min(8).max(64) })),
  (c) => {
    const result = replyInInbox(ctxOf(c), c.req.param('conversationId'), c.req.valid('json'));
    return c.json(result, result.duplicate ? 200 : 201);
  },
);

inboxRoutes.post(
  '/:conversationId/notes',
  inboxWriteLimit,
  validate('json', z.object({ body: z.string().trim().min(1).max(2000) })),
  (c) => c.json(addInboxNote(ctxOf(c), c.req.param('conversationId'), c.req.valid('json').body), 201),
);

inboxRoutes.post(
  '/:conversationId/assign',
  validate('json', z.object({ staffId: z.string().min(1).nullable() })),
  (c) => c.json(assignInbox(ctxOf(c), c.req.param('conversationId'), c.req.valid('json').staffId)),
);

inboxRoutes.post(
  '/:conversationId/state',
  validate('json', z.object({ state: z.enum(['open', 'closed']) })),
  (c) => c.json(setInboxState(ctxOf(c), c.req.param('conversationId'), c.req.valid('json').state)),
);
