import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Eyebrow } from './primitives';

/**
 * A bottom sheet over the current screen. Escape and the scrim close it;
 * focus moves into it on open and back to whatever opened it on close.
 */
export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the sheet while it is open.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  // Portalled to <body> so a sheet opened from inside a scrolling screen
  // still covers the whole app.
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" tabIndex={-1} className="flex-1 cursor-pointer" onClick={onClose} />
      <div ref={panel} className="sf-safe-bottom sf-sheet animate-rise border-t border-line-strong bg-overlay">
        <div className="max-h-[80dvh] overflow-y-auto p-4">
          <div className="flex items-center gap-2.5">
            <Eyebrow>{title}</Eyebrow>
            <span className="h-px flex-1 bg-line" />
            <button
              type="button"
              onClick={onClose}
              className="grid h-11 min-w-11 cursor-pointer place-items-center px-2 font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:text-sonar"
            >
              Close
            </button>
          </div>
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
