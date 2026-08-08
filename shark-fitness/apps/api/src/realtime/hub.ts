import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { channels } from '@shark/contracts';
import { replay, subscribe, type OutboxEvent } from '../lib/events.js';
import { resolveSession } from '../services/auth.js';

/**
 * Realtime fan-out.
 *
 * Stands in for Durable Objects (see docs/ADR-001-runtime.md). The contract is
 * the same one the PRD specifies: small payloads, a monotonic sequence per
 * channel, a replay window on reconnect, and a subscription that can only reach
 * channels the session's own scope allows.
 */

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
    const token = url.searchParams.get('token');
    const ctx = token ? resolveSession(token) : null;

    if (!ctx) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    // The set of channels this session may ever hear from. Asking for another
    // tenant's branch is simply ignored — never acknowledged, never errored in
    // a way that confirms the channel exists.
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
