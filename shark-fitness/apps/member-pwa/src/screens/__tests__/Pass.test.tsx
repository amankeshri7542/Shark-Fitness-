import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../lib/store', () => ({ useCopy: () => (key: string) => key }));
vi.mock('../../lib/realtime', () => ({ useOnline: () => true }));
vi.mock('../../lib/api', () => ({ api: async () => ({
  member: { name: 'New Member', memberNo: 'M-0051' }, membership: null,
  occupancy: { label: 'Quiet', inside: 0, capacity: 20 }, history: [], openSession: null,
}) }));
import Pass from '../Pass';
it('shows reception identification without claiming to encode a scannable door pass', async () => {
  render(<QueryClientProvider client={new QueryClient()}><Pass /></QueryClientProvider>);
  expect(await screen.findByText('M-0051')).toBeInTheDocument();
  expect(screen.getByText(/not a QR code or door credential/)).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
