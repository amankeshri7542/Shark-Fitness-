import type { RequestContext } from './context.js';
import { hashToken } from './crypto.js';
import { token } from './ids.js';

interface TicketRecord {
  ctx: RequestContext;
  expiresAt: number;
}

const tickets = new Map<string, TicketRecord>();
const TTL_MS = 30_000;

export function issueRealtimeTicket(ctx: RequestContext): { ticket: string; expiresInSec: number } {
  purgeExpired();
  const raw = token(24);
  tickets.set(hashToken(raw), {
    ctx: { ...ctx, branchIds: [...ctx.branchIds], permissions: [...ctx.permissions] },
    expiresAt: Date.now() + TTL_MS,
  });
  return { ticket: raw, expiresInSec: TTL_MS / 1000 };
}

export function consumeRealtimeTicket(raw: string): RequestContext | null {
  purgeExpired();
  const key = hashToken(raw);
  const record = tickets.get(key);
  tickets.delete(key);
  if (!record || record.expiresAt < Date.now()) return null;
  return record.ctx;
}

function purgeExpired(): void {
  const current = Date.now();
  for (const [key, record] of tickets) {
    if (record.expiresAt < current) tickets.delete(key);
  }
}
