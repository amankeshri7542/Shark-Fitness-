import { createDecipheriv, createECDH, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * A local stand-in for a browser push service, started by global setup and
 * given to the API as its only allowed push origin. Nothing in an E2E run can
 * reach FCM, Apple or Mozilla.
 *
 * POST /push/<id>     records the request, answers 201
 * GET  /__received    what it has received so far (bodies base64)
 */
export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function startFakePushService(): Promise<{ origin: string; server: Server }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/__received') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url ?? '/', headers: request.headers, body: Buffer.concat(chunks).toString('base64') });
      response.writeHead(201).end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.unref();
      done({ origin: `http://127.0.0.1:${port}`, server });
    }),
  );
}

/** A VAPID key pair in the URL-safe base64 form the API reads. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  return { publicKey: raw.toString('base64url'), privateKey: priv.d! };
}

/** What PushManager.subscribe() would give the page, plus the means to read
 *  what the push service delivers to it (RFC 8291, aes128gcm). */
export function fakeSubscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  const uaPublic = ecdh.generateKeys();
  const auth = randomBytes(16);
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  return {
    endpoint,
    keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') },
    decrypt(bodyBase64: string): string {
      const body = Buffer.from(bodyBase64, 'base64');
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idLength);
      const record = body.subarray(21 + idLength);
      const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
    },
  };
}
