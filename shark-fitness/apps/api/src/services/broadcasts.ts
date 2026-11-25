import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { NOTIFICATION_CHANNELS, broadcastCostMinor, channelLabel, type NotificationChannel } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { requireFreshAuth } from '../lib/step-up.js';
import { DAY, addDays, isoDate, now, relativeTime } from '../lib/time.js';
import { engagementSettings } from './engagement-settings.js';
import { channelAvailability, deliveryOutcomes, evaluateRecipient, queueNotification, type ExclusionCode } from './notifications/service.js';

/**
 * Broadcasts — one message to a segment (P07; PF-COMM-006).
 *
 * Preview, dry run and send all walk the same audience through the
 * NotificationService's own checks (`evaluateRecipient`), so the counts an
 * operator approves are the counts that go: the preview cannot promise a
 * member the send would then refuse. Cost is recipients × the gym's rate for
 * the channel. Above the gym's threshold the send is held until an owner
 * approves it, with a fresh re-authentication (step-up).
 *
 * A dry run has no capability to send: it never reaches `queueNotification`.
 */

export const BROADCAST_STATUSES = ['active', 'trial', 'frozen', 'grace', 'expired', 'former'] as const;

export interface Segment {
  statuses?: string[];
  branchIds?: string[];
  tags?: string[];
  /** Last visit at least this many days ago (or never). */
  notVisitedForDays?: number;
  /** Visited within this many days. */
  visitedWithinDays?: number;
  /** Their current membership ends within this many days. */
  membershipEndsWithinDays?: number;
}

type Broadcast = typeof schema.broadcasts.$inferSelect;
type Purpose = 'promotional' | 'operational';

interface Recipient {
  memberId: string;
  userId: string;
  branchId: string;
  firstName: string;
}

/** The segment's members, inside the broadcast's frozen branch scope. */
export function segmentMembers(tenantId: string, segment: Segment, branchIds: string[], atMs = now()): Recipient[] {
  const branches = segment.branchIds?.length ? branchIds.filter((b) => segment.branchIds!.includes(b)) : branchIds;
  if (branches.length === 0) return [];
  let rows = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), inArray(schema.members.homeBranchId, branches), isNull(schema.members.deletedAt), isNull(schema.members.mergedIntoId)))
    .all()
    .filter((m) => m.userId !== null);
  if (segment.statuses?.length) rows = rows.filter((m) => segment.statuses!.includes(m.lifecycle));
  if (segment.tags?.length) rows = rows.filter((m) => m.tags.some((t) => segment.tags!.includes(t)));
  if (segment.notVisitedForDays !== undefined) {
    const before = atMs - segment.notVisitedForDays * DAY;
    rows = rows.filter((m) => m.lastVisitAt === null || m.lastVisitAt < before);
  }
  if (segment.visitedWithinDays !== undefined) {
    const after = atMs - segment.visitedWithinDays * DAY;
    rows = rows.filter((m) => m.lastVisitAt !== null && m.lastVisitAt >= after);
  }
  if (segment.membershipEndsWithinDays !== undefined && rows.length) {
    const ending = new Set(
      db
        .select({ memberId: schema.memberships.memberId, endsOn: schema.memberships.endsOn, branch: schema.members.homeBranchId })
        .from(schema.memberships)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
        .where(and(eq(schema.memberships.tenantId, tenantId), inArray(schema.memberships.state, ['active', 'grace', 'cancel_scheduled'])))
        .all()
        .filter((r) => {
          if (!r.endsOn) return false;
          const today = isoDate(atMs, branchTimeZone(tenantId, r.branch));
          return r.endsOn >= today && r.endsOn <= addDays(today, segment.membershipEndsWithinDays!);
        })
        .map((r) => r.memberId),
    );
    rows = rows.filter((m) => ending.has(m.id));
  }
  return rows.map((m) => ({ memberId: m.id, userId: m.userId!, branchId: m.homeBranchId, firstName: m.firstName }));
}

export interface ChannelPreview {
  channel: NotificationChannel;
  label: string;
  /** Will receive it now or, if quiet hours apply, when they end. */
  recipients: number;
  heldForQuietHours: number;
  excluded: Record<Exclusion, number>;
  ratePerMessageMinor: number;
  estimatedCostMinor: number;
}

