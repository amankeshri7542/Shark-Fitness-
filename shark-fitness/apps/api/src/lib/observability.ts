import { runtimeConfig } from './config.js';
import { captureException, type ErrorReportContext } from './error-reporting.js';
import { redactSensitiveText } from './redaction.js';

type Level = 'info' | 'warn' | 'error';
const SENSITIVE = /password|token|secret|authorization|cookie|otp|pass|phone|email|payload/i;

function safeValue(value: unknown, key = ''): unknown {
  if (SENSITIVE.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, safeValue(item, name)]));
  return value;
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return safeValue(fields) as Record<string, unknown>;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const record = { timestamp: new Date().toISOString(), level, event, release: runtimeConfig.release, ...safeFields(fields) };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Optional JSON error-collector seam. With no endpoint it is a no-op. */
export function reportException(error: unknown, fields: Record<string, unknown> = {}): void {
  const metadata = safeFields({ ...fields, errorName: error instanceof Error ? error.name : 'UnknownError', errorMessage: error instanceof Error ? error.message : String(error) });
  log('error', 'exception', metadata);
  captureException(error, fields as ErrorReportContext);
}
