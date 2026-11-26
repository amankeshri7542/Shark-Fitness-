import { describe, expect, it } from 'vitest';
import { PublicLeadInput, PublicTrialRequestInput, toE164Phone } from '../schemas/public-site.js';

describe('toE164Phone', () => {
  it.each([
    ['98450 12345', '+919845012345'],
    ['098450-12345', '+919845012345'],
    ['+91 98450 12345', '+919845012345'],
    ['0091 9845012345', '+919845012345'],
    ['919845012345', '+919845012345'],
    ['(080) 4000 1000', '+918040001000'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('normalises %s', (raw, expected) => {
    expect(toE164Phone(raw)).toBe(expected);
  });

  it.each(['', '12345', '98450 1234', '+91 0845012345', 'call me', '98450123456789012', '+0 1234 5678', '9845O12345'])(
    'refuses %s',
    (raw) => {
      expect(toE164Phone(raw)).toBeNull();
    },
  );
});

const valid = {
  name: 'Kavya Rao',
  phone: '98450 12345',
  branchId: 'br_kor',
  consent: { processing: true, noticeVersion: 'web-2026-11' },
  formStartedAt: 1,
};

describe('PublicLeadInput', () => {
  it('normalises the phone and defaults marketing consent to off', () => {
    const parsed = PublicLeadInput.parse(valid);
    expect(parsed.phone).toBe('+919845012345');
    expect(parsed.consent.marketing).toBe(false);
    expect(parsed.email).toBeUndefined();
    expect(parsed.utm).toEqual({});
  });

  it('reports an invalid phone on the phone field', () => {
    const result = PublicLeadInput.safeParse({ ...valid, phone: '12345' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['phone']);
  });

  it('requires processing consent', () => {
    const result = PublicLeadInput.safeParse({ ...valid, consent: { processing: false, noticeVersion: 'web-2026-11' } });
    expect(result.error?.issues[0]?.path.join('.')).toBe('consent.processing');
  });

  it('caps the message at 1,000 characters', () => {
    expect(PublicLeadInput.safeParse({ ...valid, message: 'x'.repeat(1_000) }).success).toBe(true);
    expect(PublicLeadInput.safeParse({ ...valid, message: 'x'.repeat(1_001) }).success).toBe(false);
  });

  it('treats an empty email as absent and lower-cases a real one', () => {
    expect(PublicLeadInput.parse({ ...valid, email: '' }).email).toBeUndefined();
    expect(PublicLeadInput.parse({ ...valid, email: ' Kavya@Example.IN ' }).email).toBe('kavya@example.in');
  });
});

describe('PublicTrialRequestInput', () => {
  it('needs a class or a preferred time', () => {
    const result = PublicTrialRequestInput.safeParse(valid);
    expect(result.error?.issues[0]?.path.join('.')).toBe('preferredTime');
    expect(PublicTrialRequestInput.safeParse({ ...valid, preferredTime: 'evening' }).success).toBe(true);
    expect(PublicTrialRequestInput.safeParse({ ...valid, classSessionId: 'cls_1' }).success).toBe(true);
  });
});
