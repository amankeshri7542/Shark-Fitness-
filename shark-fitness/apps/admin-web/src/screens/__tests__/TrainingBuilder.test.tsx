import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../lib/api';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api };
});

import TrainingBuilderScreen from '../TrainingBuilder';

const screens = [{ path: '/training/$programId', component: TrainingBuilderScreen }];

const program = (overrides: Record<string, unknown> = {}) => ({
  id: 'prg_strength',
  name: 'Strength Base',
  version: 2,
  goal: 'strength',
  daysPerWeek: 3,
  weeks: 8,
  authorName: 'Rehan Shaikh',
  state: 'draft',
  description: 'Three full-body days built around the big lifts.',
  ...overrides,
});

const squat = {
  id: 'itm_squat',
  orderIndex: 0,
  exerciseId: 'exr_squat',
  exerciseName: 'Barbell Back Squat',
  sets: [
    { setIndex: 1, targetWeightKg: 40, repLow: 8, repHigh: 8, targetRpe: null, restSec: 90, isWarmup: true },
    { setIndex: 2, targetWeightKg: 80, repLow: 5, repHigh: 5, targetRpe: 8, restSec: 180, isWarmup: false },
  ],
  targetLabel: '3 × 5',
  supersetGroup: null,
  tempo: '3-1-1-0',
  notes: 'Brace before each rep.',
  rationale: null,
  trainerLocked: true,
  allowedSubstitutionIds: [],
};

const days = [
  { id: 'day_1', week: 1, dayIndex: 0, label: 'Lower', focus: 'squat', isRest: false, estimatedMin: 55, items: [squat] },
  { id: 'day_2', week: 1, dayIndex: 1, label: 'Recover', focus: 'mobility', isRest: true, estimatedMin: 0, items: [] },
];

const exercises = {
  items: [
    { id: 'exr_squat', name: 'Barbell Back Squat', equipment: 'barbell', archived: false },
    { id: 'exr_row', name: 'Seated Cable Row', equipment: 'cable', archived: false },
    { id: 'exr_old', name: 'Smith Machine Squat', equipment: 'machine', archived: true },
  ],
};

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> | undefined;
function respond({ detail = { program: program(), days }, extra }: { detail?: unknown; extra?: Handler } = {}) {
  api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handled = extra?.(path, options);
    if (handled) return handled;
    if (path === '/admin/training/programs/prg_strength' && !options?.method) return Promise.resolve(detail);
    if (path === '/admin/training/exercises') return Promise.resolve(exercises);
    if (options?.method) return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  api.mockReset();
  setOnline(true);
  signInAs('owner');
});
afterEach(() => setOnline(true));

describe('TrainingBuilder', () => {
  it('refuses a role without training.view, and reads nothing', async () => {
    signInAs('reception');
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Training programs is restricted/)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('says it is loading rather than showing an empty program', async () => {
    api.mockReturnValue(new Promise(() => undefined));
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No days yet')).not.toBeInTheDocument();
  });

  it('says the program could not be read, and recovers on retry', async () => {
    respond({
      extra: (path) =>
        path === '/admin/training/programs/prg_strength'
          ? refuse(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That program does not exist.', requestId: 'r' } }))
          : undefined,
    });
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByText('Could not load this program')).toBeInTheDocument();
    expect(screen.getByText('That program does not exist.')).toBeInTheDocument();

    respond();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Strength Base', level: 1 })).toBeInTheDocument();
  });

  it('starts an empty draft with the first day, and will not publish it yet', async () => {
    respond({ detail: { program: program(), days: [] } });
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByText('No days yet')).toBeInTheDocument();
    expect(screen.getByText('Publishing needs at least one non-rest day with an active exercise.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish version' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Add first day' }));
    const dialog = screen.getByRole('dialog', { name: 'Add program day' });
    await userEvent.clear(within(dialog).getByLabelText('Label'));
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Upper');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add day' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/admin/training/programs/prg_strength/days',
        expect.objectContaining({ method: 'POST', body: { week: 1, dayIndex: 0, label: 'Upper', focus: 'general', isRest: false, estimatedMin: 45 } }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add program day' })).not.toBeInTheDocument());
  });

  it('lays out the program week by week with each prescription', async () => {
    respond();
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByRole('heading', { name: 'Strength Base', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Program builder · v2')).toBeInTheDocument();
    expect(screen.getByText('3 days/week · 8 weeks')).toBeInTheDocument();
    expect(screen.getByText('2 days · 1 exercises')).toBeInTheDocument();
    expect(screen.getByText('Week 1 · Monday')).toBeInTheDocument();
    expect(screen.getByText('3 × 5 · tempo 3-1-1-0 · locked')).toBeInTheDocument();
    // Warm-up and working sets, each with its load and effort.
    expect(screen.getByText(/^W1: 8-8/)).toHaveTextContent('W1: 8-8 @ 40kg · S2: 5-5 @ 80kg · RPE 8');
    expect(screen.getByText('Recovery day.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish version' })).toBeEnabled();
  });

  it('publishes a draft that has something to train', async () => {
    respond();
    renderScreen('/training/prg_strength', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/training/programs/prg_strength/publish', { method: 'POST' }));
  });

  it('offers only live exercises when adding one to a day', async () => {
    respond();
    renderScreen('/training/prg_strength', screens);
    const lower = (await screen.findByText('Week 1 · Monday')).closest('section')!;
    await userEvent.click(within(lower).getByRole('button', { name: 'Add exercise' }));
    const select = within(lower).getByLabelText('Exercise');
    expect(within(select).getByRole('option', { name: 'Seated Cable Row · cable' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Smith Machine Squat/ })).not.toBeInTheDocument();

    await userEvent.selectOptions(select, 'exr_row');
    await userEvent.click(within(lower).getAllByRole('button', { name: 'Add exercise' }).at(-1)!);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/admin/training/days/day_1/items',
        expect.objectContaining({ method: 'POST', body: expect.objectContaining({ exerciseId: 'exr_row', targetLabel: '3 × 8-10' }) }),
      ),
    );
  });

  it('confirms before removing an exercise, and says why a removal failed', async () => {
    respond({
      extra: (path, options) =>
        options?.method === 'DELETE'
          ? refuse(new ApiError(409, { error: { code: 'CONFLICT', message: 'This draft changed since you opened it.', requestId: 'r' } }))
          : undefined,
    });
    renderScreen('/training/prg_strength', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Barbell Back Squat' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove exercise from day?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/training/items/itm_squat', { method: 'DELETE' }));
    expect(await screen.findByText('This draft changed since you opened it.')).toBeInTheDocument();
  });

  it('freezes a published version and copies it into a new draft to edit', async () => {
    respond({
      detail: { program: program({ state: 'published' }), days },
      extra: (path) => (path === '/admin/training/programs/prg_strength/version' ? Promise.resolve({ program: { id: 'prg_strength_v3' } }) : undefined),
    });
    const { router } = renderScreen('/training/prg_strength', screens);
    expect(await screen.findByRole('region', { name: 'Version lifecycle' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add day' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Barbell Back Squat' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create new version' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/training/prg_strength_v3'));
  });

  it('shows a role that cannot author programs the plan without the controls', async () => {
    signInAs('branch_manager');
    respond();
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByRole('heading', { name: 'Strength Base', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Rehan Shaikh')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add day' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('keeps the program readable offline and turns changes off', async () => {
    setOnline(false);
    respond();
    renderScreen('/training/prg_strength', screens);
    expect(await screen.findByText('You are offline. Published content remains visible, but changes are disabled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish version' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add day' })).not.toBeInTheDocument();
  });
});
