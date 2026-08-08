import { HTTP_STATUS_FOR, type ErrorCode, type FieldError } from '@shark/contracts';

/**
 * The only error type routes throw. Carries everything the envelope needs, so
 * a handler never has to guess a status code or invent a message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: FieldError[];
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { fields?: FieldError[]; retryAfterSec?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS_FOR[code];
    if (opts.fields) this.fields = opts.fields;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.details) this.details = opts.details;
  }
}

/* Shorthands. Messages here are member-facing — they must never leak schema
   names, internal ids, or why a security check failed. */

export const notFound = (what = 'That') => new AppError('NOT_FOUND', `${what} could not be found.`);

export const forbidden = (why = 'You do not have access to this.') => new AppError('FORBIDDEN', why);

export const unauthenticated = () =>
  new AppError('UNAUTHENTICATED', 'Sign in to continue.');

export const conflict = (why: string) => new AppError('CONFLICT', why);

export const invalid = (why: string, fields?: FieldError[]) =>
  new AppError('VALIDATION_FAILED', why, fields ? { fields } : {});

export const precondition = (why: string) => new AppError('PRECONDITION_FAILED', why);

export const capacityExhausted = (why = 'That class filled up while you were deciding.') =>
  new AppError('CAPACITY_EXHAUSTED', why);

export const entitlementMissing = (why: string) => new AppError('ENTITLEMENT_MISSING', why);

export const rateLimited = (retryAfterSec: number) =>
  new AppError('RATE_LIMITED', 'Too many attempts. Try again shortly.', { retryAfterSec });

export const staleVersion = () =>
  new AppError(
    'STALE_VERSION',
    'Someone else changed this while you were editing. Reload to see their version.',
  );
