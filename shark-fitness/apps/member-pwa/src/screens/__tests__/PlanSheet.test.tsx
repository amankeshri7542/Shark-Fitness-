import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));

import { ApiError } from '../../lib/api';
import { PlanSheet, type PlanOption, type PlanOptions } from '../billing/PlanSheet';

const monthly: PlanOption = {
  productId: 'prd_month', name: 'Depot Monthly', description: '', kind: 'membership', durationDays: 30, priceLabel: '₹2,500', taxLabel: '₹450',
  totalMinor: 295000, totalLabel: '₹2,950', cancellation: 'Cancel with 7 days notice.', freezeAllowed: true,
};
const quarterly: PlanOption = {
  productId: 'prd_quarter', name: 'Depot Quarterly', description: '', kind: 'membership', durationDays: 90, priceLabel: '₹6,500', taxLabel: '₹1,170',
  totalMinor: 767000, totalLabel: '₹7,670', cancellation: '', freezeAllowed: true,
};
const pack: PlanOption = { ...monthly, productId: 'prd_open', name: 'Open pass', durationDays: null, totalLabel: '₹500' };

const options = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  onlinePayment: true, mode: 'purchase', unavailableReason: null, previousProductId: null, plans: [monthly, quarterly], ...overrides,
});

function renderSheet(props: { preferredProductId?: string | null } = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlanSheet onClose={onClose} onConfirm={onConfirm} {...props} />
    </QueryClientProvider>,
  );
  return { onClose, onConfirm };
}

afterEach(() => api.mockReset());

/** The scrim is also a Close button; this is the one written out in the sheet. */
const closeButton = () => screen.getAllByRole('button', { name: 'Close' }).find((button) => button.textContent === 'Close');

describe('PlanSheet', () => {
  it('shows loading inside the dialog first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Choose a plan' });
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('lists plans with term and total; the full price, GST and terms show before anything is charged', async () => {
    api.mockResolvedValue(options({ plans: [monthly, quarterly, pack] }));
    const { onConfirm } = renderSheet();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a plan' });
    expect(await within(dialog).findByRole('radio', { name: /Depot Monthly/ })).toBeChecked();
    expect(dialog).toHaveTextContent('1 month');
    expect(dialog).toHaveTextContent('3 months');
    expect(dialog).toHaveTextContent('No fixed end date');
    expect(dialog).toHaveTextContent('GST₹450');
    expect(dialog).toHaveTextContent('Cancellation: Cancel with 7 days notice.');
    expect(api).toHaveBeenCalledWith('/member/billing/plans');

    fireEvent.click(within(dialog).getByRole('radio', { name: /Depot Quarterly/ }));
    expect(dialog).toHaveTextContent('Total today₹7,670');
    // No cancellation line when the plan has none.
    expect(dialog).not.toHaveTextContent('Cancellation:');
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pay ₹7,670' }));
    expect(onConfirm).toHaveBeenCalledWith(quarterly);
  });

  it('renewing starts on the previous plan and says Renew', async () => {
    api.mockResolvedValue(options({ mode: 'renew', previousProductId: 'prd_quarter' }));
    renderSheet();
    const dialog = await screen.findByRole('dialog', { name: 'Renew your plan' });
    expect(await within(dialog).findByRole('radio', { name: /Depot Quarterly/ })).toBeChecked();
  });

  it('a preferred plan from a link starts chosen', async () => {
    api.mockResolvedValue(options());
    renderSheet({ preferredProductId: 'prd_quarter' });
    expect(await screen.findByRole('radio', { name: /Depot Quarterly/ })).toBeChecked();
  });

  it('ignores a preferred plan that is not on offer', async () => {
    api.mockResolvedValue(options());
    renderSheet({ preferredProductId: 'prd_gone' });
    expect(await screen.findByRole('radio', { name: /Depot Monthly/ })).toBeChecked();
  });

  it('unavailable: the server’s reason and a way out (permission refused)', async () => {
    api.mockResolvedValue(options({ mode: 'unavailable', unavailableReason: 'Your membership is suspended. Reception can help.', plans: [] }));
    const { onClose } = renderSheet();
    expect(await screen.findByText('Your membership is suspended. Reception can help.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(closeButton()!);
    expect(onClose).toHaveBeenCalled();
  });

  it('empty: nothing on sale in the app, with the reception fallback', async () => {
    api.mockResolvedValue(options({ plans: [] }));
    renderSheet();
    expect(await screen.findByText('No plans can be bought in the app right now. Reception can set one up for you.')).toBeInTheDocument();
    expect(closeButton()).toBeInTheDocument();
  });

  it('error: nothing changed, retry, and close', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'r' } }));
    const { onClose } = renderSheet();
    expect(await screen.findByRole('heading', { name: 'Could not load plans' })).toBeInTheDocument();
    api.mockResolvedValue(options());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /Depot Monthly/ })).toBeInTheDocument();
    expect(closeButton()).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalled();
  });
});
