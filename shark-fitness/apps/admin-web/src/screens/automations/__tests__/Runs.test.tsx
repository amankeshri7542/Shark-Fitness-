import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import Runs from '../Runs';

/* The automation history (PF-COMM-005): every decision, including the ones
   not to send. Fixtures follow `runHistory` in apps/api/src/services/automations.ts. */

const sent = {
  id: 'arn_1',
  at: '2026-11-20T04:30:00.000Z',
  automationId: 'atm_renew',
  automationName: 'Renewal reminder',
  memberName: 'Aman Mehra',
  memberId: 'mbr_1',
  outcome: 'sent',
  reason: 'Delivered to the inbox.',
  channel: 'in_app',
  dueAt: '2026-11-20T04:30:00.000Z',
  attempts: 1,
  lastAttemptAt: '2026-11-20T04:30:00.000Z',
};

const held = {
  ...sent,
  id: 'arn_2',
  memberName: 'Riya Kapoor',
  memberId: 'mbr_2',
  outcome: 'suppressed',
  reason: 'Opted out of marketing messages.',
  dueAt: null,
  attempts: 0,
  lastAttemptAt: null,
};

beforeEach(() => {
  apiMock.mockReset();
});

describe('Runs', () => {
  it('holds the table back while the history is loading', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPanel(<Runs />);
    expect(screen.getByRole('group', { name: 'Outcome' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expect(screen.queryByText('The history could not be read')).toBeNull();
    resolve({ items: [sent] });
    expect(await screen.findByRole('table', { name: 'Automation history' })).toBeInTheDocument();
  });

  it('says there is no history yet rather than showing an empty table', async () => {
    apiMock.mockResolvedValue({ items: [] });
    renderPanel(<Runs />);
    expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    expect(screen.getByText(/record every decision they make/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a failed read as an error with the server message, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementationOnce(() =>
      refuse(new ApiError(403, { error: { code: 'FORBIDDEN', message: 'Automations are not available to your role.', requestId: 'req_1' } })),
    );
    renderPanel(<Runs />);
    expect(await screen.findByRole('heading', { name: 'The history could not be read' })).toBeInTheDocument();
    expect(screen.getByText('Automations are not available to your role.')).toBeInTheDocument();

    apiMock.mockResolvedValue({ items: [sent] });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('cell', { name: 'Renewal reminder' })).toBeInTheDocument();
  });

  it('lists sends and refusals with their reasons', async () => {
    apiMock.mockResolvedValue({ items: [sent, held] });
    renderPanel(<Runs />);
    const table = await screen.findByRole('table', { name: 'Automation history' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Aman Mehra')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Sent')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('in-app')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('1 attempt')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Held')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Opted out of marketing messages.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/admin/automations/runs?limit=200');
  });

  it('filters by outcome and says when nothing matched', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => Promise.resolve({ items: path.includes('outcome=') ? [] : [sent] }));
    renderPanel(<Runs />);
    await screen.findByRole('table', { name: 'Automation history' });
    await user.click(screen.getByRole('button', { name: 'failed' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/automations/runs?limit=200&outcome=failed'));
    expect(await screen.findByText('No runs with that outcome.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'failed' })).toHaveAttribute('aria-pressed', 'true');
  });
});
