import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));

import { OfflineError } from '../../lib/api';
import { FreestylePicker, MAX_FREESTYLE_EXERCISES, type LibraryExercise } from '../workout/FreestylePicker';

function exercise(id: string, name: string, overrides: Partial<LibraryExercise> = {}): LibraryExercise {
  return { id, name, aliases: [], equipment: 'barbell', usesBarbell: true, primaryMuscles: ['quads'], secondaryMuscles: [], defaultRestSec: 120, lastPerformance: null, ...overrides };
}

const library = [
  exercise('ex_squat', 'Back squat', { lastPerformance: { weightKg: 80, reps: 5, label: '80 kg × 5' } }),
  exercise('ex_row', 'Barbell row', { primaryMuscles: ['lats'], aliases: ['bent-over row'] }),
  exercise('ex_press', 'Overhead press', { primaryMuscles: ['shoulders'] }),
];

function renderPicker() {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FreestylePicker onStart={onStart} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { onStart, onCancel };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  api.mockReset();
});

it('picks exercises in order and starts with them', async () => {
  api.mockResolvedValue({ items: library });
  const { onStart } = renderPicker();
  expect(screen.getByLabelText('Loading the exercise library')).toBeInTheDocument();
  const squat = await screen.findByRole('button', { name: 'Back squat' });
  expect(screen.getByRole('button', { name: 'Pick at least one' })).toBeDisabled();
  expect(squat).toHaveAccessibleDescription(/last 80 kg × 5/);

  fireEvent.click(screen.getByRole('button', { name: 'Barbell row' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back squat' }));
  expect(screen.getByRole('button', { name: 'Barbell row, number 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Back squat, number 2' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Start · 2 exercises' }));
  expect(onStart).toHaveBeenCalledWith([library[1], library[0]]);
});

it('searches by name, alias and muscle', async () => {
  api.mockResolvedValue({ items: library });
  renderPicker();
  await screen.findByRole('button', { name: /Back squat/ });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bent-over' } });
  expect(screen.getByRole('button', { name: /Barbell row/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Back squat/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
  expect(screen.getByText('Nothing matches')).toBeInTheDocument();
});

it('offline after a first load: the saved library is used', async () => {
  localStorage.setItem('shark.exercise.library', JSON.stringify(library));
  api.mockRejectedValue(new OfflineError());
  renderPicker();
  expect(await screen.findByText('Offline: showing the library saved on this phone.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Overhead press/ })).toBeInTheDocument();
});

it('offline the very first time: says the library needs one connection', async () => {
  api.mockRejectedValue(new OfflineError());
  renderPicker();
  expect(await screen.findByText('The exercise library needs a connection the first time')).toBeInTheDocument();
});

it(`stops at ${MAX_FREESTYLE_EXERCISES} exercises`, async () => {
  api.mockResolvedValue({ items: Array.from({ length: MAX_FREESTYLE_EXERCISES + 1 }, (_, i) => exercise(`ex_${i}`, `Exercise ${i}`)) });
  renderPicker();
  await screen.findByRole('button', { name: 'Exercise 0' });
  for (let i = 0; i < MAX_FREESTYLE_EXERCISES; i += 1) fireEvent.click(screen.getByRole('button', { name: `Exercise ${i}` }));
  await waitFor(() => expect(screen.getByRole('button', { name: `Exercise ${MAX_FREESTYLE_EXERCISES}` })).toBeDisabled());
  expect(screen.getByText(`${MAX_FREESTYLE_EXERCISES} is the most in one session`)).toBeInTheDocument();
});

it('cancel goes back', async () => {
  api.mockResolvedValue({ items: library });
  const { onCancel } = renderPicker();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
});
