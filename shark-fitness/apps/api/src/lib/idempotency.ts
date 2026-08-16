import { eq } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from './context.js';
import { conflict } from './errors.js';
import { requestHash } from './crypto.js';

/** Store and replay successful responses for retryable writes. */
export function runIdempotently<T>(
  ctx: RequestContext,
  route: string,
  key: string | undefined,
  requestBody: unknown,
  operation: () => T,
): T {
  if (!key) return operation();

  const hash = requestHash(requestBody);
  const existing = db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)).get();
  if (existing) {
    if (existing.tenantId !== ctx.tenantId || existing.route !== route || existing.requestHash !== hash) {
      throw conflict('This idempotency key was already used for a different request.');
    }
    return existing.responseBody as T;
  }

  return transact(() => {
    const raced = db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)).get();
    if (raced) {
      if (raced.tenantId !== ctx.tenantId || raced.route !== route || raced.requestHash !== hash) {
        throw conflict('This idempotency key was already used for a different request.');
      }
      return raced.responseBody as T;
    }

    const body = operation();
    db.insert(schema.idempotencyKeys)
      .values({ key, tenantId: ctx.tenantId, route, requestHash: hash, responseBody: body, statusCode: 200, createdAt: Date.now() })
      .run();
    return body;
  });
}
