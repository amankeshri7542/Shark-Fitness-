import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Eyebrow } from './primitives';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A bottom sheet dialog over the current screen: modal, focus kept inside,
 * Escape and the scrim close it, and focus returns to whatever opened it.
 *
 * Two ways to name it (one component since the P02/P04 integration):
 * - `title` renders the standard eyebrow header with a Close button
 *   (install instructions, workout dialogs);
 * - `label` only names the dialog for assistive technology, for sheets that
 *   bring their own heading and actions (checkout plan choice, drop-in fee).
 *
 * Portalled to <body> and fixed to the viewport, so a sheet opened from inside
 * a scrolling screen still covers the whole app at every screen size.
 */
export function Sheet({ title, label, children, onClose }: { title?: string; label?: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers often pass an inline arrow; keep the latest one without re-running
  // the focus effect (which would pull focus back to the first control).
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      // Keep Tab inside the sheet while it is open.
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-scrim" role="dialog" aria-modal="true" aria-label={title ?? label}>
      <button type="button" aria-label="Close" tabIndex={-1} className="flex-1 cursor-pointer" onClick={() => close.current()} />
      <div ref={panel} className="sf-safe-bottom sf-sheet animate-rise border-t border-line-strong bg-overlay">
        <div className="max-h-[80dvh] overflow-y-auto p-4 pb-6">
          {title ? (
            <>
              <div className="flex items-center gap-2.5">
                <Eyebrow>{title}</Eyebrow>
                <span className="h-px flex-1 bg-line" />
                <button
                  type="button"
                  onClick={() => close.current()}
                  className="grid h-11 min-w-11 cursor-pointer place-items-center px-2 font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:text-sonar"
                >
                  Close
                </button>
              </div>
              <div className="mt-2">{children}</div>
            </>
          ) : (
            children
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
