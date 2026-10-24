import { describe, expect, it } from 'vitest';
import {
  TRIGGERS,
  dedupeKey,
  decideSend,
  estimateCostMinor,
  inQuietHours,
  isMetered,
  matches,
  renderTemplate,
  templateVariables,
  triggerSpec,
  validateConditions,
  type SendFacts,
} from '../automation.js';

/* ============================================================================
   Automation rules — PF-COMM-003…006.

   Every path in this module is a reason *not* to send. An automation that
   fires when it should not is a member who unsubscribes; one that stays quiet
   is a follow-up somebody makes by hand. These tests are mostly about the
   first kind.
   ========================================================================= */

describe('templates (PF-COMM-003)', () => {
  it('fills what it can', () => {
    const out = renderTemplate('Hi {{firstName}}, your plan ends {{endsOn}}.', { firstName: 'Rhea', endsOn: '12 Sept' });
    expect(out.text).toBe('Hi Rhea, your plan ends 12 Sept.');
    expect(out.missing).toEqual([]);
  });

  it('never renders a missing value as an empty string', () => {
    // "Your membership ends on ." is worse than no message at all.
    const out = renderTemplate('Your plan ends {{endsOn}}.', { endsOn: null });
    expect(out.missing).toEqual(['endsOn']);
    expect(out.text).not.toBe('Your plan ends .');
    expect(out.text).toContain('{{endsOn}}');
  });

  it('treats an empty string as missing, because it reads the same to a member', () => {
    expect(renderTemplate('Hi {{firstName}}', { firstName: '' }).missing).toEqual(['firstName']);
  });

  it('names a variable the trigger does not provide', () => {
    const out = renderTemplate('Hi {{firstName}}, {{invoiceTotal}}', { firstName: 'Rhea' }, ['firstName', 'endsOn']);
    expect(out.unknown).toEqual(['invoiceTotal']);
  });

  it('tolerates whitespace inside the braces and reports each name once', () => {
    const out = renderTemplate('{{ firstName }} {{firstName}} {{endsOn}}', { endsOn: '1 Jan' });
    expect(out.missing).toEqual(['firstName']);
  });

  it('lists the variables a template uses, in the order they appear', () => {
    expect(templateVariables('{{endsOn}} then {{firstName}} then {{endsOn}}')).toEqual(['endsOn', 'firstName']);
  });

  it('leaves a body with no variables alone', () => {
    const out = renderTemplate('The gym is shut on Sunday.', {});
    expect(out).toEqual({ text: 'The gym is shut on Sunday.', missing: [], unknown: [] });
  });
});

