import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { channels } from '@shark/contracts';
import { replay, subscribe, type OutboxEvent } from '../lib/events.js';
import { log } from '../lib/observability.js';
import { consumeRealtimeTicket } from '../lib/realtime-ticket.js';
import { resolveSessionById } from '../services/auth.js';
import type { RequestContext } from '../lib/context.js';

interface Client {
  socket: WebSocket;
  sessionId: string;
  tenantId: string;
  allowed: Set<string>;
  subscribed: Set<string>;
}

const clients = new Set<Client>();

function allowedChannels(ctx: RequestContext): Set<string> {
  // Branch/tenant events contain reception and staff records, not public feeds.
  const allowed = new Set<string>();
  if (ctx.role !== 'member') {
    allowed.add(channels.tenant(ctx.tenantId));
    for (const branchId of ctx.branchIds) allowed.add(channels.branch(branchId));
  }
  if (ctx.memberId) allowed.add(channels.member(ctx.memberId));
  return allowed;
}

function refreshAccess(client: Client): boolean {
  const ctx = resolveSessionById(client.sessionId);
  if (!ctx) { client.socket.close(4401, 'unauthenticated'); return false; }
  client.allowed = allowedChannels(ctx);
  for (const channel of client.subscribed) {
    if (!client.allowed.has(channel)) client.subscribed.delete(channel);
  }
  return true;
}

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const ctx = ticket ? consumeRealtimeTicket(ticket) : null;

    if (!ctx) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const allowed = allowedChannels(ctx);

    const client: Client = { socket, sessionId: ctx.sessionId, tenantId: ctx.tenantId, allowed, subscribed: new Set() };
    clients.add(client);

    socket.on('message', (raw) => {
      if (!refreshAccess(client)) return;
      let msg: { type?: string; channels?: string[]; since?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
        for (const channel of msg.channels) {
          if (!client.allowed.has(channel)) continue;
          client.subscribed.add(channel);
          if (typeof msg.since === 'number') {
            for (const event of replay(channel, msg.since)) send(socket, event);
          }
        }
        socket.send(JSON.stringify({ type: 'subscribed', channels: [...client.subscribed] }));
      }

      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
    socket.send(JSON.stringify({ type: 'ready', channels: [...allowed] }));
  });

  const unsubscribe = subscribe((event) => {
    for (const client of clients) {
      if (client.tenantId !== event.tenantId) continue;
      if (!refreshAccess(client)) continue;
      if (!client.subscribed.has(event.channel)) continue;
      send(client.socket, event);
    }
  });
  wss.on('close', unsubscribe);

  log('info', 'realtime_listening', { route: '/v1/realtime' });
}

function send(socket: WebSocket, event: OutboxEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: 'event',
      seq: event.seq,
      id: event.id,
      topic: event.topic,
      tenantId: event.tenantId,
      branchId: event.branchId,
      channel: event.channel,
      at: new Date(event.at).toISOString(),
      version: 1,
      payload: event.payload,
    }),
  );
}

export function connectedClients(): number {
  return clients.size;
}
