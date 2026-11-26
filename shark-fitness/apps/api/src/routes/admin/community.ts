import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import {
  approvalQueue,
  banFromCommunity,
  decideApproval,
  liftCommunityBan,
  listBans,
  moderate,
  reportsQueue,
} from '../../services/community.js';

/**
 * Community moderation (P07). Thin adapter over services/community.ts.
 * Mounted by `app.ts` at `/v1/admin/community`.
 */
export const communityRoutes = new Hono();
const moderationLimit = rateLimit(120, 60_000, { identity: 'actor', bucket: 'admin-community-moderation' });
const Reason = z.string().trim().max(500).default('');

communityRoutes.get('/reports', validate('query', z.object({ state: z.enum(['open', 'resolved']).optional().default('open') })), (c) =>
  c.json(reportsQueue(ctxOf(c), c.req.valid('query').state)),
);

communityRoutes.post(
  '/content/:targetType/:targetId',
  moderationLimit,
  validate('param', z.object({ targetType: z.enum(['post', 'comment']), targetId: z.string().min(1) })),
  validate('json', z.object({ action: z.enum(['hide', 'remove', 'dismiss', 'restore']), reason: Reason })),
  (c) => {
    const { targetType, targetId } = c.req.valid('param');
    const { action, reason } = c.req.valid('json');
    return c.json(moderate(ctxOf(c), targetType, targetId, action, reason));
  },
);

communityRoutes.get('/approvals', (c) => c.json(approvalQueue(ctxOf(c))));

communityRoutes.post(
  '/approvals/:postId',
  moderationLimit,
  validate('json', z.object({ decision: z.enum(['approve', 'reject']), reason: Reason })),
  (c) => {
    const { decision, reason } = c.req.valid('json');
    return c.json(decideApproval(ctxOf(c), c.req.param('postId'), decision, reason));
  },
);

communityRoutes.get('/bans', (c) => c.json(listBans(ctxOf(c))));

communityRoutes.post(
  '/bans',
  moderationLimit,
  validate('json', z.object({ memberId: z.string().min(1), reason: z.string().trim().min(3).max(500) })),
  (c) => {
    const { memberId, reason } = c.req.valid('json');
    return c.json(banFromCommunity(ctxOf(c), memberId, reason), 201);
  },
);

communityRoutes.delete('/bans/:memberId', (c) => c.json(liftCommunityBan(ctxOf(c), c.req.param('memberId'))));
