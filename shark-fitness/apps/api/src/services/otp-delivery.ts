import { parseRuntimeConfig, runtimeConfig, type OtpConfig, type RuntimeConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
import { basicAuth, providerPost } from '../lib/provider-http.js';

/**
 * Delivers sign-in codes. One sender per channel, chosen at startup from the
 * validated runtime config (lib/config.ts):
 *
 *   SHARK_OTP_SMS_PROVIDER    log | msg91 | twilio   (default log)
 *   SHARK_OTP_EMAIL_PROVIDER  log | resend           (default log)
 *
 * Config refuses to boot when a provider is chosen without its credentials.
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

type FetchFn = typeof fetch;

export const otpText = (m: OtpMessage) =>
  `${m.code} is your ${m.gymName} sign-in code. It expires in ${m.expiresInMin} minutes. Never share it with anyone.`;

async function post(fetchFn: FetchFn, provider: string, url: string, init: RequestInit): Promise<void> {
  const response = await providerPost(fetchFn, url, init);
  if (response.status === 0) {
    console.error(`[otp] ${provider} request failed: ${response.text}`);
    throw deliveryFailed();
  }
  if (response.status < 200 || response.status >= 300) {
    console.error(`[otp] ${provider} rejected the message (${response.status}): ${response.text.slice(0, 300)}`);
    throw deliveryFailed();
  }
}

export const deliveryFailed = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'We could not send your code right now. Try again in a minute.', {
    retryAfterSec: 60,
  });

export function logSender(isProduction: boolean = runtimeConfig.isProduction): OtpSender {
  const printCode = !isProduction;
  return {
    name: 'log',
    async send(m) {
      const shown = printCode ? m.code : '(hidden in production)';
      console.log(`[otp] ${m.channel} code for ${m.to}: ${shown}`);
    },
  };
}

/** MSG91 OTP API (India). Needs a DLT-approved template with an ##OTP## variable. */
export function msg91Sender(config: NonNullable<OtpConfig['msg91']>, fetchFn: FetchFn = fetch): OtpSender {
  const { authKey, templateId } = config;
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
export function twilioSender(config: NonNullable<OtpConfig['twilio']>, fetchFn: FetchFn = fetch): OtpSender {
  const { accountSid: sid, authToken, from, contentSid } = config;
  const whatsapp = config.channel === 'whatsapp';
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
          authorization: basicAuth(sid, authToken),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    },
  };
}

/** Resend transactional email API. */
export function resendSender(config: NonNullable<OtpConfig['resend']>, fetchFn: FetchFn = fetch): OtpSender {
  const { apiKey, from } = config;
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

/** Builds the senders the validated config selects. */
export function sendersFromConfig(
  config: Pick<RuntimeConfig, 'otp' | 'isProduction'> = runtimeConfig,
  fetchFn: FetchFn = fetch,
): OtpSenders {
  const { otp, isProduction } = config;
  const missing = (provider: string): never => {
    // parseRuntimeConfig refuses this combination; reaching it means a caller
    // built an OtpConfig by hand.
    throw new Error(`The ${provider} OTP provider is selected without its credentials.`);
  };

  const sms =
    otp.smsProvider === 'msg91'
      ? msg91Sender(otp.msg91 ?? missing('msg91'), fetchFn)
      : otp.smsProvider === 'twilio'
        ? twilioSender(otp.twilio ?? missing('twilio'), fetchFn)
        : logSender(isProduction);
  const email =
    otp.emailProvider === 'resend' ? resendSender(otp.resend ?? missing('resend'), fetchFn) : logSender(isProduction);

  if (isProduction && (sms.name === 'log' || email.name === 'log')) {
    console.warn('[otp] a log sender is active in production: members on that channel will not receive codes.');
  }
  return { sms, email };
}

/** Parses an environment record (validation included) and builds its senders. */
export function sendersFromEnv(env: Record<string, string | undefined>, fetchFn: FetchFn = fetch): OtpSenders {
  return sendersFromConfig(parseRuntimeConfig(env), fetchFn);
}

let active: OtpSenders | null = null;

export function otpSenders(): OtpSenders {
  active ??= sendersFromConfig();
  return active;
}

/** Tests swap in a recording sender; pass null to go back to env config. */
export function setOtpSenders(next: OtpSenders | null): void {
  active = next;
}

/** Turns a stored phone ("+91 98123 45678", "9812345678") into E.164. */
export function toE164(phone: string, defaultCountryCode = runtimeConfig.otp.defaultCountryCode): string | null {
  const digits = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length > 10) return `+${digits.replace(/^0+/, '')}`;
  return null;
}
