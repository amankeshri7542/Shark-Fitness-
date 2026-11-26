import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PREDATOR_COPY } from '@shark/design-tokens';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const online = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('../../lib/realtime', () => ({ useOnline: () => online.value }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import Pass, { type PassPayload } from '../Pass';
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
  // The predator register is ON: the pass must still speak plainly.
  preferences: { register: 'predator', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
};

const NOW = Date.parse('2026-11-25T10:00:10.000Z');
const WINDOW = Math.floor(NOW / 1000 / 30);

function passes(fromWindow: number, count: number, tag = 'a') {
  return Array.from({ length: count }, (_, i) => ({
    token: `tok-${tag}-${fromWindow + i}-${'x'.repeat(40)}`,
    window: fromWindow + i,
    validFrom: (fromWindow + i) * 30,
    expiresAt: (fromWindow + i + 1) * 30,
  }));
}

function payload(overrides: Partial<PassPayload> = {}): PassPayload {
  return {
    member: { name: 'Aman Mehta', memberNo: 'SF-40219', initials: 'AM' },
    branch: { id: 'br_kor', name: 'Koramangala', timezone: 'Asia/Kolkata' },
    branches: [{ id: 'br_kor', name: 'Koramangala', home: true }],
    state: 'active',
    notice: null,
    code: { rotateSec: 30, serverEpoch: Math.floor(NOW / 1000), serverTime: new Date(NOW).toISOString(), passes: passes(WINDOW, 6) },
    membership: { state: 'active', productName: 'Depot Monthly', endsOn: '2026-12-31', graceEndsOn: null },
    outstandingMinor: 0,
    willBeAdmitted: true,
    openSession: null,
    occupancy: { inside: 12, capacity: 120, label: 'quiet' },
    history: [],
    ...overrides,
  };
}

function renderPass() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Pass />
    </QueryClientProvider>,
  );
}

function predatorStrings(): string[] {
  const plain = new Set<string>(Object.values(PREDATOR_COPY).map((entry) => entry.plain));
  return Object.values(PREDATOR_COPY)
    .map((entry): string => entry.predator)
    .filter((text) => !plain.has(text));
}

beforeEach(() => {
  online.value = true;
  localStorage.clear();
  useSession.setState({ viewer, status: 'signed-in' } as never);
});

afterEach(() => {
  vi.useRealTimers();
  api.mockReset();
});

