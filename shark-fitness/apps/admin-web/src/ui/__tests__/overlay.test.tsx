import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfirmDialog, Drawer, Modal } from '../overlay';

/* The Store puts every detail view and every irreversible action behind one of
   these two surfaces, so their keyboard behaviour is the module's keyboard
   behaviour. A till operator working by keyboard must not be able to tab into
   the list behind a payment dialog, and must land back where they started. */

describe('Drawer', () => {
  it('is a labelled modal dialog', () => {
    render(
      <Drawer open onClose={() => undefined} title="Shark Tee">
        <p>Body</p>
      </Drawer>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Shark Tee' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('moves focus onto the panel on open, so its name is announced', () => {
    render(
      <Drawer open onClose={() => undefined} title="Shark Tee">
        <button type="button">First</button>
      </Drawer>,
    );

    expect(screen.getByRole('dialog', { name: 'Shark Tee' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Drawer open onClose={onClose} title="Shark Tee">
        <button type="button">First</button>
      </Drawer>,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps Tab inside the panel', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind</button>
        <Drawer open onClose={() => undefined} title="Shark Tee">
          <button type="button">First</button>
          <button type="button">Second</button>
        </Drawer>
      </>,
    );

    await user.tab();
    await user.tab();
    await user.tab();
    // Three tabs from the first control cycles back inside, never to "Behind".
    expect(screen.getByRole('button', { name: 'Behind' })).not.toHaveFocus();
  });

  it('gives focus back to whatever opened it', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Drawer open={open} onClose={() => setOpen(false)} title="Shark Tee">
            <button type="button">Inside</button>
          </Drawer>
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Shark Tee' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('renders nothing at all when closed', () => {
    render(
      <Drawer open={false} onClose={() => undefined} title="Shark Tee">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('states the consequence before it will confirm anything', () => {
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="Void this sale?"
        consequence="₹1,180.00 comes out of today's takings."
        confirmLabel="Void the sale"
      />,
    );

    const dialog = screen.getByRole('alertdialog', { name: 'Void this sale?' });
    expect(dialog).toHaveTextContent("₹1,180.00 comes out of today's takings.");
  });

  it('holds the confirm button until a long enough reason is given', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [reason, setReason] = useState('');
      return (
        <ConfirmDialog
          open
          onClose={() => undefined}
          onConfirm={() => undefined}
          title="Void this sale?"
          consequence="It cannot be undone."
          confirmLabel="Void the sale"
          reasonLabel="Reason"
          reason={reason}
          onReasonChange={setReason}
        />
      );
    }

    render(<Harness />);
    const confirm = screen.getByRole('button', { name: 'Void the sale' });
    expect(confirm).toBeDisabled();

    // The server refuses anything under four characters; so does the button.
    await user.type(screen.getByLabelText('Reason'), 'oop');
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Reason'), 's');
    expect(confirm).toBeEnabled();
  });

  it('disables both buttons while the server is still deciding', () => {
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="Void this sale?"
        consequence="It cannot be undone."
        confirmLabel="Void the sale"
        pending
      />,
    );

    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
  });
});

/* ============================================================================
   Modal.

   Eighteen dialogs across Leads, Billing, Plans, Staff, Training, Equipment
   and the member record were hand-built before this existed. Every one of them
   set `aria-modal="true"` — telling assistive technology the rest of the page
   was inert — and not one trapped focus, restored it, or closed on Escape. A
   keyboard user tabbed out of the dialog into the page behind it with no way
   back. These are the guarantees that migration was for.
   ========================================================================= */

describe('Modal', () => {
  it('is a labelled modal dialog', () => {
    render(
      <Modal open onClose={() => undefined} title="New lead">
        <p>Body</p>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'New lead' })).toHaveAttribute('aria-modal', 'true');
  });

  it('moves focus onto the panel on open, so its name is announced first', () => {
    render(
      <Modal open onClose={() => undefined} title="New lead">
        <button type="button">Inside</button>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'New lead' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open onClose={onClose} title="New lead">
        <button type="button">Inside</button>
      </Modal>,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the panel rather than letting it escape to the page behind', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind</button>
        <Modal open onClose={() => undefined} title="New lead" footer={<button type="button">Save</button>}>
          <button type="button">Inside</button>
        </Modal>
      </>,
    );

    // Round the whole panel twice. "Behind" is outside the dialog and must
    // never receive focus — that was the defect in all eighteen originals.
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(screen.getByRole('button', { name: 'Behind' })).not.toHaveFocus();
    }
  });

  it('gives focus back to whatever opened it', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open ? (
            <Modal open onClose={() => setOpen(false)} title="New lead">
              <p>Body</p>
            </Modal>
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.keyboard('{Escape}');

    // Without this the operator is dumped at the top of the document and has
    // to tab back down to where they were.
    expect(opener).toHaveFocus();
  });

  it('renders nothing at all when closed', () => {
    render(
      <Modal open={false} onClose={() => undefined} title="New lead">
        <p>Body</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
