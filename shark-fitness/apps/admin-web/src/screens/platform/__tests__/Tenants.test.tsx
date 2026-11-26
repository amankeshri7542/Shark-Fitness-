import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TenantDetail, TenantSummary } from '@shark/contracts';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import Tenants from '../Tenants';

/* The platform customer list (PF-PLAT-001/002/004). Shapes follow
   TenantSummary / TenantDetail in packages/contracts/src/schemas/platform.ts. */

const summary: TenantSummary = {
  id: 'ten_shark',
  slug: 'shark-fitness',
  displayName: 'Shark Fitness',
  legalName: 'Shark Fitness Private Limited',
  plan: 'growth',
  status: 'active',
  statusMeaning: 'Operating normally.',
  operational: true,
  billable: true,
  currency: 'INR',
  createdAt: '2026-01-10T00:00:00.000Z',
  counts: { branches: 3, activeBranches: 2, members: 1240, staff: 18, checkIns30d: 9120 },
  metersNeedingAttention: [{ meter: 'sms_sent', period: '2026-11', used: 4600, limit: 5000, health: 'approaching', percent: 92 }],
};

const quiet: TenantSummary = {
  ...summary,
  id: 'ten_reef',
  slug: 'reef-gym',
  displayName: 'Reef Gym',
  legalName: 'Reef Gym LLP',
  plan: 'starter',
  status: 'trial',
  counts: { branches: 1, activeBranches: 1, members: 40, staff: 2, checkIns30d: 210 },
  metersNeedingAttention: [],
};

const detail: TenantDetail = {
  ...summary,
  timezone: 'Asia/Kolkata',
  locale: 'en-IN',
  featureFlags: {},
  quotas: { sms_sent: 5000 },
  meters: [
    { meter: 'sms_sent', period: '2026-11', used: 4600, limit: 5000, health: 'approaching', percent: 92 },
    { meter: 'whatsapp_sent', period: '2026-11', used: 0, limit: 0, health: 'unmetered', percent: null },
  ],
  nextStatuses: ['suspended', 'archived'],
  legalHolds: 0,
  suspensionNotice: 'Suspending stops sign-in for staff and members. Data is kept.',
  owners: [{ id: 'usr_owner', name: 'Priya Nair', email: 'owner@example.test', role: 'owner', accountState: 'active' }],
  recentActions: [],
};

function answer(list: unknown = { items: [summary, quiet] }) {
  apiMock.mockImplementation((path: string) => {
    if (path === '/platform/tenants') return Promise.resolve(list);
    if (path === '/platform/tenants/ten_shark') return Promise.resolve({ tenant: detail });
    if (path === '/platform/tenants/ten_shark/status') return Promise.resolve({ tenant: { ...detail, status: 'suspended' } });
    throw new Error(`Unexpected API call: ${path}`);
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('Tenants', () => {
  it('holds the list back while it loads', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPanel(<Tenants canAdminister />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('No customers yet')).toBeNull();
    resolve({ items: [quiet] });
    expect(await screen.findByRole('table', { name: 'Customers' })).toBeInTheDocument();
  });

  it('says there are no customers yet', async () => {
    answer({ items: [] });
    renderPanel(<Tenants canAdminister />);
    expect(await screen.findByRole('heading', { name: 'No customers yet' })).toBeInTheDocument();
    expect(screen.getByText('0 gyms')).toBeInTheDocument();
  });

  it('shows a failed read as an error, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementationOnce(() =>
      refuse(new ApiError(403, { error: { code: 'FORBIDDEN', message: 'Platform tools are not available inside a support session.', requestId: 'req_1' } })),
    );
    renderPanel(<Tenants canAdminister />);
    expect(await screen.findByRole('heading', { name: 'The customer list could not be read' })).toBeInTheDocument();
    expect(screen.getByText('Platform tools are not available inside a support session.')).toBeInTheDocument();
    answer();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Shark Fitness' })).toBeInTheDocument();
  });

  it('lists every gym and flags the ones near a limit', async () => {
    answer();
    renderPanel(<Tenants canAdminister />);
    const table = await screen.findByRole('table', { name: 'Customers' });
    expect(screen.getByText('2 gyms')).toBeInTheDocument();
    expect(screen.getByText('1 needing attention')).toBeInTheDocument();
    const [, shark, reef] = within(table).getAllByRole('row');
    expect(within(shark!).getByText('1240')).toBeInTheDocument();
    expect(within(shark!).getByText('sms sent 92%')).toBeInTheDocument();
    expect(within(shark!).getByText('/ 3')).toBeInTheDocument();
    expect(within(reef!).getByText('trial')).toBeInTheDocument();
    expect(within(reef!).getByText('—')).toBeInTheDocument();
  });

  it('opens a customer and changes its status with a recorded reason', async () => {
    const user = userEvent.setup();
    answer();
    renderPanel(<Tenants canAdminister />);
    await user.click(await screen.findByRole('button', { name: 'Shark Fitness' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shark Fitness' });
    expect(await within(dialog).findByText('Operating normally.')).toBeInTheDocument();
    expect(within(dialog).getByText('not sold')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Enter account' })).toBeEnabled();

    await user.selectOptions(within(dialog).getByLabelText('Move to'), 'suspended');
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason'), 'Three failed platform payments');
    await user.click(apply);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/platform/tenants/ten_shark/status', {
        method: 'POST',
        body: { status: 'suspended', reason: 'Three failed platform payments' },
      }),
    );
  });

  it('does not offer status changes to support without administration', async () => {
    const user = userEvent.setup();
    answer();
    renderPanel(<Tenants canAdminister={false} />);
    await user.click(await screen.findByRole('button', { name: 'Shark Fitness' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shark Fitness' });
    await within(dialog).findByText('Operating normally.');
    expect(within(dialog).queryByRole('region', { name: 'Change status' })).toBeNull();
    expect(within(dialog).getByRole('region', { name: 'Support access' })).toBeInTheDocument();
  });

  it('says a customer could not be read instead of loading for ever, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === '/platform/tenants') return Promise.resolve({ items: [summary] });
      return refuse(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That customer no longer exists.', requestId: 'req_2' } }));
    });
    renderPanel(<Tenants canAdminister />);
    await user.click(await screen.findByRole('button', { name: 'Shark Fitness' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customer' });
    expect(await within(dialog).findByRole('heading', { name: 'This customer could not be read' })).toBeInTheDocument();
    expect(within(dialog).getByText('That customer no longer exists.')).toBeInTheDocument();

    answer();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Operating normally.')).toBeInTheDocument();
  });
});
