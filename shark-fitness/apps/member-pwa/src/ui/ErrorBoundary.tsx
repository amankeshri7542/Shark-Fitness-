import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import type { ClientErrorReporter } from '@shark/contracts';
import { clientErrors } from '../lib/error-reporting';
import { Button, Display, Label } from './primitives';

/**
 * What a crashed screen becomes. Plain register: say what happened, give one
 * way out, and a reference the front desk or support can search for. It
 * reports the error once per fingerprint per session.
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
  const [reference] = useState(() => reporter.referenceFor(error));
  useEffect(() => {
    reporter.report(error, 'boundary');
  }, [error, reporter]);

  const card = (
    <section role="alert" className="flex w-full flex-col items-start gap-4 border border-line bg-panel p-5">
      <Display size="md" as="h1">
        Something went wrong.
      </Display>
      <p className="text-[15px] leading-relaxed text-foam-65">
        This screen stopped working. Reloading usually fixes it.
      </p>
      <Button variant="cta" size="lg" full onClick={() => window.location.reload()}>
        Reload
      </Button>
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <Label>Reference</Label>
        <p className="font-utility text-[14px] tracking-[0.08em] text-foam" data-testid="error-reference">
          {reference}
        </p>
        <p className="text-[13px] leading-relaxed text-foam-65">If it keeps happening, show this reference at the front desk.</p>
      </div>
    </section>
  );

  if (!fullPage) return <div className="flex flex-1 flex-col justify-center px-5 py-10">{card}</div>;
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="sf-device justify-center px-5">{card}</div>
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
