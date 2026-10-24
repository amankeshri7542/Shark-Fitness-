import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { channels, type EventTopic } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { createSession, resolveSession, revokeSession } from '../services/auth.js';
import { issueRealtimeTicket, consumeRealtimeTicket } from '../lib/realtime-ticket.js';
import { attachRealtime } from '../realtime/hub.js';
import { emit, latestSeq } from '../lib/events.js';

const server = createServer();
let port: number;
beforeAll(async () => {
  attachRealtime(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { server.close(); await once(server, 'close'); });

function memberSession(email = 'aman@sharkfitness.in') {
  const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get()!;
  const session = createSession(user.id, user.tenantId, '127.0.0.1', 'privacy-test');
  return { ...session, ctx: resolveSession(session.token)! };
}

it('rejects tickets issued before session revocation', () => {
  const session = memberSession();
  const { ticket } = issueRealtimeTicket(session.ctx);
  revokeSession(session.sessionId);
  expect(consumeRealtimeTicket(ticket)).toBeNull();
});

it.each([
  ['reception@sharkfitness.in', [0, 1, 2, 3, 4, 5]],
  ['rehan@sharkfitness.in', [0, 4, 6]],
  ['accounts@sharkfitness.in', [3]],
  ['manager@sharkfitness.in', [0, 1, 2, 3, 4, 5, 6]],
])('limits %s replay and live delivery to permitted, payload-free invalidations', async (email, expectedIndices) => {
  const session = memberSession(email);
  const branchId = session.ctx.branchIds[0]!;
  const channel = channels.branch(branchId);
  const fixtures: { topic: EventTopic; payload: Record<string, unknown> }[] = [
    { topic: 'attendance.checked_in', payload: { memberId: 'another-trainers-member', memberNo: 'PRIVATE', overrideReason: 'Private medical detail' } },
    { topic: 'lead.stage_changed', payload: { leadId: 'private-lead' } },
    { topic: 'ticket.updated', payload: { ticketId: 'private-ticket' } },
    { topic: 'stock.changed', payload: { quantity: 42 } },
    { topic: 'session.updated', payload: { sessionId: 'private-session' } },
    { topic: 'alert.raised', payload: { kind: 'message_safety', memberId: 'private-member', categories: ['private-category'] } },
    { topic: 'alert.raised', payload: { kind: 'equipment_down', equipmentId: 'private-equipment' } },
    { topic: 'alert.raised', payload: { kind: 'unknown_future_alert', secret: true } },
    { topic: 'notification.created', payload: { secret: true } },
  ];
  const publish = () => fixtures.map((event) => emit({ tenantId: session.ctx.tenantId, branchId, channel, ...event }));
  const since = latestSeq();
  const replayed = publish();
  const { ticket } = issueRealtimeTicket(session.ctx);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?ticket=${ticket}`);
  const received: { type: string; id: string; payload: unknown }[] = [];
  socket.on('message', (raw) => received.push(JSON.parse(String(raw))));
  const reply = (type: string, action: () => void) => new Promise<void>((resolve) => {
    const onMessage = (raw: unknown) => {
      if (JSON.parse(String(raw)).type !== type) return;
      socket.off('message', onMessage);
      resolve();
    };
    socket.on('message', onMessage);
    action();
  });
  try {
    await once(socket, 'message');
    await reply('subscribed', () => socket.send(JSON.stringify({ type: 'subscribe', channels: [channel], since })));
    expect(received.filter((event) => event.type === 'event').map((event) => event.id)).toEqual(expectedIndices.map((index) => replayed[index]!.id));
    expect(received.filter((event) => event.type === 'event').map((event) => event.payload)).toEqual(expectedIndices.map(() => ({})));
    received.length = 0;
    const live = publish();
    await reply('pong', () => socket.send(JSON.stringify({ type: 'ping' })));
    expect(received.filter((event) => event.type === 'event').map((event) => event.id)).toEqual(expectedIndices.map((index) => live[index]!.id));
    expect(received.filter((event) => event.type === 'event').map((event) => event.payload)).toEqual(expectedIndices.map(() => ({})));
  } finally { socket.close(); await once(socket, 'close'); revokeSession(session.sessionId); }
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
    socket.send(JSON.stringify({ type: 'subscribe', channels: [channels.member(session.ctx.memberId!)] }));
    await once(socket, 'message');
    const received = once(socket, 'message');
    emit({ tenantId: session.ctx.tenantId, channel: channels.member(session.ctx.memberId!), topic: 'invoice.updated', payload: { invoiceId: 'own-invoice' } });
    expect(JSON.parse(String((await received)[0])).payload).toEqual({ invoiceId: 'own-invoice' });
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
