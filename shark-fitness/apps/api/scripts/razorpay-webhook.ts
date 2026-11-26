/**
 * Sign a Razorpay webhook fixture with SHARK_RAZORPAY_WEBHOOK_SECRET and post
 * it to a local API, the way Razorpay would.
 *
 *   SHARK_RAZORPAY_WEBHOOK_SECRET=… pnpm -F @shark/api razorpay:webhook -- payment.captured \
 *     --order order_… --payment pay_… --amount 29500 [--url http://localhost:8787/v1/webhooks/razorpay]
 *
 * Fixtures live in fixtures/razorpay/<event>.json. Flags overwrite the ids and
 * amount on every entity the event carries. Development only: it refuses any
 * URL that is not on this machine.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { FIXTURE_DIR, webhookBody, webhookSignature, type WebhookEntities } from '../src/testing/razorpay-fake.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const fixtures = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const event = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!event || !fixtures.includes(event)) {
  console.error(`Usage: pnpm -F @shark/api razorpay:webhook -- <fixture> [--url URL] [--order ID] [--payment ID] [--amount MINOR] [--refund ID] [--link ID] [--event-id ID]\nFixtures: ${fixtures.join(', ')}`);
  process.exit(2);
}
const secret = process.env.SHARK_RAZORPAY_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set SHARK_RAZORPAY_WEBHOOK_SECRET to the secret the API was started with.');
  process.exit(2);
}
const url = new URL(flag('url') ?? `http://localhost:${process.env.PORT ?? '8787'}/v1/webhooks/razorpay`);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  console.error(`Refusing to post to ${url.host}: this tool is for a local API only.`);
  process.exit(2);
}

const order = flag('order');
const payment = flag('payment');
const amount = flag('amount') ? Number(flag('amount')) : undefined;
const entities: WebhookEntities = {
  payment: { ...(payment ? { id: payment } : {}), ...(order ? { order_id: order } : {}), ...(amount ? { amount } : {}) },
  order: { ...(order ? { id: order } : {}), ...(amount ? { amount, amount_paid: amount } : {}) },
  refund: { ...(flag('refund') ? { id: flag('refund') } : {}), ...(payment ? { payment_id: payment } : {}), ...(amount ? { amount } : {}) },
  payment_link: { ...(flag('link') ? { id: flag('link') } : {}), ...(amount ? { amount, amount_paid: amount } : {}) },
};
const body = webhookBody(event, entities);
const eventId = flag('event-id') ?? `evt_dev_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-razorpay-signature': webhookSignature(body, secret), 'x-razorpay-event-id': eventId },
  body,
});
console.log(`${event} (${eventId}) → ${url.href}: ${response.status}`);
console.log(await response.text());
process.exit(response.ok ? 0 : 1);
