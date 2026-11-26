import { eq } from 'drizzle-orm';
import { DEFAULT_MESSAGE_RATES_MINOR, messageRates, type NotificationChannel } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { requirePermission, type RequestContext } from '../lib/context.js';
import { notFound } from '../lib/errors.js';
import { requireFreshAuth } from '../lib/step-up.js';
import { now } from '../lib/time.js';

/**
 * Gym-wide engagement policy (P07), stored in `tenants.policy` next to the
 * other tenant promises. One gym, one answer: a member moving branch does not
 * meet a different rule about who may message a child.
 */
export interface EngagementSettings {
  /** Member posts wait for a moderator before anyone else sees them. */
  communityApprovalMode: boolean;
  /** Staff may hold direct threads with members under 18 (plan decision 16). Off by default. */
  allowStaffMinorMessaging: boolean;
  /** Broadcasts to more people than this need an owner's approval. */
  broadcastApprovalThreshold: number;
  /** Paise per message, per channel, for broadcast cost estimates. */
  messageRates: Record<NotificationChannel, number>;
}

export const DEFAULT_BROADCAST_APPROVAL_THRESHOLD = 200;

function policyOf(tenantId: string): Record<string, unknown> {
  const tenant = db.select({ policy: schema.tenants.policy }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  if (!tenant) throw notFound('That gym');
  return (tenant.policy ?? {}) as Record<string, unknown>;
}

export function engagementSettings(tenantId: string): EngagementSettings {
  const policy = policyOf(tenantId);
  const threshold = policy.broadcastApprovalThreshold;
  return {
    communityApprovalMode: policy.communityApprovalMode === true,
    allowStaffMinorMessaging: policy.allowStaffMinorMessaging === true,
    broadcastApprovalThreshold:
      typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 0 ? threshold : DEFAULT_BROADCAST_APPROVAL_THRESHOLD,
    messageRates: messageRates(policy.messageRates),
  };
}

export interface EngagementSettingsPatch {
  communityApprovalMode?: boolean;
  allowStaffMinorMessaging?: boolean;
  broadcastApprovalThreshold?: number;
  messageRates?: Partial<Record<NotificationChannel, number>>;
}

export function updateEngagementSettings(ctx: RequestContext, patch: EngagementSettingsPatch): EngagementSettings {
  requirePermission(ctx, 'settings.manage');
  const before = engagementSettings(ctx.tenantId);
  // Loosening a safeguard is as sensitive as the action it guards: letting
  // bigger broadcasts go without an owner's approval, or opening staff
  // direct messages with children, needs a fresh password (and code).
  const raisesThreshold =
    patch.broadcastApprovalThreshold !== undefined && patch.broadcastApprovalThreshold > before.broadcastApprovalThreshold;
  const opensMinorMessaging = patch.allowStaffMinorMessaging === true && !before.allowStaffMinorMessaging;
  if (raisesThreshold || opensMinorMessaging) requireFreshAuth(ctx, 'settings.engagement');
  const policy = { ...policyOf(ctx.tenantId) };
  if (patch.communityApprovalMode !== undefined) policy.communityApprovalMode = patch.communityApprovalMode;
  if (patch.allowStaffMinorMessaging !== undefined) policy.allowStaffMinorMessaging = patch.allowStaffMinorMessaging;
  if (patch.broadcastApprovalThreshold !== undefined) policy.broadcastApprovalThreshold = patch.broadcastApprovalThreshold;
  if (patch.messageRates) policy.messageRates = { ...before.messageRates, ...patch.messageRates };

  transact(() => {
    db.update(schema.tenants).set({ policy: policy as never, updatedAt: now() }).where(eq(schema.tenants.id, ctx.tenantId)).run();
    audit(ctx, {
      action: 'tenant.engagement_settings_updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      entityLabel: 'Engagement settings',
      before: before as unknown as Record<string, unknown>,
      after: engagementSettings(ctx.tenantId) as unknown as Record<string, unknown>,
    });
  });
  return engagementSettings(ctx.tenantId);
}

export { DEFAULT_MESSAGE_RATES_MINOR };
