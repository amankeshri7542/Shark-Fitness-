import { and, asc, eq } from 'drizzle-orm';
import type { TaxProfile } from '@shark/contracts';
import { SAC_FITNESS_SERVICES, financialYear, formatMoney, parseGstin, ratePercent, rupeesInWords, splitGst } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Tax invoices (GST, India).

   An invoice row says what was charged. A tax invoice also says who charged
   it, under which GSTIN, from which state, to whom, and how the tax divides
   between the Centre and the State. The supplier's side is frozen when the
   invoice is raised (`invoice_tax_documents`), because the document has to
   read the same in an audit years later however the gym's settings have
   changed since.

   The member's side is not frozen. It is read from the member record each
   time, so a privacy erasure, which pseudonymises that record, also
   pseudonymises every invoice printed afterwards, as the retention policy
   promises. An append-only copy of a name and street address would have been
   the one place erasure could not reach.

   The figures are never recomputed here. Taxable value, tax and total come
   from the invoice lines as charged; CGST and SGST are a split of the tax each
   line already carries, so the document cannot disagree with the ledger.
   ========================================================================= */

/** SAC for the services a gym sells. Memberships, packs, PT and passes. */
export const FITNESS_SERVICE_CODE = SAC_FITNESS_SERVICES;

export interface TaxDocumentSnapshot {
  kind: 'gst_tax_invoice' | 'invoice';
  /** What tax is printed as: "GST", or the tenant's own word elsewhere. */
  taxLabel: string;
  supplier: {
    legalName: string;
    tradeName: string;
    address: string;
    /** Present only when it passed GSTIN validation at issuance. */
    gstin: string | null;
    /** Whatever registration number was configured, valid or not, for non-GST jurisdictions. */
    registrationNumber: string | null;
    stateCode: string | null;
    stateName: string | null;
  };
  /**
   * Always intra-state today: members are billed as unregistered persons at
   * the branch they train in, and the system records no recipient GSTIN that
   * could make a supply inter-state.
   */
  interState: boolean;
  placeOfSupply: { stateCode: string; stateName: string } | null;
  /** SAC or HSN per invoice line id; null where a line has no code. */
  lineCodes: Record<string, string | null>;
}

type TenantIdentity = Pick<typeof schema.tenants.$inferSelect, 'legalName' | 'displayName' | 'taxProfile'>;

/** The GSTIN a profile issues under, or null: a GST label, a valid number, rupees. */
function issuingGstin(taxProfile: unknown, currency: string) {
  const profile = (taxProfile ?? null) as TaxProfile | null;
  const label = profile?.label?.trim() || 'Tax';
  const number = profile?.registrationNumber?.trim();
  if (label.toUpperCase() !== 'GST' || !number || currency !== 'INR') return null;
  const gstin = parseGstin(number);
  return gstin.valid ? gstin : null;
}

export function taxDocumentFor(args: {
  tenant: TenantIdentity;
  branch: { addressLine: string; city: string };
  currency: string;
  lines: Array<{ id: string }>;
  /** The code every line carries: the fitness SAC for services, null for a shop basket. */
  lineCode: string | null;
}): TaxDocumentSnapshot {
  const profile = (args.tenant.taxProfile ?? null) as TaxProfile | null;
  const taxLabel = profile?.label?.trim() || 'Tax';
  const gst = issuingGstin(profile, args.currency);
  const state = gst ? { stateCode: gst.stateCode, stateName: gst.stateName } : null;

  return {
    kind: gst ? 'gst_tax_invoice' : 'invoice',
    taxLabel,
    supplier: {
      legalName: args.tenant.legalName,
      tradeName: args.tenant.displayName,
      address: `${args.branch.addressLine}, ${args.branch.city}`,
      gstin: gst?.gstin ?? null,
      registrationNumber: profile?.registrationNumber?.trim() || null,
      stateCode: state?.stateCode ?? null,
      stateName: state?.stateName ?? null,
    },
    interState: false,
    placeOfSupply: state,
    lineCodes: Object.fromEntries(args.lines.map((line) => [line.id, args.lineCode])),
  };
}

/**
 * Freezes the tax document for an invoice that has just been raised. Call it
 * in the transaction that inserted the invoice and its lines.
 */
