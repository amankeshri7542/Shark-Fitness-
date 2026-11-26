import { pushConfigured } from '../push.js';
import { queuePushOnly, type PushCategory } from '../notifications.js';
import type { ChannelDriver, OutboundMessage } from './drivers.js';

/**
 * The NotificationService's `push` channel (P07), delivered by P04's web push.
 *
 * "Sent" here means handed to P04's durable push queue (`push_deliveries`),
 * which sends to every live device of the member, honours the member's push
 * consent and quiet hours once more at send time, retries, and removes dead
 * devices. A member with no device registered is a permanent miss, said so.
 */
export function pushCategoryFor(kind: string | undefined): PushCategory {
  const value = kind ?? '';
  if (value.startsWith('payment') || value.startsWith('dunning')) return 'payment';
  if (value === 'class_reminder') return 'class_reminder';
  if (/waitlist|booking|class/.test(value)) return 'booking';
  return 'message';
}

export const webPushDriver: ChannelDriver = {
  name: 'web-push',
  get delivers() {
    return pushConfigured();
  },
  get available() {
    return pushConfigured();
  },
  async send(message: OutboundMessage) {
    const dedupeKey = `notify:${message.deliveryId ?? `${message.tenantId}:${message.userId}:${message.title}`}`;
    const outcome = queuePushOnly({
      tenantId: message.tenantId,
      userId: message.userId,
      kind: message.kind ?? 'system',
      title: message.title,
      body: message.body,
      link: message.link,
      push: { category: pushCategoryFor(message.kind), dedupeKey },
    });
    if (outcome === 'off') return { outcome: 'permanent', error: 'Push notifications are not set up on this server.' };
    if (outcome === 'no_device') return { outcome: 'permanent', error: 'The member has no device with notifications switched on.' };
    return { outcome: 'sent', providerMessageId: dedupeKey };
  },
};
