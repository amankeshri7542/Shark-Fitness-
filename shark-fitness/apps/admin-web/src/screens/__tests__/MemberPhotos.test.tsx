import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api: vi.fn(), API_ORIGIN: '' }));
import { ApiError, api } from '../../lib/api';
import { MemberPhotos } from '../members/MemberPhotos';

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

function renderPhotos() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemberPhotos memberId="mbr_1" /></QueryClientProvider>);
}

it('the assigned coach sees shared photos with their dates', async () => {
  vi.mocked(api).mockResolvedValue({ access: 'coach', message: null, items: [{ id: 'p1', takenOn: '2026-11-20', pose: 'front', url: '/v1/files/med_1?v=u&exp=1&sig=s' }] } as never);
  renderPhotos();
  expect(await screen.findByRole('img', { name: 'Progress photo, front, 2026-11-20' })).toHaveAttribute('src', '/v1/files/med_1?v=u&exp=1&sig=s');
});

it('anyone else is told who can see them, and sees nothing', async () => {
  vi.mocked(api).mockResolvedValue({ access: 'not_assigned', message: 'Progress photos are shared only with the member’s assigned coach.', items: [] } as never);
  renderPhotos();
  expect(await screen.findByText('Progress photos are shared only with the member’s assigned coach.')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('nothing shared, and an error, both say so', async () => {
  vi.mocked(api).mockResolvedValue({ access: 'coach', message: 'The member has not shared any progress photos with you.', items: [] } as never);
  renderPhotos();
  expect(await screen.findByText('Nothing shared')).toBeInTheDocument();
  cleanup();
  vi.mocked(api).mockRejectedValue(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That member could not be found.', requestId: 'r' } }));
  renderPhotos();
  expect(await screen.findByText('Could not load photos')).toBeInTheDocument();
});
