import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import AutomationsScreen from '../Automations';
import { refuse, renderScreen, signInAs } from '../../test/harness';

/* The Automations shell: who may open it, which surface is open, and that the
   choice lives in the URL. The surfaces themselves have their own tests under
   screens/automations/__tests__. */

const TABS = ['rules', 'templates', 'runs'];
const screens = [
  {
    path: '/automations',
    component: AutomationsScreen,
    validateSearch: (s: Record<string, unknown>) => ({ tab: TABS.includes(s.tab as string) ? (s.tab as string) : 'rules' }),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  signInAs('owner');
  apiMock.mockImplementation((path: string) => {
    if (path === '/admin/automations') return Promise.resolve({ items: [], triggers: [] });
    if (path === '/admin/automations/templates') return Promise.resolve({ items: [] });
    if (path.startsWith('/admin/automations/runs')) return Promise.resolve({ items: [] });
    throw new Error(`Unexpected API call: ${path}`);
  });
});

describe('Automations', () => {
  it('shows a permission state, and reads nothing, for a role without automations', async () => {
    signInAs('reception');
    renderScreen('/automations', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Automations is restricted/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('opens on the rules and moves to the history, keeping the tab in the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderScreen('/automations', screens);
    expect(await screen.findByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/automations'));

    await user.click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'runs' }));
    expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/admin/automations/runs?limit=200');
  });

  it('opens straight onto the messages from a link', async () => {
    renderScreen('/automations?tab=templates', screens);
    expect(await screen.findByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeInTheDocument();
  });

  it('keeps a failed surface inside the shell', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/automations/runs') ? refuse(new Error('down')) : Promise.resolve({ items: [], triggers: [] }),
    );
    renderScreen('/automations?tab=runs', screens);
    expect(await screen.findByRole('heading', { name: 'The history could not be read' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });
});
