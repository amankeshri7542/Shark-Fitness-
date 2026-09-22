import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { createSession, resolveSession, revokeSession } from '../services/auth.js';
import { issueRealtimeTicket, consumeRealtimeTicket } from '../lib/realtime-ticket.js';
import { attachRealtime } from '../realtime/hub.js';
import { emit } from '../lib/events.js';

const server = createServer();
let port: number;
beforeAll(async () => {
  attachRealtime(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { server.close(); await once(server, 'close'); });

function memberSession() {
  const user = db.select().from(schema.users).where(eq(schema.users.email, 'aman@sharkfitness.in')).get()!;
  const session = createSession(user.id, user.tenantId, '127.0.0.1', 'privacy-test');
  return { ...session, ctx: resolveSession(session.token)! };
}

it('rejects tickets issued before session revocation', () => {
  const session = memberSession();
  const { ticket } = issueRealtimeTicket(session.ctx);
  revokeSession(session.sessionId);
  expect(consumeRealtimeTicket(ticket)).toBeNull();
});

it('does not offer or replay staff channels to a member', async () => {
  const session = memberSession();
  const { ticket } = issueRealtimeTicket(session.ctx);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?ticket=${ticket}`);
  try {
    const [raw] = await once(socket, 'message');
    expect(JSON.parse(String(raw)).channels).toEqual([channels.member(session.ctx.memberId!)]);
    socket.send('null');
    socket.send('42');
    socket.send(JSON.stringify({ type: 'ping' }));
    const [pong] = await once(socket, 'message');
    expect(JSON.parse(String(pong))).toEqual({ type: 'pong' });
    socket.send(JSON.stringify({ type: 'subscribe', channels: [channels.branch(session.ctx.branchIds[0]!), channels.tenant(session.ctx.tenantId)], since: 0 }));
    const [reply] = await once(socket, 'message');
    expect(JSON.parse(String(reply))).toEqual({ type: 'subscribed', channels: [] });
  } finally { socket.close(); await once(socket, 'close'); revokeSession(session.sessionId); }
});

it('closes a revoked connection before sending another event', async () => {
  const session = memberSession();
  const { ticket } = issueRealtimeTicket(session.ctx);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?ticket=${ticket}`);
  await once(socket, 'message');
  socket.send(JSON.stringify({ type: 'subscribe', channels: [channels.member(session.ctx.memberId!)] }));
  await once(socket, 'message');
  const messages: unknown[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  revokeSession(session.sessionId);
  const closed = once(socket, 'close');
  emit({ tenantId: session.ctx.tenantId, channel: channels.member(session.ctx.memberId!), topic: 'attendance.checked_in', payload: { private: true } });
  // Ping forces an authority check even when no event is pending.
  socket.send(JSON.stringify({ type: 'ping' }));
  const timeout = setTimeout(() => socket.close(), 100);
  const [code] = await closed;
  clearTimeout(timeout);
  expect(code).toBe(4401);
  expect(messages).toEqual([]);
});
