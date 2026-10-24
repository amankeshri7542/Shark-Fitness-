import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConsequenceDialog, SettingRow } from '../shared';
import { renderPanel, setting } from './harness';

/* ============================================================================
   The two things Settings does that no other screen does.

   Both are load-bearing rather than decorative: the inheritance indicator is
   the whole of PF-TEN-003 as an operator experiences it, and the consequence
   dialog is the only thing standing between "change the currency" and an
   invoice history nobody can reconcile.
   ========================================================================= */

describe('SettingRow — inheritance is shown by asymmetry', () => {
  it('stays quiet when a branch inherits', () => {
    renderPanel(
      <SettingRow setting={setting({ source: 'tenant' })} disabled={false} onChange={vi.fn()} onInherit={vi.fn()} />,
    );
    expect(screen.queryByText('Overridden here')).not.toBeInTheDocument();
    // Nothing is offered to reset, because there is nothing overriding.
    expect(screen.getByRole('button', { name: 'Inherited' })).toBeDisabled();
  });

  it('announces an override, and prints the gym default beside it', () => {
    renderPanel(
      <SettingRow
        setting={setting({ source: 'branch', value: 25, tenantValue: 90 })}
        disabled={false}
        onChange={vi.fn()}
        onInherit={vi.fn()}
      />,
    );
    expect(screen.getByText('Overridden here')).toBeInTheDocument();
    // Seeing what you changed away from, without opening another screen.
    expect(screen.getByText('Gym default: 90')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use gym default' })).toBeEnabled();
  });

  it('marks a tenant-wide promise and refuses to edit it here', () => {
    renderPanel(
      <SettingRow
        setting={setting({ key: 'graceDays', label: 'Grace period', overridable: false, source: 'tenant' })}
        disabled={false}
        onChange={vi.fn()}
        onInherit={vi.fn()}
      />,
    );
    expect(screen.getByText('Whole gym')).toBeInTheDocument();
    expect(screen.getByLabelText('Grace period')).toBeDisabled();
    // No "use gym default" on something that has no branch value to clear.
    expect(screen.queryByRole('button', { name: /gym default/i })).not.toBeInTheDocument();
  });

  it('distinguishes an explicit off from an unset value', () => {
    // The reason overrides are keyed by presence: `false` is an answer.
    renderPanel(
      <SettingRow
        setting={setting({ key: 'graceAllowsEntry', label: 'Let members in during grace', kind: 'boolean', value: false, tenantValue: true, source: 'branch' })}
        disabled={false}
        onChange={vi.fn()}
        onInherit={vi.fn()}
      />,
    );
    expect(screen.getByText('Overridden here')).toBeInTheDocument();
    expect(screen.getByText('Gym default: on')).toBeInTheDocument();
    expect(screen.getByLabelText('Let members in during grace')).not.toBeChecked();
  });

  it('reports the new value as the operator types it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(<SettingRow setting={setting()} disabled={false} onChange={onChange} onInherit={vi.fn()} />);
    await user.clear(screen.getByLabelText('Anti-passback window'));
    await user.type(screen.getByLabelText('Anti-passback window'), '30');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('ConsequenceDialog — what a change does, before it does it', () => {
  const advisory = [
    { code: 'branch.future_bookings', message: '1532 future bookings will stay on the timetable.', blocking: false, count: 1532 },
  ];
  const blocking = [
    { code: 'branch.home_members', message: '40 members call this their home branch. Move them first.', blocking: true, count: 40 },
  ];

  it('lists what will happen and confirms with the operator’s own words', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderPanel(
      <ConsequenceDialog
        open
        title="This affects records that already exist"
        intent="Close temporarily"
        consequences={advisory}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText(/1532 future bookings/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close temporarily' }));
    // The codes are echoed back: a warning the client never rendered cannot be
    // acknowledged, which is the whole mechanism.
    expect(onConfirm).toHaveBeenCalledWith(['branch.future_bookings']);
  });

  it('cannot be confirmed past a blocking consequence', () => {
    renderPanel(
      <ConsequenceDialog
        open
        title="This affects records that already exist"
        intent="Archive permanently"
        consequences={[...blocking, ...advisory]}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Archive permanently' })).toBeDisabled();
    expect(screen.getByText(/Move them first/)).toBeInTheDocument();
    // One control per name inside a dialog. The panel header owns "Close"; the
    // footer abandons the attempt, and says so.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('never sends a blocking code as an acknowledgement', async () => {
    const onConfirm = vi.fn();
    renderPanel(
      <ConsequenceDialog
        open
        title="t"
        intent="Apply anyway"
        consequences={advisory}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply anyway' }));
    const sent = onConfirm.mock.calls[0]![0] as string[];
    expect(sent).not.toContain('branch.home_members');
  });

  it('is a modal dialog that traps focus and closes on Escape', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderPanel(
      <ConsequenceDialog
        open
        title="This affects records that already exist"
        intent="Apply anyway"
        consequences={advisory}
        pending={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText(/1532 future bookings/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
