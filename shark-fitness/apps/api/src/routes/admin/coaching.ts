import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { assignHabitTemplate, coachingDetail, coachingRoster, replyToCheckIn } from '../../services/coaching.js';

/**
 * Nutrition & Habits, the coach view (P07). Thin adapter over services/coaching.ts.
 * Mounted by `app.ts` at `/v1/admin/coaching`.
 */
export const coachingRoutes = new Hono();
const coachWriteLimit = rateLimit(120, 60_000, { identity: 'actor', bucket: 'admin-coaching-write' });

coachingRoutes.get('/members', (c) => c.json(coachingRoster(ctxOf(c))));
coachingRoutes.get('/members/:memberId', (c) => c.json(coachingDetail(ctxOf(c), c.req.param('memberId'))));
coachingRoutes.post(
  '/members/:memberId/habits',
  coachWriteLimit,
  validate('json', z.object({ templateKey: z.string().min(1).max(40) })),
  (c) => c.json(assignHabitTemplate(ctxOf(c), c.req.param('memberId'), c.req.valid('json').templateKey), 201),
);
coachingRoutes.post(
  '/check-ins/:checkInId/reply',
  coachWriteLimit,
  validate('json', z.object({ reply: z.string().trim().min(2).max(2000) })),
  (c) => c.json(replyToCheckIn(ctxOf(c), c.req.param('checkInId'), c.req.valid('json').reply)),
);
