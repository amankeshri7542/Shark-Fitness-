import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CommitRoster, CorrectMemberIdentity, CorrectMemberProfile, RosterInput } from '@shark/contracts';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { correctIdentity, correctProfile } from '../../services/member-operations.js';
import { commitRoster, previewRoster } from '../../services/roster-import.js';

export const memberOperationsRoutes = new Hono();
memberOperationsRoutes.use('*', bodyLimit({ maxSize: 300_000 }));
memberOperationsRoutes.patch('/:memberId/profile', validate('json', CorrectMemberProfile), (c) => c.json(correctProfile(ctxOf(c), c.req.param('memberId'), c.req.valid('json'))));
memberOperationsRoutes.patch('/:memberId/identity', rateLimit(5, 60_000, { identity: 'actor', bucket: 'member-identity-correction' }), validate('json', CorrectMemberIdentity), (c) => c.json(correctIdentity(ctxOf(c), c.req.param('memberId'), c.req.valid('json'))));
memberOperationsRoutes.post('/imports/preview', rateLimit(20, 60_000, { identity: 'actor', bucket: 'roster-preview' }), validate('json', RosterInput), (c) => c.json(previewRoster(ctxOf(c), c.req.valid('json'))));
memberOperationsRoutes.post('/imports/commit', rateLimit(10, 60_000, { identity: 'actor', bucket: 'roster-commit' }), validate('json', CommitRoster), (c) => c.json(commitRoster(ctxOf(c), c.req.valid('json'), c.req.header('idempotency-key'))));
