import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  inviteToChallenge,
  listChallengeInvitations,
  revokeChallengeInvitation,
} from '../../services/engagement-admin.js';

/**
 * Community administration (PF-GAME-003, PF-GAME-005).
 *
 * A thin adapter over `services/engagement-admin.ts`. Only the invitation
 * lifecycle lives here — challenges themselves are not managed from the
 * console in this release, and inventing a CRUD for them would be a feature
 * nobody asked for rather than the gap the audit found.
 *
 * Mounted by `app.ts` at `/v1/admin/engagement`.
 */
export const adminEngagementRoutes = new Hono();

const InviteBody = z.object({
  memberIds: z.array(z.string().trim().min(1)).min(1).max(200),
  /** Null means "until the challenge ends", which the service clamps to. */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

adminEngagementRoutes.get('/challenges/:challengeId/invitations', (c) =>
  c.json(listChallengeInvitations(ctxOf(c), c.req.param('challengeId'))),
);

adminEngagementRoutes.post(
  '/challenges/:challengeId/invitations',
  validate('json', InviteBody),
  (c) => {
    const ctx = ctxOf(c);
    const challengeId = c.req.param('challengeId');
    const body = c.req.valid('json');
    const response = runIdempotently(
      ctx,
      `/admin/engagement/challenges/${challengeId}/invitations`,
      c.req.header('idempotency-key'),
      body,
      () => inviteToChallenge(ctx, { challengeId, ...body }),
    );
    return c.json(response, 201);
  },
);

adminEngagementRoutes.delete('/challenges/:challengeId/invitations/:memberId', (c) =>
  c.json(revokeChallengeInvitation(ctxOf(c), c.req.param('challengeId'), c.req.param('memberId'))),
);
