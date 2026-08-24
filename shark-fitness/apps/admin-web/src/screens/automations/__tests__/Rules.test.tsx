import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { useAdmin } from '../../../lib/store';
import Rules, { type AutomationRow } from '../Rules';

const branches = [
  { id: 'br_kor', name: 'Koramangala', timezone: 'Asia/Kolkata' },
  { id: 'br_ind', name: 'Indiranagar', timezone: 'Asia/Kolkata' },
] as never[];

const externalRule: AutomationRow = {
  id: 'atm_sms',
  name: 'Renewal text',
  description: 'A provider truth fixture.',
  trigger: 'membership.expiring',
  triggerLabel: 'Membership expiring',
  state: 'active',
  dryRun: true,
  channel: 'sms',
  providerAvailable: false,
  templateCode: 'renewal.sms',
  templateVersion: 1,
  delayMin: 0,
  branchIds: ['br_kor'],
  conditions: [],
  quietHours: null,
  runsLast30: 0,
  lastRunAt: null,
};

const trigger = {
  key: 'membership.expiring',
  label: 'Membership expiring',
  description: 'Before a membership ends.',
  variables: ['firstName'],
  fields: ['daysUntilExpiry'],
  window: 'daily',
};

function renderRules() {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Rules />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  useAdmin.setState({ branches, activeBranchId: null });
  apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/admin/automations' && !options) return Promise.resolve({ items: [externalRule], triggers: [trigger] });
    if (path === '/admin/automations/templates') {
      return Promise.resolve({ items: [{ code: 'renewal.sms', channel: 'sms', version: 1, variables: ['firstName'] }] });
    }
    if (path === '/admin/automations/atm_sms/preview') {
      return Promise.resolve({
        summary: { considered: 1, wouldSend: 0, suppressed: 1, bySuppression: [] },
        channel: 'sms',
        metered: true,
        estimatedCostMinor: 0,
        recipients: [],
        suppressed: [],
      });
    }
    if (path === '/admin/automations/atm_sms' && options?.method === 'PATCH') {
      return Promise.resolve({ automation: externalRule });
    }
    throw new Error(`Unexpected API call: ${path}`);
  });
});

describe('Rules — truthful provider and branch scope controls', () => {
  it('never offers to send through an unavailable provider', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.click(await screen.findByText('Renewal text'));

    expect(await screen.findByText(/No sms provider is configured, so this cannot send/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Provider required' })).toBeDisabled();
    expect(screen.queryByText('Live. This reaches members.')).not.toBeInTheDocument();
  });

  it('shows the stored scope and sends explicit scope edits back to the API', async () => {
    const user = userEvent.setup();
    renderRules();

    expect(await screen.findByText('Koramangala')).toBeInTheDocument();
    await user.click(screen.getByText('Renewal text'));
    await user.click(await screen.findByRole('button', { name: 'Indiranagar' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/automations/atm_sms',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ branchIds: ['br_kor', 'br_ind'] }),
        }),
      );
    });
  });
});
