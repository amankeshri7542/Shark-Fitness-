/* ============================================================================
   GST tax invoices — India.

   Everything here is pure. A tax invoice is a document people keep and an
   accountant files, so the rules worth guarding are the quiet ones: a GSTIN
   with a typo that still "looks right", a CGST/SGST split that no longer adds
   up to the tax the invoice actually charged, an amount in words that says a
   different number from the figures above it.

   What this module does not decide: whether a gym must register, which rate a
   supply attracts, or whether a credit note is due. Those are the owner's and
   their accountant's; this module prints what the ledger already recorded.
   ========================================================================= */

/** GST state and union territory codes: the first two digits of a GSTIN. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (before reorganisation)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** SAC for "physical well-being services such as health club and fitness
 *  centre". Memberships, class packs, personal training and day passes. */
export const SAC_FITNESS_SERVICES = '999723';

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The fifteenth character: a base-36 check over the first fourteen. */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]!);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36]!;
}

export type GstinCheck =
  | { valid: true; gstin: string; stateCode: string; stateName: string; pan: string }
  | { valid: false; reason: string };

/**
 * A GSTIN is fifteen characters: state code, the holder's PAN, an entity
 * number, a literal Z and a check character. The check character is what
 * catches the typo that still matches the pattern, which is the typo a person
 * makes.
 */
export function parseGstin(raw: string): GstinCheck {
  const gstin = raw.trim().toUpperCase();
  if (gstin.length !== 15) return { valid: false, reason: 'A GSTIN has 15 characters.' };
  if (!GSTIN_PATTERN.test(gstin)) {
    return { valid: false, reason: 'That is not the shape of a GSTIN: state code, PAN, entity number, Z, check character.' };
  }
  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATES[stateCode];
  if (!stateName) return { valid: false, reason: `${stateCode} is not a GST state code.` };
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, reason: 'The last character of that GSTIN does not match the rest. Check it for a typo.' };
  }
  return { valid: true, gstin, stateCode, stateName, pan: gstin.slice(2, 12) };
}

export interface GstSplit {
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  /** Half the rate each for CGST and SGST; the whole rate for IGST. */
  cgstRateBp: number;
  sgstRateBp: number;
  igstRateBp: number;
}

/**
 * Splits the tax a line already charged. Within a state the tax is CGST plus
 * SGST at half the rate each; across states it is IGST. The halves are taken
 * from the recorded tax, not recomputed from the base, so CGST + SGST always
 * equals what the member paid: an odd paisa goes to SGST rather than
 * appearing on neither.
 */
export function splitGst(taxMinor: number, rateBp: number, interState: boolean): GstSplit {
  if (interState) {
    return { cgstMinor: 0, sgstMinor: 0, igstMinor: taxMinor, cgstRateBp: 0, sgstRateBp: 0, igstRateBp: rateBp };
  }
  const cgstMinor = Math.floor(taxMinor / 2);
  return {
    cgstMinor,
    sgstMinor: taxMinor - cgstMinor,
    igstMinor: 0,
    cgstRateBp: rateBp / 2,
    sgstRateBp: rateBp / 2,
    igstRateBp: 0,
  };
}

/** "9%" or "2.5%" from basis points. */
export function ratePercent(rateBp: number): string {
  return `${Number((rateBp / 100).toFixed(2))}%`;
}

/**
 * The financial year an invoice date falls in, April to March: 2026-10-24 is
 * "2026-27". GST numbering must be unique within one.
 */
export function financialYear(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const tens = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Whole rupees in the Indian system: thousand, lakh, crore. */
function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;
  return [
    crore ? `${indianWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    rest ? belowThousand(rest) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The total in words, as a tax invoice states it:
 * 2_949_882 paise is "Rupees Twenty-Nine Thousand Four Hundred Ninety-Eight
 * and Eighty-Two Paise Only".
 */
export function rupeesInWords(minor: number): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;
  const sign = minor < 0 ? 'Minus ' : '';
  const rupees = `${sign}Rupees ${indianWords(whole)}`;
  return paise ? `${rupees} and ${belowHundred(paise)} Paise Only` : `${rupees} Only`;
}
