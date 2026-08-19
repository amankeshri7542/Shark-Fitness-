import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { EventTopic } from '@shark/contracts';
import { API_ORIGIN, api } from './api';

/**
 * Live console updates.
 *
 * A port of the member app's realtime client, with three deliberate changes.
 *
 * 1. The invalidation map is keyed to *this* app's query keys. Every entry
 *    below corresponds to a real `useQuery` key; a topic with no matching key
 *    is left out rather than mapped hopefully, because a dead entry looks like
 *    working code and silently never refreshes anything.
 * 2. A first connection does not ask for replay. `since: 0` makes the server
 *    resend up to 200 historical events per channel, each triggering an
 *    invalidation — a thundering refetch the moment a console opens. The
 *    initial fetch already has current data; replay is only useful to close a
 *    gap after a reconnect.
 * 3. Reconnecting refetches outright instead of trusting replay. The replay
 *    window is capped and carries no gap signal, so after a long disconnect the
 *    only safe assumption is that the screen is stale.
 *
 * Staff sockets are authorised for the tenant channel and every branch in
 * `ctx.branchIds`, which is exactly `viewer.permittedBranchIds` on the client.
 * Member channels are not available to staff, so anything published only to a
 * member channel never arrives here.
 */

export type Connection = 'connecting' | 'open' | 'closed';

interface RealtimeEvent {
  type: 'event';
  seq: number;
  topic: EventTopic;
  channel: string;
  branchId: string | null;
  at: string;
  payload: Record<string, unknown>;
}

let socket: WebSocket | null = null;
let connection: Connection = 'closed';
let lastSeq = 0;
let subscribedChannels: string[] = [];
let retry = 0;
let client: QueryClient | null = null;
let shouldReconnect = false;
let opening = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hasConnectedBefore = false;

const listeners = new Set<(state: Connection) => void>();

function setConnection(next: Connection): void {
  connection = next;
  listeners.forEach((listener) => listener(next));
}

/**
 * Topic → query keys to invalidate. Keys are prefixes: invalidating `['floor']`
 * matches `['floor','current',branchId]` and `['floor','feed',…]` alike.
 *
 * Only topics that reach a *branch* channel are listed. Billing, membership and
 * message events are published to member channels, which a staff socket cannot
 * subscribe to, so mapping them here would be dead code.
 */
const INVALIDATES: Partial<Record<EventTopic, string[][]>> = {
  'attendance.checked_in': [['floor'], ['dashboard']],
  'attendance.checked_out': [['floor'], ['dashboard']],
  'attendance.denied': [['floor'], ['dashboard']],
  'occupancy.changed': [['floor'], ['dashboard']],
  'booking.confirmed': [['schedule'], ['dashboard']],
  'booking.cancelled': [['schedule'], ['dashboard']],
  'booking.seat_changed': [['schedule']],
  'waitlist.offered': [['schedule']],
  'waitlist.promoted': [['schedule']],
  'session.updated': [['schedule']],
  'session.cancelled': [['schedule'], ['dashboard']],
  'lead.stage_changed': [['leads']],
  // An escalated ticket raises this too, and the support queue is where it has
  // to be acted on.
  'alert.raised': [['dashboard'], ['support']],
  // Store. A till, a stockroom and a manager's console all watch one shelf, so
  // any of these can make another console's catalogue wrong.
  'pos.sale_completed': [['store'], ['dashboard']],
  'pos.return_completed': [['store'], ['dashboard']],
  'pos.order_voided': [['store'], ['dashboard']],
  'stock.changed': [['store']],
  'stock.low': [['store'], ['dashboard']],
  'transfer.updated': [['store']],
  // Support. A queue is worked by several people at once, so an assignment or
  // a state change made at one desk has to reach the others before two of them
  // answer the same complaint.
  'ticket.updated': [['support'], ['dashboard']],
};

/** Refetched wholesale after a reconnect, when replay cannot be trusted. */
const LIVE_SURFACES = [['floor'], ['schedule'], ['dashboard'], ['store'], ['support']];

export async function connectRealtime(queryClient: QueryClient, subscribeTo: string[]): Promise<void> {
  client = queryClient;
  subscribedChannels = [...new Set(subscribeTo)];
  shouldReconnect = true;
  await open();
}

function websocketUrl(ticket: string): string {
  const httpBase = API_ORIGIN || location.origin;
  const url = new URL('/v1/realtime', httpBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

function scheduleReconnect(): void {
  if (!shouldReconnect) return;
  const delay = Math.min(30_000, 1_000 * 2 ** retry++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void open();
  }, delay);
}

async function open(): Promise<void> {
  if (!shouldReconnect || socket || opening) return;
  opening = true;
  setConnection('connecting');

  try {
    const { ticket } = await api<{ ticket: string; expiresInSec: number }>('/me/realtime-ticket', {
      method: 'POST',
    });

    if (!shouldReconnect) return;

    const nextSocket = new WebSocket(websocketUrl(ticket));
    socket = nextSocket;

    nextSocket.addEventListener('open', () => {
      retry = 0;
      setConnection('open');

      // Replay only closes a gap. On a first connect there is nothing to close,
      // and asking would replay the entire retained outbox.
      nextSocket.send(
        JSON.stringify({
          type: 'subscribe',
          channels: subscribedChannels,
          ...(lastSeq > 0 ? { since: lastSeq } : {}),
        }),
      );

      // Anything could have happened while the socket was down, and the replay
      // window is finite, so treat every reconnect as "the screen is stale".
      if (hasConnectedBefore) {
        for (const key of LIVE_SURFACES) void client?.invalidateQueries({ queryKey: key });
      }
      hasConnectedBefore = true;
    });

    nextSocket.addEventListener('message', (message) => {
      let data: RealtimeEvent | { type: string };
      try {
        data = JSON.parse(String(message.data)) as RealtimeEvent | { type: string };
      } catch {
        return;
      }
      if (data.type !== 'event') return;

      const event = data as RealtimeEvent;
      lastSeq = Math.max(lastSeq, event.seq);
      for (const key of INVALIDATES[event.topic] ?? []) {
        void client?.invalidateQueries({ queryKey: key });
      }
    });

    nextSocket.addEventListener('close', () => {
      if (socket === nextSocket) socket = null;
      setConnection('closed');
      scheduleReconnect();
    });

    nextSocket.addEventListener('error', () => nextSocket.close());
  } catch {
    setConnection('closed');
    scheduleReconnect();
  } finally {
    opening = false;
  }
}

export function disconnectRealtime(): void {
  shouldReconnect = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socket?.close();
  socket = null;
  lastSeq = 0;
  retry = 0;
  opening = false;
  hasConnectedBefore = false;
  setConnection('closed');
}

export function useConnection(): Connection {
  const [state, setState] = useState<Connection>(connection);
  useEffect(() => {
    listeners.add(setState);
    setState(connection);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** The desk needs to know the difference between "nothing is happening" and
 *  "this machine is offline" — UX-A08 lists network unavailable as a state. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
