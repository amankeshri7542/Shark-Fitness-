import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ leadId: 'lead_web' }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/admin/leads/lead_web" className={className}>
      {children}
    </a>
  ),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

vi.mock('../../lib/store', () => ({
  usePermission: () => true,
  useAdmin: (select: (state: { branches: Array<{ id: string; name: string }>; activeBranchId: string | null }) => unknown) =>
    select({ branches: [{ id: 'br_kor', name: 'Koramangala Depot' }], activeBranchId: null }),
}));

import LeadsScreen from '../Leads';
import LeadDetailScreen from '../LeadDetail';
import PlansScreen from '../Plans';

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const websiteLead = {
  id: 'lead_web',
  name: 'Ishaan Menon',
  phone: '+919845012345',
  email: null,
  source: 'website',
  stage: 'new',
  branchName: 'Koramangala Depot',
  ownerName: null,
  expectedValueMinor: 0,
  nextActionLabel: 'Call back to confirm the free trial',
  slaBreached: false,
  duplicateOfId: null,
  convertedMemberId: null,
  campaign: 'hsr-society-nov',
  utm: { source: 'qr', medium: 'flyer', campaign: 'hsr-society-nov' },
  trial: { requestedAt: '2026-11-25T10:00:00.000Z', confirmedAt: null },
};

