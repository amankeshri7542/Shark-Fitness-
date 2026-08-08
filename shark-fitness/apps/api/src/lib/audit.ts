import { db, schema } from '../db/client.js';
import { id } from './ids.js';
import { now } from './time.js';
import type { RequestContext } from './context.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string;
  reason?: string | null;
  branchId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Field-level diff, so the audit viewer shows what actually moved rather than
 *  two JSON blobs. Values are stringified — this is a human record. */
function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Array<{ field: string; from: string; to: string }> {
  if (!before && !after) return [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: Array<{ field: string; from: string; to: string }> = [];
  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    out.push({ field: key, from: render(from), to: render(to) });
  }
  return out;
}

function render(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Writes an audit row. Called inside the same transaction as the change it
 * records, so an audited action cannot commit without its audit entry.
 */
export function audit(ctx: RequestContext, input: AuditInput): void {
  db.insert(schema.auditLog)
    .values({
      id: id('aud'),
      tenantId: ctx.tenantId,
      branchId: input.branchId ?? ctx.activeBranchId ?? null,
      actorId: ctx.userId,
      actorName: ctx.impersonatorId ? `${ctx.name} (via support)` : ctx.name,
      actorRole: ctx.role,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? '',
      reason: input.reason ?? null,
      changes: diff(input.before, input.after),
      ip: ctx.ip,
      requestId: ctx.requestId,
      at: now(),
    })
    .run();
}
