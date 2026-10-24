import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn(), filters: { offset: 0, q: '' } }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.filters, useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../lib/store', () => ({ usePermission: () => true, useAdmin: () => 'branch' }));
vi.mock('../../ui/shell', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
import Members from '../Members';
beforeEach(() => {
  mocks.filters = { offset: 0, q: '' }; mocks.navigate.mockReset();
  mocks.api.mockResolvedValue({ total: 51, offset: 0, limit: 50, scopeNote: 'Branch', columns: { balanceVisible: true }, items: [] });
});
it('lets reception browse beyond 50 and resets the page when searching', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Members /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
  expect(mocks.navigate.mock.calls.at(-1)?.[0].search({ offset: 0 })).toMatchObject({ offset: 50 });
  mocks.filters.offset = 50;
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Ada' } });
  expect(mocks.navigate.mock.calls.at(-1)?.[0].search({ offset: 50 })).toMatchObject({ offset: 0, q: 'Ada' });
  await waitFor(() => expect(mocks.api).toHaveBeenCalled());
});
