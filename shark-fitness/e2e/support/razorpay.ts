import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';

/**
 * Razorpay in the E2E run (global-setup.ts starts a local fake API and points
 * the server at it). Checkout.js itself is never fetched: `stubCheckout`
 * answers the script URL with a stand-in that records the options the app
 * passes and lets the spec play the member completing payment.
 */

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the payment specs through global-setup.ts.`);
  return value;
}

export const razorpay = {
  apiBase: () => env('SHARK_E2E_RAZORPAY_API_BASE'),
  /** The checkout signature Razorpay would hand the browser. */
  checkoutSignature: (orderId: string, paymentId: string) =>
    createHmac('sha256', env('SHARK_E2E_RAZORPAY_KEY_SECRET')).update(`${orderId}|${paymentId}`).digest('hex'),
  webhookSignature: (body: string) => createHmac('sha256', env('SHARK_E2E_RAZORPAY_WEBHOOK_SECRET')).update(body).digest('hex'),
  /** The member pays inside Checkout: the fake records a payment on the order. */
  async pay(orderId: string, status: 'created' | 'authorized' | 'captured' = 'created'): Promise<Record<string, unknown>> {
    const response = await fetch(`${razorpay.apiBase().replace(/\/v1$/, '')}/__control/orders/${orderId}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error(`Fake Razorpay refused the payment: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  },
};

export const CHECKOUT_STUB = `
  window.Razorpay = function (options) { this.options = options; };
  window.Razorpay.prototype.on = function (event, handler) { (window.__rzpHandlers = window.__rzpHandlers || {})[event] = handler; };
  window.Razorpay.prototype.open = function () { window.__rzpCheckout = this.options; };
`;

/** Answer checkout.js with the stub, and refuse (and record) any other
 *  request the browser makes to a Razorpay host. */
export async function stubCheckout(page: Page): Promise<string[]> {
  const toRazorpay: string[] = [];
  await page.route(/^https:\/\/([a-z0-9-]+\.)*razorpay\.com\//, (route) => {
    if (route.request().url() === 'https://checkout.razorpay.com/v1/checkout.js') {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: CHECKOUT_STUB });
    }
    toRazorpay.push(route.request().url());
    return route.abort();
  });
  return toRazorpay;
}
