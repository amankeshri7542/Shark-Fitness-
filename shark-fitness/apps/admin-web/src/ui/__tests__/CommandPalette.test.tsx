import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Viewer } from '@shark/contracts';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { useAdmin } from '../../lib/store';
import { CommandPalette } from '../shell';

const OWNER = {
  userId: 'usr_owner',
  tenantId: 'ten_shark',
  name: 'Owner',
  role: 'owner',
  permittedBranchIds: ['br_kor'],
} as Viewer;

describe('CommandPalette', () => {
  beforeEach(() => {
    useAdmin.setState({ viewer: OWNER, paletteOpen: false });
  });

  it('focuses search on open and returns focus to its trigger after Escape', async () => {
    const user = userEvent.setup();

    function Harness() {
      const togglePalette = useAdmin((state) => state.togglePalette);
      return (
        <>
          <button type="button" onClick={() => togglePalette(true)}>Search</button>
          <CommandPalette />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Search' });
    await user.click(trigger);

    expect(screen.getByPlaceholderText('Jump to a module')).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