export function recordTaxDocument(tenantId: string, invoiceId: string, lineCode: string | null): void {
  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.id, invoiceId))).get();
  if (!invoice) throw notFound('That invoice');
  const { tenant, branch } = identityFor(tenantId, invoice);
  const document = taxDocumentFor({
    tenant,
    branch,
    currency: invoice.currency,
    lines: db.select({ id: schema.invoiceLines.id }).from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).all(),
    lineCode,
  });
  db.insert(schema.invoiceTaxDocuments)
    .values({
      invoiceId,
      tenantId,
      kind: document.kind,
      gstin: document.supplier.gstin,
      document: document as unknown as Record<string, unknown>,
      createdAt: now(),
    })
    .run();
}

function identityFor(tenantId: string, invoice: typeof schema.invoices.$inferSelect) {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()!;
  const branch = db.select().from(schema.branches).where(and(eq(schema.branches.tenantId, tenantId), eq(schema.branches.id, invoice.branchId))).get()!;
  const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, tenantId), eq(schema.members.id, invoice.memberId))).get()!;
  return { tenant, branch, member };
}

/** An invoice raised before tax documents existed: today's supplier details,
 *  printed as a plain invoice, because nothing records what it was issued under. */
function legacyDocument(
  identity: ReturnType<typeof identityFor>,
  invoice: typeof schema.invoices.$inferSelect,
  lines: Array<{ id: string }>,
): TaxDocumentSnapshot {
  const today = taxDocumentFor({
    tenant: identity.tenant,
    branch: identity.branch,
    currency: invoice.currency,
    lines,
    lineCode: invoice.refType === 'pos_order' ? null : FITNESS_SERVICE_CODE,
  });
  return { ...today, kind: 'invoice', supplier: { ...today.supplier, gstin: null, stateCode: null, stateName: null }, placeOfSupply: null };
}

/* ——— Reading ————————————————————————————————————————— */

/**
 * What an invoice prints as, for a link label, without building the document.
 * One raised before tax documents were recorded is a plain invoice: nothing
 * records the GSTIN it was raised under, so it is never re-issued as an
 * original tax invoice under today's.
 */
export function taxDocumentKind(tenantId: string, invoice: { id: string }): { kind: TaxDocumentSnapshot['kind']; title: string } {
  const stored = db
    .select({ kind: schema.invoiceTaxDocuments.kind })
    .from(schema.invoiceTaxDocuments)
    .where(and(eq(schema.invoiceTaxDocuments.tenantId, tenantId), eq(schema.invoiceTaxDocuments.invoiceId, invoice.id)))
    .get();
  const kind = (stored?.kind as TaxDocumentSnapshot['kind'] | undefined) ?? 'invoice';
  return { kind, title: kind === 'gst_tax_invoice' ? 'Tax invoice' : 'Invoice' };
}

export interface TaxInvoiceLine {
  description: string;
  code: string | null;
  quantity: number;
  taxableMinor: number;
  rateLabel: string;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  cgstRateLabel: string;
  sgstRateLabel: string;
  igstRateLabel: string;
  totalMinor: number;
}

export interface TaxInvoiceRecord {
  invoice: typeof schema.invoices.$inferSelect;
  document: TaxDocumentSnapshot;
  /** Read from the member record now, so erasure reaches it. */
  recipient: { name: string; memberNo: string; address: string | null };
  /** True for an invoice raised before tax documents were recorded. */
  legacy: boolean;
  title: string;
  financialYear: string;
  lines: TaxInvoiceLine[];
  totals: { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; taxMinor: number; totalMinor: number };
  inWords: string;
  paidMinor: number;
  refundedMinor: number;
  dueMinor: number;
}

