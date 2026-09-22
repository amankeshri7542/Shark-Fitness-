import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../lib/redaction.js';

describe('observability text redaction', () => {
  it('removes common PII and credential shapes before truncating', () => {
    const source = 'owner@example.com +91 98765 43210 password=hunter2 token=short-secret Bearer abcdefghijklmnopqrstuvwxyz123456';
    const redacted = redactSensitiveText(source);

    expect(redacted).not.toContain('owner@example.com');
    expect(redacted).not.toContain('98765');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('short-secret');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).toContain('[redacted-email]');
    expect(redacted).toContain('[redacted-phone]');
  });
});
