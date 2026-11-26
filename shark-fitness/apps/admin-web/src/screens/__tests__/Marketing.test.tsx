import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import MarketingScreen, { type BroadcastRow, type Preview } from '../Marketing';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const channels = [
  { channel: 'in_app', available: true, delivers: true, driver: 'in_app', label: 'In-app', note: '' },
  { channel: 'push', available: false, delivers: false, driver: 'none', label: 'push', note: '' },
  { channel: 'email', available: true, delivers: false, driver: 'log', label: 'email', note: '' },
  { channel: 'sms', available: true, delivers: false, driver: 'log', label: 'SMS', note: '' },
  { channel: 'whatsapp', available: true, delivers: false, driver: 'log', label: 'WhatsApp', note: '' },
];

const preview: Preview = {
  segmentSize: 120,
  chosen: {
    channel: 'sms',
    label: 'SMS',
    recipients: 96,
    heldForQuietHours: 0,
    excluded: { no_consent: 20, opted_out: 4, no_destination: 0, channel_unavailable: 0, inactive: 0, missing_variable: 0 },
    ratePerMessageMinor: 25,
    estimatedCostMinor: 2400,
  },
  byChannel: [
    { channel: 'in_app', label: 'In-app', recipients: 120, heldForQuietHours: 0, excluded: {}, ratePerMessageMinor: 0, estimatedCostMinor: 0 },
    { channel: 'sms', label: 'SMS', recipients: 96, heldForQuietHours: 0, excluded: {}, ratePerMessageMinor: 25, estimatedCostMinor: 2400 },
  ],
  approvalThreshold: 50,
  approvalRequired: true,
};

const draft: BroadcastRow = {
  id: 'bct_1',
  name: 'Diwali hours',
  channel: 'sms',
  purpose: 'operational',
  title: 'Diwali hours',
  body: 'Hi {{firstName}}, we open at 8am.',
  state: 'awaiting_approval',
  recipientCount: 96,
  estimatedCostMinor: 2400,
  approvalRequired: true,
  approved: false,
  lastDryRunAt: null,
  sentAt: null,
  createdRelative: '2m',
};

const screens = [{ path: '/marketing', component: MarketingScreen }];

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('branch_manager');
});
afterEach(() => setOnline(true));

describe('Marketing states', () => {
  it('shows a permission state to reception', async () => {
    signInAs('reception');
    renderScreen('/marketing', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
  });

  it('explains broadcasts when there are none, with the approval threshold', async () => {
    apiMock.mockResolvedValue({ items: [], approvalThreshold: 50, channels });
    renderScreen('/marketing', screens);
    expect(await screen.findByText('No broadcasts yet')).toBeInTheDocument();
    expect(screen.getByText(/more than 50 people need an owner's approval/)).toBeInTheDocument();
    const strip = screen.getByRole('region', { name: 'Message channels' });
    expect(within(strip).getByText('SMS').closest('li')).toHaveTextContent('Logged only');
  });

  it('shows an error state', async () => {
    apiMock.mockImplementation(() => refuse(new Error('down')));
    renderScreen('/marketing', screens);
    expect(await screen.findByText('Could not load broadcasts')).toBeInTheDocument();
  });

  it('shows a loading state, then the offline warning', async () => {
    setOnline(false);
    let resolve: (v: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = renderScreen('/marketing', screens);
    await waitFor(() => expect(container.querySelector('.sf-skeleton')).not.toBeNull());
    resolve({ items: [draft], approvalThreshold: 50, channels });
    expect(await screen.findByText(/Offline\. Nothing can be previewed or sent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New broadcast' })).toBeDisabled();
  });
});

describe('Composing and sending', () => {
  it('previews who it reaches, why people are left out and the cost, then saves a draft', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/broadcasts') return Promise.resolve({ items: [], approvalThreshold: 50, channels });
      if (path === '/admin/broadcasts/preview') return Promise.resolve(preview);
      return Promise.resolve({ broadcast: { id: 'bct_1' } });
    });
    renderScreen('/marketing', screens);
    await user.click(await screen.findByRole('button', { name: 'New broadcast' }));
    const dialog = await screen.findByRole('dialog', { name: 'New broadcast' });
    await user.type(within(dialog).getByLabelText('Name (staff only)'), 'Diwali hours');
    await user.selectOptions(within(dialog).getByLabelText('Channel'), 'sms');
    await user.type(within(dialog).getByLabelText('Title'), 'Diwali hours');
    await user.type(within(dialog).getByLabelText('Message'), 'We open at 8am on Monday.');
    await user.click(within(dialog).getByRole('button', { name: 'Check who it reaches' }));

    expect(await within(dialog).findByText(/of 120 people in this group will get it by SMS/)).toBeInTheDocument();
    expect(within(dialog).getByText('20 left out: have not agreed to this channel')).toBeInTheDocument();
    expect(within(dialog).getByText('4 left out: switched these messages off')).toBeInTheDocument();
    expect(within(dialog).getByText(/an owner has to approve this/)).toBeInTheDocument();
    expect(within(dialog).getByRole('table', { name: 'Estimated cost by channel' })).toHaveTextContent('₹24');

    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/broadcasts',
        expect.objectContaining({ method: 'POST', body: expect.objectContaining({ channel: 'sms', segment: expect.objectContaining({ statuses: ['active'] }) }) }),
      ),
    );
  });

  it('keeps send off until an owner approves, and lets an owner approve', async () => {
    const user = userEvent.setup();
    signInAs('owner');
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/broadcasts') return Promise.resolve({ items: [draft], approvalThreshold: 50, channels });
      if (path === '/admin/broadcasts/bct_1') return Promise.resolve({ broadcast: draft, preview, report: null });
      return Promise.resolve({ ok: true, preview });
    });
    renderScreen('/marketing', screens);
    await user.click(await screen.findByRole('button', { name: /Diwali hours/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Diwali hours' });
    expect(await within(drawer).findByRole('button', { name: 'Send' })).toBeDisabled();
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/broadcasts/bct_1/approve', { method: 'POST', body: {} }));
    await user.click(within(drawer).getByRole('button', { name: 'Dry run' }));
    expect(await within(drawer).findByText(/Rehearsed: 96 would get it now\. Nothing was sent\./)).toBeInTheDocument();
  });
});
