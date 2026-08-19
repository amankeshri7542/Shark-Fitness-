import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Retention from '../Retention';
import { TZ, renderPanel, retention } from './harness';

function open(overrides: Partial<Parameters<typeof Retention>[0]> = {}) {
  return renderPanel(
    <Retention data={retention()} loading={false} timeZone={TZ} online onChanged={() => undefined} {...overrides} />,
  );
}

describe('Retention — explainable, or not claimed at all', () => {
  it('shows the contributions behind every score, not just the number', () => {
    open();
    // PF-SUP-003 asks for explainable. A score with no reasons is a number
    // staff will not act on.
    expect(screen.getByText('Attendance down 55% on their own norm')).toBeInTheDocument();
    expect(screen.getByText('A payment failed and is unresolved')).toBeInTheDocument();
    expect(screen.getByText('+20')).toBeInTheDocument();
  });

  it('says why a member is not being scored rather than reporting a confident zero', () => {
    open({
      data: retention({
        atRisk: [
          {
            ...retention().atRisk[0]!,
            score: 0,
            band: 'low',
            reasons: [],
            suppressed: 'The branch was closed for most of the last four weeks.',
          },
        ],
      }),
    });
    // PF-SUP's own edge case: a risk score must not rise because the gym shut.
    expect(screen.getByText('The branch was closed for most of the last four weeks.')).toBeInTheDocument();
  });

  it('states, per member, why an automated message may not be sent', () => {
    open();
    // PF-SUP-005 as a refusal you can see, not a pipeline that quietly drops
    // somebody.
    expect(screen.getByText(/No automation · Open complaint/)).toBeInTheDocument();
  });

  it('stops a second person being assigned the same member', () => {
    open({
      data: retention({ atRisk: [{ ...retention().atRisk[0]!, openInterventionId: 'itv_1' }] }),
    });
    expect(screen.getByText('Already assigned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument();
  });

  it('withholds an effectiveness rate that has too little behind it', () => {
    open();
    // Three judged calls give a rate; one judged check-in does not.
    expect(screen.getByText('67%')).toBeInTheDocument();
    // Two judged cases is noise dressed as measurement (PF-RPT-004).
    expect(screen.getByText('Too few')).toBeInTheDocument();
  });

  it('explains that unreachable members are excluded rather than counted as failures', () => {
    open();
    expect(screen.getByText(/says nothing about whether calling works/)).toBeInTheDocument();
  });

  it('offers no planning while offline', () => {
    open({ online: false });
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDisabled();
  });

  it('reads an empty band as good news, not as missing data', () => {
    open({ data: retention({ atRisk: [] }) });
    expect(screen.getByText('Nobody in this band')).toBeInTheDocument();
    expect(screen.getByText(/good news, not missing data/)).toBeInTheDocument();
  });
});

describe('Retention — planning an intervention', () => {
  it('carries the recommendation and the reasons into the plan', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'Plan' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Sort the failed payment first.')).toBeInTheDocument();
    expect(within(drawer).getByText('A payment failed and is unresolved')).toBeInTheDocument();
    expect(within(drawer).getByText(/Weeks the branch was closed are excluded/)).toBeInTheDocument();
  });

  it('repeats the automation block where the decision is actually made', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'Plan' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/A person contacts them, or nobody does/)).toBeInTheDocument();
  });

  it('posts the chosen action rather than the recommended one', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ interventionId: 'itv_9' });
    open();

    await user.click(screen.getByRole('button', { name: 'Plan' }));
    const drawer = await screen.findByRole('dialog');
    // The disagreement between suggestion and choice is the signal
    // effectiveness tracking measures, so the choice has to travel.
    await user.selectOptions(within(drawer).getByLabelText('Intervention action'), 'visit_invite');
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    const call = apiMock.mock.calls.find(([p]) => String(p) === '/admin/support/interventions')!;
    expect((call[1] as { body: { action: string; memberId: string } }).body).toMatchObject({
      action: 'visit_invite',
      memberId: 'mbr_2',
    });
  });
});

/* ============================================================================
   Idempotency — one intervention, one key.

   A duplicate here is not a stray row. The member is assigned the same call
   twice, two staff can each pick one up and both phone them, and the
   effectiveness measure — which exists to compare the recommended action
   against the one staff actually chose — is fed a repeat it should never have
   counted.

   The server wraps the write in `runIdempotently()`. Whether a retry after a
   lost response is safe is therefore decided entirely by whether it carries
   the same `Idempotency-Key`; minting it inside `mutationFn` meant it never
   did, because `idempotencyKey()` ends every key with a random suffix.
   ========================================================================= */

/** The `Idempotency-Key` each intervention POST carried. */
function planKeys(): string[] {
  return apiMock.mock.calls
    .filter(
      ([path, options]) =>
        path === '/admin/support/interventions' && (options as { method?: string }).method === 'POST',
    )
    .map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
}

function rejectWith(error: Error) {
  const rejected = Promise.reject(error);
  rejected.catch(() => undefined);
  return rejected;
}

async function plan(user: ReturnType<typeof userEvent.setup>) {
  open();
  await user.click(screen.getByRole('button', { name: 'Plan' }));
  return screen.findByRole('dialog');
}

describe('Retention — one intervention, one key', () => {
  it('retries a lost assignment under the same key rather than assigning it twice', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../../lib/api');

    apiMock.mockImplementationOnce(() => rejectWith(new OfflineError()));
    apiMock.mockResolvedValue({ interventionId: 'itv_9' });

    const drawer = await plan(user);
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());

    // The drawer is still open on the same member, because as far as this
    // screen knows nothing was assigned.
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(planKeys()).toHaveLength(2));

    expect(planKeys()[0]).toBe(planKeys()[1]);
  });

  it('keeps the key across a server refusal so a straight retry cannot double-assign', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');

    apiMock.mockImplementationOnce(() =>
      rejectWith(new ApiError(500, { error: { code: 'INTERNAL', message: 'That did not save.', requestId: 'r1' } })),
    );
    apiMock.mockResolvedValue({ interventionId: 'itv_9' });

    const drawer = await plan(user);
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(planKeys()).toHaveLength(2));

    expect(planKeys()[0]).toBe(planKeys()[1]);
  });

  it('mints a new key when a different action is chosen', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');

    apiMock.mockImplementation(() =>
      rejectWith(new ApiError(500, { error: { code: 'INTERNAL', message: 'That did not save.', requestId: 'r2' } })),
    );

    const drawer = await plan(user);
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(planKeys()).toHaveLength(1));

    // Changing the action changes the body, and the server refuses a key
    // replayed against different content.
    await user.selectOptions(within(drawer).getByLabelText('Intervention action'), 'visit_invite');
    await user.click(within(drawer).getByRole('button', { name: 'Assign this' }));
    await waitFor(() => expect(planKeys()).toHaveLength(2));

    expect(planKeys()[0]).not.toBe(planKeys()[1]);
  });
});
