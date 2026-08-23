import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { SupportBanner } from '../SupportBanner';
import { useAdmin } from '../../lib/store';

/* ============================================================================
   The support-session banner (PF-PLAT-004).

   Its whole job is to be impossible to miss and impossible to be stuck in.
   These are the two things worth asserting: that it says who is acting as whom
   in whose gym, and that leaving works even when the server refuses — an
   operator whose session has already expired must not be trapped in a console
   they can no longer use.
   ========================================================================= */

const banner = {
  active: true as const,
  operatorName: 'Noel D’Souza',
  tenantName: 'Shark Fitness',
  userName: 'Vikas Menon',
  minutesRemaining: 42,
  expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
};

function renderBanner() {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SupportBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ok: true });
  useAdmin.setState({ impersonation: null });
});

describe('SupportBanner', () => {
  it('renders nothing at all in an ordinary session', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('names who is acting as whom, in whose gym', () => {
    useAdmin.setState({ impersonation: banner });
    renderBanner();
    const status = screen.getByRole('status');
    // All three identities in one sentence. "You are signed in as a customer"
    // without saying which customer is not a warning, it is a mood.
    expect(status).toHaveTextContent('Vikas Menon');
    expect(status).toHaveTextContent('Shark Fitness');
    expect(status).toHaveTextContent('Noel D’Souza');
    expect(status).toHaveTextContent(/recorded in their audit log/);
  });

  it('shows the time left, because support access expires on a clock', () => {
    useAdmin.setState({ impersonation: banner });
    renderBanner();
    expect(screen.getByText(/42 min left/)).toBeInTheDocument();
  });

  it('says the session is over rather than counting into the negatives', () => {
    useAdmin.setState({
      impersonation: { ...banner, minutesRemaining: 0, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    renderBanner();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('is announced to assistive technology without stealing focus', () => {
    useAdmin.setState({ impersonation: banner });
    renderBanner();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('ends the session on the server and clears it locally', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    useAdmin.setState({ impersonation: banner, signOut });
    renderBanner();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave this account' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/platform/impersonate/end', { method: 'POST' }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });

  it('still lets the operator out when the server refuses', async () => {
    // The session has already expired server-side. Failing to clear locally
    // would strand them in a console that answers 401 to everything.
    apiMock.mockRejectedValue(new Error('gone'));
    const signOut = vi.fn().mockResolvedValue(undefined);
    useAdmin.setState({ impersonation: banner, signOut });
    renderBanner();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave this account' }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
