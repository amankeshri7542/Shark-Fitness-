import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../lib/api';
import { refuse, renderScreen, signInAs } from '../../../test/harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import CommissionSurface from '../Commission';

const SETTLEMENT =
  'Commission is calculated from payments recorded in this system. Marking a line paid records an external payroll settlement; no money moves here.';

const line = (overrides: Record<string, unknown> = {}) => ({
  id: 'cml_1',
  kind: 'membership_sale',
  basisMinor: 2_400_000,
  ratePct: 5,
  amountMinor: 120_000,
  state: 'pending',
  ruleVersion: 'v2026-04',
  refType: 'invoice',
  refId: 'inv_1',
  branchId: 'br_kor',
  correctionOfLineId: null,
  correctionReason: null,
  evidence: ['INV-0042 paid in full'],
  createdAt: Date.parse('2026-11-10T10:00:00Z'),
  ...overrides,
});

const report = (staff = [
  {
    staffId: 'stf_rehan',
    name: 'Rehan Shaikh',
    pendingMinor: 120_000,
    approvedMinor: 60_000,
    paidMinor: 0,
    totalMinor: 180_000,
    lines: [line(), line({ id: 'cml_2', amountMinor: 60_000, basisMinor: 1_200_000, state: 'approved' })],
  },
]) => ({
  periodStart: '2026-11-01',
  periodEnd: '2026-11-26',
  currency: 'INR',
  staff,
  totals: {
    pendingMinor: staff.reduce((t, s) => t + s.pendingMinor, 0),
    approvedMinor: staff.reduce((t, s) => t + s.approvedMinor, 0),
    paidMinor: 0,
    totalMinor: staff.reduce((t, s) => t + s.totalMinor, 0),
  },
  settlementNote: SETTLEMENT,
});

