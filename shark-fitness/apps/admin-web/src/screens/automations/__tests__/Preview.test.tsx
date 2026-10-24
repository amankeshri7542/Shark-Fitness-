import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Preview from '../Preview';

/* ============================================================================
   The audience preview.

   The half that matters is the right-hand column. An operator looking at "142
   recipients" learns nothing they could act on; an operator looking at "38
   held because they never agreed to SMS" learns their consent capture at the
   desk is broken, which is worth more than the campaign.
   ========================================================================= */

const payload = {
  summary: {
    considered: 46,
    suppressed: 38,
    bySuppression: [
      { code: 'no_consent', reason: 'This member has not agreed to sms messages.', count: 30 },
      { code: 'quiet_hours', reason: 'Held until quiet hours end at this branch.', count: 8 },
    ],
  },
  channel: 'sms',
  metered: true,
  estimatedCostMinor: 20_000,
  recipients: [
    { memberId: 'mbr_1', name: 'Rhea Kapoor', branchName: 'Koramangala Depot', preview: 'Hi Rhea, your Elite Annual ends on 2026-09-12.' },
  ],
  suppressed: [{ memberId: 'mbr_2', name: 'Devraj Rao', code: 'no_consent', reason: 'This member has not agreed to sms messages.' }],
};

function renderPreview() {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Preview automationId="atm_1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(payload);
});

describe('Preview — who this reaches, and who it does not', () => {
  it('shows the message as the member would read it, not the template', async () => {
    renderPreview();
    // A preview showing `{{firstName}}` is a preview of the wrong thing.
    const line = await screen.findByText(/Hi Rhea, your Elite Annual ends/);
    expect(line).toBeInTheDocument();
    expect(line.textContent).not.toContain('{{');
  });

  it('gives the held-back reasons as much room as the recipients', async () => {
    renderPreview();
    expect(await screen.findByText(/has not agreed to sms/)).toBeInTheDocument();
    expect(screen.getByText(/Held until quiet hours end/)).toBeInTheDocument();
    // Counted, so an operator can see that consent capture is the problem.
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('states the cost before the send, on a metered channel', async () => {
    renderPreview();
    // PF-COMM-006. After the fact is an invoice, not a decision.
    expect(await screen.findByText('about ₹200.00')).toBeInTheDocument();
  });

  it('says nothing about cost when the channel is free', async () => {
    apiMock.mockResolvedValue({ ...payload, metered: false, channel: 'in_app', estimatedCostMinor: 0 });
    renderPreview();
    await screen.findByText(/Would receive it/);
    expect(screen.queryByText(/about ₹/)).not.toBeInTheDocument();
  });

  it('does not read an empty audience as a fault', async () => {
    apiMock.mockResolvedValue({ ...payload, recipients: [] });
    renderPreview();
    // Nobody matching is often correct — the reason is next door.
    expect(await screen.findByText(/That is not necessarily wrong/)).toBeInTheDocument();
  });

  it('reports a rehearsal as a rehearsal, naming nobody messaged', async () => {
    const user = userEvent.setup();
    renderPreview();
    apiMock.mockResolvedValueOnce({ dryRun: true, sent: 0, suppressed: 46 });
    await user.click(await screen.findByRole('button', { name: 'Run it now' }));
    expect(await screen.findByText(/Nobody was messaged/)).toBeInTheDocument();
  });

  it('reports a real send with both numbers', async () => {
    const user = userEvent.setup();
    renderPreview();
    apiMock.mockResolvedValueOnce({ dryRun: false, sent: 8, suppressed: 38 });
    await user.click(await screen.findByRole('button', { name: 'Run it now' }));
    expect(await screen.findByText(/Sent to 8\. 38 held\./)).toBeInTheDocument();
  });

  it('surfaces a failed read rather than an empty audience', async () => {
    const { ApiError } = await import('../../../lib/api');
    apiMock.mockRejectedValue(new ApiError(500, { error: { code: 'INTERNAL', message: 'The query failed.', requestId: 'r' } }));
    renderPreview();
    expect(await screen.findByText('The query failed.')).toBeInTheDocument();
  });
});
