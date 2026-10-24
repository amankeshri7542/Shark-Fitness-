import { expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderPanel } from './harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import Business from '../Business';

const profile = (taxProfile: Record<string, unknown> | null) => ({
  legalName: 'Shark Fitness Private Limited',
  displayName: 'Shark Fitness',
  locale: 'en-IN',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  unitSystem: 'metric',
  taxProfile,
  dataProcessing: null,
  slug: 'shark',
  plan: 'growth',
  status: 'active',
});

it('checks a GSTIN as it is typed and names the state it belongs to', async () => {
  api.mockResolvedValue(profile({ registrationNumber: '29AABCS1429B1ZQ', label: 'GST', defaultRateBp: 1800, pricesIncludeTax: false }));
  renderPanel(<Business canManage />);

  expect(await screen.findByText('GSTIN for Karnataka (29). New invoices print as GST tax invoices.')).toBeInTheDocument();

  // One character off: the right shape, the wrong check character.
  fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: '29AABCS1429B1ZR' } });
  expect(screen.getByText(/does not match the rest/)).toBeInTheDocument();
  expect(screen.getByLabelText('Registration number')).toHaveAttribute('aria-invalid', 'true');
});

it('says prices are before tax, and saves that, even over an old profile that claimed otherwise', async () => {
  api.mockResolvedValue(profile({ registrationNumber: '29AABCS1429B1ZQ', label: 'GST', defaultRateBp: 1800, pricesIncludeTax: true }));
  renderPanel(<Business canManage />);

  expect(await screen.findByText(/Catalogue prices are before tax/)).toBeInTheDocument();
  expect(screen.getByText(/Your saved profile says prices include tax/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Prices include tax')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Invoice number prefix'), { target: { value: 'dep-1' } });
  expect(screen.getByLabelText('Invoice number prefix')).toHaveValue('DEP1');

  fireEvent.click(screen.getByRole('button', { name: 'Save tax' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/admin/settings/business', {
      method: 'PATCH',
      body: { taxProfile: expect.objectContaining({ pricesIncludeTax: false, invoicePrefix: 'DEP1', registrationNumber: '29AABCS1429B1ZQ' }) },
    }),
  );
});
