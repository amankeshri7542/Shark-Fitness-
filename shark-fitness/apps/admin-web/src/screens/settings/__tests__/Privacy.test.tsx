import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { renderPanel } from './harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import Privacy from '../Privacy';

const DELIVERY =
  'This system produces the export as an internal record. It does not email it or upload it anywhere — handing it to the member is a manual step.';

const profile = (dataProcessing: Record<string, unknown> | null) => ({
  legalName: 'Shark Fitness Private Limited',
  displayName: 'Shark Fitness',
  locale: 'en-IN',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  unitSystem: 'metric',
  taxProfile: null,
  dataProcessing,
  slug: 'shark',
  plan: 'growth',
  status: 'active',
});

const request = (overrides: Record<string, unknown> = {}) => ({
  id: 'prq_1',
  kind: 'deletion',
  state: 'in_review',
  subjectUserId: 'usr_aman',
  subjectName: 'Aman Mehra',
  submittedAt: Date.parse('2026-11-20T09:00:00.000Z'),
  reviewedAt: null,
  completedAt: null,
  outcomeNote: null,
  artifactId: null,
  onLegalHold: false,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  request: request(),
  legalHold: null,
  retention: {
    retentionDays: 1095,
    jurisdiction: 'India — DPDP Act 2023',
    retainUntil: '2029-10-31',
    relationshipEndedOn: '2026-10-31',
    withinRetentionWindow: true,
    preserved: [{ table: 'invoices', reason: 'Tax records' }, { table: 'consents', reason: 'Proof of consent' }],
  },
  plan: { pseudonym: 'Former member 7F3A', overwrites: [{ table: 'users', field: 'name' }, { table: 'users', field: 'email' }], blockers: [] },
  artifact: null,
  ...overrides,
});

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> | undefined;
function respond({
  business = profile({ privacyContact: 'privacy@sharkfitness.in', retentionDays: 1095, consentVersion: '2026-01', jurisdiction: 'India — DPDP Act 2023' }),
  requests = [request()],
  extra,
}: { business?: unknown; requests?: unknown[]; extra?: Handler } = {}) {
  api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handled = extra?.(path, options);
    if (handled) return handled;
    if (path === '/admin/settings/business' && !options?.method) return Promise.resolve(business);
    if (path === '/admin/privacy/requests') return Promise.resolve({ requests, deliveryNote: DELIVERY });
    if (path === '/admin/privacy/requests/prq_1') return Promise.resolve(detail());
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  api.mockReset();
});

