import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button, Segmented, Tabs } from '../console';

/* ============================================================================
   The controls every screen is built from.

   These are the guarantees the console-wide refinement pass was for: one
   keyboard contract for the two strip controls, and one busy contract for
   every action that writes.
   ========================================================================= */

const TABS = [
  { key: 'queue', label: 'Queue' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'retention', label: 'Retention' },
];

function TabHarness({ onChange = () => undefined }: { onChange?: (key: string) => void }) {
  const [active, setActive] = useState('queue');
  return (
    <Tabs
      items={TABS}
      active={active}
      label="Support surfaces"
      onChange={(key) => {
        setActive(key);
        onChange(key);
      }}
    />
  );
}

describe('Tabs — one stop in the tab order', () => {
  it('puts only the selected tab in the tab order', () => {
    render(<TabHarness />);

    // Roving tabIndex. Every tab used to be tabbable, so reaching the content
    // past a five-tab strip cost five presses.
    expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Feedback' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'Retention' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrow keys and wraps', async () => {
    const user = userEvent.setup();
    render(<TabHarness />);

    screen.getByRole('tab', { name: 'Queue' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Feedback' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Retention' })).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<TabHarness />);

    screen.getByRole('tab', { name: 'Queue' }).focus();
    // These strips scroll horizontally, so the last tab is often off screen and
    // End is the only way to reach it without dragging.
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Retention' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Segmented — the same keyboard contract as Tabs', () => {
  function SegHarness() {
    const [value, setValue] = useState('all');
    return (
      <Segmented
        label="State"
        value={value}
        onChange={setValue}
        options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'shut', label: 'Shut' },
        ]}
      />
    );
  }

  it('is one stop in the tab order, not one per option', () => {
    render(<SegHarness />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with arrows and Home/End', async () => {
    const user = userEvent.setup();
    render(<SegHarness />);

    screen.getByRole('button', { name: 'All' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');

    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Shut' })).toHaveAttribute('aria-pressed', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Button — the busy contract', () => {
  it('refuses a second press while the first is still in flight', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button pending onClick={onClick}>
        Save
      </Button>,
    );

    await user.click(screen.getByRole('button'));
    // Thirty-three call sites hand-wrote this, and each one had to remember to
    // disable the control as well as change the label. Several did not — which
    // on a write endpoint is a duplicate record.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks itself busy for assistive technology', () => {
    render(<Button pending>Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the pending label while in flight and the real one otherwise', () => {
    const { rerender } = render(
      <Button pending pendingLabel="Saving…">
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();

    rerender(<Button pendingLabel="Saving…">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('stays disabled when asked, pending or not', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