type Exclusion = Exclude<ExclusionCode, 'quiet_hours'>;

const EMPTY_EXCLUDED: Record<Exclusion, number> = {
  inactive: 0,
  no_consent: 0,
  opted_out: 0,
  channel_unavailable: 0,
  no_destination: 0,
  missing_variable: 0,
};

function previewChannel(
  tenantId: string,
  audience: Recipient[],
  channel: NotificationChannel,
  purpose: Purpose,
  body: string,
  rate: number,
  atMs: number,
): ChannelPreview {
  const excluded = { ...EMPTY_EXCLUDED };
  let recipients = 0;
  let held = 0;
  for (const r of audience) {
    const verdict = evaluateRecipient(
      { tenantId, userId: r.userId, memberId: r.memberId, branchId: r.branchId, channel, purpose, body, variables: { firstName: r.firstName } },
      atMs,
    );
    if (verdict.outcome === 'exclude') excluded[verdict.code as Exclusion] += 1;
    else {
      recipients += 1;
      if (verdict.outcome === 'defer') held += 1;
    }
  }
  return {
    channel,
    label: channelLabel(channel),
    recipients,
    heldForQuietHours: held,
    excluded,
    ratePerMessageMinor: rate,
    estimatedCostMinor: broadcastCostMinor(recipients, rate),
  };
}

function loadBroadcast(ctx: RequestContext, broadcastId: string): Broadcast {
  requirePermission(ctx, 'broadcast.send');
  const row = db.select().from(schema.broadcasts).where(and(eq(schema.broadcasts.id, broadcastId), eq(schema.broadcasts.tenantId, ctx.tenantId))).get();
  // Created by someone with a wider scope than mine: not mine to see.
  if (!row || !row.branchIds.every((b) => ctx.branchIds.includes(b))) throw notFound('That broadcast');
  return row;
}

interface PreviewSource {
  segment: Segment | Record<string, unknown>;
  branchIds: string[];
  channel: string;
  purpose: string;
  body: string;
}

function previewFor(ctx: RequestContext, b: PreviewSource, atMs: number) {
  const settings = engagementSettings(ctx.tenantId);
  const audience = segmentMembers(ctx.tenantId, b.segment as Segment, b.branchIds, atMs);
  const byChannel = NOTIFICATION_CHANNELS.map((channel) =>
    previewChannel(ctx.tenantId, audience, channel, b.purpose as Purpose, b.body, settings.messageRates[channel], atMs),
  );
  const chosen = byChannel.find((c) => c.channel === b.channel)!;
  return {
    segmentSize: audience.length,
    chosen,
    byChannel,
    approvalThreshold: settings.broadcastApprovalThreshold,
    approvalRequired: chosen.recipients > settings.broadcastApprovalThreshold,
  };
}

function serialise(row: Broadcast) {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    purpose: row.purpose,
    segment: row.segment,
    branchIds: row.branchIds,
    title: row.title,
    body: row.body,
    state: row.state,
    recipientCount: row.recipientCount,
    estimatedCostMinor: row.estimatedCostMinor,
    approvalRequired: row.approvalRequired,
    approved: row.approvedAt !== null,
    approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
    lastDryRunAt: row.lastDryRunAt ? new Date(row.lastDryRunAt).toISOString() : null,
    sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    createdRelative: relativeTime(row.createdAt),
  };
}

export interface BroadcastInput {
  name: string;
  channel: NotificationChannel;
  purpose: Purpose;
  segment: Segment;
  title: string;
  body: string;
}

function validateBody(body: string): void {
  const unknown = [...body.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g)].map((m) => m[1]).filter((v) => v !== 'firstName');
  if (unknown.length) throw invalid(`A broadcast can only use {{firstName}}. Remove ${unknown.map((v) => `{{${v}}}`).join(', ')}.`);
}

export function listBroadcasts(ctx: RequestContext) {
  requirePermission(ctx, 'broadcast.send');
  const rows = db
    .select()
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.tenantId, ctx.tenantId))
    .orderBy(desc(schema.broadcasts.createdAt))
    .limit(100)
    .all()
    .filter((r) => r.branchIds.every((b) => ctx.branchIds.includes(b)));
  const settings = engagementSettings(ctx.tenantId);
  return {
    items: rows.map(serialise),
    approvalThreshold: settings.broadcastApprovalThreshold,
    rates: settings.messageRates,
    channels: channelAvailability(),
  };
}

