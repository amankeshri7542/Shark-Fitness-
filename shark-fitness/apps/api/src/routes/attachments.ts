import { Hono } from 'hono';
import { ctxOf } from '../middleware/index.js';
import { readAttachment } from '../services/messaging.js';

/**
 * `GET /v1/attachments/:id?exp=&sig=` — one message attachment (P07).
 *
 * Needs a session *and* a fresh signature: the signature proves the link was
 * issued in the last five minutes, the session proves who is asking, and the
 * service re-checks that this person may see the conversation. Never cached
 * by shared caches; images open inline, documents download.
 */
export const attachmentRoutes = new Hono();

attachmentRoutes.get('/:attachmentId', (c) => {
  const ctx = ctxOf(c);
  const file = readAttachment(ctx, c.req.param('attachmentId'), c.req.query('exp'), c.req.query('sig'));
  const inline = file.mimeType.startsWith('image/');
  const encoded = encodeURIComponent(file.fileName);
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(file.bytes.byteLength),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
