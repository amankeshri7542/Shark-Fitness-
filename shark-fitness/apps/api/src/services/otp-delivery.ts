import { AppError } from '../lib/errors.js';

/**
 * Delivers sign-in codes. One sender per channel, chosen from env at startup:
 *
 *   SHARK_OTP_SMS_PROVIDER    log | msg91 | twilio   (default log)
 *   SHARK_OTP_EMAIL_PROVIDER  log | resend           (default log)
 *
 * The log sender prints the code only outside production, so a misconfigured
 * production deploy never leaks codes into logs.
 */

export type OtpChannel = 'sms' | 'email';

export interface OtpMessage {
  channel: OtpChannel;
  /** E.164 phone (+919812345678) or a lowercased email address. */
  to: string;
  code: string;
  gymName: string;
  expiresInMin: number;
}

export interface OtpSender {
  readonly name: string;
  send(message: OtpMessage): Promise<void>;
}

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

const SEND_TIMEOUT_MS = 8_000;

export const otpText = (m: OtpMessage) =>
  `${m.code} is your ${m.gymName} sign-in code. It expires in ${m.expiresInMin} minutes. Never share it with anyone.`;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for the configured OTP provider.`);
  return value;
}

async function post(fetchFn: FetchFn, provider: string, url: string, init: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, method: 'POST', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  } catch (error) {
    console.error(`[otp] ${provider} request failed: ${(error as Error).message}`);
    throw deliveryFailed();
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[otp] ${provider} rejected the message (${response.status}): ${detail.slice(0, 300)}`);
    throw deliveryFailed();
  }
}

export const deliveryFailed = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'We could not send your code right now. Try again in a minute.', {
    retryAfterSec: 60,
  });

export function logSender(env: Env = process.env): OtpSender {
  const printCode = env.NODE_ENV !== 'production';
  return {
    name: 'log',
    async send(m) {
      const shown = printCode ? m.code : '(hidden in production)';
      console.log(`[otp] ${m.channel} code for ${m.to}: ${shown}`);
    },
  };
}

/** MSG91 OTP API (India). Needs a DLT-approved template with an ##OTP## variable. */
export function msg91Sender(env: Env = process.env, fetchFn: FetchFn = fetch): OtpSender {
  const authKey = required(env, 'SHARK_MSG91_AUTH_KEY');
  const templateId = required(env, 'SHARK_MSG91_TEMPLATE_ID');
  return {
    name: 'msg91',
    async send(m) {
      const url = new URL('https://control.msg91.com/api/v5/otp');
      url.searchParams.set('template_id', templateId);
      url.searchParams.set('mobile', m.to.replace(/^\+/, ''));
      url.searchParams.set('otp', m.code);
      url.searchParams.set('otp_expiry', String(m.expiresInMin));
      await post(fetchFn, 'msg91', url.toString(), {
        headers: { authkey: authKey, 'content-type': 'application/json' },
        body: '{}',
      });
    },
  };
}

/**
 * Twilio Messages API for SMS or WhatsApp (SHARK_TWILIO_CHANNEL=whatsapp).
 * WhatsApp needs an approved template outside the 24h window: set
 * SHARK_TWILIO_CONTENT_SID to a template whose {{1}} is the code.
 */
export function twilioSender(env: Env = process.env, fetchFn: FetchFn = fetch): OtpSender {
  const sid = required(env, 'SHARK_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'SHARK_TWILIO_AUTH_TOKEN');
  const from = required(env, 'SHARK_TWILIO_FROM');
  const whatsapp = env.SHARK_TWILIO_CHANNEL?.trim() === 'whatsapp';
  const contentSid = env.SHARK_TWILIO_CONTENT_SID?.trim();
  const prefix = whatsapp ? 'whatsapp:' : '';
  return {
    name: whatsapp ? 'twilio-whatsapp' : 'twilio',
    async send(m) {
      const form = new URLSearchParams({ To: `${prefix}${m.to}`, From: `${prefix}${from}` });
      if (contentSid) {
        form.set('ContentSid', contentSid);
        form.set('ContentVariables', JSON.stringify({ 1: m.code }));
      } else {
        form.set('Body', otpText(m));
      }
      await post(fetchFn, 'twilio', `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    },
  };
}

/** Resend transactional email API. */
export function resendSender(env: Env = process.env, fetchFn: FetchFn = fetch): OtpSender {
  const apiKey = required(env, 'SHARK_RESEND_API_KEY');
  const from = required(env, 'SHARK_OTP_EMAIL_FROM');
  return {
    name: 'resend',
    async send(m) {
      await post(fetchFn, 'resend', 'https://api.resend.com/emails', {
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [m.to],
          subject: `${m.code} is your ${m.gymName} sign-in code`,
          text: otpText(m),
        }),
      });
    },
  };
}

export interface OtpSenders {
  sms: OtpSender;
  email: OtpSender;
}

export function sendersFromEnv(env: Env = process.env, fetchFn: FetchFn = fetch): OtpSenders {
  const smsProvider = env.SHARK_OTP_SMS_PROVIDER?.trim() || 'log';
  const emailProvider = env.SHARK_OTP_EMAIL_PROVIDER?.trim() || 'log';

  const sms =
    smsProvider === 'log'
      ? logSender(env)
      : smsProvider === 'msg91'
        ? msg91Sender(env, fetchFn)
        : smsProvider === 'twilio'
          ? twilioSender(env, fetchFn)
          : null;
  if (!sms) throw new Error(`Unknown SHARK_OTP_SMS_PROVIDER "${smsProvider}". Use log, msg91 or twilio.`);

  const email =
    emailProvider === 'log' ? logSender(env) : emailProvider === 'resend' ? resendSender(env, fetchFn) : null;
  if (!email) throw new Error(`Unknown SHARK_OTP_EMAIL_PROVIDER "${emailProvider}". Use log or resend.`);

  if (env.NODE_ENV === 'production' && (sms.name === 'log' || email.name === 'log')) {
    console.warn('[otp] a log sender is active in production: members on that channel will not receive codes.');
  }
  return { sms, email };
}

let active: OtpSenders | null = null;

export function otpSenders(): OtpSenders {
  active ??= sendersFromEnv();
  return active;
}

/** Tests swap in a recording sender; pass null to go back to env config. */
export function setOtpSenders(next: OtpSenders | null): void {
  active = next;
}

/** Turns a stored phone ("+91 98123 45678", "9812345678") into E.164. */
export function toE164(phone: string, defaultCountryCode = process.env.SHARK_OTP_DEFAULT_COUNTRY_CODE ?? '91'): string | null {
  const digits = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length > 10) return `+${digits.replace(/^0+/, '')}`;
  return null;
}