/** Preview a draft that is not saved yet (the compose screen). */
export function previewDraft(ctx: RequestContext, input: BroadcastInput) {
  requirePermission(ctx, 'broadcast.send');
  validateBody(input.body);
  return previewFor(ctx, { ...input, branchIds: branchScope(ctx) }, now());
}

export function createBroadcast(ctx: RequestContext, input: BroadcastInput) {
  requirePermission(ctx, 'broadcast.send');
  validateBody(input.body);
  for (const b of input.segment.branchIds ?? []) if (!ctx.branchIds.includes(b)) throw notFound('That branch');
  const branchIds = branchScope(ctx);
  const atMs = now();
  const preview = previewFor(ctx, { ...input, branchIds }, atMs);
  const broadcastId = id('bct');
  transact(() => {
    db.insert(schema.broadcasts)
      .values({
        id: broadcastId,
        tenantId: ctx.tenantId,
        name: input.name.trim(),
        channel: input.channel,
        purpose: input.purpose,
        segment: input.segment as Record<string, unknown>,
        branchIds,
        title: input.title.trim(),
        body: input.body.trim(),
        state: 'draft',
        recipientCount: preview.chosen.recipients,
        estimatedCostMinor: preview.chosen.estimatedCostMinor,
        approvalRequired: preview.approvalRequired,
        approvedByUserId: null,
        approvedAt: null,
        lastDryRunAt: null,
        createdByUserId: ctx.userId,
        sentAt: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    audit(ctx, {
      action: 'broadcast.created',
      entityType: 'broadcast',
      entityId: broadcastId,
      entityLabel: input.name.trim(),
      after: { channel: input.channel, purpose: input.purpose, recipients: preview.chosen.recipients, estimatedCostMinor: preview.chosen.estimatedCostMinor },
    });
  });
  return { broadcast: serialise(db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcastId)).get()!), preview };
}

export function broadcastDetail(ctx: RequestContext, broadcastId: string) {
  const row = loadBroadcast(ctx, broadcastId);
  const live = row.state === 'sent' || row.state === 'cancelled' ? null : previewFor(ctx, row, now());
  return {
    broadcast: serialise(row),
    preview: live,
    report: row.state === 'sent' ? deliveryReport(ctx.tenantId, row.id) : null,
  };
}

/**
 * Exactly what a send would do, recorded, with nothing sent. There is no
 * code path from here to the NotificationService's enqueue.
 */
export function dryRunBroadcast(ctx: RequestContext, broadcastId: string) {
  const row = loadBroadcast(ctx, broadcastId);
  if (row.state === 'sent' || row.state === 'cancelled') throw conflict('That broadcast is finished.');
  const atMs = now();
  const preview = previewFor(ctx, row, atMs);
  transact(() => {
    db.update(schema.broadcasts)
      .set({ lastDryRunAt: atMs, recipientCount: preview.chosen.recipients, estimatedCostMinor: preview.chosen.estimatedCostMinor, approvalRequired: preview.approvalRequired, updatedAt: atMs })
      .where(eq(schema.broadcasts.id, row.id))
      .run();
    audit(ctx, {
      action: 'broadcast.dry_run',
      entityType: 'broadcast',
      entityId: row.id,
      entityLabel: row.name,
      after: { recipients: preview.chosen.recipients, excluded: preview.chosen.excluded, heldForQuietHours: preview.chosen.heldForQuietHours },
    });
  });
  return { dryRun: true as const, preview };
}

export function approveBroadcast(ctx: RequestContext, broadcastId: string) {
  requirePermission(ctx, 'broadcast.approve');
  const row = loadBroadcast(ctx, broadcastId);
  if (row.state === 'sent' || row.state === 'cancelled') throw conflict('That broadcast is finished.');
  // Releasing a large send is a high-risk action: a fresh password (and code).
  requireFreshAuth(ctx, 'broadcast.approve');
  const atMs = now();
  transact(() => {
    db.update(schema.broadcasts)
      .set({ state: 'approved', approvedByUserId: ctx.userId, approvedAt: atMs, updatedAt: atMs })
      .where(eq(schema.broadcasts.id, row.id))
      .run();
    audit(ctx, { action: 'broadcast.approved', entityType: 'broadcast', entityId: row.id, entityLabel: row.name, after: { recipients: row.recipientCount } });
  });
  return { broadcast: serialise(db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, row.id)).get()!) };
}

