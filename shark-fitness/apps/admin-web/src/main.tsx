import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { channels } from '@shark/contracts';
import { router } from './router';
import { useAdmin } from './lib/store';
import { ApiError } from './lib/api';
import { connectRealtime, disconnectRealtime } from './lib/realtime';
import { installGlobalErrorListeners } from './lib/error-reporting';
import { recoverFromRootServiceWorker } from './lib/sw-recovery';
import { AppErrorBoundary } from './ui/ErrorBoundary';
import { SessionGuard, safeReturnPath } from './ui/SessionGuard';
import { TwoStepGate } from './ui/TwoStep';
import './styles.css';

/** Installable console: a shell-only worker scoped to /admin/ (src/sw/sw.ts). */
function registerConsoleWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/', updateViaCache: 'none' }).catch(() => undefined);
  });
}
registerConsoleWorker();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

function Boot() {
  const status = useAdmin((s) => s.status);
  const bootstrap = useAdmin((s) => s.bootstrap);
  const viewer = useAdmin((s) => s.viewer);
  const mfaPending = useAdmin((s) => s.mfaPending);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Staff sockets may hold the tenant channel and every branch they can see.
  // There is no member channel for staff, so nothing member-scoped arrives.
  useEffect(() => {
    if (!viewer) {
      disconnectRealtime();
      return;
    }
    void connectRealtime(queryClient, [
      channels.tenant(viewer.tenantId),
      ...viewer.permittedBranchIds.map(channels.branch),
    ]);
    return () => disconnectRealtime();
  }, [viewer]);

  if (status === 'loading') {
    return (
      <div className="grid h-dvh place-items-center">
        <div className="flex items-center gap-2.5">
          <span className="font-display text-[22px] uppercase tracking-[0.06em]">Shark</span>
          <span
            aria-hidden="true"
            className="h-1 w-10"
            style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
          />
          <span className="sr-only">Loading</span>
        </div>
      </div>
    );
  }

  // A session that still owes a code or an enrolment sees only that.
  if (mfaPending) {
    return (
      <TwoStepGate
        state={mfaPending}
        onComplete={() => {
          const returnTo = safeReturnPath(new URLSearchParams(window.location.search).get('redirect'));
          void useAdmin
            .getState()
            .bootstrap()
            .then(() => router.navigate({ href: returnTo ?? '/' }));
        }}
      />
    );
  }

  return (
    <>
      <RouterProvider router={router} />
      <SessionGuard
        onSignIn={(returnTo) => {
          // Clear the dead session locally, then sign in and come back here.
          useAdmin.setState({ viewer: null, impersonation: null, status: 'signed-out', sessionEnded: null });
          queryClient.clear();
          void router.navigate({ to: '/sign-in', search: { redirect: returnTo } });
        }}
      />
    </>
  );
}

recoverFromRootServiceWorker();
installGlobalErrorListeners();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Boot />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
