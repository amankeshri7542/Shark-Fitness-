import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const navigateMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { useAdmin } from '../../lib/store';
import { CommandPalette } from '../shell';

const viewer = (role: string) =>
  ({ userId: 'usr_1', tenantId: 'ten_shark', name: 'Priya Rao', role, permittedBranchIds: ['br_kor'] }) as unknown as Viewer;

function Harness() {
  const togglePalette = useAdmin((state) => state.togglePalette);
  return (
    <>
      <button type="button" onClick={() => togglePalette(true)}>
        Search
      </button>
      <CommandPalette />
    </>
  );
}

function renderPalette() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const results = {
  results: [
    { type: 'member', id: 'mbr_1', title: 'Aman Mehra', subtitle: 'SF-40219 · Koramangala · active', to: '/members/mbr_1', meta: { memberNo: 'SF-40219' } },
    { type: 'invoice', id: 'inv_1', title: 'INV-1042 · Aman Mehra', subtitle: 'open · ₹4,999 due', to: '/billing?invoice=inv_1' },
  ],
};

describe('CommandPalette', () => {
  beforeEach(() => {
    localStorage.clear();
    navigateMock.mockReset();
    apiMock.mockReset();
    apiMock.mockResolvedValue(results);
    useAdmin.setState({ viewer: viewer('owner'), paletteOpen: false, branches: [], activeBranchId: null });
  });

  it('focuses the combobox on open and returns focus to its trigger after Escape', async () => {
    const user = userEvent.setup();
    renderPalette();
    const trigger = screen.getByRole('button', { name: 'Search' });
    await user.click(trigger);

    const combo = screen.getByRole('combobox', { name: 'Search and commands' });
    expect(combo).toHaveFocus();
    expect(combo).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('opens with Ctrl+K, searches the server, and Enter on an arrowed result opens it', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const combo = screen.getByRole('combobox');
    await user.type(combo, 'aman');
    const option = await screen.findByRole('option', { name: /Aman MehraSF-40219/ });
    expect(apiMock).toHaveBeenCalledWith('/admin/search?q=aman');

    // Arrow down from the first option until the member is active.
    const options = screen.getAllByRole('option');
    const index = options.indexOf(option);
    for (let i = 0; i < index; i++) await user.keyboard('{ArrowDown}');
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(combo).toHaveAttribute('aria-activedescendant', option.id);
    await user.keyboard('{Enter}');
    expect(navigateMock).toHaveBeenCalledWith({ to: '/members/mbr_1', search: {} });

    // It is remembered as a recent pick.
    await user.keyboard('{Control>}k{/Control}');
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: /Aman Mehra/ })).toBeInTheDocument();
  });

  it('offers actions by permission: reception records payments but cannot create classes', async () => {
    useAdmin.setState({ viewer: viewer('reception') });
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const list = screen.getByRole('listbox');
    expect(within(list).getByRole('option', { name: /Record payment/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Add member/ })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /Create class/ })).toBeNull();
    // Store is off reception's rail but still one search away.
    expect(within(list).getByRole('option', { name: 'Store' })).toBeInTheDocument();
  });

  it('Record payment asks for the invoice, then opens the payment flow on it', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'record');
    await user.keyboard('{Enter}');
    const combo = screen.getByRole('combobox', { name: 'Find the invoice' });
    await user.type(combo, 'aman');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/search?q=aman&types=invoice&outstanding=1'));
    await screen.findAllByRole('option');
    await user.keyboard('{Enter}');
    expect(navigateMock).toHaveBeenCalledWith({ to: '/billing', search: { invoice: 'inv_1', pay: 1 } });
  });

  it('Escape in a follow-up step goes back to the main list first', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'check in');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Find the member' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: 'Search and commands' })).toHaveFocus();
  });

  it('Add member opens the quick add form', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'add mem');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Add a member' })).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    apiMock.mockResolvedValue({ results: [] });
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'zzzz');
    expect(await screen.findByText('Nothing matches “zzzz”.')).toBeInTheDocument();
  });
});
