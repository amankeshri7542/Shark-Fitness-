import { Hono } from 'hono';
import { authenticate, clientIp, ctxOf, rateLimit } from '../middleware/index.js';
import { validate } from '../middleware/validate.js';
import { IssueRecoveryInput, RedeemRecoveryInput, issueAccountRecovery, redeemAccountRecovery } from '../services/account-recovery.js';

export const accountRecoveryRoutes = new Hono();
accountRecoveryRoutes.post('/recovery/issue', authenticate, rateLimit(5, 60_000, { identity: 'actor' }), validate('json', IssueRecoveryInput), (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(issueAccountRecovery(ctxOf(c), c.req.valid('json')));
});
accountRecoveryRoutes.post('/recovery/redeem', rateLimit(10, 60_000), validate('json', RedeemRecoveryInput), (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(redeemAccountRecovery(c.req.valid('json'), { ip: clientIp(c), requestId: c.get('requestId') ?? 'unknown' }));
});
