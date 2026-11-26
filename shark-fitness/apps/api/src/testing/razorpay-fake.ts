import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

/**
 * A local stand-in for Razorpay's REST API, for integration tests and the E2E
 * harness. It never reaches the internet, and anything it is asked that the
 * adapter has no business asking is recorded in `unexpected` so a test can
 * fail on it.
 *
 * Shapes follow Razorpay's API reference (Orders, Payments, Refunds, Payment
 * Links). It is deliberately small: enough behaviour to exercise the adapter's
 * paths (capture of authorized payments only, refund bounds and idempotency,
 * payment-link creation) and controls for faults (`fault`).
 */

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Json | null;
}

export interface FakeRazorpay {
  /** e.g. http://127.0.0.1:18150/v1 */
  baseUrl: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  requests: RecordedRequest[];
  unexpected: RecordedRequest[];
  orders: Map<string, Json>;
  payments: Map<string, Json>;
  refunds: Map<string, Json>;
  links: Map<string, Json>;
  /** Make the next matching request hang (timeout) or fail with a status. */
  fault(match: { method: string; path: RegExp }, behaviour: { hangMs: number } | { status: number; error?: Json }, times?: number): void;
  /** A payment on an order, as if the member paid in Checkout. */
  pay(orderId: string, options?: { status?: 'created' | 'authorized' | 'captured' | 'failed'; amount?: number; currency?: string; method?: string }): Json;
  /** A payment made through a payment link. */
  payLink(linkId: string, options?: { status?: 'captured' | 'authorized'; amount?: number }): { payment: Json; order: Json };
  checkoutSignature(orderId: string, paymentId: string): string;
  close(): Promise<void>;
}

const randomId = (prefix: string) => `${prefix}_${randomBytes(7).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x')}`;
const seconds = () => Math.floor(Date.now() / 1000);

