import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FeedbackSummary } from '@shark/contracts';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Feedback from '../Feedback';
import { TZ, renderPanel } from './harness';

/* ============================================================================
   Recording feedback at the desk.

   Feedback is not an inert log: NPS, CSAT and the cancellation reasons are all
   computed from these rows. A duplicate is therefore not a cosmetic repeat —
   it weights one member's answer twice in every satisfaction figure derived
   from it afterwards, and nobody looking at the number can see why it moved.

   The server wraps the write in `runIdempotently()`, so whether a retry is
   safe is decided entirely by whether it carries the same `Idempotency-Key`.
   That key used to be minted inside `mutationFn`, and `idempotencyKey()` ends
   every key it returns with a random suffix, so every press asked the server a
   brand-new question and got a second row.
   ========================================================================= */

const summary: FeedbackSummary = {
  items: [],
  nps: { responses: 0, promoters: 0, passives: 0, detractors: 0, score: null },
  csat: { responses: 0, average: null, satisfiedPct: null },
  cancellationReasons: [],
  classRating: null,
  trainerRating: null,
  anonymousCount: 0,
  asOf: '2026-08-19T04:00:00.000Z',
} as unknown as FeedbackSummary;

function open(overrides: Partial<Parameters<typeof Feedback>[0]> = {}) {
  return renderPanel(
    <Feedback data={summary} loading={false} timeZone={TZ} online onChanged={() => undefined} {...overrides} />,
  );
}

/** The `Idempotency-Key` each feedback POST carried. */
function saveKeys(): string[] {
  return apiMock.mock.calls
    .filter(([path, options]) => path === '/admin/support/feedback' && (options as { method?: string }).method === 'POST')
    .map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
}

async function record(user: ReturnType<typeof userEvent.setup>) {
  open();
  await user.click(screen.getByRole('button', { name: 'Record feedback' }));
  const drawer = await screen.findByRole('dialog');
  await user.type(within(drawer).getByLabelText('Score out of 5'), '4');
  return drawer;
}

function rejectWith(error: Error) {
  const rejected = Promise.reject(error);
  rejected.catch(() => undefined);
  return rejected;
}

describe('Feedback — one response, one key', () => {
  it('retries a lost save under the same key rather than recording it twice', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../../lib/api');

    // The server committed; the response never arrived. Indistinguishable from
    // "nothing happened" at the desk, which is the whole reason the key exists.
    apiMock.mockImplementationOnce(() => rejectWith(new OfflineError()));
    apiMock.mockResolvedValue({});

    const drawer = await record(user);
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());

    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveKeys()).toHaveLength(2));

    // One answer from one member, one key — so the second request is answered
    // from the first one's record and CSAT counts it once.
    expect(saveKeys()[0]).toBe(saveKeys()[1]);
  });

  it('keeps the key across a server refusal so a straight retry cannot double-record', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');

    apiMock.mockImplementationOnce(() =>
      rejectWith(new ApiError(500, { error: { code: 'INTERNAL', message: 'That did not save.', requestId: 'r1' } })),
    );
    apiMock.mockResolvedValue({});

    const drawer = await record(user);
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveKeys()).toHaveLength(2));

    expect(saveKeys()[0]).toBe(saveKeys()[1]);
  });

  it('mints a new key once the response being recorded is a different one', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');

    apiMock.mockImplementation(() =>
      rejectWith(new ApiError(500, { error: { code: 'INTERNAL', message: 'That did not save.', requestId: 'r2' } })),
    );

    const drawer = await record(user);
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveKeys()).toHaveLength(1));

    // A different score is a different answer. The server hashes the body
    // alongside the key and refuses a key replayed against different content,
    // so carrying the first key here would turn a correction into a 409.
    await user.clear(within(drawer).getByLabelText('Score out of 5'));
    await user.type(within(drawer).getByLabelText('Score out of 5'), '2');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveKeys()).toHaveLength(2));

    expect(saveKeys()[0]).not.toBe(saveKeys()[1]);
  });
});
