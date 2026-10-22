import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logSender,
  msg91Sender,
  resendSender,
  sendersFromEnv,
  toE164,
  twilioSender,
  type OtpMessage,
} from '../services/otp-delivery.js';
import { OTP_LIMITS, resetOtpLimits, takeDestinationSend, takeIpSend } from '../lib/otp-limits.js';
import { AppError } from '../lib/errors.js';

const sms: OtpMessage = { channel: 'sms', to: '+919812345678', code: '482913', gymName: 'Shark Fitness', expiresInMin: 10 };
const email: OtpMessage = { ...sms, channel: 'email', to: 'aman@sharkfitness.in' };

function recordingFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status < 400 ? '{}' : 'nope', { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('OTP sender selection', () => {
  it('defaults both channels to the log sender', () => {
    const senders = sendersFromEnv({});
    expect(senders.sms.name).toBe('log');
    expect(senders.email.name).toBe('log');
  });

  it('picks providers from env and fails fast on missing keys or unknown names', () => {
    const senders = sendersFromEnv({
      SHARK_OTP_SMS_PROVIDER: 'msg91',
      SHARK_MSG91_AUTH_KEY: 'k',
      SHARK_MSG91_TEMPLATE_ID: 't',
      SHARK_OTP_EMAIL_PROVIDER: 'resend',
      SHARK_RESEND_API_KEY: 'r',
      SHARK_OTP_EMAIL_FROM: 'Shark <no-reply@shark.in>',
    });
    expect(senders.sms.name).toBe('msg91');
    expect(senders.email.name).toBe('resend');
    expect(() => sendersFromEnv({ SHARK_OTP_SMS_PROVIDER: 'twilio' })).toThrow(/SHARK_TWILIO_ACCOUNT_SID/);
    expect(() => sendersFromEnv({ SHARK_OTP_SMS_PROVIDER: 'carrier-pigeon' })).toThrow(/Unknown/);
  });
});

describe('OTP senders', () => {
  it('log sender prints the code in development and hides it in production', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await logSender({ NODE_ENV: 'development' }).send(sms);
    await logSender({ NODE_ENV: 'production' }).send(sms);
    expect(log.mock.calls[0]?.[0]).toContain('482913');
    expect(log.mock.calls[1]?.[0]).not.toContain('482913');
  });

  it('msg91 sends the code to the OTP API without the plus sign', async () => {
    const { fn, calls } = recordingFetch();
    await msg91Sender({ SHARK_MSG91_AUTH_KEY: 'key', SHARK_MSG91_TEMPLATE_ID: 'tpl' }, fn).send(sms);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://control.msg91.com/api/v5/otp');
    expect(url.searchParams.get('mobile')).toBe('919812345678');
    expect(url.searchParams.get('otp')).toBe('482913');
    expect(url.searchParams.get('template_id')).toBe('tpl');
    expect((calls[0]!.init.headers as Record<string, string>).authkey).toBe('key');
  });

  it('twilio sends SMS with a body, and WhatsApp with a template when configured', async () => {
    const base = { SHARK_TWILIO_ACCOUNT_SID: 'AC1', SHARK_TWILIO_AUTH_TOKEN: 'tok', SHARK_TWILIO_FROM: '+15550001111' };
    const smsFetch = recordingFetch();
    await twilioSender(base, smsFetch.fn).send(sms);
    expect(smsFetch.calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    const smsForm = new URLSearchParams(String(smsFetch.calls[0]!.init.body));
    expect(smsForm.get('To')).toBe('+919812345678');
    expect(smsForm.get('Body')).toContain('482913');

    const waFetch = recordingFetch();
    await twilioSender({ ...base, SHARK_TWILIO_CHANNEL: 'whatsapp', SHARK_TWILIO_CONTENT_SID: 'HX1' }, waFetch.fn).send(sms);
    const waForm = new URLSearchParams(String(waFetch.calls[0]!.init.body));
    expect(waForm.get('To')).toBe('whatsapp:+919812345678');
    expect(waForm.get('From')).toBe('whatsapp:+15550001111');
    expect(waForm.get('ContentSid')).toBe('HX1');
    expect(JSON.parse(waForm.get('ContentVariables')!)).toEqual({ 1: '482913' });
    expect(waForm.get('Body')).toBeNull();
  });

  it('resend emails the code', async () => {
    const { fn, calls } = recordingFetch();
    await resendSender({ SHARK_RESEND_API_KEY: 're_1', SHARK_OTP_EMAIL_FROM: 'no-reply@shark.in' }, fn).send(email);
    const body = JSON.parse(String(calls[0]!.init.body)) as { to: string[]; subject: string };
    expect(body.to).toEqual(['aman@sharkfitness.in']);
    expect(body.subject).toContain('482913');
  });

  it('turns a provider rejection into a retryable PROVIDER_UNAVAILABLE error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fn } = recordingFetch(500);
    const error = await resendSender({ SHARK_RESEND_API_KEY: 'k', SHARK_OTP_EMAIL_FROM: 'a@b.c' }, fn)
      .send(email)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('Phone normalisation', () => {
  it('formats stored phones as E.164', () => {
    expect(toE164('+91 98123 45678')).toBe('+919812345678');
    expect(toE164('98123-45678', '91')).toBe('+919812345678');
    expect(toE164('919812345678')).toBe('+919812345678');
    expect(toE164('123')).toBeNull();
  });
});

describe('OTP send limits', () => {
  afterEach(() => resetOtpLimits());

  it('enforces a resend cooldown per destination', () => {
    takeDestinationSend('+919812345678', 0);
    expect(() => takeDestinationSend('+919812345678', 1_000)).toThrow(AppError);
    expect(() => takeDestinationSend('+919800000000', 1_000)).not.toThrow();
    expect(() => takeDestinationSend('+919812345678', OTP_LIMITS.resendCooldownMs)).not.toThrow();
  });

  it('caps sends per destination per day', () => {
    let at = 0;
    for (let i = 0; i < OTP_LIMITS.perDestinationPerDay; i += 1) {
      takeDestinationSend('a@b.c', at);
      at += OTP_LIMITS.resendCooldownMs;
    }
    expect(() => takeDestinationSend('a@b.c', at)).toThrow(/Too many/);
  });

  it('caps sends per IP per hour', () => {
    for (let i = 0; i < OTP_LIMITS.perIpPerHour; i += 1) takeIpSend('10.0.0.1', i);
    const error = (() => {
      try {
        takeIpSend('10.0.0.1', 100);
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(error?.code).toBe('RATE_LIMITED');
    expect(error?.retryAfterSec).toBeGreaterThan(0);
  });
});
