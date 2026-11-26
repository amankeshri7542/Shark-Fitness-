import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const session = vi.hoisted(() => ({
  signOutAndWipe: vi.fn(() => Promise.resolve()),
  unsyncedWarning: vi.fn(() => Promise.resolve<string | null>(null)),
  requestDeletionAndSignOut: vi.fn(() => Promise.resolve()),
}));
const push = vi.hoisted(() => ({ supported: false }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('../../lib/session', () => session);
vi.mock('../../lib/push', () => ({
  pushSupported: () => push.supported,
  fetchPushConfig: () => Promise.resolve({ available: true, publicKey: 'BPublicKey', items: [] }),
  thisDeviceSubscription: () => null,
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { ApiError, OfflineError } from '../../lib/api';
import ProfileScreen from '../Profile';
import { useSession } from '../../lib/store';

const viewer: Viewer = {
  userId: 'usr_aman',
  tenantId: 'ten_shark',
  memberId: 'mbr_aman',
  staffId: null,
  name: 'Aman Mehta',
  initials: 'AM',
  email: 'aman@sharkfitness.in',
  role: 'member',
  accountState: 'active',
  homeBranchId: 'br_kor',
  permittedBranchIds: ['br_kor'],
  permissions: [],
  preferences: { register: 'predator', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
};

/** GET /me/consents and /me/sessions as routes/me.ts sends them. */
const consents = {
  items: [
    { purpose: 'terms', granted: true, version: '1.0', currentVersion: '1.0', required: true, description: 'Terms of membership', updatedAt: '2026-01-01T00:00:00Z' },
    { purpose: 'marketing_email', granted: true, version: '1.0', currentVersion: '1.0', required: false, description: 'Offers and news by email', updatedAt: '2026-01-01T00:00:00Z' },
    { purpose: 'community_visibility', granted: false, version: '1.0', currentVersion: '1.0', required: false, description: 'Show your name on gym leaderboards', updatedAt: '2026-01-01T00:00:00Z' },
  ],
};
const sessions = {
  items: [
    { id: 'ses_here', userAgent: 'Chrome on Android', ip: '10.0.0.4', current: true },
    { id: 'ses_ipad', userAgent: 'Safari on iPad', ip: '10.0.0.9', current: false },
  ],
};

type Handler = (options?: { method?: string; body?: unknown }) => unknown;
let server: Record<string, Handler>;

beforeEach(() => {
  push.supported = false;
  useSession.setState({ viewer, status: 'signed-in' } as never);
  server = {
    'GET /me/consents': () => consents,
    'GET /me/sessions': () => sessions,
  };
  api.mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const handler = server[`${options.method ?? 'GET'} ${path}`];
    if (!handler) throw new Error(`Unexpected ${options.method ?? 'GET'} ${path}`);
    return handler(options);
  });
});
afterEach(() => {
  api.mockReset();
  navigate.mockClear();
  Object.values(session).forEach((fn) => fn.mockClear());
  session.unsyncedWarning.mockImplementation(() => Promise.resolve(null));
});

function renderProfile(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <ProfileScreen />
    </QueryClientProvider>,
  );
}

const fail = (status = 500, message = 'x', code: 'INTERNAL' | 'FORBIDDEN' | 'VALIDATION_FAILED' = 'INTERNAL') => {
  throw new ApiError(status, { error: { code, message, requestId: 'r' } });
};

describe('Profile', () => {
  it('shows a loading skeleton until the viewer is known', () => {
    useSession.setState({ viewer: null } as never);
    const { container } = renderProfile();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders who is signed in, the menu, permissions and devices', async () => {
    renderProfile();
    expect(screen.getByRole('heading', { level: 2, name: 'Aman Mehta' })).toBeInTheDocument();
    expect(screen.getByText('aman@sharkfitness.in')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'More' })).getByRole('link', { name: /Billing/ })).toHaveAttribute('href', '/billing');
    // A required permission cannot be switched off.
    const terms = await screen.findByRole('checkbox', { name: /Terms of membership/ });
    expect(terms).toBeChecked();
    expect(terms).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Offers and news by email' })).toBeEnabled();
    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPad')).toBeInTheDocument();
  });

  it('withdrawing a permission saves the refusal and refreshes', async () => {
    server['PUT /me/consents'] = () => ({ ok: true });
    renderProfile();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Offers and news by email' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/me/consents', { method: 'PUT', body: { purpose: 'marketing_email', granted: false } }));
    await waitFor(() => expect(api.mock.calls.filter(([path, options]) => path === '/me/consents' && !options).length).toBe(2));
  });

  it('a refused permission change says why, and can be dismissed', async () => {
    server['PUT /me/consents'] = () => fail(403, 'A support session cannot change consent.', 'FORBIDDEN');
    renderProfile();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show your name on gym leaderboards' }));
    expect(await screen.findByText('A support session cannot change consent.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('A support session cannot change consent.')).not.toBeInTheDocument();
  });

  it('a preference applies at once and rolls back if the save fails', async () => {
    server['PATCH /me/preferences'] = () => {
      throw new OfflineError();
    };
    renderProfile();
    fireEvent.click(screen.getByRole('tab', { name: 'lb' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/me/preferences', { method: 'PATCH', body: { unitSystem: 'imperial' } }));
    expect(await screen.findByText('That did not go through. Nothing has changed.')).toBeInTheDocument();
    expect(useSession.getState().viewer?.preferences.unitSystem).toBe('metric');
    expect(screen.getByRole('tab', { name: 'kg' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a saved preference takes the server’s viewer', async () => {
    server['PATCH /me/preferences'] = ({ body } = {}) => ({ viewer: { ...viewer, preferences: { ...viewer.preferences, ...(body as object) } } });
    renderProfile();
    fireEvent.click(screen.getByRole('checkbox', { name: /Reduce motion/ }));
    await waitFor(() => expect(useSession.getState().viewer?.preferences.reducedMotion).toBe(true));
    expect(screen.getByRole('checkbox', { name: /Reduce motion/ })).toBeChecked();
  });

  it('signs another device out', async () => {
    server['DELETE /me/sessions/ses_ipad'] = () => ({ ok: true });
    renderProfile();
    await screen.findByText('Safari on iPad');
    const ipad = screen.getByText('Safari on iPad').closest('div.flex') as HTMLElement;
    fireEvent.click(within(ipad).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('That device has been signed out.')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/me/sessions/ses_ipad', { method: 'DELETE' });
  });

  it('sign out wipes this phone and goes to sign-in', async () => {
    renderProfile();
    fireEvent.click(within(screen.getByTestId('sign-out')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(session.signOutAndWipe).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
  });

  it('sign out with unsynced writes warns first, and Stay keeps the member signed in', async () => {
    session.unsyncedWarning.mockImplementation(() => Promise.resolve("2 workout sets haven't synced yet"));
    renderProfile();
    fireEvent.click(within(screen.getByTestId('sign-out')).getByRole('button', { name: 'Sign out' }));
    const warning = await screen.findByRole('alertdialog');
    expect(warning).toHaveTextContent("2 workout sets haven't synced yet. If you sign out now they are deleted from this phone");
    fireEvent.click(within(warning).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(session.signOutAndWipe).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId('sign-out')).getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(session.signOutAndWipe).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
  });

  it('records a data export request', async () => {
    server['POST /me/data-export'] = () => ({ message: 'Request recorded. The privacy contact replies within 30 days.' });
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Request a copy of my data' }));
    expect(await screen.findByText('Request recorded. The privacy contact replies within 30 days.')).toBeInTheDocument();
  });

  it('deletion asks first, says what survives, and Keep my account backs out', async () => {
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Request account deletion' }));
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeInTheDocument();
    expect(screen.getByText(/does not automatically erase/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my account' }));
    expect(session.requestDeletionAndSignOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Request account deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request deletion' }));
    await waitFor(() => expect(session.requestDeletionAndSignOut).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
  });

  it('a failed deletion request says nothing changed and stays put', async () => {
    session.requestDeletionAndSignOut.mockImplementationOnce(() => Promise.reject(new OfflineError()));
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Request account deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request deletion' }));
    expect(await screen.findByText('That did not go through. Nothing has changed.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('permissions and devices that fail to load each say so, and retry', async () => {
    let consentCalls = 0;
    let sessionCalls = 0;
    server['GET /me/consents'] = () => (consentCalls++ === 0 ? fail() : consents);
    server['GET /me/sessions'] = () => (sessionCalls++ === 0 ? fail() : sessions);
    renderProfile();
    expect(await screen.findByRole('heading', { name: 'Could not load your permissions' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Could not load your devices' })).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'Try again' })) fireEvent.click(button);
    expect(await screen.findByRole('checkbox', { name: 'Offers and news by email' })).toBeInTheDocument();
    expect(await screen.findByText('This device')).toBeInTheDocument();
  });

  it('offline: the saved permissions stay on screen when the refresh fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['consents'], consents, { updatedAt: Date.now() - 60 * 60 * 1000 });
    server['GET /me/consents'] = () => {
      throw new OfflineError();
    };
    renderProfile(client);
    await waitFor(() => expect(client.getQueryState(['consents'])?.status).toBe('error'));
    expect(screen.getByRole('checkbox', { name: 'Offers and news by email' })).toBeChecked();
    expect(screen.queryByRole('heading', { name: 'Could not load your permissions' })).not.toBeInTheDocument();
  });

  it('notifications blocked in the phone’s settings: says where to allow them (permission refused)', async () => {
    push.supported = true;
    const original = (globalThis as { Notification?: unknown }).Notification;
    (globalThis as { Notification?: unknown }).Notification = { permission: 'denied' };
    try {
      renderProfile();
      expect(await screen.findByText(/Notifications are blocked for this app in your browser or phone settings/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Turn on notifications' })).not.toBeInTheDocument();
    } finally {
      (globalThis as { Notification?: unknown }).Notification = original;
    }
  });
});
