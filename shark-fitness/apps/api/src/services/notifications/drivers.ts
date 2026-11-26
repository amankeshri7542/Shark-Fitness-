import { classifyProviderResponse } from '@shark/domain';
import { runtimeConfig, type NotifyConfig, type RuntimeConfig } from '../../lib/config.js';
import { basicAuth, jsonObject, providerPost, type ProviderResponse } from '../../lib/provider-http.js';
import { webPushDriver } from './web-push.js';

/**
 * Channel drivers for the NotificationService (PF-COMM-002).
 *
 * `log` is the default for every channel, in every environment. It records
 * the attempt and reports it truthfully as "logged, not delivered" — it never
 * pretends a member was reached. Real drivers are chosen by env
 * (SHARK_NOTIFY_*_DRIVER), reuse the OTP providers' HTTP code
 * (`lib/provider-http.ts`) and are only ever tested against local fakes: each
 * takes its base URL as a parameter so a test can point it at 127.0.0.1.
 *
 * A driver never throws. It answers with one of four outcomes and the service
 * decides what to write down.
 */

export type DriverChannel = 'push' | 'email' | 'sms' | 'whatsapp';

export interface OutboundMessage {
  channel: DriverChannel;
  /** E.164 phone, an email address, or (push) the user id. */
  to: string;
  title: string;
  body: string;
  link: string | null;
  /** Approved provider template: WhatsApp template name or MSG91 flow id. */
  providerTemplate: string | null;
  /** Template parameters in order, for providers that only accept templates. */
  templateParams: string[];
  tenantId: string;
  userId: string;
  /** The notification_deliveries row: a stable key for drivers that dedupe (push). */
  deliveryId?: string;
  /** In-app kind (payment_due, waitlist_offer, …): push picks its category from it. */
  kind?: string;
}

export type DriverResult =
  | { outcome: 'logged' }
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'retry'; error: string }
  | { outcome: 'permanent'; error: string };

export interface ChannelDriver {
  readonly name: string;
  /** False for the log driver and for a channel this server cannot use. */
  readonly delivers: boolean;
  /** False when the channel cannot be used at all here (push without P04). */
  readonly available: boolean;
  send(message: OutboundMessage): Promise<DriverResult>;
}

type FetchFn = typeof fetch;

export function logDriver(channel: DriverChannel): ChannelDriver {
  return {
    name: 'log',
    delivers: false,
    available: true,
    async send(m) {
      // The body is not printed: it can carry personal details, and the
      // delivery row already holds what was meant to be sent.
      console.log(`[notify] ${channel} logged, not delivered (tenant ${m.tenantId}, user ${m.userId})`);
      return { outcome: 'logged' };
    },
  };
}

/** What a provider answer means for the delivery row. */
function interpret(response: ProviderResponse, provider: string, idOf: (body: Record<string, unknown>) => unknown): DriverResult {
  const verdict = classifyProviderResponse(response.status);
  if (verdict === 'accepted') {
    const body = jsonObject(response.text);
    const providerId = body ? idOf(body) : null;
    if (typeof providerId === 'string' && providerId.length > 0) return { outcome: 'sent', providerMessageId: providerId.slice(0, 200) };
    // Accepted without an id: treat as sent but say we could not trace it.
    return { outcome: 'sent', providerMessageId: `${provider}:untracked` };
  }
  const error = response.status === 0
    ? `${provider} did not answer (${response.text.slice(0, 120)})`
    : `${provider} answered ${response.status}: ${response.text.slice(0, 160)}`;
  return verdict === 'retry' ? { outcome: 'retry', error } : { outcome: 'permanent', error };
}

/** Resend transactional email. */
export function resendDriver(
  config: NonNullable<NotifyConfig['resend']>,
  fetchFn: FetchFn = fetch,
  baseUrl = 'https://api.resend.com',
): ChannelDriver {
  return {
    name: 'resend',
    delivers: true,
    available: true,
    async send(m) {
      const text = m.link ? `${m.body}\n\n${m.link}` : m.body;
      const response = await providerPost(fetchFn, `${baseUrl}/emails`, {
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.from, to: [m.to], subject: m.title, text }),
      });
      return interpret(response, 'Resend', (body) => body.id);
    },
  };
}

/**
 * MSG91 Flow API (India). Every SMS to an Indian number needs a DLT-approved
 * template, so a message without one — its own or the configured default — is
 * refused here rather than sent and silently dropped by the operator.
 */
