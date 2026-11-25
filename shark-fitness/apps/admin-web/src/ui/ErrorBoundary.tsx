import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import type { ClientErrorReporter } from '@shark/contracts';
import { clientErrors } from '../lib/error-reporting';
import { Button, Display, Label } from './console';

/**
 * What a crashed screen becomes. Plain register: say what happened, give one
 * way out, and a reference support can search for. It reports the error once
 * per fingerprint per session; a reload loop does not flood the inbox.
 */
export function RecoveryScreen({
  error,
  reporter = clientErrors,
  fullPage = false,
}: {
  error: unknown;
  reporter?: ClientErrorReporter;
  fullPage?: boolean;
}) {
  // Keyed on the error: the router can render this screen for one error and
  // then again for the one that finally stuck, and the reference shown must be
  // the one that was reported.
  const reference = useMemo(() => reporter.referenceFor(error), [error, reporter]);
  useEffect(() => {
    reporter.report(error, 'boundary');
  }, [error, reporter]);

  return (
    <div className={fullPage ? 'grid min-h-dvh place-items-center bg-abyss p-6' : 'grid place-items-center px-6 py-16'}>
      <section
        role="alert"
        className="flex w-full max-w-[440px] flex-col items-start gap-4 border border-line bg-panel p-6"
      >
        <Display size="md" as="h1">
          Something went wrong.
        </Display>
        <p className="text-[14px] leading-relaxed text-foam-65">
          This screen stopped working. Reloading usually fixes it, and nothing you saved before this is lost.
        </p>
        <Button variant="cta" size="md" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <Label>Reference</Label>
          <p className="font-utility text-[13px] tracking-[0.08em] text-foam" data-testid="error-reference">
            {reference}
          </p>
          <p className="text-[12px] leading-relaxed text-foam-65">If it keeps happening, send this reference to support.</p>
        </div>
      </section>
    </div>
  );
}

/** Top-level boundary for anything outside the router's own error handling. */
export class AppErrorBoundary extends Component<
  { children: ReactNode; reporter?: ClientErrorReporter },
  { error: unknown; failed: boolean }
> {
  override state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Reporting happens in RecoveryScreen so both boundaries share one path.
  }

  override render() {
    if (this.state.failed) {
      return <RecoveryScreen error={this.state.error} fullPage {...(this.props.reporter ? { reporter: this.props.reporter } : {})} />;
    }
    return this.props.children;
  }
}
