import { z } from 'zod';

/**
 * Browser error reports: the member app and the staff console send one to
 * POST /v1/client-errors when a screen crashes or an error escapes to the
 * window. Shared here so the API validates exactly what the apps send.
 */
export const CLIENT_ERROR_MAX_BYTES = 8 * 1024;

export const CLIENT_ERROR_SOURCES = ['admin', 'member'] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export const CLIENT_ERROR_KINDS = ['boundary', 'error', 'unhandledrejection'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

const MAX_MESSAGE = 2_000;
const MAX_STACK = 6_000;
const MAX_ROUTE = 300;

export const ClientErrorReport = z
  .object({
    source: z.enum(CLIENT_ERROR_SOURCES),
    kind: z.enum(CLIENT_ERROR_KINDS),
    name: z.string().trim().min(1).max(120),
    message: z.string().max(MAX_MESSAGE),
    stack: z.string().max(MAX_STACK).optional(),
    /** The SPA route, e.g. /admin/members/mbr_123. The API collapses ids. */
    route: z.string().max(MAX_ROUTE).optional(),
    /** The id the recovery screen shows, so support can find this report. */
    reference: z.string().regex(/^[A-Za-z0-9-]{8,40}$/),
    release: z.string().max(80).optional(),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

/** Reads name, message and stack from anything that was thrown. */
export function describeThrown(error: unknown): { name: string; message: string; stack: string } {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const name = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : 'Error';
  const message =
    typeof record?.message === 'string' ? record.message : record ? safeString(record) : String(error);
  const stack = typeof record?.stack === 'string' ? record.stack : '';
  return { name, message, stack };
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The same bug gives the same fingerprint every time it happens: type,
 * message with numbers blanked out, and the first stack location without its
 * query string or column. A reload loop is therefore reported once.
 */
export function errorFingerprint(name: string, message: string, stack = ''): string {
  const firstFrame =
    stack
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^at\s|@/.test(line))
      ?.replace(/[?#][^:)\s]*/g, '')
      .replace(/:\d+\)?$/, '') ?? '';
  return fnv1a(`${name}|${message.replace(/\d+/g, '#').slice(0, 300)}|${firstFrame}`);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A short id a person can read out to support: `ERR-7K2M-Q9XD`. */
export function newErrorReference(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = random(new Uint8Array(8));
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `ERR-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/**
 * Builds a report that fits the API's limits: fields are clipped to their
 * maxima, then stack lines are dropped until the JSON body is under
 * CLIENT_ERROR_MAX_BYTES.
 */
export function buildClientErrorReport(input: {
  source: ClientErrorSource;
  kind: ClientErrorKind;
  error: unknown;
  reference: string;
  route?: string;
  release?: string;
}): ClientErrorReport {
  const { name, message, stack } = describeThrown(input.error);
  const report: ClientErrorReport = {
    source: input.source,
    kind: input.kind,
    name: name.slice(0, 120),
    message: message.slice(0, MAX_MESSAGE),
    reference: input.reference,
    ...(stack ? { stack: stack.slice(0, MAX_STACK) } : {}),
    ...(input.route ? { route: input.route.slice(0, MAX_ROUTE) } : {}),
    ...(input.release ? { release: input.release.slice(0, 80) } : {}),
  };
  const size = () => new TextEncoder().encode(JSON.stringify(report)).byteLength;
  while (report.stack && size() > CLIENT_ERROR_MAX_BYTES) {
    const lines = report.stack.split('\n');
    if (lines.length <= 1) delete report.stack;
    else report.stack = lines.slice(0, Math.max(1, Math.floor(lines.length / 2))).join('\n');
  }
  if (size() > CLIENT_ERROR_MAX_BYTES) report.message = report.message.slice(0, 500);
  return report;
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ClientErrorReporterOptions {
  source: ClientErrorSource;
  /** Full URL of POST /v1/client-errors. */
  endpoint: string;
  /** sessionStorage in the browser, so "once per error" lasts for the tab's session. */
  storage?: KeyValueStorage | null;
  /** Current SPA path; the API collapses ids out of it. */
  route?: () => string;
  release?: string;
  send?: (endpoint: string, body: string) => Promise<unknown>;
}

export interface ClientErrorReporter {
  /** The reference for this error: the one already given to it this session, or a new one. */
  referenceFor(error: unknown): string;
  /** Sends the error unless the same fingerprint was already sent this session. Never throws. */
  report(error: unknown, kind: ClientErrorKind): { reference: string; sent: boolean };
}

const MAX_REMEMBERED = 50;

/**
 * Framework-free browser reporter shared by both apps. It remembers, per
 * fingerprint, the reference it handed out and whether that error was sent,
 * so a crash that repeats (StrictMode double effects, a reload loop, the same
 * bug on two screens) is reported once and always shows the same reference.
 */
export function createClientErrorReporter(options: ClientErrorReporterOptions): ClientErrorReporter {
  const key = `shark.client-errors.${options.source}`;
  const send =
    options.send ??
    ((endpoint: string, body: string) =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'include',
        // Lets the report leave even if the person reloads straight away.
        keepalive: true,
      }));
  let memory: Record<string, { reference: string; sent: boolean }> = {};

  const load = (): Record<string, { reference: string; sent: boolean }> => {
    try {
      const raw = options.storage?.getItem(key);
      if (raw) memory = { ...(JSON.parse(raw) as typeof memory), ...memory };
    } catch {
      // Unreadable storage: the in-memory copy still dedupes this page load.
    }
    return memory;
  };
  const save = (entries: typeof memory) => {
    const kept = Object.entries(entries).slice(-MAX_REMEMBERED);
    memory = Object.fromEntries(kept);
    try {
      options.storage?.setItem(key, JSON.stringify(memory));
    } catch {
      // Private mode or full storage: keep the in-memory copy.
    }
  };
  const fingerprintOf = (error: unknown) => {
    const { name, message, stack } = describeThrown(error);
    return errorFingerprint(name, message, stack);
  };

  const referenceFor = (error: unknown): string => {
    const fingerprint = fingerprintOf(error);
    const entries = load();
    const existing = entries[fingerprint];
    if (existing) return existing.reference;
    const reference = newErrorReference();
    save({ ...entries, [fingerprint]: { reference, sent: false } });
    return reference;
  };

  return {
    referenceFor,
    report(error, kind) {
      try {
        const reference = referenceFor(error);
        const fingerprint = fingerprintOf(error);
        const entries = load();
        if (entries[fingerprint]?.sent) return { reference, sent: false };
        save({ ...entries, [fingerprint]: { reference, sent: true } });
        const route = options.route?.();
        const body = JSON.stringify(
          buildClientErrorReport({
            source: options.source,
            kind,
            error,
            reference,
            ...(route ? { route } : {}),
            ...(options.release ? { release: options.release } : {}),
          }),
        );
        void Promise.resolve()
          .then(() => send(options.endpoint, body))
          .catch(() => undefined);
        return { reference, sent: true };
      } catch {
        return { reference: 'ERR-UNSENT', sent: false };
      }
    },
  };
}
