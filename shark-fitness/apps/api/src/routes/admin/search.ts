import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { SEARCH_TYPES, consoleSearch, type SearchType } from '../../services/search.js';

/**
 * Command palette search (P07). Mounted by `app.ts` at `/v1/admin/search`.
 * `types` narrows the kinds searched (the palette's "Record payment" step
 * looks only for outstanding invoices).
 */
export const searchRoutes = new Hono();
const searchLimit = rateLimit(120, 60_000, { identity: 'actor', bucket: 'admin-search' });

searchRoutes.get(
  '/',
  searchLimit,
  validate(
    'query',
    z.object({
      q: z.string().max(80),
      types: z.string().max(80).optional(),
      outstanding: z.enum(['1']).optional(),
    }),
  ),
  (c) => {
    const { q, types, outstanding } = c.req.valid('query');
    const wanted = types
      ? (types.split(',').filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t)))
      : [...SEARCH_TYPES];
    return c.json(consoleSearch(ctxOf(c), q, wanted, { outstandingOnly: outstanding === '1' }));
  },
);
