import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), API_ORIGIN: 'https://api.example' }));

import { CheckoutPanel } from '../billing/CheckoutPanel';
import type { CheckoutState, CheckoutTarget } from '../../lib/checkout';

const target: CheckoutTarget = { kind: 'invoice', invoiceId: 'inv_1', label: 'invoice SF-2026-00042' };

function renderPanel(state: Exclude<CheckoutState, { phase: 'idle' }>) {
  const onRetry = vi.fn();
  const onClose = vi.fn();
  render(<CheckoutPanel state={state} onRetry={onRetry} onClose={onClose} />);
  return { onRetry, onClose };
}

describe('CheckoutPanel', () => {
  it('opening: a polite status while the payment window loads', () => {
    renderPanel({ phase: 'opening', target });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Opening payment');
    expect(status).toHaveTextContent('Opening the secure Razorpay window for invoice SF-2026-00042…');
  });

  it('confirming: promises no double charge, and says when the bank is slow', () => {
    const { rerender } = render(<CheckoutPanel state={{ phase: 'confirming', target, intentId: 'pi_1', slow: false }} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('You will not be charged twice.');
    expect(screen.queryByText(/taking longer than usual/)).not.toBeInTheDocument();
    rerender(<CheckoutPanel state={{ phase: 'confirming', target, intentId: 'pi_1', slow: true }} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/The bank is taking longer than usual\. You can leave this screen/)).toBeInTheDocument();
  });

  it('paid: the amount, receipt links on the API origin, and Done', () => {
    const { onClose } = renderPanel({ phase: 'paid', target, invoiceId: 'inv_1', paymentId: 'pay_9', amountLabel: '₹295' });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Paid');
    expect(status).toHaveTextContent('₹295 received for invoice SF-2026-00042.');
    expect(within(status).getByRole('link', { name: 'View receipt' })).toHaveAttribute('href', 'https://api.example/v1/member/billing/payments/pay_9/receipt?format=html');
    expect(within(status).getByRole('link', { name: 'Download receipt' })).toHaveAttribute('href', 'https://api.example/v1/member/billing/payments/pay_9/receipt');
    fireEvent.click(within(status).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('paid by credits or a free plan: says it is active, with no receipt links', () => {
    renderPanel({ phase: 'paid', target: { kind: 'plan', productId: 'prd_1', label: 'Depot Monthly' }, invoiceId: 'inv_2', paymentId: null, amountLabel: null });
    expect(screen.getByRole('status')).toHaveTextContent('Depot Monthly is active.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('needs review: tells the member not to pay again', () => {
    const { onClose } = renderPanel({ phase: 'review', target });
    expect(screen.getByRole('status')).toHaveTextContent('Payment received, being checked');
    expect(screen.getByText(/Do not pay again/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('dismissed: nothing was charged; Try again retries the same target, Not now closes', () => {
    const { onRetry, onClose } = renderPanel({ phase: 'dismissed', target });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Payment not completed');
    expect(status).toHaveTextContent('You closed the payment window. Nothing was charged for invoice SF-2026-00042.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledWith(target);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('failed: an assertive alert with the reason, a retry, and the reception fallback', () => {
    const { onRetry } = renderPanel({ phase: 'failed', target, reason: 'You are offline. Nothing was charged. Try again when you are connected.' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Payment did not go through');
    expect(alert).toHaveTextContent('You are offline. Nothing was charged. Try again when you are connected.');
    expect(alert).toHaveTextContent('You can also pay at reception.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledWith(target);
  });
});
