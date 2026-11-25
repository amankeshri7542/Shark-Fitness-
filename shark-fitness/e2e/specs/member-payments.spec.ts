import { expect, test } from '@playwright/test';
import { DEMO, signInToMemberApp } from '../support/demo';
import { razorpay, stubCheckout } from '../support/razorpay';

/**
 * A member pays an open invoice online (P02 acceptance 9), on a phone.
 *
 * Checkout.js is replaced by a stub; the API talks to a local fake Razorpay.
 * The browser's success callback is only a claim: the server checks the
 * signature, asks Razorpay, finds the payment not yet captured and waits.
 * Razorpay's signed payment.captured webhook is what settles the invoice,
 * and the app shows Paid with a receipt when the server says so.
 */
test('a member pays an open invoice through Razorpay Checkout and sees Paid with a receipt @payments', async ({ page, request, baseURL }) => {
  const toRazorpay = await stubCheckout(page);
  await signInToMemberApp(page, DEMO.graceMember);
  await page.goto('/billing');

  await expect(page.getByText('Online payments use Razorpay test mode. No real money moves.')).toBeVisible();
  const pay = page.getByRole('button', { name: /^Pay ₹[\d,.]+ now for invoice SF-/ }).first();
  await expect(pay).toBeVisible();
  const label = (await pay.getAttribute('aria-label'))!;
  const invoiceNumber = label.split(' for invoice ')[1]!;
  await pay.click();

  // The app opened Checkout with an order the server created at "Razorpay".
  const options = await page.waitForFunction(() => (window as unknown as { __rzpCheckout?: Record<string, unknown> }).__rzpCheckout ?? null);
  const checkout = (await options.jsonValue()) as { key: string; order_id: string; amount: number; currency: string };
  expect(checkout.key).toMatch(/^rzp_test_/);
  expect(checkout.order_id).toMatch(/^order_/);
  expect(checkout.currency).toBe('INR');

  // The member completes payment inside Checkout; the bank has not confirmed yet.
  const payment = await razorpay.pay(checkout.order_id, 'created');
  const signature = razorpay.checkoutSignature(checkout.order_id, String(payment.id));
  await page.evaluate(
    (response) => (window as unknown as { __rzpCheckout: { handler: (r: unknown) => void } }).__rzpCheckout.handler(response),
    { razorpay_payment_id: payment.id, razorpay_order_id: checkout.order_id, razorpay_signature: signature },
  );
  await expect(page.getByRole('status').filter({ hasText: 'Confirming payment' })).toBeVisible();
  await expect(page.getByText('Paid', { exact: true })).toHaveCount(0);

  // Razorpay's signed webhook: the money is captured.
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_E2E',
    event: 'payment.captured',
    contains: ['payment'],
    payload: { payment: { entity: { ...payment, status: 'captured', captured: true } } },
    created_at: Math.floor(Date.now() / 1000),
  });
  const webhook = await request.post(`${baseURL}/v1/webhooks/razorpay`, {
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': razorpay.webhookSignature(body), 'x-razorpay-event-id': `evt_e2e_${Date.now()}` },
    data: body,
  });
  expect(webhook.status()).toBe(200);

  const paid = page.getByRole('status').filter({ hasText: 'Paid' });
  await expect(paid).toBeVisible();
  await expect(paid).toContainText(`received for invoice ${invoiceNumber}.`);
  const receipt = paid.getByRole('link', { name: 'View receipt' });
  await expect(receipt).toHaveAttribute('href', /\/v1\/member\/billing\/payments\/pay_[a-z0-9]+\/receipt\?format=html$/);
  const receiptBody = await page.request.get(new URL((await receipt.getAttribute('href'))!, baseURL).href);
  expect(receiptBody.status()).toBe(200);
  expect(await receiptBody.text()).toContain(invoiceNumber);

  // After a reload the invoice is settled and not offered for payment again.
  await page.reload();
  await expect(page.getByText(invoiceNumber, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Pay ${label.split('Pay ')[1]!.split(' now')[0]} now for invoice ${invoiceNumber}` })).toHaveCount(0);

  // The browser fetched nothing from Razorpay except (the stub of) checkout.js.
  expect(toRazorpay).toEqual([]);
});
