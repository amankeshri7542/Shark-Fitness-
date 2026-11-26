import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountActivation } from '../AccountActivation';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: apiMock }));

function wrap(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ activationId: 'act_1', token: 'synthetic-token', expiresAt: '2026-12-01T12:00:00Z', tenantSlug: 'shark', email: 'new@test.invalid' });
});

it('points a member activation link at the member app under /app/', async () => {
  render(wrap(<AccountActivation memberId="mem_1" />));
  fireEvent.click(screen.getByRole('button', { name: 'Create activation link' }));
  const link = await screen.findByLabelText('Private activation link');
  expect((link as HTMLInputElement).value).toBe(`${window.location.origin}/app/sign-in#activationId=act_1&activationToken=synthetic-token&gym=shark`);
});

it('points a staff activation link at the console under /admin/', async () => {
  render(wrap(<AccountActivation staffId="stf_1" />));
  fireEvent.click(screen.getByRole('button', { name: 'Create activation link' }));
  const link = await screen.findByLabelText('Private activation link');
  expect((link as HTMLInputElement).value).toBe(`${window.location.origin}/admin/sign-in#activationId=act_1&activationToken=synthetic-token&gym=shark`);
});
