import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { TrainerReport } from '@shark/contracts';

import Trainer from '../Trainer';
import { TZ, meta, renderPanel } from './harness';

type Row = TrainerReport['rows'][number];
const row = (overrides: Partial<Row>): Row => ({
  trainerId: 'stf_rehan',
  trainerName: 'Rehan Shaikh',
  sessionsLed: 22,
  seatsBooked: 396,
  seatsCapacity: 440,
  utilisationBp: 9000,
  attended: 371,
  noShows: 25,
  membersCoached: 18,
  retentionBp: 8889,
  ...overrides,
});

describe('Trainer', () => {
  it('gives each coach a row of utilisation and retention, with the base it is computed on', () => {
    renderPanel(
      <Trainer
        data={{ meta: meta(), rows: [row({}), row({ trainerId: 'stf_priya', trainerName: 'Priya Rao', sessionsLed: 9, utilisationBp: 6120, membersCoached: 2, retentionBp: 10000 })] }}
        timeZone={TZ}
      />,
    );
    expect(screen.getByRole('region', { name: 'Utilisation and retention by coach' })).toBeInTheDocument();
    const rehan = screen.getByText('Rehan Shaikh').closest('tr')!;
    expect(within(rehan).getByText('90.0%')).toBeInTheDocument();
    expect(within(rehan).getByText('88.9%')).toBeInTheDocument();
    const priya = screen.getByText('Priya Rao').closest('tr')!;
    expect(within(priya).getByText('100.0%')).toBeInTheDocument();
    expect(within(priya).getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Koramangala Depot only.')).toBeInTheDocument();
  });

  it('leaves a ratio with no base absent rather than zero', () => {
    renderPanel(
      <Trainer
        data={{ meta: meta(), rows: [row({ sessionsLed: 0, seatsBooked: 0, seatsCapacity: 0, utilisationBp: null, attended: 0, noShows: 0, membersCoached: 0, retentionBp: null })] }}
        timeZone={TZ}
      />,
    );
    const rehan = screen.getByText('Rehan Shaikh').closest('tr')!;
    expect(within(rehan).getAllByText('—')).toHaveLength(2);
    expect(within(rehan).queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('says no coach worked in range rather than showing an empty table', () => {
    renderPanel(<Trainer data={{ meta: meta(), rows: [] }} timeZone={TZ} />);
    expect(screen.getByText('No coaches in range')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
