import { WEBHOOK_ENVELOPE_VERSION, type WebhookEventType } from '@shark/contracts';
import { emit } from '../lib/events.js';
import { log } from '../lib/observability.js';

/* ============================================================================
   Business events for outbound webhooks (PF-INT-003, PRD 01 §4.23).

   Call `emitIntegrationEvent` inside the transaction that made the change, the
   same way realtime events are emitted: the event exists if and only if the
   change committed. It goes to the outbox on a channel no socket may join, and
   the `deliver-webhooks` job fans it out to the gym's endpoints.

   **Minimal data.** Identifiers, states, amounts and timestamps only. Never
   health or injury data, photos, notes, messages or any free text, and no
   contact details: an integration that needs a member's name looks it up with
   the gym's permission. The guard below drops any key that looks like one of
   those, so a careless call site cannot widen what leaves the building.
   ========================================================================= */

export type IntegrationData = Record<string, string | number | boolean | null>;

/** Key fragments that must never appear in a webhook payload. */
export const EXCLUDED_KEY_PATTERN =
  /name|email|phone|address|dob|birth|gender|note|message|text|comment|reason|description|body|health|injur|medical|photo|image|media|weight|measure|password|secret|token/i;

export function integrationChannel(tenantId: string): string {
  return `integrations:${tenantId}`;
}

export function minimalData(data: IntegrationData): IntegrationData {
  const kept: IntegrationData = {};
  for (const [key, value] of Object.entries(data)) {
    if (EXCLUDED_KEY_PATTERN.test(key)) {
      log('warn', 'integration_event_field_dropped', { field: key });
      continue;
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) kept[key] = value;
  }
  return kept;
}

export function emitIntegrationEvent(input: {
  tenantId: string;
  branchId?: string | null;
  type: WebhookEventType;
  data: IntegrationData;
}): void {
  emit({
    tenantId: input.tenantId,
    branchId: input.branchId ?? null,
    channel: integrationChannel(input.tenantId),
    topic: 'integration.event',
    payload: { type: input.type, version: WEBHOOK_ENVELOPE_VERSION, data: minimalData(input.data) },
  });
}