export function taxInvoiceRecord(tenantId: string, invoiceId: string): TaxInvoiceRecord {
  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.id, invoiceId))).get();
  if (!invoice) throw notFound('That invoice');
  const lines = db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id)).orderBy(asc(schema.invoiceLines.id)).all();
  const stored = db.select().from(schema.invoiceTaxDocuments).where(and(eq(schema.invoiceTaxDocuments.tenantId, tenantId), eq(schema.invoiceTaxDocuments.invoiceId, invoice.id))).get();
  const legacy = !stored;
  const identity = identityFor(tenantId, invoice);
  const document = stored ? (stored.document as unknown as TaxDocumentSnapshot) : legacyDocument(identity, invoice, lines);
  const recipient = {
    name: `${identity.member.firstName} ${identity.member.lastName}`.trim(),
    memberNo: identity.member.memberNo,
    address: identity.member.addressLine?.trim() || null,
  };

  const rows: TaxInvoiceLine[] = lines.map((line) => {
    const split = splitGst(line.taxMinor, line.taxRateBp, document.interState);
    // A shop basket charged to an account is one line carrying the tax of
    // items at different rates; it has a tax amount and no single rate.
    const mixed = line.taxRateBp === 0 && line.taxMinor > 0;
    return {
      description: line.description,
      code: document.lineCodes[line.id] ?? null,
      quantity: line.quantity,
      taxableMinor: line.totalMinor - line.taxMinor,
      rateLabel: mixed ? 'mixed' : ratePercent(line.taxRateBp),
      cgstMinor: split.cgstMinor,
      sgstMinor: split.sgstMinor,
      igstMinor: split.igstMinor,
      cgstRateLabel: mixed ? 'mixed' : ratePercent(split.cgstRateBp),
      sgstRateLabel: mixed ? 'mixed' : ratePercent(split.sgstRateBp),
      igstRateLabel: mixed ? 'mixed' : ratePercent(split.igstRateBp),
      totalMinor: line.totalMinor,
    };
  });

  const sum = (pick: (row: TaxInvoiceLine) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const totals = {
    taxableMinor: sum((row) => row.taxableMinor),
    cgstMinor: sum((row) => row.cgstMinor),
    sgstMinor: sum((row) => row.sgstMinor),
    igstMinor: sum((row) => row.igstMinor),
    taxMinor: invoice.taxMinor,
    totalMinor: invoice.totalMinor,
  };

  return {
    invoice,
    document,
    recipient,
    legacy,
    title: document.kind === 'gst_tax_invoice' ? 'Tax invoice' : 'Invoice',
    financialYear: financialYear(invoice.issuedOn),
    lines: rows,
    totals,
    inWords: invoice.currency === 'INR' ? rupeesInWords(invoice.totalMinor) : '',
    paidMinor: invoice.paidMinor,
    refundedMinor: invoice.refundedMinor,
    dueMinor: invoice.voided ? 0 : Math.max(invoice.totalMinor - invoice.paidMinor, 0),
  };
}

/** `tax-invoice-SF-2026-00042.txt`, or `invoice-…` where it is not a tax invoice. */
export function taxInvoiceFilename(title: string, number: string): string {
  return `${title === 'Tax invoice' ? 'tax-invoice' : 'invoice'}-${number.replace(/[^a-zA-Z0-9_-]/g, '')}.txt`;
}

