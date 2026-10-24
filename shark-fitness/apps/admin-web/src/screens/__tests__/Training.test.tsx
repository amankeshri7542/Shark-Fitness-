import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin/training">{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api };
});
vi.mock('../../lib/store', () => ({ usePermission: () => true }));
vi.mock('../../lib/realtime', () => ({ useOnline: () => true }));
vi.mock('../../ui/shell', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }));

import Training from '../Training';

const exercise = (id: string, name: string, tenantId: string | null) => ({
  id, tenantId, slug: id, name, equipment: 'barbell', primaryMuscles: ['quads'], difficulty: 'intermediate', archived: false, defaultRestSec: 120,
});

it('lists the shared library without offering to archive it', async () => {
  api.mockImplementation(async (path: string) =>
    path.startsWith('/admin/training/exercises')
      ? { total: 2, items: [exercise('exr_squat', 'Barbell Back Squat', null), exercise('exr_own', 'Depot Sled Push', 'ten_shark')] }
      : { total: 0, items: [] },
  );
  render(<QueryClientProvider client={new QueryClient()}><Training /></QueryClientProvider>);

  // The console asks for the live library with archived=false, which the API
  // once read as "archived only".
  expect(await screen.findByText('Barbell Back Squat')).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith(expect.stringContaining('archived=false'));

  // A gym cannot archive a shared exercise (the API answers 404), so the
  // console must not offer it; its own exercises keep the action.
  const shared = screen.getByText('Barbell Back Squat').closest('div.flex')!;
  expect(within(shared as HTMLElement).getByText('shared')).toBeInTheDocument();
  expect(within(shared as HTMLElement).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  const own = screen.getByText('Depot Sled Push').closest('div.flex')!;
  expect(within(own as HTMLElement).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
});
