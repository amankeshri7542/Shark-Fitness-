import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createClientErrorReporter } from '@shark/contracts';
import { AppErrorBoundary } from '../ErrorBoundary';
import { installGlobalErrorListeners } from '../../lib/error-reporting';
import { ApiError } from '../../lib/api';

function Bomb({ message }: { message: string }): never {
  throw new TypeError(message);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

beforeEach(() => {
  // React logs every error a boundary catches; the assertions below are what matter.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('member app error boundary', () => {
  it('replaces a crashed tree with the plain recovery screen and a reference', async () => {
    const send = vi.fn(async () => undefined);
    const reporter = createClientErrorReporter({ source: 'member', endpoint: '/v1/client-errors', storage: memoryStorage(), send });
    render(
      <AppErrorBoundary reporter={reporter}>
        <Bomb message="Cannot read properties of undefined (reading 'plan')" />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    const reference = screen.getByTestId('error-reference').textContent ?? '';
    expect(reference).toMatch(/^ERR-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, string])[1]) as Record<string, unknown>;
    expect(body).toMatchObject({ source: 'member', kind: 'boundary', name: 'TypeError', reference });
  });

  it('posts once per error fingerprint, however often the same crash renders', async () => {
    const send = vi.fn(async () => undefined);
    const reporter = createClientErrorReporter({ source: 'member', endpoint: '/v1/client-errors', storage: memoryStorage(), send });
    const first = render(
      <AppErrorBoundary reporter={reporter}>
        <Bomb message="Row 3 has no plan" />
      </AppErrorBoundary>,
    );
    const firstReference = screen.getByTestId('error-reference').textContent;
    first.unmount();
    render(
      <AppErrorBoundary reporter={reporter}>
        <Bomb message="Row 8 has no plan" />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('error-reference').textContent).toBe(firstReference);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(1);

    render(
      <AppErrorBoundary reporter={reporter}>
        <Bomb message="A different failure" />
      </AppErrorBoundary>,
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it('sends to /v1/client-errors with the default reporter', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    render(
      <AppErrorBoundary>
        <Bomb message="default reporter probe" />
      </AppErrorBoundary>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/client-errors$/);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true });
    expect(JSON.parse(String(init!.body))).toMatchObject({ source: 'member', message: 'default reporter probe' });
  });
});

describe('global error listeners', () => {
  it('report window errors and unhandled rejections, but not API or offline failures', () => {
    const target = new EventTarget() as unknown as Window;
    const report = vi.fn(() => ({ reference: 'ERR-AAAA-BBBB', sent: true }));
    installGlobalErrorListeners(target, { report, referenceFor: () => 'ERR-AAAA-BBBB' });

    const boom = new Error('handler blew up');
    target.dispatchEvent(Object.assign(new Event('error'), { error: boom, message: boom.message }));
    const rejected = new RangeError('async blew up');
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: rejected }));
    const apiFailure = new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_1' } });
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: apiFailure }));
    target.dispatchEvent(Object.assign(new Event('error'), { error: null, message: '' }));

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, boom, 'error');
    expect(report).toHaveBeenNthCalledWith(2, rejected, 'unhandledrejection');
  });
});

describe('offline', () => {
  it('explains that an unvisited screen needs a connection and reports nothing', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const send = vi.fn(async () => undefined);
    const reporter = createClientErrorReporter({ source: 'member', endpoint: '/v1/client-errors', storage: memoryStorage(), send });
    render(
      <AppErrorBoundary reporter={reporter}>
        <Bomb message="Failed to fetch dynamically imported module: /app/assets/Pack-x.js" />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("You're offline");
    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/app/');
    await new Promise((done) => setTimeout(done, 20));
    expect(send).not.toHaveBeenCalled();
  });
});