describe('Privacy', () => {
  it('renders nothing and reads nothing for a role without settings access', () => {
    const { container } = renderPanel(<Privacy canManage={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });

  it('shows neither a form nor an empty queue while loading', async () => {
    api.mockReturnValue(new Promise(() => undefined));
    renderPanel(<Privacy canManage />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/privacy/requests'));
    expect(screen.queryByLabelText('Privacy contact')).not.toBeInTheDocument();
    expect(screen.queryByText('No open requests')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  it('says each half could not be read, and retries them', async () => {
    api.mockImplementation(() =>
      refuse(new ApiError(503, { error: { code: 'INTERNAL', message: 'Settings are unavailable.', requestId: 'r' } })),
    );
    renderPanel(<Privacy canManage />);
    expect(await screen.findByText('Settings could not be read')).toBeInTheDocument();
    expect(await screen.findByText('The request queue could not be read')).toBeInTheDocument();

    respond({ requests: [] });
    for (const retry of screen.getAllByRole('button', { name: 'Try again' })) await userEvent.click(retry);
    expect(await screen.findByLabelText('Privacy contact')).toHaveValue('privacy@sharkfitness.in');
    expect(await screen.findByText('No open requests')).toBeInTheDocument();
  });

  it('starts an unset profile from a three-year retention, and saves the edit', async () => {
    respond({ business: profile(null), requests: [] });
    const saved = { privacyContact: 'dpo@sharkfitness.in', retentionDays: 1095, consentVersion: '', jurisdiction: '' };
    const base = api.getMockImplementation()!;
    api.mockImplementation((path: string, options?: { method?: string }) =>
      options?.method === 'PATCH' ? Promise.resolve(profile(saved)) : base(path, options),
    );
    renderPanel(<Privacy canManage />);
    expect(await screen.findByLabelText('Retention after leaving (days)')).toHaveValue(1095);
    expect(screen.getByText('Nobody has asked to see or delete their data.')).toBeInTheDocument();
    expect(screen.getByText(DELIVERY)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Privacy contact'), 'dpo@sharkfitness.in');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save data processing' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/settings/business', { method: 'PATCH', body: { dataProcessing: saved } }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('says why a save was refused', async () => {
    respond({
      requests: [],
      extra: (_path, options) =>
        options?.method === 'PATCH'
          ? refuse(new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Retention must be at least 30 days.', requestId: 'r' } }))
          : undefined,
    });
    renderPanel(<Privacy canManage />);
    const retention = await screen.findByLabelText('Retention after leaving (days)');
    await userEvent.clear(retention);
    await userEvent.type(retention, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save data processing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Retention must be at least 30 days.');
  });

  it('lists requests, shows a legal hold as a state of its own, and opens what erasure would do', async () => {
    respond({ requests: [request(), request({ id: 'prq_2', kind: 'export', state: 'on_hold', subjectName: 'Priya Rao', onLegalHold: true })] });
    renderPanel(<Privacy canManage />);
    const table = await screen.findByRole('table', { name: 'Data-subject requests' });
    expect(screen.getByRole('region', { name: 'Data requests · 2' })).toBeInTheDocument();
    const priya = within(table).getByText('Priya Rao').closest('tr')!;
    expect(within(priya).getByText('A copy of their data')).toBeInTheDocument();
    expect(within(priya).getByText('legal hold')).toBeInTheDocument();

    const aman = within(table).getByText('Aman Mehra').closest('tr')!;
    await userEvent.click(within(aman).getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Overwrites 2 personal fields with “Former member 7F3A”/)).toBeInTheDocument();
    expect(screen.getByText('1095 days · keep until 2029-10-31')).toBeInTheDocument();
    expect(screen.getByText('invoices')).toBeInTheDocument();
    expect(within(aman).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('applies an erasure and says what it changed and what it kept', async () => {
    respond({
      extra: (path) => (path.endsWith('/erase') ? Promise.resolve({ pseudonym: 'Former member 7F3A', applied: 6 }) : undefined),
    });
    renderPanel(<Privacy canManage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply erasure' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/privacy/requests/prq_1/erase', { method: 'POST' }));
    expect(await screen.findByText(/Erased\. 6 personal fields overwritten/)).toBeInTheDocument();
  });

  it('will not erase while a blocker stands', async () => {
    respond({
      extra: (path) =>
        path === '/admin/privacy/requests/prq_1'
          ? Promise.resolve(
              detail({
                legalHold: { id: 'lh_1', reason: 'Insurance claim', reference: 'CLM-881', placedAt: Date.parse('2026-11-01T00:00:00Z') },
                plan: { pseudonym: 'Former member 7F3A', overwrites: [], blockers: ['A legal hold is in force.'] },
              }),
            )
          : undefined,
    });
    renderPanel(<Privacy canManage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Legal hold in force: Insurance claim \(CLM-881\)/)).toBeInTheDocument();
    expect(screen.getByText('A legal hold is in force.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply erasure' })).toBeDisabled();
  });

  it('says a request could not be opened, rather than doing nothing', async () => {
    respond({
      extra: (path) =>
        path === '/admin/privacy/requests/prq_1'
          ? refuse(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That request no longer exists.', requestId: 'r' } }))
          : undefined,
    });
    renderPanel(<Privacy canManage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    // Regression: a failed detail read rendered nothing at all.
    expect(await screen.findByText('This request could not be read')).toBeInTheDocument();
    expect(screen.getByText('That request no longer exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
