import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import CommunityScreen, { type ReportItem } from '../Community';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const report: ReportItem = {
  key: 'post:pst_1',
  targetType: 'post',
  targetId: 'pst_1',
  body: 'Anyone else think the new squat racks wobble?',
  state: 'visible',
  context: null,
  author: { id: 'mbr_1', name: 'Aman Mehra', memberNo: 'SF-40219', minor: false, banned: false },
  reportCount: 2,
  reasons: [{ reason: 'harassment', count: 2 }],
  notes: ['Rude to staff'],
  lastReportedRelative: '5m',
  resolution: null,
};

const screens = [{ path: '/community', component: CommunityScreen }];

function answer(overrides: Partial<Record<string, unknown>> = {}) {
  return (path: string) => {
    if (path in overrides) {
      const value = overrides[path];
      return value instanceof Error ? refuse(value) : Promise.resolve(value);
    }
    if (path.startsWith('/admin/community/reports')) return Promise.resolve({ items: [report] });
    if (path === '/admin/community/approvals') return Promise.resolve({ approvalMode: true, items: [] });
    if (path === '/admin/community/bans') return Promise.resolve({ items: [] });
    return Promise.resolve({ ok: true });
  };
}

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('owner');
});
afterEach(() => setOnline(true));

describe('Community states', () => {
  it('shows a permission state to reception', async () => {
    signInAs('reception');
    renderScreen('/community', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
  });

  it('shows the empty queue', async () => {
    apiMock.mockImplementation(answer({ '/admin/community/reports?state=open': { items: [] } }));
    renderScreen('/community', screens);
    expect(await screen.findByText('Nothing reported')).toBeInTheDocument();
  });

  it('says a failed read is not an empty queue', async () => {
    apiMock.mockImplementation(answer({ '/admin/community/reports?state=open': new Error('down') }));
    renderScreen('/community', screens);
    expect(await screen.findByText('Could not load reports')).toBeInTheDocument();
  });

  it('warns when offline and disables decisions', async () => {
    setOnline(false);
    apiMock.mockImplementation(answer());
    renderScreen('/community', screens);
    expect(await screen.findByText(/Offline\. Decisions will not save/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});

describe('Moderating', () => {
  it('shows the reported content with why, and removes it with a reason the author is told', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(answer());
    renderScreen('/community', screens);

    expect(await screen.findByText('Anyone else think the new squat racks wobble?')).toBeInTheDocument();
    expect(screen.getByText('2 reports')).toBeInTheDocument();
    expect(screen.getByText('Unkind or harassing')).toBeInTheDocument();
    expect(screen.getByText('“Rude to staff”')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this' });
    const confirm = within(dialog).getByRole('button', { name: 'Remove' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason (the member is told this)'), 'Personal remarks about staff');
    await user.click(confirm);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/community/content/post/pst_1', {
        method: 'POST',
        body: { action: 'remove', reason: 'Personal remarks about staff' },
      }),
    );
  });

  it('approves a waiting post and lets an owner switch approval mode', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(
      answer({
        '/admin/community/approvals': {
          approvalMode: true,
          items: [{ id: 'pst_9', body: 'Waiting for approval please', relativeTime: '1m', author: report.author }],
        },
      }),
    );
    renderScreen('/community', screens);
    await user.click(await screen.findByRole('tab', { name: /Approval/ }));
    expect(await screen.findByText('Waiting for approval please')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/community/approvals/pst_9', { method: 'POST', body: { decision: 'approve', reason: '' } }),
    );
    await user.click(screen.getByLabelText(/Approve member posts before they appear/));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/settings/engagement', { method: 'PATCH', body: { communityApprovalMode: false } }),
    );
  });
});