export function msg91Driver(
  config: NonNullable<NotifyConfig['msg91']>,
  fetchFn: FetchFn = fetch,
  baseUrl = 'https://control.msg91.com',
): ChannelDriver {
  return {
    name: 'msg91',
    delivers: true,
    available: true,
    async send(m) {
      const flowId = m.providerTemplate ?? config.defaultFlowId;
      if (!flowId) return { outcome: 'permanent', error: 'MSG91 needs a DLT-approved flow (template) id for this message.' };
      const recipient: Record<string, string> = { mobiles: m.to.replace(/^\+/, ''), body: m.body };
      m.templateParams.forEach((value, index) => {
        recipient[`var${index + 1}`] = value;
      });
      const response = await providerPost(fetchFn, `${baseUrl}/api/v5/flow`, {
        headers: { authkey: config.authKey, 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: flowId, short_url: '0', recipients: [recipient] }),
      });
      // MSG91 answers 200 with {type:"error"} for some refusals.
      const body = jsonObject(response.text);
      if (response.status >= 200 && response.status < 300 && body?.type === 'error') {
        return { outcome: 'permanent', error: `MSG91 refused the message: ${String(body.message ?? '').slice(0, 160)}` };
      }
      return interpret(response, 'MSG91', (b) => b.message ?? b.request_id);
    },
  };
}

/** Twilio Messages API (SMS). */
export function twilioDriver(
  config: NonNullable<NotifyConfig['twilio']>,
  fetchFn: FetchFn = fetch,
  baseUrl = 'https://api.twilio.com',
): ChannelDriver {
  return {
    name: 'twilio',
    delivers: true,
    available: true,
    async send(m) {
      const form = new URLSearchParams({ To: m.to, From: config.from, Body: m.body });
      const response = await providerPost(
        fetchFn,
        `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
        {
          headers: {
            authorization: basicAuth(config.accountSid, config.authToken),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
      return interpret(response, 'Twilio', (body) => body.sid);
    },
  };
}

/**
 * WhatsApp Cloud API. A business may only start a conversation with an
 * approved template, so a message is sent as its template name with the
 * parameters in order; a message with no template is refused.
 */
export function whatsappCloudDriver(
  config: NonNullable<NotifyConfig['whatsapp']>,
  fetchFn: FetchFn = fetch,
  baseUrl = 'https://graph.facebook.com/v21.0',
): ChannelDriver {
  return {
    name: 'whatsapp-cloud',
    delivers: true,
    available: true,
    async send(m) {
      if (!m.providerTemplate) {
        return { outcome: 'permanent', error: 'WhatsApp needs an approved template name for this message.' };
      }
      const response = await providerPost(fetchFn, `${baseUrl}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
        headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: m.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: m.providerTemplate,
            language: { code: config.language },
            components: m.templateParams.length
              ? [{ type: 'body', parameters: m.templateParams.map((text) => ({ type: 'text', text })) }]
              : [],
          },
        }),
      });
      return interpret(response, 'WhatsApp', (body) => {
        const messages = body.messages;
        return Array.isArray(messages) ? (messages[0] as { id?: unknown } | undefined)?.id : undefined;
      });
    },
  };
}

/**
 * Push belongs to P04 (web push with VAPID): `webPushDriver` (./web-push.ts)
 * is the push driver, available exactly when VAPID keys are configured. This
 * stand-in is for callers that build drivers by hand without push; a push
 * delivery is then suppressed with the reason — never "logged" as if it had a
 * real path.
 */
export const pushUnavailable: ChannelDriver = {
  name: 'none',
  delivers: false,
  available: false,
  async send() {
    return { outcome: 'permanent', error: 'Push notifications are not set up on this server.' };
  },
};

export interface NotificationDrivers {
  push: ChannelDriver;
  email: ChannelDriver;
  sms: ChannelDriver;
  whatsapp: ChannelDriver;
}

export function driversFromConfig(
  config: Pick<RuntimeConfig, 'notify'> = runtimeConfig,
  fetchFn: FetchFn = fetch,
): NotificationDrivers {
  const { notify } = config;
  const required = <T>(value: T | null, name: string): T => {
    // parseRuntimeConfig refuses a driver without credentials; reaching this
    // means a caller built a config by hand.
    if (!value) throw new Error(`The ${name} notification driver is selected without its credentials.`);
    return value;
  };
  return {
    // Reports itself unavailable until VAPID keys are configured (P04).
    push: webPushDriver,
    email: notify.emailDriver === 'resend' ? resendDriver(required(notify.resend, 'resend'), fetchFn) : logDriver('email'),
    sms:
      notify.smsDriver === 'msg91'
        ? msg91Driver(required(notify.msg91, 'msg91'), fetchFn)
        : notify.smsDriver === 'twilio'
          ? twilioDriver(required(notify.twilio, 'twilio'), fetchFn)
          : logDriver('sms'),
    whatsapp:
      notify.whatsappDriver === 'cloud' ? whatsappCloudDriver(required(notify.whatsapp, 'whatsapp'), fetchFn) : logDriver('whatsapp'),
  };
}

let active: NotificationDrivers | null = null;

export function notificationDrivers(): NotificationDrivers {
  active ??= driversFromConfig();
  return active;
}

/** Tests swap in fakes; P04 registers its push driver here. Null resets to env. */
export function setNotificationDrivers(next: Partial<NotificationDrivers> | null): void {
  active = next ? { ...(active ?? driversFromConfig()), ...next } : null;
}
