import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import PlatformScreen from '../Platform';
import { refuse, renderScreen, signInAs } from '../../test/harness';

/* The Platform shell: tenant roles are refused, support sees customers only,
   and administration adds Health. The surfaces have their own tests under
   screens/platform/__tests__. */

const TABS = ['tenants', 'health'];
const screens = [
  {
    path: '/platform',
    component: PlatformScreen,
    validateSearch: (s: Record<string, unknown>) => ({ tab: TABS.includes(s.tab as string) ? (s.tab as string) : 'tenants' }),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === '/platform/tenants') return Promise.resolve({ items: [] });
    if (path === '/platform/health') return refuse(new Error('down'));
    throw new Error(`Unexpected API call: ${path}`);
  });
});

describe('Platform', () => {
  it('refuses a gym owner, and reads nothing', async () => {
    signInAs('owner');
    renderScreen('/platform', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Platform administration is restricted/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('gives support the customer list only, even when a link asks for health', async () => {
    signInAs('platform_support');
    renderScreen('/platform?tab=health', screens);
    expect(await screen.findByRole('heading', { name: 'No customers yet' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith('/platform/health');
  });

  it('lets an administrator move to health, keeping the tab in the URL', async () => {
    const user = userEvent.setup();
    signInAs('platform_admin');
    const { router } = renderScreen('/platform', screens);
    expect(await screen.findByRole('tab', { name: 'Customers' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Health' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'health' }));
    expect(await screen.findByRole('heading', { name: 'Health could not be read' })).toBeInTheDocument();
  });
});
