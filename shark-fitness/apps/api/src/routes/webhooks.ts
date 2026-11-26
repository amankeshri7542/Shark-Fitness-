import { Hono } from 'hono';
import { AppError } from '../lib/errors.js';
import { clientIp } from '../middleware/index.js';
import { handleRazorpayWebhook, WEBHOOK_MAX_BYTES } from '../services/payments/webhooks.js';

/**
 * Inbound provider webhooks. Server-to-server: no session, no cookies, no
 * Origin, so lib/security.ts exempts `/v1/webhooks/*` from the browser CSRF
 * checks; the HMAC signature over the raw body is the authentication.
 */
export const webhookRoutes = new Hono();

webhookRoutes.post('/razorpay', async (c) => {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > WEBHOOK_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'That webhook body is too large.');
  // The signature covers the exact bytes Razorpay sent: read them raw, before
  // anything parses or re-serialises the body.
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody) > WEBHOOK_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'That webhook body is too large.');
  const outcome = await handleRazorpayWebhook({
    rawBody,
    signature: c.req.header('x-razorpay-signature'),
    eventIdHeader: c.req.header('x-razorpay-event-id'),
    ip: clientIp(c),
    requestId: c.get('requestId') ?? 'unknown',
  });
  return c.json({ ok: true, ...outcome });
});
