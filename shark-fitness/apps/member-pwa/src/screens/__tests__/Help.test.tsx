import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Branch } from '@shark/contracts';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import HelpScreen from '../Help';
import { useSession } from '../../lib/store';

const branch: Branch = {
  id: 'br_kor',
  tenantId: 'ten_shark',
  name: 'Koramangala Depot',
  slug: 'koramangala',
  addressLine: '80 Feet Road',
  city: 'Bengaluru',
  timezone: 'Asia/Kolkata',
  capacity: 120,
  opensAt: '05:30',
  closesAt: '23:00',
  state: 'active',
  amenities: [],
  phone: '+91 80 4000 1234',
};

beforeEach(() => {
  useSession.setState({ branches: [], activeBranchId: null } as never);
});

describe('Help', () => {
  it('gives the gym’s phone, hours and address, and a way to message', () => {
    useSession.setState({ branches: [branch], activeBranchId: 'br_kor' } as never);
    render(<HelpScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'How can we help' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Send a message' })).toHaveAttribute('href', '/messages');
    // The dial string keeps only digits and the plus.
    expect(screen.getByRole('link', { name: 'Call Koramangala Depot · +91 80 4000 1234' })).toHaveAttribute('href', 'tel:+918040001234');
    expect(screen.getByText('Koramangala Depot: open 05:30–23:00. 80 Feet Road, Bengaluru.')).toBeInTheDocument();
  });

  it('without a known branch or phone, still offers messages and the offline advice, never a dead call link', () => {
    render(<HelpScreen />);
    expect(screen.getByRole('link', { name: 'Send a message' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No signal on the gym floor?' })).toBeInTheDocument();
    expect(screen.getByText(/saved on this phone and upload on their own/)).toBeInTheDocument();
  });

  it('a branch with no phone on file shows its hours but no call button', () => {
    useSession.setState({ branches: [{ ...branch, phone: null }], activeBranchId: 'br_kor' } as never);
    render(<HelpScreen />);
    expect(screen.getByText(/Koramangala Depot: open 05:30–23:00/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
  });
});
