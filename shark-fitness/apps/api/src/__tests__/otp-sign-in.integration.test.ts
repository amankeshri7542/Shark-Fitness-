import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { resetOtpLimits } from '../lib/otp-limits.js';
import { setOtpSenders, toE164, type OtpMessage, type OtpSender } from '../services/otp-delivery.js';

const ORIGIN = 'http://localhost:5173';
// Each test uses its own account: the DB-backed per-identifier limit (4 per
// 5 minutes) is shared with the other suites that sign in as Aman.
const AMAN = 'aman@sharkfitness.in';

let sent: OtpMessage[] = [];
let failNext = false;
const recorder: OtpSender = {
  name: 'recorder',
  async send(message) {
    if (failNext) {
      failNext = false;
      throw new Error('provider down');
    }
    sent.push(message);
  },
};

let ipSeq = 0;
function startOtp(identifier: string, ip = `10.9.0.${++ipSeq}`) {
  return app.request('/v1/auth/otp/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip },
    body: JSON.stringify({ tenantSlug: 'shark', identifier }),
  });
}

beforeEach(() => {
  sent = [];
  failNext = false;
  resetOtpLimits();
  setOtpSenders({ sms: recorder, email: recorder });
});
afterEach(() => setOtpSenders(null));

describe('OTP sign-in delivery', () => {
  it('emails the code to the member and the code signs them in', async () => {
    const start = await startOtp(AMAN);
    expect(start.status).toBe(200);
    const { challengeId } = (await start.json()) as { challengeId: string };
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'email', to: AMAN, gymName: expect.any(String) });

    const verify = await app.request('/v1/auth/otp/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ challengeId, code: sent[0]!.code }),
    });
    expect(verify.status).toBe(200);
  });

  it('texts the phone on file when the member signs in with a phone number', async () => {
    const user = db.select().from(schema.users).where(eq(schema.users.email, 'priya@sharkfitness.in')).get()!;
    expect(user.phone).toBeTruthy();
    const typed = user.phone!.replace(/\D/g, '').slice(-10);

    const response = await startOtp(typed);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: toE164(user.phone!) });
  });

  it('sends nothing for an identifier that is not a member', async () => {
    const response = await startOtp('nobody-here@example.com');
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('blocks an immediate resend to the same member, even from another IP', async () => {
    expect((await startOtp('rehan@sharkfitness.in')).status).toBe(200);
    const again = await startOtp('REHAN@sharkfitness.in');
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it('returns 503 and burns the challenge when the provider fails', async () => {
    failNext = true;
    const response = await startOtp('nikhil@sharkfitness.in');
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_UNAVAILABLE');

    const latest = db
      .select()
      .from(schema.otpChallenges)
      .where(eq(schema.otpChallenges.identifier, 'nikhil@sharkfitness.in'))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)[0]!;
    expect(latest.consumedAt).not.toBeNull();
  });
});
