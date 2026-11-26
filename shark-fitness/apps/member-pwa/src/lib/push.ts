import { api } from './api';

/**
 * Web Push on this device (PF-COMM-002, PRD 03 §5.6).
 *
 * Permission is only ever requested from a tap on the rationale screen
 * (ui/PushSettings). The server says whether push is configured at all; when
 * it is not, no push UI renders.
 */
export interface PushSubscriptionRow {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

export interface PushConfig {
  available: boolean;
  publicKey: string | null;
  items: PushSubscriptionRow[];
}

const DEVICE_KEY = 'shark.member.push-device';

interface DeviceRecord {
  owner: string;
  id: string;
  endpoint: string;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function fetchPushConfig(): Promise<PushConfig> {
  return api<PushConfig>('/me/push-subscriptions');
}

function readDevice(): DeviceRecord | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw ? (JSON.parse(raw) as DeviceRecord) : null;
  } catch {
    return null;
  }
}

function writeDevice(record: DeviceRecord | null): void {
  try {
    if (record) localStorage.setItem(DEVICE_KEY, JSON.stringify(record));
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* the server copy is still removable from Profile */
  }
}

/** The subscription id this device registered for `owner`, if any. */
export function thisDeviceSubscription(owner: string): string | null {
  const device = readDevice();
  return device && device.owner === owner ? device.id : null;
}

/** VAPID keys travel as URL-safe base64; PushManager wants the raw bytes. */
export function applicationServerKey(base64url: string): Uint8Array {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type EnableResult = 'enabled' | 'denied' | 'unsupported';

/** Asks for permission (call only from a tap), subscribes, and registers the
 *  subscription with the server. */
export async function enablePush(owner: string, publicKey: string): Promise<EnableResult> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  const json = subscription.toJSON();
  const created = await api<{ id: string }>('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys },
  });
  writeDevice({ owner, id: created.id, endpoint: subscription.endpoint });
  return 'enabled';
}

/** Removes this device's subscription from the server, then from the browser. */
export async function disablePush(owner: string): Promise<void> {
  const device = readDevice();
  if (device && device.owner === owner) {
    await api(`/me/push-subscriptions/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
  }
  writeDevice(null);
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/app/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

/** Sign-out: best effort, never blocks leaving. Even if this fails, the
 *  server stops pushing to a device once the session that registered it has
 *  ended (services/notifications.ts). */
export async function forgetPushOnSignOut(owner: string): Promise<void> {
  try {
    await disablePush(owner);
  } catch {
    writeDevice(null);
    // Offline, or the server refused: the session may still be live on the
    // server, so the browser subscription itself must go. The push service
    // then answers 410 and the server deletes its copy on the next send.
    try {
      if (!pushSupported()) return;
      const registration = await navigator.serviceWorker.getRegistration('/app/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    } catch {
      /* nothing more this device can do */
    }
  }
}

/**
 * After signing in again, tell the server this phone's existing subscription
 * belongs to the new session, so notifications keep arriving. Silent: no
 * permission prompt, nothing if push was never switched on here.
 */
export async function refreshPushRegistration(owner: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const device = readDevice();
  if (!device || device.owner !== owner) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/app/');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) {
      writeDevice(null);
      return;
    }
    const json = subscription.toJSON();
    const created = await api<{ id: string }>('/me/push-subscriptions', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: json.keys },
    });
    writeDevice({ owner, id: created.id, endpoint: subscription.endpoint });
  } catch {
    /* push may be off on the server now; Profile shows the truth */
  }
}
