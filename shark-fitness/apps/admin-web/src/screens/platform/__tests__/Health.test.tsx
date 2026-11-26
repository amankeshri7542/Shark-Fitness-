import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlatformHealth } from '@shark/contracts';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { refuse } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import Health from '../Health';

/* Service health (PF-PLAT-003). Shape follows PlatformHealth in
   packages/contracts/src/schemas/platform.ts. */

const job = {
  name: 'membership-expiry',
  everyMinutes: 60,
  lastRunAt: '2026-11-26T04:00:00.000Z',
  status: 'succeeded' as const,
  durationMs: 42,
  error: null,
  summary: {},
  buildId: null,
  lastSuccessfulRunAt: '2026-11-26T04:00:00.000Z',
  lastFailedRunAt: null,
  lastFailureCategory: null,
  lastFailureMessage: null,
  nextExpectedAt: '2026-11-26T05:00:00.000Z',
  health: 'healthy' as const,
};

function health(overrides: Partial<PlatformHealth> = {}): PlatformHealth {
  return {
    computedAt: '2026-11-26T04:30:00.000Z',
    tenants: { total: 12, active: 9, trial: 2, suspended: 1, archived: 0 },
    members: 15400,
    checkIns24h: 830,
    jobs: [
      job,
      {
        ...job,
        name: 'outbox-dispatch',
        everyMinutes: 1,
        status: 'failed',
        lastFailedRunAt: '2026-11-26T04:29:00.000Z',
        lastFailureMessage: 'SMTP connection refused',
        health: 'failing',
        durationMs: null,
      },
    ],
    outboxPending: 37,
    activeSupportSessions: 0,
    metersNeedingAttention: [],
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('Health', () => {
  it('holds the figures back while health loads', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPanel(<Health />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Health could not be read')).toBeNull();
    resolve(health());
    expect(await screen.findByRole('table', { name: 'Scheduled jobs' })).toBeInTheDocument();
  });

  it('shows a failed read as an error, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementationOnce(() => refuse(new Error('down')));
    renderPanel(<Health />);
    expect(await screen.findByRole('heading', { name: 'Health could not be read' })).toBeInTheDocument();
    expect(screen.getByText('The server did not answer.')).toBeInTheDocument();
    apiMock.mockResolvedValue(health());
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Scheduled jobs' })).toBeInTheDocument();
  });

  it('shows the estate, a failing job and that nobody is near a quota', async () => {
    apiMock.mockResolvedValue(health());
    renderPanel(<Health />);
    const jobs = await screen.findByRole('table', { name: 'Scheduled jobs' });
    expect(apiMock).toHaveBeenCalledWith('/platform/health');
    expect(screen.getByText('9 active · 2 trial · 1 suspended')).toBeInTheDocument();
    expect(screen.getByText('15,400')).toBeInTheDocument();
    expect(screen.getByText('nobody is inside a customer account')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();

    const [, hourly, outbox] = within(jobs).getAllByRole('row');
    expect(within(hourly!).getByText('membership expiry')).toBeInTheDocument();
    expect(within(hourly!).getByText('1 h')).toBeInTheDocument();
    expect(within(hourly!).getByText('healthy')).toBeInTheDocument();
    expect(within(outbox!).getByText('1 min')).toBeInTheDocument();
    expect(within(outbox!).getByText('failing')).toBeInTheDocument();
    expect(within(outbox!).getByText('SMTP connection refused')).toBeInTheDocument();

    // An empty meter list is said, not drawn as an empty table.
    expect(screen.getByText('Nobody is close to a quota.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Gyms near a limit' })).toBeNull();
  });

  it('lists gyms near a limit and open support sessions', async () => {
    apiMock.mockResolvedValue(
      health({
        activeSupportSessions: 2,
        metersNeedingAttention: [
          { tenantId: 'ten_shark', tenantName: 'Shark Fitness', meter: 'sms_sent', period: '2026-11', used: 5200, limit: 5000, health: 'exceeded', percent: 104 },
        ],
      }),
    );
    renderPanel(<Health />);
    const meters = await screen.findByRole('table', { name: 'Gyms near a limit' });
    expect(screen.getByText('open right now')).toBeInTheDocument();
    const [, row] = within(meters).getAllByRole('row');
    expect(within(row!).getByText('Shark Fitness')).toBeInTheDocument();
    expect(within(row!).getByText('sms sent')).toBeInTheDocument();
    expect(within(row!).getByText('5,200')).toBeInTheDocument();
    expect(within(row!).getByText('104%')).toBeInTheDocument();
  });
});
