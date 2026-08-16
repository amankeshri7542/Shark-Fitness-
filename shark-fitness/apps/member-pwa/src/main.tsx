import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { channels } from '@shark/contracts';
import { router } from './router';
import { useSession } from './lib/store';
import { connectRealtime, disconnectRealtime } from './lib/realtime';
import { startOutbox, stopOutbox } from './lib/outbox';
import { API_ORIGIN, ApiError } from './lib/api';
import { hasMemberSessionHint, setMemberSessionHint } from './lib/session-hint';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const SESSION_RESTORE_TIMEOUT_MS = 12_000;

function wakeHostedBackend(): void {
  // The demo's static shell can be served from the PWA cache while Render's
  // free web service is asleep. Wake it opportunistically without blocking the
  // sign-in UI; by the time a reviewer submits credentials it is often ready.
  void fetch(`${API_ORIGIN}/health`, { cache: 'no-store' }).catch(() => undefined);
}

function Boot() {
  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  const setViewer = useSession((s) => s.setViewer);
  const viewer = useSession((s) => s.viewer);

  useEffect(() => {
    // The real session lives in an HttpOnly cookie, so JS cannot inspect it.
    // A fresh browser therefore used to call /v1/me unconditionally. Because
    // the member PWA can load from cache while the free Render backend sleeps,
    // that request could leave the app on the SHARK splash indefinitely.
    // Fresh visitors do not need a server round-trip just to see sign-in.
    if (!hasMemberSessionHint()) {
      setViewer(null);
      wakeHostedBackend();
      return;
    }

    let active = true;
    const timeout = window.setTimeout(() => {
      if (active && useSession.getState().status === 'loading') {
        // Never trap a reviewer/member behind an infinite bootstrap screen.
        // The HttpOnly cookie is not modified; a later sign-in can reuse the
        // backend normally once it is awake.
        setViewer(null);
        wakeHostedBackend();
      }
    }, SESSION_RESTORE_TIMEOUT_MS);

    void bootstrap().finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [bootstrap, setViewer]);

  useEffect(() => {
    if (status === 'signed-in') setMemberSessionHint(true);
    if (status === 'signed-out') setMemberSessionHint(false);
  }, [status]);

  useEffect(() => {
    if (!viewer) {
      disconnectRealtime();
      stopOutbox();
      return;
    }

    const ownerKey = `${viewer.tenantId}:${viewer.userId}`;
    const stop = startOutbox(ownerKey);
    const subscribe = [
      channels.tenant(viewer.tenantId),
      ...viewer.permittedBranchIds.map(channels.branch),
      ...(viewer.memberId ? [channels.member(viewer.memberId)] : []),
    ];
    void connectRealtime(queryClient, subscribe);

    return () => {
      stop();
      disconnectRealtime();
    };
  }, [viewer]);

  if (status === 'loading') {
    return (
      <div className="sf-device items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="font-display text-[28px] uppercase tracking-[0.06em]">Shark</span>
          <span
            aria-hidden="true"
            className="h-1.5 w-16"
            style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
          />
          <span className="sr-only">Loading</span>
        </div>
      </div>
    );
  }

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Boot />
    </QueryClientProvider>
  </StrictMode>,
);
