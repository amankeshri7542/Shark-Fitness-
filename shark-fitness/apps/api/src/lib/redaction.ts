/** Keep exception/log text useful without allowing common credential or PII
 * shapes to cross an observability boundary. */
export function redactSensitiveText(value: string, maximumLength = 500): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s()-]{8,}\d/g, '[redacted-phone]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
    .replace(/(?:password|secret|token|cookie|authorization|otp)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, maximumLength);
}
