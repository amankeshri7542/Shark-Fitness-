/**
 * Personal data and credential shapes that must never cross an observability
 * boundary (logs, error reports, metrics). Shared by the redaction, error
 * reporting and client-error tests so they all prove the same thing.
 */
export const SENSITIVE = {
  email: 'owner@example.com',
  phone: '+91 98765 43210',
  phoneDigits: '98765',
  password: 'hunter2',
  token: 'short-secret',
  bearer: 'abcdefghijklmnopqrstuvwxyz123456',
  sessionCookie: 'shark_session=sess-cookie-value-9f3',
  sessionCookieValue: 'sess-cookie-value-9f3',
} as const;

/** One line that contains every shape above. */
export const SENSITIVE_SENTENCE =
  `${SENSITIVE.email} ${SENSITIVE.phone} password=${SENSITIVE.password} token=${SENSITIVE.token} ` +
  `Bearer ${SENSITIVE.bearer} ${SENSITIVE.sessionCookie}`;

/** Values whose appearance in any outbound payload is a leak. */
export const SENSITIVE_VALUES = [
  SENSITIVE.email,
  SENSITIVE.phoneDigits,
  SENSITIVE.password,
  SENSITIVE.token,
  SENSITIVE.bearer,
  SENSITIVE.sessionCookieValue,
] as const;