/** Rupees always to the paisa on a tax invoice: "₹24,999.00", never "₹24,999". */
function money(minor: number, currency: string): string {
  if (currency !== 'INR') return formatMoney(minor, currency);
  return `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const clean = (value: string) => value.replace(/[\r\n\t]/g, ' ');

/** Notes the document must carry, in the order a reader needs them. */
function notices(record: TaxInvoiceRecord): string[] {
  const { invoice, document } = record;
  return [
    invoice.voided ? `CANCELLED${invoice.voidReason ? `: ${clean(invoice.voidReason)}` : ''}` : '',
    record.legacy
      ? 'Raised before tax-invoice details were recorded, so it is not issued as a GST tax invoice. Supplier details shown are current, not as at issuance.'
      : document.kind === 'invoice' && invoice.currency === 'INR'
        ? 'Not a GST tax invoice: no valid GSTIN was configured when this invoice was raised.'
        : '',
    invoice.refundedMinor > 0
      ? 'Refunds are recorded against payments. This system does not issue GST credit notes; raise one in your accounts if a refund reduces the taxable value.'
      : '',
  ].filter(Boolean);
}

export function taxInvoiceText(record: TaxInvoiceRecord): string {
  const { invoice, document } = record;
  const cur = invoice.currency;
  const gst = document.kind === 'gst_tax_invoice';
  const state = (s: { stateName: string; stateCode: string } | null) => (s ? `${s.stateName} (${s.stateCode})` : 'Not stated');
  return [
    `${record.title.toUpperCase()}${gst ? ' — Original for recipient' : ''}`,
    ...notices(record),
    '',
    `Supplier: ${clean(document.supplier.legalName)}${document.supplier.tradeName !== document.supplier.legalName ? ` (trading as ${clean(document.supplier.tradeName)})` : ''}`,
    `Address: ${clean(document.supplier.address)}`,
    gst
      ? `GSTIN: ${document.supplier.gstin}; State: ${document.supplier.stateName} (${document.supplier.stateCode})`
      : document.supplier.registrationNumber ? `Registration: ${clean(document.supplier.registrationNumber)}` : 'Registration: none recorded',
    '',
    `Invoice number: ${invoice.number}`,
    `Invoice date: ${invoice.issuedOn} (financial year ${record.financialYear})`,
    `Due: ${invoice.dueOn}`,
    `Billed to: ${clean(record.recipient.name)} (${clean(record.recipient.memberNo)})`,
    `Address: ${record.recipient.address ? clean(record.recipient.address) : 'Not recorded'}`,
    ...(gst ? [`Place of supply: ${state(document.placeOfSupply)}`, 'Tax payable on reverse charge: No'] : []),
    '',
    ...record.lines.map((line, i) => {
      const tax = gst
        ? document.interState
          ? `IGST ${line.igstRateLabel} ${money(line.igstMinor, cur)}`
          : `CGST ${line.cgstRateLabel} ${money(line.cgstMinor, cur)}; SGST ${line.sgstRateLabel} ${money(line.sgstMinor, cur)}`
        : `${document.taxLabel} ${line.rateLabel} ${money(line.cgstMinor + line.sgstMinor + line.igstMinor, cur)}`;
      return `${i + 1}. ${clean(line.description)}${line.code ? `; SAC ${line.code}` : ''}; quantity ${line.quantity}; taxable ${money(line.taxableMinor, cur)}; ${tax}; total ${money(line.totalMinor, cur)}`;
    }),
    '',
    `Taxable value: ${money(record.totals.taxableMinor, cur)}`,
    ...(gst
      ? document.interState
        ? [`IGST: ${money(record.totals.igstMinor, cur)}`]
        : [`CGST: ${money(record.totals.cgstMinor, cur)}`, `SGST: ${money(record.totals.sgstMinor, cur)}`]
      : [`${document.taxLabel}: ${money(record.totals.taxMinor, cur)}`]),
    `Invoice total: ${money(record.totals.totalMinor, cur)}`,
    ...(record.inWords ? [`In words: ${record.inWords}`] : []),
    '',
    `Paid: ${money(record.paidMinor, cur)}`,
    `Refunded: ${money(record.refundedMinor, cur)}`,
    `Balance due: ${money(record.dueMinor, cur)}`,
    '',
    `For ${clean(document.supplier.legalName)}: authorised signatory`,
    'Computer-generated from the gym ledger.',
  ].join('\n');
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function taxInvoiceHtml(record: TaxInvoiceRecord): string {
  const { invoice, document } = record;
  const cur = invoice.currency;
  const e = escapeHtml;
  const gst = document.kind === 'gst_tax_invoice';
  const split = gst && !document.interState;
  const taxHeads = gst ? (document.interState ? ['IGST'] : ['CGST', 'SGST']) : [document.taxLabel];
  const lineTax = (line: TaxInvoiceLine): Array<[string, number]> =>
    gst
      ? document.interState
        ? [[line.igstRateLabel, line.igstMinor]]
        : [[line.cgstRateLabel, line.cgstMinor], [line.sgstRateLabel, line.sgstMinor]]
      : [[line.rateLabel, line.cgstMinor + line.sgstMinor + line.igstMinor]];

  const rows = record.lines
    .map((line, i) => {
      const taxCells = lineTax(line).map(([rate, amount]) => `<td class="n">${e(rate)}</td><td class="n">${e(money(amount, cur))}</td>`).join('');
      return `<tr><td>${i + 1}</td><td>${e(line.description)}</td><td>${e(line.code ?? '—')}</td><td class="n">${line.quantity}</td><td class="n">${e(money(line.taxableMinor, cur))}</td>${taxCells}<td class="n">${e(money(line.totalMinor, cur))}</td></tr>`;
    })
    .join('');
  const taxTotals = gst
    ? document.interState
      ? [['IGST', record.totals.igstMinor]]
      : [['CGST', record.totals.cgstMinor], ['SGST', record.totals.sgstMinor]]
    : [[document.taxLabel, record.totals.taxMinor]];
  const party = (label: string, lines: string[]) => `<div class="party"><h2>${e(label)}</h2>${lines.map((l) => `<p>${e(l)}</p>`).join('')}</div>`;

  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(`${record.title} ${invoice.number}`)}</title>
<style>
body{max-width:900px;margin:24px auto;padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}
h1{font-size:22px;margin:0 0 4px;letter-spacing:.04em;text-transform:uppercase}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#555;margin:0 0 4px}
p{margin:0}.meta{display:flex;flex-wrap:wrap;gap:4px 24px;margin:8px 0 16px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0}
.party{border:1px solid #ccc;padding:10px}.notice{border:1px solid #b45309;background:#fff7ed;padding:8px 10px;margin:8px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-size:12px}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.totals{margin:12px 0 0 auto;min-width:280px;width:auto}
.words{margin:8px 0}.sign{margin-top:32px;text-align:right}.help{background:#eee;padding:10px;margin-bottom:12px}
@media (max-width:600px){.parties{grid-template-columns:1fr}}@media print{body{margin:0;max-width:none}.help{display:none}}
</style><body>
<p class="help">Use your browser's Print command to print this ${e(record.title.toLowerCase())} or save it as a PDF.</p>
<h1>${e(record.title)}</h1>${gst ? '<p>Original for recipient</p>' : ''}
${notices(record).map((n) => `<p class="notice">${e(n)}</p>`).join('')}
<div class="meta"><p><strong>Invoice number</strong> ${e(invoice.number)}</p><p><strong>Date</strong> ${e(invoice.issuedOn)}</p><p><strong>Financial year</strong> ${e(record.financialYear)}</p><p><strong>Due</strong> ${e(invoice.dueOn)}</p></div>
<div class="parties">
${party('Supplier', [
  document.supplier.legalName,
  ...(document.supplier.tradeName !== document.supplier.legalName ? [`Trading as ${document.supplier.tradeName}`] : []),
  document.supplier.address,
  gst
    ? `GSTIN ${document.supplier.gstin} · ${document.supplier.stateName} (${document.supplier.stateCode})`
    : document.supplier.registrationNumber ? `Registration ${document.supplier.registrationNumber}` : 'No registration recorded',
])}
${party('Billed to', [
  record.recipient.name,
  `Member ${record.recipient.memberNo}`,
  record.recipient.address ?? 'Address not recorded',
  ...(gst ? [`Place of supply: ${document.placeOfSupply ? `${document.placeOfSupply.stateName} (${document.placeOfSupply.stateCode})` : 'Not stated'}`, 'Reverse charge: No'] : []),
])}
</div>
<div class="scroll"><table><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Taxable value</th>${taxHeads.map((h) => `<th class="n">${e(h)} rate</th><th class="n">${e(h)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
<table class="totals"><tbody>
<tr><th>Taxable value</th><td class="n">${e(money(record.totals.taxableMinor, cur))}</td></tr>
${taxTotals.map(([label, amount]) => `<tr><th>${e(String(label))}</th><td class="n">${e(money(Number(amount), cur))}</td></tr>`).join('')}
<tr><th>Invoice total</th><td class="n"><strong>${e(money(record.totals.totalMinor, cur))}</strong></td></tr>
<tr><th>Paid</th><td class="n">${e(money(record.paidMinor, cur))}</td></tr>
${record.refundedMinor > 0 ? `<tr><th>Refunded</th><td class="n">${e(money(record.refundedMinor, cur))}</td></tr>` : ''}
<tr><th>Balance due</th><td class="n">${e(money(record.dueMinor, cur))}</td></tr>
</tbody></table>
${record.inWords ? `<p class="words"><strong>In words:</strong> ${e(record.inWords)}</p>` : ''}
<p class="sign">For ${e(document.supplier.legalName)}<br><br>Authorised signatory</p>
<p>Computer-generated from the gym ledger${split ? '. CGST and SGST are each half of the tax charged on the line' : ''}.</p>
</body></html>`;
}
