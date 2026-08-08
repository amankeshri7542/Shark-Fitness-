import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { EventTopic } from '@shark/contracts';
import { API_ORIGIN, api } from './api';

export type Connection = 'connecting' | 'open' | 'closed';

interface RealtimeEvent {
  type: 'event';
  seq: number;
  topic: EventTopic;
  channel: string;
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

const listeners = new Set<(state: Connection) => void>();

function setConnection(next: Connection): void {
  connection = next;
  listeners.forEach((listener) => listener(next));
}

const INVALIDATES: Partial<Record<EventTopic, string[][]>> = {
  'attendance.checked_in': [['home'], ['pass'], ['occupancy']],
  'attendance.checked_out': [['pass'], ['occupancy']],
  'attendance.denied': [['pass']],
  'occupancy.changed': [['occupancy'], ['home']],
  'booking.confirmed': [['schedule'], ['home']],
  'booking.cancelled': [['schedule'], ['home']],
  'booking.seat_changed': [['schedule']],
  'waitlist.offered': [['schedule'], ['notifications']],
  'waitlist.promoted': [['schedule']],
  'session.updated': [['schedule']],
  'session.cancelled': [['schedule'], ['home'], ['notifications']],
  'membership.state_changed': [['home'], ['billing'], ['pass']],
  'payment.succeeded': [['billing'], ['home'], ['pass']],
  'payment.failed': [['billing'], ['notifications']],
  'invoice.updated': [['billing']],
  'workout.synced': [['progress'], ['home']],
  'pr.achieved': [['progress'], ['pack']],
  'message.created': [['messages'], ['notifications']],
  'notification.created': [['notifications']],
  'post.created': [['pack']],
  'challenge.score_changed': [['pack']],
};

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
      nextSocket.send(JSON.stringify({ type: 'subscribe', channels: subscribedChannels, since: lastSeq }));
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
      if (!shouldReconnect) return;

      const delay = Math.min(30_000, 1_000 * 2 ** retry++);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void open();
      }, delay);
    });

    nextSocket.addEventListener('error', () => nextSocket.close());
  } catch {
    setConnection('closed');
    if (shouldReconnect) {
      const delay = Math.min(30_000, 1_000 * 2 ** retry++);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void open();
      }, delay);
    }
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
