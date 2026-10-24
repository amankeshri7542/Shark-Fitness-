import { describe, expect, it } from 'vitest';
import { financialYear, parseGstin, ratePercent, rupeesInWords, splitGst } from '../gst.js';
import { taxOn } from '../money.js';

/* ============================================================================
   GST tax invoices.

   A tax invoice is filed by somebody else. The failures worth guarding are the
   ones that still look right on the page: a GSTIN off by one character, a
   CGST and SGST that no longer add up to the tax charged, an amount in words
   that names a different number from the figure beside it.
   ========================================================================= */

describe('parseGstin', () => {
  it('accepts a real GSTIN and reads its state from the first two digits', () => {
    const result = parseGstin('27AAPFU0939F1ZV');
    expect(result).toEqual({ valid: true, gstin: '27AAPFU0939F1ZV', stateCode: '27', stateName: 'Maharashtra', pan: 'AAPFU0939F' });
  });

  it('normalises case and stray spaces, which is how people paste them', () => {
    expect(parseGstin('  29abcde1234f1zw ')).toMatchObject({ valid: true, gstin: '29ABCDE1234F1ZW', stateName: 'Karnataka' });
  });

  it('refuses a typo that keeps the right shape, by its check character', () => {
    const result = parseGstin('29ABCDE1234F1Z5');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match the rest/);
  });

  it('refuses the wrong length, the wrong shape and a state code that does not exist', () => {
    expect(parseGstin('29ABCDE1234F1Z').valid).toBe(false);
    expect(parseGstin('29ABCDE12341F1ZW').valid).toBe(false);
    expect(parseGstin('2AABCDE1234F1ZW').valid).toBe(false);
    const unknownState = parseGstin('00ABCDE1234F1ZW');
    expect(unknownState.valid).toBe(false);
    if (!unknownState.valid) expect(unknownState.reason).toMatch(/00 is not a GST state code/);
  });
});

describe('splitGst', () => {
  it('splits intra-state tax into equal CGST and SGST at half the rate', () => {
    expect(splitGst(54_000, 1800, false)).toEqual({
      cgstMinor: 27_000, sgstMinor: 27_000, igstMinor: 0, cgstRateBp: 900, sgstRateBp: 900, igstRateBp: 0,
    });
  });

  it('never loses or invents a paisa: the halves add up to the tax charged', () => {
    for (const base of [299_900, 249_900, 2_499_900, 79_900, 1]) {
      const tax = taxOn(base, 1800);
      const split = splitGst(tax, 1800, false);
      expect(split.cgstMinor + split.sgstMinor).toBe(tax);
      expect(Math.abs(split.cgstMinor - split.sgstMinor)).toBeLessThanOrEqual(1);
    }
  });

  it('charges the whole rate as IGST across states', () => {
    expect(splitGst(53_982, 1800, true)).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 53_982, igstRateBp: 1800 });
  });

  it('prints rates the way an invoice does', () => {
    expect(ratePercent(900)).toBe('9%');
    expect(ratePercent(250)).toBe('2.5%');
    expect(ratePercent(1800)).toBe('18%');
  });
});

describe('rupeesInWords', () => {
  it('states rupees and paise', () => {
    expect(rupeesInWords(2_949_882)).toBe('Rupees Twenty-Nine Thousand Four Hundred Ninety-Eight and Eighty-Two Paise Only');
  });

  it('counts in lakh and crore, not millions', () => {
    expect(rupeesInWords(12_500_000)).toBe('Rupees One Lakh Twenty-Five Thousand Only');
    expect(rupeesInWords(1_23_45_678_00)).toBe('Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Only');
  });

  it('handles the edges: zero, a single rupee, paise alone', () => {
    expect(rupeesInWords(0)).toBe('Rupees Zero Only');
    expect(rupeesInWords(100)).toBe('Rupees One Only');
    expect(rupeesInWords(5)).toBe('Rupees Zero and Five Paise Only');
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2026-10-24')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2026-03-31')).toBe('2025-26');
  });

  it('carries the century across 2099-2100', () => {
    expect(financialYear('2099-06-01')).toBe('2099-00');
  });
});
