import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../lib/errors.js';
import { scanSignedPass } from '../services/access.js';

interface ReaderConfig {
  key: string;
  branchSlugs: string[];
}

const ScanBody = z.object({
  token: z.string().min(20).max(4096),
  branchId: z.string().min(1),
});

export const doorRoutes = new Hono();

/**
 * A door reader authenticates independently from the member. The browser app
 * never receives this credential. Configure production readers with:
 * SHARK_READER_KEYS_JSON='{"reader-1":{"key":"...","branchSlugs":["koramangala"]}}'
 */
doorRoutes.post('/scan', validate('json', ScanBody), (c) => {
  const readerId = c.req.header('x-reader-id')?.trim();
  const readerKey = c.req.header('x-reader-key') ?? '';
  const reader = readerId ? readerConfig()[readerId] : undefined;

  if (!reader || !constantTimeKeyEqual(reader.key, readerKey)) {
    throw new AppError('UNAUTHENTICATED', 'Reader authentication failed.');
  }

  const body = c.req.valid('json');
  return c.json(
    scanSignedPass({
      rawToken: body.token,
      branchId: body.branchId,
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
  const raw = process.env.SHARK_READER_KEYS_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, ReaderConfig>;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          ([, value]) =>
            value &&
            typeof value.key === 'string' &&
            value.key.length >= 16 &&
            Array.isArray(value.branchSlugs) &&
            value.branchSlugs.every((slug) => typeof slug === 'string'),
        ),
      );
    } catch {
      throw new Error('SHARK_READER_KEYS_JSON must be valid JSON');
    }
  }

  if (process.env.NODE_ENV === 'production') return {};
  return {
    'demo-reader': {
      key: process.env.SHARK_DEMO_READER_KEY ?? 'demo-reader-secret-change-me',
      branchSlugs: ['*'],
    },
  };
}

function constantTimeKeyEqual(expected: string, supplied: string): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(left, right);
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';
}
