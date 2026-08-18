import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import type { Viewer } from '@shark/contracts';
import { ADMIN_NAV, can } from '@shark/domain';

const viewerMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/',
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../../lib/store', () => ({
  useViewer: () => viewerMock() as Viewer | null,
  useAdmin: (selector: (s: unknown) => unknown) =>
    selector({ density: 'comfortable', theme: 'dark', paletteOpen: false }),
}));

import { Rail } from '../shell';

const viewer = (role: Viewer['role']): Viewer =>
  ({ userId: 'usr_1', tenantId: 'ten_1', role, permittedBranchIds: ['brn_1'] }) as Viewer;

describe('module rail', () => {
  beforeEach(() => {
    viewerMock.mockReset();
  });

  it('shows an owner every module their role permits', () => {
    viewerMock.mockReturnValue(viewer('owner'));

    render(<Rail />);

    const expected = ADMIN_NAV.filter((m) => can('owner', m.permission));
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(expected.length);
  });

  it('hides the modules reception has no permission for', () => {
    viewerMock.mockReturnValue(viewer('reception'));

    render(<Rail />);

    // Navigation is permission-aware by design: reception should not be shown
    // sixteen modules when they need five.
    const denied = ADMIN_NAV.filter((m) => !can('reception', m.permission));
    expect(denied.length).toBeGreaterThan(0);
    for (const module of denied) {
      expect(screen.queryByRole('link', { name: new RegExp(module.label, 'i') })).not.toBeInTheDocument();
    }
  });

  it('gives reception strictly fewer modules than an owner', () => {
    viewerMock.mockReturnValue(viewer('reception'));
    const { unmount } = render(<Rail />);
    const receptionCount = screen.getAllByRole('link').length;
    unmount();

    viewerMock.mockReturnValue(viewer('owner'));
    render(<Rail />);
    const ownerCount = screen.getAllByRole('link').length;

    expect(receptionCount).toBeLessThan(ownerCount);
    expect(receptionCount).toBeGreaterThan(0);
  });

  it('renders no modules at all when there is no viewer', () => {
    viewerMock.mockReturnValue(null);

    render(<Rail />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
