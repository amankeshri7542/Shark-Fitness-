import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
const permissionMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ leadId: 'led_1' }),
  Link: ({ children }: { children: ReactNode }) => <a href="/admin/leads">{children}</a>,
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

vi.mock('../../lib/store', () => ({
  usePermission: (permission: string) => permissionMock(permission) as boolean,
}));

import LeadDetailScreen from '../LeadDetail';

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LeadDetailScreen />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerender: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <LeadDetailScreen />
        </QueryClientProvider>,
      ),
  };
}

describe('lead detail permission gate', () => {
  beforeEach(() => {
    apiMock.mockReset();
    permissionMock.mockReset();
  });

  it('tells a viewer without lead.view that the record is restricted', () => {
    permissionMock.mockReturnValue(false);

    renderScreen();

    expect(screen.getByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/This lead is restricted/)).toBeInTheDocument();
  });

  it('does not fetch the lead a viewer is not allowed to see', () => {
    permissionMock.mockReturnValue(false);

    renderScreen();

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('survives the permission flipping from denied to granted', () => {
    // Regression guard. The three useMutation calls used to sit *below* the
    // `if (!canView) return` early exit, so the hook count changed the moment
    // the permission resolved and React threw "rendered more hooks than during
    // the previous render". Nothing here asserts on markup — the point is that
    // the second render does not throw.
    permissionMock.mockReturnValue(false);
    apiMock.mockResolvedValue({ lead: {}, activities: [], existingMember: null });

    const view = renderScreen();
    expect(screen.getByText('Not available to your role')).toBeInTheDocument();

    permissionMock.mockReturnValue(true);
    expect(() => view.rerender()).not.toThrow();
    expect(screen.queryByText('Not available to your role')).not.toBeInTheDocument();
  });

  it('survives the permission flipping from granted to denied', () => {
    permissionMock.mockReturnValue(true);
    apiMock.mockResolvedValue({ lead: {}, activities: [], existingMember: null });

    const view = renderScreen();

    permissionMock.mockReturnValue(false);
    expect(() => view.rerender()).not.toThrow();
    expect(screen.getByText('Not available to your role')).toBeInTheDocument();
  });
});
