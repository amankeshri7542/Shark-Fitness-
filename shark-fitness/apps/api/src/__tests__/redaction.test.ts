import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, reportException } from '../lib/observability.js';
import { redactSensitiveText } from '../lib/redaction.js';
import { setErrorReporterForTest } from '../lib/error-reporting.js';
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

describe('P06 secrets never reach logs or error reports', () => {
  const webhookSecret = 'whsec_q2ZbX0wYp8sV3m1Lk7Rt4Nc9Hd6Fg5Ja2Ue8Wi0Oy3T';
  const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const uri = `otpauth://totp/Shark%20Fitness:owner%40gym.example?issuer=Shark%20Fitness&secret=${totpSecret}&algorithm=SHA1`;
  const recoveryCode = 'K7QPX-M2ZRT';
  afterEach(() => {
    vi.restoreAllMocks();
    setErrorReporterForTest(null);
  });

  it('redacts webhook secrets, authenticator URIs and signatures in free text', () => {
    const text = `rotated ${webhookSecret}; scan ${uri}; shark-signature: t=1,v1=abcdef0123`;
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain(webhookSecret);
    expect(redacted).not.toContain(totpSecret);
    expect(redacted).not.toContain('abcdef0123');
    expect(redacted).toContain('[redacted-webhook-secret]');
    expect(redacted).toContain('[redacted-otpauth-uri]');
  });

  it('keeps every MFA and webhook secret out of structured logs and error reports', () => {
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
    }
    const reports: string[] = [];
    setErrorReporterForTest({ name: 'console', capture: (error) => void reports.push(String((error as Error).message)), flush: async () => undefined });

    log('info', 'mfa_probe', { secret: totpSecret, recoveryCode, note: `uri ${uri}`, webhook: webhookSecret });
    reportException(new Error(`delivery failed with ${webhookSecret} and ${uri}`), { route: '/v1/admin/integrations/webhooks' });

    const output = lines.join('\n');
    for (const value of [webhookSecret, totpSecret, recoveryCode]) expect(output).not.toContain(value);
    // The reporter receives the raw error; its transport redacts (error-reporting.test.ts).
    expect(redactSensitiveText(reports.join(' '))).not.toContain(webhookSecret);
    expect(redactSensitiveText(reports.join(' '))).not.toContain(totpSecret);
  });
});