describe('triggers and conditions (PF-COMM-004)', () => {
  it('offers a window and a variable set for every trigger', () => {
    for (const spec of TRIGGERS) {
      expect(spec.variables.length).toBeGreaterThan(0);
      expect(['once_ever', 'per_day', 'per_occurrence']).toContain(spec.window);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it('refuses a condition on a field the trigger does not have', () => {
    // A rule written against a field that does not exist is a rule that
    // silently never matches, which is the worst way for it to fail.
    const outcome = validateConditions('member.joined', [{ field: 'daysSinceVisit', op: 'gt', value: '30' }]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/nothing called daysSinceVisit/);
  });

  it('accepts a condition the trigger does provide', () => {
    expect(validateConditions('member.inactive', [{ field: 'daysSinceVisit', op: 'gte', value: '21' }]).ok).toBe(true);
  });

  it('refuses an unknown comparison', () => {
    expect(validateConditions('member.inactive', [{ field: 'daysSinceVisit', op: 'roughly', value: '21' }]).ok).toBe(false);
  });

  it('narrows as conditions are added, never widens', () => {
    const facts = { daysSinceVisit: 30, branchId: 'br_kor' };
    expect(matches([{ field: 'daysSinceVisit', op: 'gte', value: '21' }], facts)).toBe(true);
    expect(
      matches(
        [
          { field: 'daysSinceVisit', op: 'gte', value: '21' },
          { field: 'branchId', op: 'eq', value: 'br_ind' },
        ],
        facts,
      ),
    ).toBe(false);
  });

  it('matches everyone when there are no conditions', () => {
    expect(matches([], { anything: 1 })).toBe(true);
  });

  it('never matches on a fact the subject does not have', () => {
    expect(matches([{ field: 'daysSinceVisit', op: 'gte', value: '1' }], { daysSinceVisit: null })).toBe(false);
  });

  it('compares numbers as numbers, not as text', () => {
    // '9' > '30' as strings. A member who has been away nine days is not
    // overdue for a "we miss you" written for thirty.
    expect(matches([{ field: 'daysSinceVisit', op: 'gt', value: '30' }], { daysSinceVisit: 9 })).toBe(false);
    expect(matches([{ field: 'daysSinceVisit', op: 'gt', value: '30' }], { daysSinceVisit: 31 })).toBe(true);
  });
});

describe('quiet hours', () => {
  it('spans midnight, which is the normal shape', () => {
    // 21:00–08:00 is the default. A naive from<=now<to is false all night,
    // which is exactly when it needs to be true.
    expect(inQuietHours('21:00', '08:00', 23 * 60)).toBe(true);
    expect(inQuietHours('21:00', '08:00', 2 * 60)).toBe(true);
    expect(inQuietHours('21:00', '08:00', 12 * 60)).toBe(false);
  });

  it('handles a window inside one day', () => {
    expect(inQuietHours('13:00', '14:00', 13 * 60 + 30)).toBe(true);
    expect(inQuietHours('13:00', '14:00', 14 * 60)).toBe(false);
  });

  it('is exclusive at the end and inclusive at the start', () => {
    expect(inQuietHours('21:00', '08:00', 21 * 60)).toBe(true);
    expect(inQuietHours('21:00', '08:00', 8 * 60)).toBe(false);
  });

  it('treats an empty window as no quiet hours at all', () => {
    expect(inQuietHours('08:00', '08:00', 8 * 60)).toBe(false);
  });
});

describe('deduplication (PF-COMM-004)', () => {
  it('keys a welcome once ever, whatever the day', () => {
    expect(dedupeKey('member.joined', 'mbr_1', { day: '2026-08-23' })).toBe(
      dedupeKey('member.joined', 'mbr_1', { day: '2027-01-01' }),
    );
  });

  it('keys an expiry nudge once a day', () => {
    expect(dedupeKey('membership.expiring', 'mbr_1', { day: '2026-08-23' })).not.toBe(
      dedupeKey('membership.expiring', 'mbr_1', { day: '2026-08-24' }),
    );
  });

  it('keys a class reminder per class, so two classes send two reminders', () => {
    // Too wide a key here means a member never hears about the second class.
    expect(dedupeKey('class.tomorrow', 'mbr_1', { occurrenceId: 'ses_a' })).not.toBe(
      dedupeKey('class.tomorrow', 'mbr_1', { occurrenceId: 'ses_b' }),
    );
  });

  it('keeps two members apart on the same event', () => {
    expect(dedupeKey('member.joined', 'mbr_1', {})).not.toBe(dedupeKey('member.joined', 'mbr_2', {}));
  });
});

describe('the send decision', () => {
  const base: SendFacts = {
    automationState: 'active',
    channel: 'sms',
    hasConsent: true,
    hasDestination: true,
    branchTrades: true,
    inQuietHours: false,
    alreadySent: false,
    quotaRemaining: 100,
    missingVariables: [],
    unknownVariables: [],
  };

  it('sends when nothing stands in the way', () => {
    expect(decideSend(base)).toEqual({ send: true, code: null, reason: '' });
  });

  it('refuses without consent, and says so in the member’s terms', () => {
    const out = decideSend({ ...base, hasConsent: false });
    expect(out.code).toBe('no_consent');
    expect(out.reason).toMatch(/has not agreed to sms/);
  });

  it('reports consent before it reports a missing variable', () => {
    // The reader of the run log needs the real reason, not the first one a
    // naive order happened to hit. This member was never going to be messaged.
    const out = decideSend({ ...base, hasConsent: false, missingVariables: ['endsOn'] });
    expect(out.code).toBe('no_consent');
  });

  it('refuses a paused automation before anything else', () => {
    expect(decideSend({ ...base, automationState: 'paused', hasConsent: false }).code).toBe('automation_paused');
  });

  it('refuses when the member’s branch is not trading', () => {
    expect(decideSend({ ...base, branchTrades: false }).code).toBe('branch_not_trading');
  });

  it('refuses when the destination belongs to an account that cannot receive messages', () => {
    const out = decideSend({ ...base, accountActive: false });
    expect(out.code).toBe('account_unavailable');
    expect(out.reason).toMatch(/account is not active/i);
  });

  it('reports an unavailable provider instead of pretending an external message is held', () => {
    expect(decideSend({ ...base, channel: 'sms', providerAvailable: false, inQuietHours: true }).code)
      .toBe('provider_unavailable');
  });

  it('refuses a repeat of an event already sent', () => {
    expect(decideSend({ ...base, alreadySent: true }).code).toBe('already_sent');
  });

  it('refuses rather than send a template it could not fill', () => {
    const out = decideSend({ ...base, missingVariables: ['endsOn'] });
    expect(out.code).toBe('missing_variables');
    expect(out.reason).toMatch(/endsOn/);
  });

  it('refuses a template using a variable this trigger never provides', () => {
    expect(decideSend({ ...base, unknownVariables: ['invoiceTotal'] }).code).toBe('unknown_variables');
  });

  it('holds during quiet hours rather than dropping', () => {
    const out = decideSend({ ...base, inQuietHours: true });
    expect(out.code).toBe('quiet_hours');
    expect(out.reason).toMatch(/Held until/);
  });

  it('refuses once the gym’s allowance is used up', () => {
    expect(decideSend({ ...base, quotaRemaining: 0 }).code).toBe('quota_exhausted');
  });

  it('ignores quota entirely on an unmetered channel', () => {
    expect(decideSend({ ...base, channel: 'in_app', quotaRemaining: null }).send).toBe(true);
  });
});

describe('cost (PF-COMM-006)', () => {
  it('charges for the metered channels and nothing for the rest', () => {
    expect(estimateCostMinor('sms', 400)).toBe(10_000);
    expect(estimateCostMinor('whatsapp', 10)).toBe(400);
    expect(estimateCostMinor('in_app', 5000)).toBe(0);
    expect(estimateCostMinor('email', 5000)).toBe(0);
  });

  it('knows which channels cost money', () => {
    expect(isMetered('sms')).toBe(true);
    expect(isMetered('push')).toBe(false);
  });

  it('costs nothing for nobody', () => {
    expect(estimateCostMinor('sms', 0)).toBe(0);
  });
});

describe('trigger lookup', () => {
  it('finds a known trigger and rejects an invented one', () => {
    expect(triggerSpec('member.joined')?.window).toBe('once_ever');
    expect(triggerSpec('member.abducted')).toBeUndefined();
  });
});
