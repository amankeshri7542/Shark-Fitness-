import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../lib/config.js';

/* P02 acceptance 2: live keys are refused everywhere, and a half-configured
   provider never boots. */

const STRONG_SECRET = 'A9!production-pass-secret-with-more-than-48-bytes!';
const RAZORPAY = {
  SHARK_PAYMENT_PROVIDER: 'razorpay',
  SHARK_RAZORPAY_KEY_ID: 'rzp_test_1DP5mmOlF5G5ag',
  SHARK_RAZORPAY_KEY_SECRET: 'test-key-secret-placeholder',
  SHARK_RAZORPAY_WEBHOOK_SECRET: 'webhook-secret-placeholder',
};

const environments: Record<'development' | 'test' | 'production', Record<string, string>> = {
  development: { NODE_ENV: 'development' },
  test: { NODE_ENV: 'test' },
  production: {
    NODE_ENV: 'production',
    SHARK_DB: '/var/lib/shark/shark.db',
    SHARK_PASS_SECRET: STRONG_SECRET,
    SHARK_PUBLIC_ORIGIN: 'https://fitness.example',
    // Production also requires the MFA key since P06 (test value).
    SHARK_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
};

describe('Razorpay configuration', () => {
  it('is off unless explicitly selected, whatever keys are lying around', () => {
    expect(parseRuntimeConfig({}).payments).toBeNull();
    expect(parseRuntimeConfig({ SHARK_PAYMENT_PROVIDER: 'none' }).payments).toBeNull();
    const { SHARK_PAYMENT_PROVIDER: _selected, ...keysOnly } = RAZORPAY;
    expect(parseRuntimeConfig(keysOnly).payments).toBeNull();
  });

  it.each(Object.keys(environments) as Array<keyof typeof environments>)('refuses a live key id in %s', (name) => {
    const environment = { ...environments[name], ...RAZORPAY, SHARK_RAZORPAY_KEY_ID: 'rzp_live_1DP5mmOlF5G5ag' };
    expect(() => parseRuntimeConfig(environment)).toThrow(/rzp_test_.*Live mode is out of scope/s);
    // Even with the provider switched off: a live key must not sit in the file.
    expect(() => parseRuntimeConfig({ ...environment, SHARK_PAYMENT_PROVIDER: 'none' })).toThrow(/Live mode is out of scope/);
  });

  it.each(['rzp_test_', 'rzp_test_abc-def', 'pk_test_123', 'RZP_TEST_abc'])('refuses the malformed key id %s', (keyId) => {
    expect(() => parseRuntimeConfig({ ...RAZORPAY, SHARK_RAZORPAY_KEY_ID: keyId })).toThrow(/SHARK_RAZORPAY_KEY_ID/);
  });

  it.each(['SHARK_RAZORPAY_KEY_ID', 'SHARK_RAZORPAY_KEY_SECRET', 'SHARK_RAZORPAY_WEBHOOK_SECRET'] as const)(
    'refuses to boot with SHARK_PAYMENT_PROVIDER=razorpay and no %s, in every environment',
    (missing) => {
      for (const environment of Object.values(environments)) {
        const values: Record<string, string | undefined> = { ...environment, ...RAZORPAY, [missing]: undefined };
        expect(() => parseRuntimeConfig(values)).toThrow(new RegExp(`${missing} is required when SHARK_PAYMENT_PROVIDER=razorpay`));
        expect(() => parseRuntimeConfig({ ...values, [missing]: '' })).toThrow(new RegExp(missing));
      }
    },
  );

  it('builds the adapter configuration from a complete test-mode setup', () => {
    expect(parseRuntimeConfig(RAZORPAY).payments).toEqual({
      provider: 'razorpay',
      razorpay: {
        keyId: RAZORPAY.SHARK_RAZORPAY_KEY_ID,
        keySecret: RAZORPAY.SHARK_RAZORPAY_KEY_SECRET,
        webhookSecret: RAZORPAY.SHARK_RAZORPAY_WEBHOOK_SECRET,
        apiBase: 'https://api.razorpay.com/v1',
      },
    });
    expect(parseRuntimeConfig({ ...environments.production, ...RAZORPAY }).payments?.provider).toBe('razorpay');
  });

  it('refuses an unknown provider name', () => {
    expect(() => parseRuntimeConfig({ SHARK_PAYMENT_PROVIDER: 'stripe' })).toThrow(/Unknown SHARK_PAYMENT_PROVIDER/);
  });

  it('accepts only Razorpay itself or a loopback fake as the API base', () => {
    for (const base of ['http://127.0.0.1:18150/v1', 'http://localhost:18150/v1/', 'https://api.razorpay.com/v1']) {
      expect(parseRuntimeConfig({ ...RAZORPAY, SHARK_RAZORPAY_API_BASE: base }).payments?.razorpay.apiBase).toBe(base.replace(/\/$/, ''));
    }
    for (const base of ['https://razorpay.attacker.example/v1', 'http://10.0.0.5/v1', 'https://api.razorpay.com.evil.example/v1']) {
      expect(() => parseRuntimeConfig({ ...RAZORPAY, SHARK_RAZORPAY_API_BASE: base })).toThrow(/SHARK_RAZORPAY_API_BASE/);
    }
  });

  it('demands a webhook secret of 16 or more characters in production', () => {
    expect(() =>
      parseRuntimeConfig({ ...environments.production, ...RAZORPAY, SHARK_RAZORPAY_WEBHOOK_SECRET: 'short' }),
    ).toThrow(/at least 16 characters/);
    expect(parseRuntimeConfig({ ...RAZORPAY, SHARK_RAZORPAY_WEBHOOK_SECRET: 'short' }).payments).not.toBeNull();
  });
});