describe('Leads: website enquiries', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('labels the source Website, shows the trial chip and the QR campaign', async () => {
    apiMock.mockResolvedValue({ total: 1, byStage: { new: 1 }, items: [websiteLead], hasMore: false });
    renderWithClient(<LeadsScreen />);

    const card = (await screen.findByText('Ishaan Menon')).closest('a')!;
    expect(within(card).getByText(/Website/)).toBeInTheDocument();
    expect(within(card).getByText('trial requested')).toBeInTheDocument();
    expect(within(card).getByText(/qr · hsr-society-nov/)).toBeInTheDocument();
  });

  it('asks the API for website leads only when the Website filter is pressed', async () => {
    apiMock.mockResolvedValue({ total: 0, byStage: {}, items: [], hasMore: false });
    renderWithClient(<LeadsScreen />);
    await screen.findByText('No leads yet');
    expect(apiMock).toHaveBeenLastCalledWith('/admin/leads?limit=500');

    await userEvent.click(screen.getByRole('button', { name: 'Website' }));
    await screen.findByText('No website leads yet');
    expect(apiMock).toHaveBeenLastCalledWith('/admin/leads?limit=500&source=website');
    expect(screen.getByRole('button', { name: 'Website' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith('/admin/leads?limit=500'));
  });
});

describe('Lead detail: free trial', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  const detail = (trialConfirmed = false) => ({
    lead: {
      ...websiteLead,
      lossReason: null,
      tags: [],
      goal: 'Group classes',
      preferredTime: null,
      interestedPlan: { id: 'prd_elite_annual', name: 'Elite Annual' },
      referralCode: null,
      consents: [
        { purpose: 'processing', granted: true, noticeVersion: 'web-2026-11', source: 'website:trial', capturedAt: '2026-11-25T10:00:00.000Z' },
        { purpose: 'marketing', granted: false, noticeVersion: 'web-2026-11', source: 'website:trial', capturedAt: '2026-11-25T10:00:00.000Z' },
      ],
      trial: {
        requestedAt: '2026-11-25T10:00:00.000Z',
        sessionId: 'cls_spin',
        sessionLabel: 'Spin Sprint · 2026-11-26 18:30',
        preferredTime: null,
        confirmedSessionId: trialConfirmed ? 'cls_spin' : null,
        confirmedSessionLabel: trialConfirmed ? 'Spin Sprint · 2026-11-26 18:30' : null,
        confirmedAt: trialConfirmed ? '2026-11-25T11:00:00.000Z' : null,
      },
    },
    activities: [],
    availableStages: ['contacted', 'lost', 'disqualified'],
    duplicate: null,
    ownerUnavailable: false,
    existingMember: null,
  });

  it('shows what was asked for, the campaign and consent, and confirms the requested class', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/admin/leads/lead_web') return detail();
      if (path === '/admin/leads/lead_web/trial/options') {
        return {
          items: [
            { id: 'cls_hiit', label: 'Apex HIIT · 2026-11-26 07:00', trainerName: 'Rehan Shaikh', openSpots: 4, requested: false },
            { id: 'cls_spin', label: 'Spin Sprint · 2026-11-26 18:30', trainerName: 'Priya Nair', openSpots: 0, requested: true },
          ],
        };
      }
      if (path === '/admin/leads/lead_web/trial/confirm' && init?.method === 'POST') return { ok: true, stage: 'trial_booked', sessionLabel: 'x' };
      throw new Error(`unexpected ${JSON.stringify([path, init])}`);
    });
    renderWithClient(<LeadDetailScreen />);

    const trial = (await screen.findByRole('heading', { name: 'Free trial' })).closest('section')!;
    expect(within(trial).getByText('Spin Sprint · 2026-11-26 18:30')).toBeInTheDocument();
    const enquiry = screen.getByRole('heading', { name: 'Enquiry' }).closest('section')!;
    expect(within(enquiry).getByText('qr · flyer · hsr-society-nov')).toBeInTheDocument();
    expect(within(enquiry).getByText('Elite Annual')).toBeInTheDocument();
    expect(within(enquiry).getByText('Do not add this person to offers or broadcasts.')).toBeInTheDocument();

    const select = await within(trial).findByLabelText('Class agreed on the call');
    expect(select).toHaveValue('cls_spin');
    await userEvent.selectOptions(select, 'cls_hiit');
    await userEvent.type(within(trial).getByLabelText('Note for the timeline'), 'Bring a towel');
    await userEvent.click(within(trial).getByRole('button', { name: 'Confirm trial' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/leads/lead_web/trial/confirm', {
        method: 'POST',
        body: { sessionId: 'cls_hiit', note: 'Bring a towel' },
      }),
    );
  });

  it('shows the API’s reason when a confirmation is refused, and a confirmed trial', async () => {
    const { ApiError } = await import('../../lib/api');
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/leads/lead_web') return detail(true);
      if (path === '/admin/leads/lead_web/trial/options') return { items: [{ id: 'cls_spin', label: 'Spin Sprint · 2026-11-26 18:30', trainerName: null, openSpots: 3, requested: true }] };
      throw new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Choose an upcoming class at this lead’s branch.', requestId: 'req_test' } } as never);
    });
    renderWithClient(<LeadDetailScreen />);
    const trial = (await screen.findByRole('heading', { name: 'Free trial' })).closest('section')!;
    expect(within(trial).getByText('confirmed')).toBeInTheDocument();
    await userEvent.click(await within(trial).findByRole('button', { name: 'Change trial class' }));
    expect(await within(trial).findByRole('alert')).toHaveTextContent('Choose an upcoming class');
  });
});

describe('Plans: Show on website', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('publishes and unpublishes a plan', async () => {
    const product = (overrides: Record<string, unknown>) => ({
      id: 'prd_offpeak',
      kind: 'membership',
      name: 'Off-Peak Monthly',
      description: 'Weekdays between 10am and 4pm.',
      version: 1,
      priceMinor: 199_900,
      priceLabel: '₹1,999',
      cadence: 'monthly',
      durationDays: 30,
      credits: null,
      access: { allBranches: false, branchIds: ['br_kor'] },
      freeze: { allowed: false, maxDaysPerTerm: 0 },
      cancellation: { noticeDays: 7, refundable: false, description: '' },
      branchIds: ['br_kor'],
      status: 'active',
      public: true,
      ...overrides,
    });
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/billing/products') return { items: [product({})] };
      return { ok: true, public: false, listed: false };
    });
    renderWithClient(<PlansScreen />);

    const box = await screen.findByRole('checkbox', { name: /Show on website/ });
    expect(box).toBeChecked();
    expect(screen.getByText('Listed on Plans & pricing with its price including GST.')).toBeInTheDocument();
    await userEvent.click(box);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/billing/products/prd_offpeak/website', { method: 'PUT', body: { public: false } }),
    );
  });
});
