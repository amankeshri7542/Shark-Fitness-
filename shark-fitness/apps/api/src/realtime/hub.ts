import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { channels } from '@shark/contracts';
import { replay, subscribe, type OutboxEvent } from '../lib/events.js';
import { consumeRealtimeTicket } from '../lib/realtime-ticket.js';

interface Client {
  socket: WebSocket;
  tenantId: string;
  allowed: Set<string>;
  subscribed: Set<string>;
}

const clients = new Set<Client>();

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

    const allowed = new Set<string>([channels.tenant(ctx.tenantId)]);
    for (const branchId of ctx.branchIds) allowed.add(channels.branch(branchId));
    if (ctx.memberId) allowed.add(channels.member(ctx.memberId));

    const client: Client = { socket, tenantId: ctx.tenantId, allowed, subscribed: new Set() };
    clients.add(client);

    socket.on('message', (raw) => {
      let msg: { type?: string; channels?: string[]; since?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

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

  subscribe((event) => {
    for (const client of clients) {
      if (client.tenantId !== event.tenantId) continue;
      if (!client.subscribed.has(event.channel)) continue;
      send(client.socket, event);
    }
  });

  console.log('[realtime] websocket listening on /v1/realtime');
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
