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
