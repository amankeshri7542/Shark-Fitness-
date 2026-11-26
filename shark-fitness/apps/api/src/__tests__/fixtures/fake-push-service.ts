import { createECDH, createDecipheriv, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

/**
 * A local stand-in for a browser push service (FCM, Mozilla autopush, …), so
 * push sends can be tested end to end without anything leaving the machine.
 *
 * It plays both halves the test needs:
 * - a "browser": a real P-256 key pair and auth secret, exactly what
 *   PushManager.subscribe() would hand the app;
 * - a "push service": an HTTP server that records each request and answers
 *   with the status the endpoint path asks for (`/push/ok-…` 201,
 *   `/push/gone-…` 410, `/push/busy-…` 503).
 *
 * `decrypt` undoes RFC 8291 (aes128gcm) with the browser's private key, and
 * `verifyVapid` checks the RFC 8292 JWT, so the tests prove the payload really
 * is encrypted to that browser and signed by this server.
 */

export interface ReceivedPush {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeBrowser {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  decrypt: (body: Buffer) => string;
}

export interface FakePushService {
  origin: string;
  received: ReceivedPush[];
  browser: (kind: 'ok' | 'gone' | 'busy') => FakeBrowser;
  close: () => Promise<void>;
}

export async function startFakePushService(): Promise<FakePushService> {
  const received: ReceivedPush[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      received.push({ path, headers: request.headers, body: Buffer.concat(chunks) });
      const status = path.startsWith('/push/gone-') ? 410 : path.startsWith('/push/busy-') ? 503 : 201;
      response.writeHead(status).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    received,
    browser: (kind) => fakeBrowser(`${origin}/push/${kind}-${randomBytes(6).toString('hex')}`),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function fakeBrowser(endpoint: string): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  const uaPublic = ecdh.generateKeys();
  const authSecret = randomBytes(16);

  const decrypt = (body: Buffer): string => {
    // aes128gcm header: salt(16) | record size(4) | key id length(1) | key id
    const salt = body.subarray(0, 16);
    const idLength = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLength);
    const record = body.subarray(21 + idLength);

    const ecdhSecret = ecdh.computeSecret(asPublic);
    const prkKey = hmac(authSecret, ecdhSecret);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    // The last record ends with the delimiter 0x02, then zero padding.
    const delimiter = padded.lastIndexOf(2);
    return padded.subarray(0, delimiter).toString('utf8');
  };

  return {
    endpoint,
    keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
    decrypt,
  };
}

/** Checks `Authorization: vapid t=<jwt>, k=<key>` (RFC 8292). Returns the claims. */
export function verifyVapid(
  authorization: string | undefined,
  expected: { publicKey: string; audience: string },
): { aud: string; exp: number; sub: string } {
  const match = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authorization ?? '');
  if (!match) throw new Error(`Not a VAPID authorization header: ${authorization}`);
  const [, token, key] = match as unknown as [string, string, string];
  if (key !== expected.publicKey) throw new Error('VAPID key does not match the server key');

  const [header, payload, signature] = token.split('.') as [string, string, string];
  const raw = Buffer.from(expected.publicKey, 'base64url');
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  const valid = verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  if (!valid) throw new Error('VAPID signature does not verify');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string };
  if (claims.aud !== expected.audience) throw new Error(`VAPID audience ${claims.aud} is not ${expected.audience}`);
  return claims;
}
