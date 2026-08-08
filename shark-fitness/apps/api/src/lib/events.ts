import { desc, isNull, sql } from 'drizzle-orm';
import type { EventTopic } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { id } from './ids.js';
import { now } from './time.js';

/**
 * Transactional outbox. An event is written in the same transaction as the
 * change that caused it, then fanned out. If the socket layer is down the row
 * is still there, so nothing is lost — this is what stands in for Durable
 * Objects here (see docs/ADR-001-runtime.md).
 */

type Listener = (event: OutboxEvent) => void;

export interface OutboxEvent {
  id: string;
  seq: number;
  tenantId: string;
  branchId: string | null;
  channel: string;
  topic: EventTopic;
  at: number;
  payload: Record<string, unknown>;
}

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let seqCounter: number | null = null;

function nextSeq(): number {
  if (seqCounter === null) {
    const row = db
      .select({ max: sql<number>`coalesce(max(${schema.outboxEvents.seq}), 0)` })
      .from(schema.outboxEvents)
      .get();
    seqCounter = row?.max ?? 0;
  }
  seqCounter += 1;
  return seqCounter;
}

export interface EmitInput {
  tenantId: string;
  branchId?: string | null;
  channel: string;
  topic: EventTopic;
  payload: Record<string, unknown>;
}

export function emit(input: EmitInput): OutboxEvent {
  const event: OutboxEvent = {
    id: id('evt'),
    seq: nextSeq(),
    tenantId: input.tenantId,
    branchId: input.branchId ?? null,
    channel: input.channel,
    topic: input.topic,
    at: now(),
    payload: input.payload,
  };

  db.insert(schema.outboxEvents)
    .values({
      id: event.id,
      seq: event.seq,
      tenantId: event.tenantId,
      branchId: event.branchId,
      channel: event.channel,
      topic: event.topic,
      payload: event.payload,
      at: event.at,
      deliveredAt: null,
    })
    .run();

  // Fan out after the row exists. A listener that throws must not roll back
  // the business change that produced the event.
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[events] listener failed', err);
      }
    }
    db.update(schema.outboxEvents)
      .set({ deliveredAt: now() })
      .where(sql`${schema.outboxEvents.id} = ${event.id}`)
      .run();
  });

  return event;
}

/** Replay window for a reconnecting client (`?since=`). */
export function replay(channel: string, sinceSeq: number, limit = 200): OutboxEvent[] {
  return db
    .select()
    .from(schema.outboxEvents)
    .where(sql`${schema.outboxEvents.channel} = ${channel} and ${schema.outboxEvents.seq} > ${sinceSeq}`)
    .orderBy(schema.outboxEvents.seq)
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      seq: r.seq,
      tenantId: r.tenantId,
      branchId: r.branchId,
      channel: r.channel,
      topic: r.topic as EventTopic,
      at: r.at,
      payload: r.payload,
    }));
}

export function pendingCount(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.outboxEvents)
    .where(isNull(schema.outboxEvents.deliveredAt))
    .get();
  return row?.n ?? 0;
}

export function latestSeq(): number {
  const row = db.select({ seq: schema.outboxEvents.seq }).from(schema.outboxEvents).orderBy(desc(schema.outboxEvents.seq)).limit(1).get();
  return row?.seq ?? 0;
}
