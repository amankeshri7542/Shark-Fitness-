import { describe, expect, it } from 'vitest';
import {
  ageOn,
  broadcastCostMinor,
  classifyProviderResponse,
  consentAllows,
  insideWindow,
  isMinor,
  maskDestination,
  messageRates,
  notificationRetryDelayMs,
  quietHoursApply,
} from '../notifications.js';

describe('consent by purpose', () => {
  it('never needs consent for a transactional message', () => {
    expect(consentAllows('transactional', 'sms', {}).allowed).toBe(true);
    expect(consentAllows('transactional', 'email', { marketing_email: false }).allowed).toBe(true);
  });

  it('treats operational and coaching as on until withdrawn', () => {
    expect(consentAllows('operational', 'sms', {}).allowed).toBe(true);
    expect(consentAllows('operational', 'sms', { notifications_operational: false })).toMatchObject({
      allowed: false,
      code: 'opted_out',
    });
    expect(consentAllows('coaching', 'in_app', { notifications_coaching: false }).allowed).toBe(false);
  });

  it('treats promotional on a metered channel as off until the member said yes on that channel', () => {
    expect(consentAllows('promotional', 'whatsapp', {})).toMatchObject({ allowed: false, code: 'no_consent' });
    expect(consentAllows('promotional', 'whatsapp', { marketing_sms: true }).allowed).toBe(false);
    expect(consentAllows('promotional', 'whatsapp', { marketing_whatsapp: true }).allowed).toBe(true);
    expect(consentAllows('promotional', 'email', { marketing_email: false })).toMatchObject({ code: 'opted_out' });
    expect(consentAllows('promotional', 'in_app', {}).allowed).toBe(true);
  });
});

describe('quiet hours', () => {
  it('holds interruptions but not the inbox or a transactional message', () => {
    expect(quietHoursApply('operational', 'sms')).toBe(true);
    expect(quietHoursApply('promotional', 'push')).toBe(true);
    expect(quietHoursApply('operational', 'in_app')).toBe(false);
    expect(quietHoursApply('transactional', 'sms')).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    expect(insideWindow(21 * 60, 8 * 60, 23 * 60)).toBe(true);
    expect(insideWindow(21 * 60, 8 * 60, 7 * 60)).toBe(true);
    expect(insideWindow(21 * 60, 8 * 60, 12 * 60)).toBe(false);
    expect(insideWindow(13 * 60, 14 * 60, 13 * 60 + 30)).toBe(true);
    expect(insideWindow(9 * 60, 9 * 60, 9 * 60)).toBe(false);
  });
});

describe('provider responses', () => {
  it('retries what might work next time and stops on what will not', () => {
    expect(classifyProviderResponse(202)).toBe('accepted');
    expect(classifyProviderResponse(0)).toBe('retry');
    expect(classifyProviderResponse(429)).toBe('retry');
    expect(classifyProviderResponse(503)).toBe('retry');
    expect(classifyProviderResponse(400)).toBe('permanent');
    expect(classifyProviderResponse(401)).toBe('permanent');
    expect(notificationRetryDelayMs(1)).toBe(60_000);
    expect(notificationRetryDelayMs(2)).toBe(300_000);
  });
});

describe('destinations, cost and minors', () => {
  it('masks an address', () => {
    expect(maskDestination('sms', '+919812345678')).toBe('+91•••••45678');
    expect(maskDestination('email', 'aman@sharkfitness.in')).toBe('a•••@sharkfitness.in');
    expect(maskDestination('in_app', 'x')).toBe('in the app');
  });

  it('prices a broadcast as recipients times the rate, with gym overrides', () => {
    const rates = messageRates({ sms: 30, whatsapp: 'free', email: -1 });
    expect(rates.sms).toBe(30);
    expect(rates.whatsapp).toBe(80);
    expect(rates.email).toBe(10);
    expect(broadcastCostMinor(137, rates.sms)).toBe(4110);
  });

  it('works out an age on a given day', () => {
    expect(ageOn('2010-06-15', '2026-06-14')).toBe(15);
    expect(ageOn('2010-06-15', '2026-06-15')).toBe(16);
    expect(isMinor('2009-01-01', '2026-11-26')).toBe(true);
    expect(isMinor('2008-11-26', '2026-11-26')).toBe(false);
    expect(isMinor(null, '2026-11-26')).toBe(false);
  });
});