describe('Pass', () => {
  it('shows a scannable code with a countdown read through the server clock', async () => {
    api.mockResolvedValue(payload());
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    renderPass();
    const code = await screen.findByRole('img', { name: /Entry code for Aman Mehta/ });
    expect(code.getAttribute('data-qr-value')).toBe(`tok-a-${WINDOW}-${'x'.repeat(40)}`);
    // 10 s into a 30 s window, replaced 2 s early: 18 s on the clock.
    expect(screen.getByTestId('pass-countdown')).toHaveTextContent('18');
    expect(screen.getByText(/works once, so a screenshot will not get anyone in/)).toBeInTheDocument();
    expect(screen.getByText(/screen brightness up/)).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('puts the next code on screen before the countdown reaches zero', async () => {
    api.mockResolvedValue(payload());
    vi.useFakeTimers({ shouldAdvanceTime: false, now: NOW });
    renderPass();
    for (let i = 0; i < 5 && !screen.queryByRole('img', { name: /Entry code/ }); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    const code = screen.getByRole('img', { name: /Entry code/ });
    const first = code.getAttribute('data-qr-value');
    let seen = Number(screen.getByTestId('pass-countdown').textContent);
    // Walk the clock second by second: the code must change while the
    // countdown still shows at least one second.
    for (let i = 0; i < 20 && screen.getByRole('img', { name: /Entry code/ }).getAttribute('data-qr-value') === first; i++) {
      expect(seen).toBeGreaterThanOrEqual(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      seen = Number(screen.getByTestId('pass-countdown').textContent);
    }
    expect(screen.getByRole('img', { name: /Entry code/ }).getAttribute('data-qr-value')).toBe(`tok-a-${WINDOW + 1}-${'x'.repeat(40)}`);
  });

  it('grace: the code plus a plain notice and a way to Billing', async () => {
    api.mockResolvedValue(
      payload({
        state: 'grace',
        notice: { title: 'Payment overdue', body: 'You can still check in until 2026-12-02. Pay in Billing to keep your access.', action: 'billing' },
      }),
    );
    renderPass();
    expect(await screen.findByRole('img', { name: /Entry code/ })).toBeInTheDocument();
    expect(screen.getByText('Payment overdue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Billing' })).toHaveAttribute('href', '/billing');
    expect(screen.getByText('Grace period')).toBeInTheDocument();
  });

  it.each([
    ['frozen', 'Membership frozen', 'billing'],
    ['expired', 'Membership ended', 'billing'],
    ['suspended', 'Access on hold', 'reception'],
    ['cancelled', 'Membership cancelled', 'billing'],
  ] as const)('%s: no code, the reason and what to do', async (state, title, action) => {
    api.mockResolvedValue(payload({ state, code: null, notice: { title, body: `${title}. Here is what to do.`, action } }));
    renderPass();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Entry code/ })).not.toBeInTheDocument();
    expect(screen.getByText('No entry code')).toBeInTheDocument();
    expect(screen.getByText('SF-40219')).toBeInTheDocument();
    if (action === 'billing') expect(screen.getByRole('link', { name: 'Open Billing' })).toBeInTheDocument();
    else expect(screen.getByText(/Reception can help/)).toBeInTheDocument();
  });

  it('offline: the member number and that reception can check you in with it', async () => {
    api.mockResolvedValue(payload());
    online.value = false;
    renderPass();
    expect(await screen.findByText('SF-40219')).toBeInTheDocument();
    expect(screen.getByText('Reception can check you in with this number.')).toBeInTheDocument();
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Entry code/ })).not.toBeInTheDocument();
  });

  it('refresh failure with nothing loaded: the remembered member number, and a retry', async () => {
    localStorage.setItem('shark.passcard.usr_aman', JSON.stringify({ memberNo: 'SF-40219', name: 'Aman Mehta' }));
    api.mockRejectedValue(new Error('network'));
    renderPass();
    // One retry (a second, by design) before the fallback shows.
    expect(await screen.findByText('SF-40219', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Could not get a fresh code')).toBeInTheDocument();
    expect(screen.getByText('Reception can check you in with this number.')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: /Entry code/ })).toBeInTheDocument();
  });

  it('a spent run whose refresh fails falls back to the member number', async () => {
    // Every held code is in the past: the run is spent.
    api.mockResolvedValueOnce(payload({ code: { rotateSec: 30, serverEpoch: Math.floor(NOW / 1000), serverTime: new Date(NOW).toISOString(), passes: passes(WINDOW - 10, 2) } }));
    api.mockRejectedValue(new Error('network'));
    renderPass();
    expect(await screen.findByText('Could not get a fresh code', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Reception can check you in with this number.')).toBeInTheDocument();
  });

  it('keeps the screen awake while a code shows, and lets go when the pass closes', async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(() => Promise.resolve({ release }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    try {
      api.mockResolvedValue(payload());
      const view = renderPass();
      await screen.findByRole('img', { name: /Entry code for Aman Mehta/ });
      await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
      view.unmount();
      await waitFor(() => expect(release).toHaveBeenCalled());
    } finally {
      delete (navigator as { wakeLock?: unknown }).wakeLock;
    }
  });

  it('sweeps the sonar line only while getting a fresh code, and not at all under reduced motion', async () => {
    const spent = payload({ code: { rotateSec: 30, serverEpoch: Math.floor(NOW / 1000), serverTime: new Date(NOW).toISOString(), passes: passes(WINDOW - 10, 2) } });
    const sweep = (root: HTMLElement) => root.querySelector('[style*="sf-sonar"]');

    // A spent run whose refresh is still on its way: acquiring.
    api.mockResolvedValueOnce(spent).mockImplementation(() => new Promise(() => undefined));
    const acquiring = renderPass();
    expect(await screen.findByText('Getting a fresh code…')).toBeInTheDocument();
    expect(sweep(acquiring.container)).not.toBeNull();
    acquiring.unmount();

    api.mockReset();
    useSession.setState({ viewer: { ...viewer, preferences: { ...viewer.preferences, reducedMotion: true } } } as never);
    api.mockResolvedValueOnce(spent).mockImplementation(() => new Promise(() => undefined));
    const reduced = renderPass();
    expect(await screen.findByText('Getting a fresh code…')).toBeInTheDocument();
    expect(sweep(reduced.container)).toBeNull();
    reduced.unmount();

    // A code on screen with nothing being fetched: no sweep.
    api.mockReset();
    useSession.setState({ viewer } as never);
    api.mockResolvedValue(payload());
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    const steady = renderPass();
    await screen.findByRole('img', { name: /Entry code for Aman Mehta/ });
    await waitFor(() => expect(sweep(steady.container)).toBeNull());
  });

  it('lets a member entitled to several branches pick where they are checking in', async () => {
    api.mockResolvedValue(
      payload({
        branches: [
          { id: 'br_kor', name: 'Koramangala', home: true },
          { id: 'br_ind', name: 'Indiranagar', home: false },
        ],
      }),
    );
    renderPass();
    const group = await screen.findByRole('radiogroup', { name: 'Branch you are checking in at' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Koramangala/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Indiranagar' }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/member/pass?branchId=br_ind'));
  });

  it('shows the visit in progress with a plain check-out', async () => {
    api.mockResolvedValue(payload({ openSession: { id: 'chk_1', enteredAt: new Date(NOW).toISOString(), minutesInside: 42 } }));
    renderPass();
    expect(await screen.findByText('Checked in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeInTheDocument();
  });

  it('never renders a predator string, even with the predator register on', async () => {
    api.mockResolvedValue(payload({ openSession: { id: 'chk_1', enteredAt: new Date(NOW).toISOString(), minutesInside: 3 } }));
    const { container } = renderPass();
    await screen.findByRole('img', { name: /Entry code/ });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Gym pass');
    const text = container.textContent ?? '';
    for (const predator of predatorStrings()) expect(text).not.toContain(predator);
  });

  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderPass();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
