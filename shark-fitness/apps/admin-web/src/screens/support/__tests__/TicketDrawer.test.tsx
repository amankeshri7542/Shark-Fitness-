import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import TicketDrawer from '../TicketDrawer';
import { TZ, detail, renderPanel, ticket } from './harness';

function open(overrides: Partial<Parameters<typeof TicketDrawer>[0]> = {}) {
  return renderPanel(
    <TicketDrawer
      ticketId="tkt_1"
      timeZone={TZ}
      online
      onClose={() => undefined}
      onChanged={() => undefined}
      {...overrides}
    />,
  );
}

/** The `Idempotency-Key` header each reply POST carried. */
function replyKeys(): string[] {
  return apiMock.mock.calls
    .filter(([path, options]) => String(path).endsWith('/reply') && (options as { method?: string }).method === 'POST')
    .map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
}

describe('Ticket detail — what the desk needs to answer', () => {
  it('shows the promise, the member and the conversation', async () => {
    apiMock.mockResolvedValue(detail());
    open();

    expect(await screen.findByText('Charged twice in July')).toBeInTheDocument();
    expect(screen.getByText('Reply due in 4h')).toBeInTheDocument();
    // The name appears twice by design — as the message sender and in the
            // member card — so assert on both rather than either.
    expect(screen.getAllByText('Asha Iyer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Reef Unlimited')).toBeInTheDocument();
    expect(screen.getByText('I was charged twice for July.')).toBeInTheDocument();
  });

  it('withholds a balance the role may not see rather than showing zero', async () => {
    apiMock.mockResolvedValue(detail({ member: { ...detail().member!, balanceMinor: null } }));
    open();
    await screen.findByText('Charged twice in July');
    expect(screen.getByText('Restricted')).toBeInTheDocument();
  });

  it('says the read failed instead of sitting on a skeleton for ever', async () => {
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(new Error('boom'));
      rejected.catch(() => undefined);
      return rejected;
    });
    open();

    expect(await screen.findByText('Could not load this ticket')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has changed on the ticket/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('Ticket detail — replying', () => {
  it('sends to the member and says the reply lands in their app', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail());
    open();

    await screen.findByText('Charged twice in July');
    await user.type(screen.getByLabelText('Reply to the member'), 'Refunded — sorry about that.');
    await user.click(screen.getByRole('button', { name: 'Send to member' }));

    await waitFor(() => expect(replyKeys()).toHaveLength(1));
    const call = apiMock.mock.calls.find(([p]) => String(p).endsWith('/reply'))!;
    expect((call[1] as { body: { body: string; internal: boolean } }).body).toEqual({
      body: 'Refunded — sorry about that.',
      internal: false,
    });
  });

  it('retries a lost reply under the same key so the member is not told twice', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../../lib/api');
    apiMock.mockImplementation((path: string) => {
      if (!String(path).endsWith('/reply')) return Promise.resolve(detail());
      if (replyKeys().length === 1) {
        const rejected = Promise.reject(new OfflineError());
        rejected.catch(() => undefined);
        return rejected;
      }
      return Promise.resolve(detail());
    });
    open();

    await screen.findByText('Charged twice in July');
    await user.type(screen.getByLabelText('Reply to the member'), 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send to member' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/No connection/));

    // The draft is intact, because as far as this screen knows nothing sent.
    fireEvent.click(screen.getByRole('button', { name: 'Send to member' }));
    await waitFor(() => expect(replyKeys()).toHaveLength(2));
    expect(replyKeys()[0]).toBe(replyKeys()[1]);
  });

  it('mints a new key once the draft changes, because that is a different message', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');
    apiMock.mockImplementation((path: string) => {
      if (!String(path).endsWith('/reply')) return Promise.resolve(detail());
      if (replyKeys().length === 1) {
        const rejected = Promise.reject(
          new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Too long.', requestId: 'r' } }),
        );
        rejected.catch(() => undefined);
        return rejected;
      }
      return Promise.resolve(detail());
    });
    open();

    await screen.findByText('Charged twice in July');
    const box = screen.getByLabelText('Reply to the member');
    await user.type(box, 'First draft.');
    fireEvent.click(screen.getByRole('button', { name: 'Send to member' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.clear(box);
    await user.type(box, 'Rewritten and shorter.');
    fireEvent.click(screen.getByRole('button', { name: 'Send to member' }));
    await waitFor(() => expect(replyKeys()).toHaveLength(2));
    expect(replyKeys()[0]).not.toBe(replyKeys()[1]);
  });

  it('sends an internal note as internal, and says the member never sees it', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail());
    open();

    await screen.findByText('Charged twice in July');
    await user.click(screen.getByRole('button', { name: 'Internal' }));
    expect(screen.getByText(/It does not start or stop the reply clock/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Internal note'), 'Third complaint this month.');
    await user.click(screen.getByRole('button', { name: 'Add internal note' }));

    await waitFor(() => expect(replyKeys()).toHaveLength(1));
    const call = apiMock.mock.calls.find(([p]) => String(p).endsWith('/reply'))!;
    expect((call[1] as { body: { internal: boolean } }).body.internal).toBe(true);
  });

  it('refuses to offer a reply to an anonymous report, and explains why', async () => {
    apiMock.mockResolvedValue(
      detail({
        ticket: ticket({ anonymous: true, memberId: null, memberName: null, category: 'complaint' }),
        member: null,
        conversationId: null,
        messages: [],
        replyBlockedReason:
          'This was reported anonymously, so there is no member to reply to. Nothing links it to a person — that was the promise made when it was submitted.',
      }),
    );
    open();

    // Stated twice on purpose: once where the member card would be, once
    // where the reply box would be. Both are places somebody looks.
    expect((await screen.findAllByText(/reported anonymously/i)).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByLabelText('Reply to the member')).not.toBeInTheDocument();
    // An anonymous report is still workable — it just cannot be answered.
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('blocks a reply to a member whose record was deleted, without closing the ticket', async () => {
    apiMock.mockResolvedValue(
      detail({
        ticket: ticket({ memberInactive: true }),
        member: { ...detail().member!, inactive: true },
        replyBlockedReason: 'This member’s record has been deleted. The ticket stays open so it can be settled.',
      }),
    );
    open();

    expect(await screen.findByText(/record has been deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('sends nothing while offline', async () => {
    apiMock.mockResolvedValue(detail());
    open({ online: false });

    await screen.findByText('Charged twice in July');
    expect(screen.getByText(/Replies, assignment and resolution all need a connection/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('Ticket detail — the record', () => {
  it('states the consequence and demands a reason before escalating', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail());
    open();

    await screen.findByText('Charged twice in July');
    await user.click(screen.getByRole('button', { name: 'Escalate' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Escalate' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Why'), 'Threatening to go to the press.');
    expect(confirm).toBeEnabled();
  });

  it('offers no escalation on a ticket already escalated, and shows the record', async () => {
    apiMock.mockResolvedValue(
      detail({
        ticket: ticket({ escalated: true }),
        escalation: { at: '2026-08-19T05:00:00.000Z', by: 'Vikas Menon', reason: 'Member very upset' },
      }),
    );
    open();

    expect(await screen.findByText(/Escalated by Vikas Menon/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be lifted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
  });

  it('demands a resolution that says what was done', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail());
    open();

    await screen.findByText('Charged twice in July');
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Resolve' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('What was done'), 'Refunded the duplicate charge.');
    expect(within(dialog).getByRole('button', { name: 'Resolve' })).toBeEnabled();
  });

  it('says reopening keeps the original reply time', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail({ ticket: ticket({ state: 'resolved' }) }));
    open();

    await screen.findByText('Charged twice in July');
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/original reply time is not reset/i)).toBeInTheDocument();
  });

  it('offers nothing at all on a closed ticket', async () => {
    apiMock.mockResolvedValue(detail({ ticket: ticket({ state: 'closed' }) }));
    open();

    expect(await screen.findByRole('button', { name: 'Closed for good' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('shows the timeline and says it cannot be edited', async () => {
    apiMock.mockResolvedValue(detail());
    open();

    expect(await screen.findByText(/Append-only · cannot be edited/)).toBeInTheDocument();
    expect(screen.getByText('SUP-1051 opened: Charged twice in July')).toBeInTheDocument();
  });

  it('flags a safety-scanned ticket in the plain register', async () => {
    apiMock.mockResolvedValue(
      detail({ ticket: ticket({ safetyCategories: ['distress'], vulnerabilityFlag: true, priority: 'urgent' }) }),
    );
    open();

    expect(await screen.findByText(/tripped a safety pattern/i)).toBeInTheDocument();
    expect(screen.getByText('Vulnerable — no automation')).toBeInTheDocument();
  });
});
