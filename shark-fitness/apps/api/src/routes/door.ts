import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { clientIp, rateLimit } from '../middleware/index.js';
import { runtimeConfig, type ReaderConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
import { scanSignedPass } from '../services/access.js';

const ScanBody = z.object({
  token: z.string().min(20).max(4096),
  branchId: z.string().min(1),
});

export const doorRoutes = new Hono();

/**
 * A door reader authenticates independently from the member. The browser app
 * never receives this credential. Configure production readers with:
 * SHARK_READER_KEYS_JSON='{"reader-1":{"key":"...","tenantSlug":"shark","branchSlugs":["koramangala"]}}'
 */
doorRoutes.post('/scan', rateLimit(120, 60_000, { bucket: 'door-scan' }), validate('json', ScanBody), (c) => {
  const readerId = c.req.header('x-reader-id')?.trim();
  const readerKey = c.req.header('x-reader-key') ?? '';
  const configuredReaders = readerConfig();
  const reader = readerId && Object.hasOwn(configuredReaders, readerId) ? configuredReaders[readerId] : undefined;

  if (!reader || !constantTimeKeyEqual(reader.key, readerKey)) {
    throw new AppError('UNAUTHENTICATED', 'Reader authentication failed.');
  }

  const body = c.req.valid('json');
  return c.json(
    scanSignedPass({
      rawToken: body.token,
      branchId: body.branchId,
      allowedTenantSlug: reader.tenantSlug,
      allowedBranchSlugs: reader.branchSlugs,
      actor: {
        requestId: c.get('requestId') ?? 'unknown',
        name: readerId!,
        ip: clientIp(c),
        userAgent: c.req.header('user-agent') ?? 'door-reader',
      },
    }),
  );
});

function readerConfig(): Record<string, ReaderConfig> {
  if (Object.keys(runtimeConfig.readerKeys).length > 0 || runtimeConfig.isProduction) {
    return runtimeConfig.readerKeys;
  }
  return {
    'demo-reader': {
      key: runtimeConfig.demoReaderKey,
      tenantSlug: '*',
      branchSlugs: ['*'],
    },
  };
}

function constantTimeKeyEqual(expected: string, supplied: string): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(left, right);
}
