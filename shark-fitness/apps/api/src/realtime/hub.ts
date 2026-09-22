import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { channels, type EventTopic } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';
import { replay, subscribe, type OutboxEvent } from '../lib/events.js';
import { log } from '../lib/observability.js';
import { consumeRealtimeTicket } from '../lib/realtime-ticket.js';
import { resolveSessionById } from '../services/auth.js';
import type { RequestContext } from '../lib/context.js';

interface Client {
  socket: WebSocket;
  sessionId: string;
  ctx: RequestContext;
  allowed: Set<string>;
  subscribed: Set<string>;
}

const clients = new Set<Client>();

// Staff clients use events only to refetch their permission-scoped HTTP views.
// Never send row payloads: a branch includes other trainers' members and private
// support records. Unknown topics/kinds stay private until explicitly reviewed.
const STAFF_TOPICS: Partial<Record<EventTopic, Permission>> = {
  'attendance.checked_in': 'attendance.view',
  'attendance.checked_out': 'attendance.view',
  'attendance.denied': 'attendance.view',
  'occupancy.changed': 'attendance.view',
  'booking.confirmed': 'schedule.view',
  'booking.cancelled': 'schedule.view',
  'booking.seat_changed': 'schedule.view',
  'waitlist.offered': 'schedule.view',
  'waitlist.promoted': 'schedule.view',
  'session.updated': 'schedule.view',
  'session.cancelled': 'schedule.view',
  'lead.stage_changed': 'lead.view',
  'pos.sale_completed': 'inventory.view',
  'pos.return_completed': 'inventory.view',
  'pos.order_voided': 'inventory.view',
  'stock.changed': 'inventory.view',
  'stock.low': 'inventory.view',
  'transfer.updated': 'inventory.view',
  'ticket.updated': 'support.manage',
};
const STAFF_ALERTS: Record<string, Permission> = {
  ticket: 'support.manage',
  message_safety: 'support.manage',
  safety_check_in: 'support.manage',
  equipment_updated: 'facility.view',
  equipment_returned_to_service: 'facility.view',
  equipment_down: 'facility.view',
  work_order_created: 'facility.view',
  work_order_updated: 'facility.view',
};

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
  client.ctx = ctx;
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

    const client: Client = { socket, sessionId: ctx.sessionId, ctx, allowed, subscribed: new Set() };
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
            for (const event of replay(channel, msg.since)) send(client, event);
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
      if (!refreshAccess(client)) continue;
      if (!client.subscribed.has(event.channel)) continue;
      send(client, event);
    }
  });
  wss.on('close', unsubscribe);

  log('info', 'realtime_listening', { route: '/v1/realtime' });
}

function send(client: Client, event: OutboxEvent): void {
  const { socket, ctx } = client;
  if (socket.readyState !== socket.OPEN) return;
  if (ctx.tenantId !== event.tenantId) return;
  if (ctx.role !== 'member') {
    if (event.branchId && !ctx.branchIds.includes(event.branchId)) return;
    const permission = event.topic === 'alert.raised'
      ? STAFF_ALERTS[String(event.payload.kind)]
      : STAFF_TOPICS[event.topic];
    if (!permission || !can(ctx.role, permission)) return;
  }
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
      payload: ctx.role === 'member' ? event.payload : {},
    }),
  );
}

export function connectedClients(): number {
  return clients.size;
}
