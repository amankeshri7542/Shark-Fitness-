import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
const online = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api, API_ORIGIN: '' }));
vi.mock('../../lib/realtime', () => ({ useOnline: () => online.value }));
vi.mock('../../lib/photo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/photo')>()),
  prepareUpload: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

import { ApiError } from '../../lib/api';
import { PhotosSection, type PhotosPayload, type PhotoView } from '../progress/PhotosSection';

const consent = { granted: true, version: '2.0', current: true, currentVersion: '2.0', text: 'Shark Fitness stores the progress photos you upload so you can compare them over time.' };

function photo(id: string, takenOn: string, overrides: Partial<PhotoView> = {}): PhotoView {
  return { id, takenOn, pose: 'front', visibility: 'private', createdAt: `${takenOn}T08:00:00Z`, width: 600, height: 800, url: `/v1/files/med_${id}?v=u&exp=1&sig=s`, urlExpiresAt: null, deleteAfter: null, ...overrides };
}

function payload(overrides: Partial<PhotosPayload> = {}): PhotosPayload {
  return { consent, retentionDays: 30, items: [photo('a', '2026-09-01'), photo('b', '2026-11-20', { visibility: 'coach' })], ...overrides };
}

function renderSection() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <PhotosSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  online.value = true;
});
afterEach(() => {
  cleanup();
  api.mockReset();
});

it('loading, then the photos with dates and who can see them', async () => {
  api.mockResolvedValue(payload());
  renderSection();
  expect(screen.getByLabelText('Loading photos')).toBeInTheDocument();
  expect(await screen.findByRole('img', { name: 'Progress photo, front, 1 Sept 2026' })).toHaveAttribute('src', '/v1/files/med_a?v=u&exp=1&sig=s');
  expect(screen.getByText('Coach')).toBeInTheDocument();
  expect(screen.getByText('Private')).toBeInTheDocument();
  expect(screen.getByText(/Nobody else at the gym can see them/)).toBeInTheDocument();
});

it('asks for consent before anything is uploaded, and records agreement', async () => {
  api.mockImplementation(async (path: string) => (path === '/me/consents' ? { ok: true } : payload({ consent: { ...consent, granted: false, current: false, version: null }, items: [] })));
  renderSection();
  expect(await screen.findByText('Before you add photos')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add a photo' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'I agree, store my photos' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/me/consents', { method: 'PUT', body: { purpose: 'progress_photos', granted: true } }));
});

it('a changed consent text asks again', async () => {
  api.mockResolvedValue(payload({ consent: { ...consent, version: '1.0', current: false } }));
  renderSection();
  expect(await screen.findByText('The photo consent has changed')).toBeInTheDocument();
});

it('empty: says what photos are for', async () => {
  api.mockResolvedValue(payload({ items: [] }));
  renderSection();
  expect(await screen.findByText('No photos yet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compare two dates' })).not.toBeInTheDocument();
});

it('error and offline states', async () => {
  api.mockRejectedValue(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'r' } }));
  renderSection();
  expect(await screen.findByText('Could not load your photos')).toBeInTheDocument();
  cleanup();
  online.value = false;
  renderSection();
  expect(await screen.findByText(/Photos need a connection/)).toBeInTheDocument();
});

it('offline with photos loaded: adding is disabled and says why', async () => {
  online.value = false;
  api.mockResolvedValue(payload());
  renderSection();
  expect(await screen.findByRole('button', { name: 'Add a photo' })).toBeDisabled();
  expect(screen.getByText('You are offline. Photos can be added once you are connected.')).toBeInTheDocument();
});

it('shares a photo with the coach and makes it private again', async () => {
  api.mockImplementation(async (path: string, init?: { method?: string }) => (init?.method === 'PATCH' ? { ok: true } : payload()));
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Share the 1 Sept 2026 photo with my coach' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/progress/photos/a', { method: 'PATCH', body: { visibility: 'coach' } }));
  expect(await screen.findByText('Shared with your coach.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Make the 20 Nov 2026 photo private' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/progress/photos/b', { method: 'PATCH', body: { visibility: 'private' } }));
});

