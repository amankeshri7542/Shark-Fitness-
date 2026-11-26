import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <a href="#member" onClick={onClick}>
      {children}
    </a>
  ),
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../lib/api';
import { QuickAddDialog } from '../QuickAddDialog';
import { refuse, signInAs } from '../../test/harness';

function renderDialog() {
  const client = new QueryClient({ mutationCache: new MutationCache({ onError: () => undefined }), defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuickAddDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  signInAs('reception');
});

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Full name'), 'Kabir Rao');
  await user.type(screen.getByLabelText('Phone'), '98765 43210');
  await user.type(screen.getByLabelText('Email (optional)'), 'kabir@example.test');
}

describe('Quick add', () => {
  it('adds a walk-in and offers the activation link', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/billing/products') return Promise.resolve({ items: [{ id: 'prd_1', name: 'Monthly', kind: 'membership', status: 'active', priceLabel: '₹2,999' }] });
      if (path === '/admin/members/quick-add') {
        return Promise.resolve({ member: { id: 'mbr_9', memberNo: 'SF-40301', name: 'Kabir Rao' }, activation: { eligible: true, note: 'Send an activation link.' } });
      }
      return Promise.resolve({});
    });
    renderDialog();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeDisabled();
    await fill(user);
    await user.selectOptions(await screen.findByLabelText('Plan (optional)'), 'prd_1');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/members/quick-add',
        expect.objectContaining({ body: { name: 'Kabir Rao', phone: '98765 43210', email: 'kabir@example.test', branchId: 'br_kor', productId: 'prd_1' } }),
      ),
    );
    expect(await screen.findByText('Kabir Rao is SF-40301.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create activation link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open member' })).toBeInTheDocument();
  });

  it('points at the existing member when the phone is already used', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/members/quick-add') {
        return refuse(
          new ApiError(409, {
            error: {
              code: 'CONFLICT',
              message: 'Aman Mehra (SF-40219) already has this phone.',
              requestId: 'r',
              details: { existing: { id: 'mbr_1', name: 'Aman Mehra', memberNo: 'SF-40219', matchedOn: 'phone' } },
            },
          }),
        );
      }
      return Promise.resolve({ items: [] });
    });
    renderDialog();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Aman Mehra (SF-40219) already has this phone.');
    expect(screen.getByRole('link', { name: 'Open Aman Mehra' })).toBeInTheDocument();
  });

  it('hides the plan picker from a role that cannot sell plans', async () => {
    signInAs('trainer');
    apiMock.mockResolvedValue({ items: [] });
    renderDialog();
    expect(screen.queryByLabelText('Plan (optional)')).toBeNull();
  });
});
