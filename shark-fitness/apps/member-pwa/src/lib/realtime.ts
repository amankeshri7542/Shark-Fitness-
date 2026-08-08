import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { EventTopic } from '@shark/contracts';
import { auth } from './api';

/**
 * Realtime client. Subscribes to the channels the session is allowed, resumes
 * from the last sequence it saw on reconnect, and invalidates the query cache
 * for the topics that actually changed rather than refetching everything.
 */

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
let channels: string[] = [];
let retry = 0;
let client: QueryClient | null = null;

const listeners = new Set<(state: Connection) => void>();

function setConnection(next: Connection): void {
  connection = next;
  listeners.forEach((l) => l(next));
}

/** Which queries a topic makes stale. Narrow on purpose — a check-in should
 *  not cause the whole app to refetch. */
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

export function connectRealtime(queryClient: QueryClient, subscribeTo: string[]): void {
  client = queryClient;
  channels = subscribeTo;
  open();
}

function open(): void {
  const token = auth.get();
  if (!token || socket) return;

  setConnection('connecting');

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/v1/realtime?token=${encodeURIComponent(token)}`);

  socket.addEventListener('open', () => {
    retry = 0;
    setConnection('open');
    socket?.send(JSON.stringify({ type: 'subscribe', channels, since: lastSeq }));
  });

  socket.addEventListener('message', (message) => {
    let data: RealtimeEvent | { type: string };
    try {
      data = JSON.parse(String(message.data));
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

  socket.addEventListener('close', () => {
    socket = null;
    setConnection('closed');
    // Backoff with a ceiling. A member on a train should not melt their battery.
    const delay = Math.min(30_000, 1_000 * 2 ** retry++);
    setTimeout(open, delay);
  });

  socket.addEventListener('error', () => socket?.close());
}

export function disconnectRealtime(): void {
  socket?.close();
  socket = null;
  lastSeq = 0;
  retry = 0;
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