it('deleting asks first and says it cannot be undone', async () => {
  api.mockImplementation(async (path: string, init?: { method?: string }) => (init?.method === 'DELETE' ? { ok: true } : payload()));
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete the 1 Sept 2026 photo' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this photo' });
  expect(dialog).toHaveTextContent('This cannot be undone.');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Delete the 1 Sept 2026 photo' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete photo' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/progress/photos/a', { method: 'DELETE' }));
  expect(await screen.findByText('Photo deleted. The file is gone.')).toBeInTheDocument();
});

it('compares two dates with a slider and textual date labels', async () => {
  api.mockResolvedValue(payload());
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Compare two dates' }));
  const dialog = await screen.findByRole('dialog', { name: 'Compare two photos' });
  expect(dialog).toHaveTextContent('Before · 1 Sept 2026');
  expect(dialog).toHaveTextContent('After · 20 Nov 2026');
  const slider = screen.getByLabelText(/Compare position/);
  fireEvent.change(slider, { target: { value: '30' } });
  expect(slider).toHaveAttribute('aria-valuetext', '30% before, 70% after');
  expect(screen.getByRole('img', { name: 'Before: 1 Sept 2026' })).toHaveStyle({ clipPath: 'inset(0 70% 0 0)' });
});

it('withdrawing consent explains what happens and when photos go', async () => {
  api.mockImplementation(async (path: string) => (path === '/me/consents' ? { ok: true, photos: { scheduled: 2 } } : payload()));
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Withdraw photo consent' }));
  const dialog = await screen.findByRole('dialog', { name: 'Withdraw photo consent' });
  expect(dialog).toHaveTextContent('Your coach stops seeing your photos straight away. All 2 photos are deleted after 30 days');
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/me/consents', { method: 'PUT', body: { purpose: 'progress_photos', granted: false } }));
});

it('photos scheduled for deletion say when', async () => {
  api.mockResolvedValue(payload({ items: [photo('a', '2026-09-01', { deleteAfter: '2026-12-25T00:00:00Z' })] }));
  renderSection();
  expect(await screen.findByText(/will be deleted on 25 Dec 2026/)).toBeInTheDocument();
});

it('uploads a prepared photo as multipart with the chosen date, pose and audience', async () => {
  api.mockImplementation(async (path: string) => (path === '/member/media/uploads' ? { photo: photo('c', '2026-11-25') } : payload()));
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a photo' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a progress photo' });
  expect(dialog).toHaveTextContent('Location and camera details are removed before it is sent.');
  fireEvent.change(screen.getByLabelText('Photo'), { target: { files: [new File(['x'], 'IMG_0001.HEIC.jpg', { type: 'image/jpeg' })] } });
  fireEvent.click(screen.getByRole('tab', { name: 'Side' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Me and my coach' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save photo' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/media/uploads', expect.objectContaining({ method: 'POST', form: expect.any(FormData) })));
  const form = api.mock.calls.find(([path]) => path === '/member/media/uploads')![1].form as FormData;
  expect(form.get('purpose')).toBe('progress_photo');
  expect(form.get('pose')).toBe('side');
  expect(form.get('visibility')).toBe('coach');
  expect(await screen.findByText('Photo saved and shared with your coach.')).toBeInTheDocument();
});

it('an upload the server refuses explains why', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/member/media/uploads') throw new ApiError(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is over 10 MB. Choose a smaller photo.', requestId: 'r' } });
    return payload();
  });
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a photo' }));
  fireEvent.change(await screen.findByLabelText('Photo'), { target: { files: [new File(['x'], 'big.jpg', { type: 'image/jpeg' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Save photo' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That file is over 10 MB. Choose a smaller photo.');
});