const rules = (canApprove = true) => ({
  kinds: ['membership_sale', 'retail_sale', 'session'],
  tenantRates: [{ kind: 'membership_sale', ratePct: 5, version: 'v2026-04', effectiveFrom: '2026-04-01' }],
  unsourcedKinds: ['session'],
  canApprove,
});

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> | undefined;
function respond({ canApprove = true, staff, extra }: { canApprove?: boolean; staff?: Parameters<typeof report>[0]; extra?: Handler } = {}) {
  api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handled = extra?.(path, options);
    if (handled) return handled;
    if (path === '/admin/staff/commission/rules') return Promise.resolve(rules(canApprove));
    if (path.startsWith('/admin/staff/commission?')) return Promise.resolve(report(staff));
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

const show = () => renderScreen('/staff', [{ path: '/staff', component: CommissionSurface }]);

beforeEach(() => {
  api.mockReset();
  signInAs('owner');
});

describe('Commission', () => {
  it('refuses a role without staff.commission, and reads nothing', async () => {
    signInAs('branch_manager');
    show();
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Commission figures is restricted/)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('shows no figures, and no zeroes, while the ledger loads', async () => {
    api.mockReturnValue(new Promise(() => undefined));
    show();
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('/admin/staff/commission?periodStart='), { branchId: 'br_kor' }));
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing accrued in this period')).not.toBeInTheDocument();
    expect(screen.queryByText('Commission could not be read')).not.toBeInTheDocument();
  });

  it('says the ledger could not be read, and reads it again on retry', async () => {
    respond({
      extra: (path) =>
        path.startsWith('/admin/staff/commission?')
          ? refuse(new ApiError(500, { error: { code: 'INTERNAL', message: 'Ledger unavailable.', requestId: 'r' } }))
          : undefined,
    });
    show();
    expect(await screen.findByText('Commission could not be read')).toBeInTheDocument();
    expect(screen.getByText('Ledger unavailable.')).toBeInTheDocument();

    respond();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Commission by staff' })).toBeInTheDocument();
  });

  it('says nothing has accrued yet and offers to calculate the period', async () => {
    respond({
      staff: [],
      extra: (path) =>
        path === '/admin/staff/commission/calculate'
          ? Promise.resolve({ created: 3, alreadyAccrued: 1, noRate: [{ staffId: 'stf_x' }], totalMinor: 90_000 })
          : undefined,
    });
    show();
    expect(await screen.findByText('Nothing accrued in this period')).toBeInTheDocument();
    expect(screen.getAllByText('₹0.00')).toHaveLength(3);

    await userEvent.click(screen.getByRole('button', { name: 'Calculate period' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/admin/staff/commission/calculate',
        expect.objectContaining({ method: 'POST', branchId: 'br_kor', body: expect.objectContaining({ periodStart: expect.any(String) }) }),
      ),
    );
    expect(
      await screen.findByText('3 new lines accrued, 1 already existed. 1 eligible transaction has no rule and earned nothing.'),
    ).toBeInTheDocument();
  });

  it('totals the period by staff, and says plainly that no money moves here', async () => {
    respond();
    show();
    const table = await screen.findByRole('table', { name: 'Commission by staff' });
    const rehan = within(table).getByText('Rehan Shaikh').closest('tr')!;
    expect(within(rehan).getByText('₹1,800.00')).toBeInTheDocument();
    expect(screen.getByText(SETTLEMENT)).toBeInTheDocument();
    expect(screen.getByText(/Rates are configured for session/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot approve or settle/)).not.toBeInTheDocument();
  });

  it('approves pending lines, and will not record a payment without a payroll reference', async () => {
    respond({
      extra: (path, options) => {
        if (path === '/admin/staff/commission/approve') return Promise.resolve({ approved: (options?.body as { lineIds: string[] }).lineIds, totalMinor: 120_000 });
        if (path === '/admin/staff/commission/paid') return Promise.resolve({ paid: ['cml_2'] });
        return undefined;
      },
    });
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Lines' }));
    const panel = screen.getByRole('region', { name: 'Rehan Shaikh · 2 lines' });

    await userEvent.click(within(panel).getByRole('button', { name: 'Approve 1 pending' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/staff/commission/approve', { method: 'POST', body: { lineIds: ['cml_1'] }, branchId: 'br_kor' }),
    );
    expect(await screen.findByText('Approved 1 line.')).toBeInTheDocument();

    const pay = within(panel).getByRole('button', { name: 'Record 1 as paid' });
    expect(pay).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText('Payroll reference'), 'PAYROLL-2026-11');
    await userEvent.click(pay);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/staff/commission/paid', {
        method: 'POST',
        body: { lineIds: ['cml_2'], reference: 'PAYROLL-2026-11' },
        branchId: 'br_kor',
      }),
    );
    expect(await screen.findByText('1 line recorded as settled by that payroll run. No money moved here.')).toBeInTheDocument();
  });

  it('shows a reader the lines without the buttons, and says why', async () => {
    respond({ canApprove: false });
    show();
    expect(await screen.findByText(/Your role can read these figures and cannot approve or settle them/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lines' }));
    expect(screen.getByRole('table', { name: 'Commission lines for Rehan Shaikh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument();
  });

  it('does not blame the role when approval rights could not be read', async () => {
    respond({ extra: (path) => (path === '/admin/staff/commission/rules' ? refuse(new Error('down')) : undefined) });
    show();
    await screen.findByRole('table', { name: 'Commission by staff' });
    // Regression: a failed rules read was reported as a permission refusal.
    expect(await screen.findByText(/Whether you can approve could not be checked/)).toBeInTheDocument();
    expect(screen.queryByText(/Your role can read these figures/)).not.toBeInTheDocument();
  });

  it('raises a correction against a line without rewriting it, and says why one was refused', async () => {
    respond({
      extra: (path) =>
        path === '/admin/staff/commission/cml_1/correct'
          ? refuse(new ApiError(409, { error: { code: 'CONFLICT', message: 'That line was already corrected.', requestId: 'r' } }))
          : undefined,
    });
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Lines' }));
    const lines = screen.getByRole('table', { name: 'Commission lines for Rehan Shaikh' });
    await userEvent.click(within(lines).getAllByRole('button', { name: 'Correct' })[0]!);

    const form = screen.getByRole('region', { name: 'Correct a commission line' });
    expect(within(form).getByText(/compensating entry of -₹1,200.00/)).toBeInTheDocument();
    const raise = within(form).getByRole('button', { name: 'Raise correction' });
    expect(raise).toBeDisabled();
    await userEvent.type(within(form).getByLabelText('Reason'), 'Member refunded the plan');
    await userEvent.type(within(form).getByLabelText('Take back only (optional)'), '500');
    await userEvent.click(raise);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/staff/commission/cml_1/correct', {
        method: 'POST',
        body: { reason: 'Member refunded the plan', amountMinor: 50_000 },
        branchId: 'br_kor',
      }),
    );
    expect(await screen.findByText('That line was already corrected.')).toBeInTheDocument();
  });
});
