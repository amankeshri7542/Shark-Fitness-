import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WebhookDelivery, WebhookEndpoint } from '@shark/contracts';
import { renderPanel } from './harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api')>()), api }));
vi.mock('../../../lib/store', () => ({ useBranchTimeZone: () => 'Asia/Kolkata' }));

import { ApiError } from '../../../lib/api';
import Integrations from '../Integrations';

const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 'whe_1', url: 'https://crm.example.com/hooks/shark', description: 'CRM sync', events: ['lead.created', 'member.created'], state: 'active',
  disabledReason: null, disabledAt: null, consecutiveFailures: 0, secretHint: 'a1b2', previousSecretExpiresAt: null,
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', lastDelivery: { at: '2026-11-25T04:00:00.000Z', ok: true, statusCode: 200 }, ...overrides,
});
const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'whd_1', endpointId: 'whe_1', eventId: 'evt_1', eventType: 'lead.created', state: 'failed', attempts: 7, nextAttemptAt: null,
  createdAt: '2026-11-24T00:00:00.000Z', completedAt: '2026-11-24T20:00:00.000Z', replayOf: null, test: false, lastStatusCode: 500, lastError: 'The receiver answered 500.',
  log: [{ attempt: 1, at: '2026-11-24T00:00:00.000Z', statusCode: 500, ok: false, latencyMs: 120, error: 'The receiver answered 500.', responseExcerpt: 'boom' }], ...overrides,
});

beforeEach(() => {
  api.mockReset();
});

it('is closed to roles without settings access', () => {
  renderPanel(<Integrations canManage={false} />);
  expect(screen.getByText('Not available to your role')).toBeInTheDocument();
});

it('starts empty, adds an endpoint and shows its secret once', async () => {
  const items: WebhookEndpoint[] = [];
  api.mockImplementation(async (path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === '/admin/integrations/webhooks' && !options?.method) return { items };
    if (path === '/admin/integrations/webhooks' && options?.method === 'POST') {
      items.push(endpoint({ url: String(options.body?.url) }));
      return { endpoint: items[0], secret: 'whsec_brandnewsecretvalue' };
    }
    throw new Error(path);
  });
  renderPanel(<Integrations canManage />);
  expect(await screen.findByText('No endpoints yet')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Add endpoint' })[0]!);
  const dialog = screen.getByRole('dialog', { name: 'Add endpoint' });
  const submit = within(dialog).getByRole('button', { name: 'Add endpoint' });
  expect(submit).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText('Endpoint URL'), { target: { value: 'https://crm.example.com/hooks/shark' } });
  fireEvent.click(within(dialog).getByLabelText(/Lead created/));
  fireEvent.click(within(dialog).getByLabelText(/Payment received/));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/admin/integrations/webhooks', {
      method: 'POST',
      body: { url: 'https://crm.example.com/hooks/shark', description: '', events: ['lead.created', 'payment.succeeded'] },
    }),
  );
  expect(await screen.findByTestId('webhook-secret')).toHaveTextContent('whsec_brandnewsecretvalue');
  expect(screen.getByText(/Copy it now/)).toBeInTheDocument();
});

it('shows a refused URL in the form', async () => {
  api.mockImplementation(async (_path: string, options?: { method?: string }) => {
    if (!options?.method) return { items: [] };
    throw new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Refused', requestId: 'r', fields: [{ path: 'url', code: 'unsafe_url', message: 'That address points at a private, link-local or reserved address, which webhooks may not reach.' }] } });
  });
  renderPanel(<Integrations canManage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Add endpoint' }))[0]!);
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Endpoint URL'), { target: { value: 'https://10.0.0.1/hook' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select all' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('private, link-local or reserved');
});

it('says plainly when the product turned an endpoint off, and lists, logs and replays deliveries', async () => {
  api.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/admin/integrations/webhooks') return { items: [endpoint({ state: 'disabled', disabledReason: 'Disabled after 15 failed deliveries in a row. Fix the receiver, then turn the endpoint back on.' })] };
    if (path === '/admin/integrations/webhooks/whe_1/deliveries') return { items: [delivery()] };
    if (path === '/admin/integrations/webhooks/deliveries/whd_1/replay' && options?.method === 'POST') return { delivery: delivery({ id: 'whd_2', state: 'succeeded' }) };
    if (path === '/admin/integrations/webhooks/whe_1' && options?.method === 'PATCH') return { endpoint: endpoint() };
    throw new Error(path);
  });
  renderPanel(<Integrations canManage />);
  expect(await screen.findByText('Turned off')).toBeInTheDocument();
  expect(screen.getByText(/15 failed deliveries in a row/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send test event' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Deliveries' }));
  const table = await screen.findByRole('table', { name: 'Recent deliveries' });
  expect(within(table).getByText('Gave up')).toBeInTheDocument();
  fireEvent.click(within(table).getByRole('button', { name: 'Log' }));
  expect(screen.getByRole('list', { name: 'Attempts' })).toHaveTextContent('#1');
  fireEvent.click(within(table).getByRole('button', { name: 'Replay' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/integrations/webhooks/deliveries/whd_1/replay', { method: 'POST' }));

  fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/integrations/webhooks/whe_1', { method: 'PATCH', body: { state: 'active' } }));
});

it('reports a test send result', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/admin/integrations/webhooks') return { items: [endpoint()] };
    if (path === '/admin/integrations/webhooks/whe_1/test') return { delivery: delivery({ test: true, eventType: 'webhook.test', log: [{ attempt: 1, at: '2026-11-25T04:00:00.000Z', statusCode: 204, ok: true, latencyMs: 85, error: null, responseExcerpt: null }] }) };
    throw new Error(path);
  });
  renderPanel(<Integrations canManage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Send test event' }));
  expect(await screen.findByText('Test delivered with 204 in 85 ms.')).toBeInTheDocument();
});

it('shows a load failure', async () => {
  api.mockRejectedValue(new Error('down'));
  renderPanel(<Integrations canManage />);
  expect(await screen.findByText('Could not load integrations')).toBeInTheDocument();
});
