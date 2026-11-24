import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../lib/redaction.js';
import { SENSITIVE, SENSITIVE_SENTENCE, SENSITIVE_VALUES } from './fixtures/redaction.js';

describe('observability text redaction', () => {
  it('removes common PII and credential shapes before truncating', () => {
    const redacted = redactSensitiveText(SENSITIVE_SENTENCE);

    for (const value of SENSITIVE_VALUES) expect(redacted).not.toContain(value);
    expect(redacted).toContain('[redacted-email]');
    expect(redacted).toContain('[redacted-phone]');
  });

  it('keeps the name of a redacted credential so the report stays readable', () => {
    expect(redactSensitiveText(`password=${SENSITIVE.password}`)).toBe('password=[redacted]');
    expect(redactSensitiveText(SENSITIVE.sessionCookie)).toBe('shark_session=[redacted]');
  });
});
