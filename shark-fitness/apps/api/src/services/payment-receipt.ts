import { and, eq } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';

export function receiptRecord(tenantId: string, paymentId: string) {
  const payment = db.select().from(schema.payments).where(and(eq(schema.payments.tenantId, tenantId), eq(schema.payments.id, paymentId))).get();
  if (!payment?.invoiceId) throw notFound('That payment');
  if (payment.state !== 'succeeded') throw conflict('A receipt is available only for a successful payment.');
  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.id, payment.invoiceId))).get();
  if (!invoice) throw notFound('That invoice');
  const snapshot = db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.paymentId, payment.id)).get();
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()!;
  const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, tenantId), eq(schema.members.id, payment.memberId))).get()!;
  const refunds = db.select().from(schema.refunds).where(and(eq(schema.refunds.tenantId, tenantId), eq(schema.refunds.paymentId, payment.id), eq(schema.refunds.state, 'succeeded'))).orderBy(schema.refunds.createdAt, schema.refunds.id).all();
  const lines = db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id)).all();
  const refunded = refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  const clean = (value: string) => value.replace(/[\r\n\t]/g, ' ');
  const content = [
    'PAYMENT ACKNOWLEDGEMENT — not a tax invoice',
    `Receipt: ${payment.id}`,
    `Gym: ${clean(snapshot?.issuerName ?? tenant.legalName)}`,
    `Member: ${clean(snapshot?.memberName ?? `${member.firstName} ${member.lastName}`)} (${clean(snapshot?.memberNo ?? member.memberNo)})`,
    snapshot ? 'Identity: recorded at payment issuance.' : 'Legacy record: identity shown is current; issuance identity was not captured.',
    `Invoice: ${invoice.number} (${invoice.id})`,
    `Invoice issued: ${invoice.issuedOn}; due: ${invoice.dueOn}`,
    ...lines.map((line) => `Item: ${clean(line.description)}; quantity ${line.quantity}; ${formatMoney(line.totalMinor, invoice.currency)}`),
    `Currency: ${payment.currency}`,
    `Payment date (UTC): ${new Date(payment.settledAt ?? payment.createdAt).toISOString()}`,
    `Method: ${clean(payment.method)}`,
    `Amount: ${formatMoney(payment.amountMinor, payment.currency)}`,
    `Reference: ${clean(payment.providerRef ?? 'Not provided')}`,
    `Recorded by: ${clean(payment.recordedByName ?? payment.provider ?? 'System')}`,
    `Refunded: ${formatMoney(refunded, payment.currency)}`,
    `Net received: ${formatMoney(payment.amountMinor - refunded, payment.currency)}`,
    ...refunds.map((refund) => `Refund ${refund.id} (${new Date(refund.createdAt).toISOString()}): ${formatMoney(refund.amountMinor, payment.currency)} — ${clean(refund.reason)}`),
    '',
    `Invoice total: ${formatMoney(invoice.totalMinor, invoice.currency)}`,
    `Invoice gross payments: ${formatMoney(invoice.paidMinor, invoice.currency)}`,
    `Invoice refunds: ${formatMoney(invoice.refundedMinor, invoice.currency)}`,
    `Invoice net retained: ${formatMoney(invoice.paidMinor - invoice.refundedMinor, invoice.currency)}`,
    `Unpaid principal: ${formatMoney(invoice.voided ? 0 : Math.max(invoice.totalMinor - invoice.paidMinor, 0), invoice.currency)}`,
    '',
    'Refunds and invoice balances reflect the current ledger; original payment facts remain unchanged.',
    'This acknowledgement records the gym ledger. It does not independently verify bank settlement or certify fiscal suitability.',
  ].join('\n');
  return { payment, invoice, content };
}

export function receiptHtml(content: string): string {
  const escaped = content.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment acknowledgement</title><style>body{max-width:760px;margin:32px auto;padding:16px;font:16px/1.6 system-ui;color:#111}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.help{background:#eee;padding:12px}@media print{body{margin:0;max-width:none}.help{display:none}}</style><body><p class="help">Use your browser's Print command to print or save as PDF.</p><pre>${escaped}</pre></body></html>`;
}
