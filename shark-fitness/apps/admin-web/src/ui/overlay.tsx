import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Display, Label, cx } from './console';

/* ============================================================================
   Floating surfaces — the same hairline geometry as the console grid, lifted
   off it. Nothing here rounds a corner, tints a shadow or animates for
   decoration; a drawer slides because it came from an edge, and the global
   reduced-motion rule in sonar.css turns that off for anyone who asked.

   Both surfaces trap focus and give it back. A till operator working by
   keyboard must not be able to tab out of a payment dialog into the catalogue
   behind it, and must land back on the control they opened it from.
   ========================================================================= */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Focus containment for a modal surface.
 *
 * Returns a ref for the panel. On mount it remembers what had focus, moves
 * focus inside, and on unmount puts it back — including when the element that
 * opened the panel has since been re-rendered, which is why the restore target
 * is captured rather than looked up again.
 */
function useFocusTrap(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // Callers pass an inline arrow, so `onClose` is a new function on every
  // parent render. Held in a ref, the effects below key on `open` alone —
  // otherwise every keystroke in a dialog re-ran the effect and pulled focus
  // back out of the field being typed into.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    // The panel itself, not its first control. A screen reader then announces
    // the dialog and its name before anything inside it, and Tab walks the
    // content in document order rather than starting at the close button that
    // happens to sit first in the header.
    panelRef.current?.focus();

    return () => {
      restoreTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      // Focus starts on the panel, which is not in this list, so a first Tab
      // has to be steered explicitly or it would escape to the page behind.
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  return panelRef;
}

/**
 * A right-anchored sheet for detail and quick edit.
 *
 * Used wherever a record needs more room than a row but does not deserve its
 * own route: an order's lines and tenders, a product's ledger, a transfer's
 * receipt count. The list behind it stays on screen, which is the point —
 * a stocktake is a comparison, not a sequence of pages.
 */
export function Drawer({
  open,
  onClose,
  title,
  kicker,
  footer,
  children,
  width = 'w-[min(560px,100vw)]',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  kicker?: string;
  footer?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useFocusTrap(open, onClose);
  const close = onClose;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim" onClick={close} role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cx('flex h-full flex-col border-l border-line-strong bg-overlay outline-none', width)}
      >
        <header className="flex flex-none items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {kicker ? <Label>{kicker}</Label> : null}
            <Display size="sm" as="h2" className="mt-0.5 truncate">
              {title}
            </Display>
          </div>
          <span className="flex-1" />
          <Button variant="ghost" onClick={close} aria-label="Close">
            Close
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer ? <div className="flex-none border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * A centred dialog for an action that cannot be taken back.
 *
 * The Design PRD requires a destructive or financially significant action to
 * state its impact and scope before it happens, so `consequence` is a required
 * prop rather than an optional flourish — there is no way to call this and
 * leave the operator guessing what a void does to the day's takings.
 *
 * `reasonLabel` turns it into a reason-gated confirm. The server refuses a void
 * or a cancellation without one, so collecting it here is not client-side
 * validation standing in for a rule; it is asking before the round trip.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel,
  tone = 'danger',
  reasonLabel,
  reason,
  onReasonChange,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  consequence: string;
  confirmLabel: string;
  tone?: 'danger' | 'cta';
  reasonLabel?: string;
  reason?: string;
  onReasonChange?: (value: string) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const panelRef = useFocusTrap(open, onClose);
  const close = onClose;

  if (!open) return null;

  // The server wants at least four characters; asking for them here saves a
  // round trip, but the server is still the one that decides.
  const reasonTooShort = reasonLabel !== undefined && (reason ?? '').trim().length < 4;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[14vh]"
      onClick={close}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(460px,92vw)] border border-line-strong bg-overlay outline-none"
      >
        <div className="flex flex-col gap-3 p-4">
          <Display size="sm" as="h2">
            {title}
          </Display>
          <p className="text-[13px] leading-relaxed text-foam-65">{consequence}</p>

          {reasonLabel !== undefined ? (
            <label className="flex flex-col gap-1">
              <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                {reasonLabel}
              </span>
              <textarea
                className="sf-field !min-h-[72px] !text-[13px]"
                value={reason ?? ''}
                onChange={(e) => onReasonChange?.(e.target.value)}
                placeholder="Recorded in the audit log"
              />
            </label>
          ) : null}

          {error ? <p className="text-[12px] text-chum">{error}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="outline" onClick={close} disabled={pending}>
            Keep it
          </Button>
          <Button variant={tone} onClick={onConfirm} disabled={pending || reasonTooShort}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
