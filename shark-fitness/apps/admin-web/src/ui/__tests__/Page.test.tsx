import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Page } from '../shell';

/* ============================================================================
   The screen shell's scroll contract.

   Every admin screen is a fixed-height pane that clips, with one scrolling
   region inside it. That only works if the shell actually *takes* the pane's
   height: it is a block child, and a block box sizes to its content, so
   without `h-full` it grew past its parent instead of filling it. Its own
   `overflow-hidden` then never fired, the pane below never became a scroller,
   and nothing scrolled — Billing rendered all 107 invoice rows with 96 of them
   below the fold and no way to reach them. On every screen, for the life of
   the console.

   jsdom has no layout, so this asserts the structural contract rather than
   pixels: the shell fills its parent and clips, the header does not shrink,
   and the content pane is the one thing allowed to scroll. The behavioural
   proof is the browser pass — 107 rows reachable at 1440, 768 and 375.
   ========================================================================= */

const shellOf = (container: HTMLElement): HTMLElement => container.firstElementChild as HTMLElement;

describe('Page — the scroll contract', () => {
  it('fills its parent rather than growing to its content', () => {
    const { container } = render(
      <Page title="Billing">
        <p>Rows</p>
      </Page>,
    );
    const shell = shellOf(container);
    // Without `h-full` the shell is as tall as its content and the pane below
    // can never overflow, which is exactly how this broke.
    expect(shell.className).toContain('h-full');
    expect(shell.className).toContain('min-h-0');
    expect(shell.className).toContain('overflow-hidden');
    expect(shell.className).toContain('flex-col');
  });

  it('keeps the title row out of the scroll and gives the scroll to the body', () => {
    const { container } = render(
      <Page title="Billing" kicker="107 invoices">
        <p>Rows</p>
      </Page>,
    );
    const [header, body] = [...shellOf(container).children] as HTMLElement[];

    // The header stays put while the body scrolls under it.
    expect(header!.className).toContain('flex-none');
    expect(body!.className).toContain('overflow-auto');
    expect(body!.className).toContain('flex-1');
    // `min-h-0` on the body, or a flex item refuses to shrink below its
    // content and the overflow moves back up to the clipping parent.
    expect(body!.className).toContain('min-h-0');
  });

  it('renders the title as the page heading, with the kicker above it', () => {
    render(
      <Page title="Billing" kicker="107 invoices" actions={<button type="button">Export</button>}>
        <p>Rows</p>
      </Page>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByText('107 invoices')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});