export function sendBroadcast(ctx: RequestContext, broadcastId: string) {
  const row = loadBroadcast(ctx, broadcastId);
  if (row.state === 'sent') throw conflict('That broadcast was already sent.');
  if (row.state === 'cancelled') throw conflict('That broadcast was cancelled.');
  const atMs = now();
  // Recount at send time: the audience may have grown past the threshold.
  const preview = previewFor(ctx, row, atMs);
  if (preview.approvalRequired && row.approvedAt === null) {
    db.update(schema.broadcasts)
      .set({ state: 'awaiting_approval', approvalRequired: true, recipientCount: preview.chosen.recipients, estimatedCostMinor: preview.chosen.estimatedCostMinor, updatedAt: atMs })
      .where(eq(schema.broadcasts.id, row.id))
      .run();
    throw precondition(
      `This reaches ${preview.chosen.recipients} people, more than the ${preview.approvalThreshold} the gym allows without an owner's approval. It is waiting for an owner to approve it.`,
    );
  }
  const audience = segmentMembers(ctx.tenantId, row.segment as Segment, row.branchIds, atMs);
  let queued = 0;
  let suppressed = 0;
  transact(() => {
    for (const r of audience) {
      const result = queueNotification(
        {
          tenantId: ctx.tenantId,
          userId: r.userId,
          memberId: r.memberId,
          branchId: r.branchId,
          channel: row.channel as NotificationChannel,
          purpose: row.purpose as Purpose,
          source: 'broadcast',
          sourceId: row.id,
          dedupeKey: `broadcast:${row.id}:${r.memberId}`,
          kind: 'broadcast',
          title: row.title,
          body: row.body,
          variables: { firstName: r.firstName },
        },
        atMs,
      );
      if (result.state === 'suppressed' || result.state === 'failed') suppressed += 1;
      else queued += 1;
    }
    db.update(schema.broadcasts)
      .set({ state: 'sent', sentAt: atMs, recipientCount: queued, estimatedCostMinor: broadcastCostMinor(queued, preview.chosen.ratePerMessageMinor), updatedAt: atMs })
      .where(eq(schema.broadcasts.id, row.id))
      .run();
    audit(ctx, {
      action: 'broadcast.sent',
      entityType: 'broadcast',
      entityId: row.id,
      entityLabel: row.name,
      after: { channel: row.channel, recipients: queued, suppressed },
    });
  });
  return { sent: true as const, recipients: queued, suppressed, report: deliveryReport(ctx.tenantId, row.id) };
}

export function cancelBroadcast(ctx: RequestContext, broadcastId: string) {
  const row = loadBroadcast(ctx, broadcastId);
  if (row.state === 'sent') throw conflict('A sent broadcast cannot be cancelled.');
  db.update(schema.broadcasts).set({ state: 'cancelled', updatedAt: now() }).where(eq(schema.broadcasts.id, row.id)).run();
  audit(ctx, { action: 'broadcast.cancelled', entityType: 'broadcast', entityId: row.id, entityLabel: row.name });
  return { ok: true as const };
}

/** Outcome counts for a sent broadcast, plus suppression reasons in words. */
export function deliveryReport(tenantId: string, broadcastId: string) {
  const counts = deliveryOutcomes(tenantId, 'broadcast', broadcastId);
  const reasons = new Map<string, number>();
  for (const row of db
    .select({ state: schema.notificationDeliveries.state, reason: schema.notificationDeliveries.reason })
    .from(schema.notificationDeliveries)
    .where(and(eq(schema.notificationDeliveries.tenantId, tenantId), eq(schema.notificationDeliveries.source, 'broadcast'), eq(schema.notificationDeliveries.sourceId, broadcastId)))
    .all()) {
    if (row.state === 'suppressed' || row.state === 'failed') reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  }
  return { counts, reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })) };
}
