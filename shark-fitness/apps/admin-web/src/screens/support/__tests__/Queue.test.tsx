import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Queue from '../Queue';
import { TZ, queue, renderPanel, ticket } from './harness';

function open(overrides: Partial<Parameters<typeof Queue>[0]> = {}) {
  return renderPanel(
    <Queue
      data={queue()}
      loading={false}
      timeZone={TZ}
      online
      canManage
      flag="all"
      onFlag={() => undefined}
      search=""
      onSearch={() => undefined}
      onOpen={() => undefined}
      onNew={() => undefined}
      {...overrides}
    />,
  );
}

describe('Queue — the working surface', () => {
  it('keeps valid table semantics with the reference as the row control', () => {
    open();
    // A `<tr role="button">` removes a row from a table rather than adding a
    // button to one; the control lives in the identifying cell instead.
    const row = screen.getByRole('row', { name: /SUP-1051/ });
    expect(row).not.toHaveAttribute('role', 'button');
    expect(within(row).getByRole('button', { name: 'SUP-1051' })).toBeInTheDocument();
    expect(within(row).getByText('Charged twice in July')).toBeInTheDocument();
  });

  it('opens a ticket from the keyboard without the row pretending to be a button', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    open({ onOpen });

    screen.getByRole('button', { name: 'SUP-1051' }).focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('tkt_1');
  });

  it('states the reply promise as a sentence, not as a state name', () => {
    open();
    // "breached" tells a receptionist nothing they can act on.
    expect(screen.getByText('Reply due in 4h')).toBeInTheDocument();
  });

  it('leads with a breach', () => {
    open({
      data: queue({
        items: [
          ticket({
            id: 'tkt_2',
            reference: 'SUP-1054',
            sla: {
              state: 'breached',
              label: 'Reply 16h overdue',
              dueInMinutes: -960,
              breached: true,
              dueAt: '2026-08-18T12:00:00.000Z',
              responseMinutes: 720,
              firstResponseAt: null,
            },
          }),
        ],
        counts: { ...queue().counts, breached: 1 },
      }),
    });
    expect(screen.getByText('Reply 16h overdue')).toBeInTheDocument();
    const breaching = screen.getByRole('button', { name: /Breaching/ });
    expect(within(breaching).getByText('1')).toBeInTheDocument();
  });

  it('names an anonymous report without inventing a member to withhold', () => {
    open({
      data: queue({
        items: [ticket({ anonymous: true, memberId: null, memberName: null, memberInactive: false })],
      }),
    });
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });

  it('says a member record is gone rather than showing a blank cell', () => {
    open({ data: queue({ items: [ticket({ memberInactive: true })] }) });
    expect(screen.getByText('Record deleted')).toBeInTheDocument();
  });

  it('marks a reopened ticket, because the same dispute coming back matters', () => {
    open({ data: queue({ items: [ticket({ reopenCount: 2 })] }) });
    expect(screen.getByText('Reopened 2×')).toBeInTheDocument();
  });

  it('uses the counts as filters rather than as decoration', async () => {
    const user = userEvent.setup();
    const onFlag = vi.fn();
    open({ onFlag });

    await user.click(screen.getByRole('button', { name: /Unassigned/ }));
    expect(onFlag).toHaveBeenCalledWith('unassigned');
  });

  it('offers no ticket creation while offline', () => {
    open({ online: false });
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();
  });

  it('says "nothing in the queue" only when the queue really is empty', () => {
    open({ data: queue({ items: [] }) });
    expect(screen.getByText('Nothing in the queue')).toBeInTheDocument();
  });

  it('says something different when a filter is what emptied the table', async () => {
    const user = userEvent.setup();
    open();
    // There is a ticket; the state filter just excludes it. Rendering the same
    // "nothing here" sentence for both would teach the operator to distrust it.
    await user.selectOptions(screen.getByRole('combobox', { name: /State/i }), 'closed');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
  });

  it('shows a skeleton rather than an empty table while loading', () => {
    open({ data: undefined, loading: true });
    expect(screen.queryByText('Nothing in the queue')).not.toBeInTheDocument();
  });
});