export async function startFakeRazorpay(options: { port?: number; keyId?: string; keySecret?: string; webhookSecret?: string } = {}): Promise<FakeRazorpay> {
  const keyId = options.keyId ?? `rzp_test_${randomBytes(7).toString('hex')}`;
  const keySecret = options.keySecret ?? randomBytes(18).toString('base64url');
  const webhookSecret = options.webhookSecret ?? randomBytes(18).toString('base64url');
  const expectedAuth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const orders = new Map<string, Json>();
  const payments = new Map<string, Json>();
  const refunds = new Map<string, Json>();
  const refundKeys = new Map<string, string>();
  const links = new Map<string, Json>();
  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];
  const faults: Array<{ method: string; path: RegExp; behaviour: { hangMs: number } | { status: number; error?: Json }; times: number }> = [];

  const error = (res: ServerResponse, status: number, description: string, code = 'BAD_REQUEST_ERROR') =>
    send(res, status, { error: { code, description, source: 'business', step: 'payment_initiation', reason: 'input_validation_failed', metadata: {}, field: null } });

  function newPayment(order: Json, status: string, amount: number, currency: string, method: string): Json {
    const captured = status === 'captured';
    const payment: Json = {
      id: randomId('pay'), entity: 'payment', amount, currency, status, order_id: order.id, invoice_id: null, international: false,
      method, amount_refunded: 0, refund_status: null, captured, description: null, card_id: null, bank: null, wallet: null,
      vpa: method === 'upi' ? (status === 'failed' ? 'failure@razorpay' : 'success@razorpay') : null,
      email: 'member@example.com', contact: '+919000090000', notes: order.notes ?? {}, fee: captured ? 708 : null, tax: captured ? 108 : null,
      error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description: status === 'failed' ? 'Payment failed because the UPI request was declined by the payer.' : null,
      error_source: status === 'failed' ? 'customer' : null, error_step: status === 'failed' ? 'payment_authorization' : null,
      error_reason: status === 'failed' ? 'payment_declined' : null, acquirer_data: {}, created_at: seconds(),
    };
    payments.set(payment.id as string, payment);
    order.attempts = Number(order.attempts ?? 0) + 1;
    order.status = captured ? 'paid' : 'attempted';
    if (captured) { order.amount_paid = amount; order.amount_due = 0; }
    return payment;
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Json | null;
      try {
        body = raw ? (JSON.parse(raw) as Json) : null;
      } catch {
        body = null;
      }
      const url = new URL(req.url ?? '/', 'http://fake');
      const record: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body };
      requests.push(record);

      const fault = faults.find((candidate) => candidate.method === record.method && candidate.path.test(url.pathname) && candidate.times > 0);
      if (fault) {
        fault.times -= 1;
        if ('hangMs' in fault.behaviour) {
          setTimeout(() => !res.writableEnded && error(res, 504, 'Gateway timeout (fake)'), fault.behaviour.hangMs);
          return;
        }
        send(res, fault.behaviour.status, fault.behaviour.error ?? { error: { code: 'SERVER_ERROR', description: 'Fake fault' } });
        return;
      }
      // Test control, not part of Razorpay's API: lets an E2E worker (another
      // process) act as the member paying inside Checkout.
      const control = url.pathname.match(/^\/__control\/orders\/([^/]+)\/payments$/);
      if (control && record.method === 'POST') {
        const order = orders.get(control[1]!);
        if (!order) return error(res, 404, 'No such order (fake control).');
        return send(res, 200, newPayment(order, String(body?.status ?? 'captured'), Number(body?.amount ?? order.amount), String(order.currency), 'upi'));
      }
      if (req.headers.authorization !== expectedAuth) {
        error(res, 401, 'Authentication failed', 'BAD_REQUEST_ERROR');
        return;
      }
      route(record, url, body, res);
    });
  });

  function route(record: RecordedRequest, url: URL, body: Json | null, res: ServerResponse): void {
    const path = url.pathname;
    let match: RegExpMatchArray | null;

    if (record.method === 'POST' && path === '/v1/orders') {
      const amount = Number(body?.amount);
      if (!Number.isInteger(amount) || amount < 100) return error(res, 400, 'The amount must be atleast INR 1.00');
      if (typeof body?.receipt === 'string' && [...orders.values()].some((order) => order.receipt === body!.receipt)) {
        return error(res, 400, 'Duplicate request');
      }
      const order: Json = { id: randomId('order'), entity: 'order', amount, amount_paid: 0, amount_due: amount, currency: body?.currency,
        receipt: body?.receipt ?? null, offer_id: null, status: 'created', attempts: 0, notes: body?.notes ?? {}, created_at: seconds() };
      orders.set(order.id as string, order);
      return send(res, 200, order);
    }
    if (record.method === 'GET' && (match = path.match(/^\/v1\/orders\/([^/]+)\/payments$/))) {
      if (!orders.has(match[1]!)) return error(res, 400, 'The id provided does not exist');
      const items = [...payments.values()].filter((payment) => payment.order_id === match![1]);
      return send(res, 200, { entity: 'collection', count: items.length, items });
    }
    if (record.method === 'GET' && path === '/v1/payments') {
      const from = Number(url.searchParams.get('from') ?? 0);
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
      const count = Math.min(Number(url.searchParams.get('count') ?? 10), 100);
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const items = [...payments.values()].filter((payment) => Number(payment.created_at) >= from && Number(payment.created_at) <= to).slice(skip, skip + count);
      return send(res, 200, { entity: 'collection', count: items.length, items });
    }
    if (record.method === 'GET' && (match = path.match(/^\/v1\/payments\/([^/]+)$/))) {
      const payment = payments.get(match[1]!);
      return payment ? send(res, 200, payment) : error(res, 400, 'The id provided does not exist');
    }
    if (record.method === 'POST' && (match = path.match(/^\/v1\/payments\/([^/]+)\/capture$/))) {
      const payment = payments.get(match[1]!);
      if (!payment) return error(res, 400, 'The id provided does not exist');
      if (payment.status !== 'authorized') return error(res, 400, 'This payment has already been captured');
      if (Number(body?.amount) !== payment.amount || body?.currency !== payment.currency) {
        return error(res, 400, 'Capture amount must be equal to the amount authorized');
      }
      payment.status = 'captured';
      payment.captured = true;
      const order = orders.get(payment.order_id as string);
      if (order) { order.status = 'paid'; order.amount_paid = payment.amount; order.amount_due = 0; }
      return send(res, 200, payment);
    }
    if (record.method === 'POST' && (match = path.match(/^\/v1\/payments\/([^/]+)\/refund$/))) {
      const key = record.headers['x-refund-idempotency'];
      if (typeof key !== 'string' || key.length < 10) return error(res, 400, 'X-Refund-Idempotency header is invalid');
      const previous = refundKeys.get(key);
      if (previous) return send(res, 200, refunds.get(previous)!);
      const payment = payments.get(match[1]!);
      if (!payment) return error(res, 400, 'The id provided does not exist');
      if (!payment.captured) return error(res, 400, 'The payment has not been captured');
      const amount = Number(body?.amount ?? payment.amount);
      const refundable = Number(payment.amount) - Number(payment.amount_refunded);
      if (amount > refundable) return error(res, 400, 'The refund amount provided is greater than amount captured');
      const refund: Json = { id: randomId('rfnd'), entity: 'refund', amount, currency: payment.currency, payment_id: payment.id,
        notes: body?.notes ?? {}, receipt: body?.receipt ?? null, acquirer_data: { arn: null }, created_at: seconds(), batch_id: null,
        status: 'pending', speed_processed: 'normal', speed_requested: body?.speed ?? 'normal' };
      refunds.set(refund.id as string, refund);
      refundKeys.set(key, refund.id as string);
      payment.amount_refunded = Number(payment.amount_refunded) + amount;
      payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
      return send(res, 200, refund);
    }
    if (record.method === 'POST' && path === '/v1/payment_links') {
      const link: Json = { id: randomId('plink'), entity: 'payment_link', amount: body?.amount, amount_paid: 0, currency: body?.currency,
        accept_partial: body?.accept_partial ?? false, first_min_partial_amount: 0, description: body?.description, reference_id: body?.reference_id,
        short_url: `https://rzp.io/i/${randomBytes(5).toString('hex')}`, status: 'created', expire_by: body?.expire_by, expired_at: 0,
        cancelled_at: 0, created_at: seconds(), updated_at: seconds(), customer: body?.customer ?? {}, notify: body?.notify,
        reminder_enable: body?.reminder_enable, notes: body?.notes ?? {}, payments: null, user_id: '', upi_link: false, reminders: [] };
      links.set(link.id as string, link);
      return send(res, 200, link);
    }
    if (record.method === 'GET' && (match = path.match(/^\/v1\/payment_links\/([^/]+)$/))) {
      const link = links.get(match[1]!);
      return link ? send(res, 200, link) : error(res, 400, 'The id provided does not exist');
    }
    unexpected.push(record);
    error(res, 404, `The requested URL was not found on the server (fake: ${record.method} ${path}).`, 'NOT_FOUND');
  }

  await new Promise<void>((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    keyId,
    keySecret,
    webhookSecret,
    requests,
    unexpected,
    orders,
    payments,
    refunds,
    links,
    fault(match, behaviour, times = 1) {
      faults.push({ ...match, behaviour, times });
    },
    pay(orderId, payOptions = {}) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`Fake Razorpay has no order ${orderId}`);
      return newPayment(order, payOptions.status ?? 'captured', payOptions.amount ?? Number(order.amount), payOptions.currency ?? String(order.currency), payOptions.method ?? 'upi');
    },
    payLink(linkId, payOptions = {}) {
      const link = links.get(linkId);
      if (!link) throw new Error(`Fake Razorpay has no link ${linkId}`);
      const order: Json = { id: randomId('order'), entity: 'order', amount: link.amount, amount_paid: 0, amount_due: link.amount, currency: link.currency,
        receipt: null, offer_id: null, status: 'created', attempts: 0, notes: link.notes, created_at: seconds() };
      orders.set(order.id as string, order);
      const payment = newPayment(order, payOptions.status ?? 'captured', payOptions.amount ?? Number(link.amount), String(link.currency), 'upi');
      link.status = 'paid';
      link.amount_paid = payment.amount;
      link.order_id = order.id;
      link.payments = [{ amount: payment.amount, created_at: payment.created_at, method: 'upi', payment_id: payment.id, plink_id: link.id, status: payment.status, updated_at: payment.created_at }];
      return { payment, order };
    },
    checkoutSignature(orderId, paymentId) {
      return createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    },
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

function send(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* — Webhook fixtures ———————————————————————————————————————————————— */

export const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/razorpay');

export type WebhookEntities = Partial<Record<'payment' | 'order' | 'refund' | 'payment_link', Json>>;

/** A documented-shape webhook body (fixtures/razorpay/<event>.json) with the
 *  given entity fields overlaid. */
export function webhookBody(event: string, entities: WebhookEntities = {}): string {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${event}.json`), 'utf8')) as Json & { payload: Record<string, { entity: Json }> };
  for (const [name, fields] of Object.entries(entities)) {
    const holder = fixture.payload[name];
    if (holder) holder.entity = { ...holder.entity, ...fields };
  }
  fixture.created_at = seconds();
  return JSON.stringify(fixture);
}

export function webhookSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
