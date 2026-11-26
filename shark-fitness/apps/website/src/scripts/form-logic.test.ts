import { describe, expect, it } from 'vitest';
import { toE164Phone } from '../../../../packages/contracts/src/schemas/public-site';
import { fieldErrorsFrom, firstInvalid, payload, summary, toE164, validate, type FormValues } from './form-logic';

const blank: FormValues = {
  name: '',
  phone: '',
  email: '',
  branchId: '',
  goal: '',
  preferredTime: '',
  classSessionId: '',
  message: '',
  consentProcessing: false,
  consentMarketing: false,
  website: '',
};

describe('toE164 mirrors the API contract', () => {
  it.each(['98450 12345', '098450-12345', '+91 98450 12345', '0091 9845012345', '919845012345', '(080) 4000 1000', '+44 20 7946 0958', '12345', '+91 0845012345', 'call me', ''])(
    '%s',
    (raw) => {
      expect(toE164(raw)).toBe(toE164Phone(raw));
    },
  );
});

describe('validate', () => {
  it('lists every missing required field of the trial form, in screen order', () => {
    const errors = validate(blank, 'trial');
    expect(Object.keys(errors)).toEqual(['name', 'phone', 'branchId', 'preferredTime', 'consent.processing']);
    expect(firstInvalid(errors)).toBe('name');
    expect(summary(errors)).toBe('5 fields need attention. The first is highlighted.');
  });

  it('accepts a class instead of a time, and needs a question on the contact form', () => {
    const filled = { ...blank, name: 'Kavya Rao', phone: '9845012345', branchId: 'br_kor', consentProcessing: true };
    expect(validate({ ...filled, classSessionId: 'cls_1' }, 'trial')).toEqual({});
    expect(validate(filled, 'contact')).toEqual({ message: 'Tell us what you would like to know.' });
    expect(validate({ ...filled, email: 'not-an-email', preferredTime: 'evening' }, 'trial')).toEqual({ email: expect.any(String) });
  });

  it('caps the message at 1,000 characters', () => {
    const filled = { ...blank, name: 'Kavya', phone: '9845012345', branchId: 'br_kor', consentProcessing: true, preferredTime: 'evening' };
    expect(validate({ ...filled, message: 'x'.repeat(1_001) }, 'trial').message).toMatch(/1,000/);
  });
});

describe('payload', () => {
  it('sends attribution, consent with its version, the honeypot and the start time; never empty optional fields', () => {
    const body = payload(
      { ...blank, name: ' Kavya ', phone: '98450 12345', branchId: 'br_kor', consentProcessing: true, preferredTime: 'evening' },
      { utm_source: 'qr', utm_campaign: 'poster', ref: 'AMAN-2041' },
      'web-2026-11',
      1234,
    );
    expect(body).toEqual({
      name: 'Kavya',
      phone: '98450 12345',
      branchId: 'br_kor',
      preferredTime: 'evening',
      consent: { processing: true, marketing: false, noticeVersion: 'web-2026-11' },
      utm: { source: 'qr', campaign: 'poster' },
      referralCode: 'AMAN-2041',
      website: '',
      formStartedAt: 1234,
    });
  });
});

describe('fieldErrorsFrom', () => {
  it('maps API field paths onto the form and keeps unknown ones as a form message', () => {
    expect(
      fieldErrorsFrom([
        { path: 'phone', message: 'Enter a 10-digit mobile number.' },
        { path: 'consent.noticeVersion', message: 'Unknown notice.' },
        { path: 'utm.source', message: 'Too long.' },
      ]),
    ).toEqual({ phone: 'Enter a 10-digit mobile number.', 'consent.processing': 'Unknown notice.', _form: 'Too long.' });
  });
});
