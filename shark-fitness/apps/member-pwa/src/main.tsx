import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { useSession } from './lib/store';
import { useMemberConnection } from './lib/realtime';
import { API_ORIGIN } from './lib/api';
import { queryClient } from './lib/query-client';
import { ownerOf, purgeExpiredSnapshots, startPersisting } from './lib/persisted-cache';
import { refreshPushRegistration } from './lib/push';
import { hasMemberSessionHint, setMemberSessionHint } from './lib/session-hint';
import { installGlobalErrorListeners } from './lib/error-reporting';
import { AppErrorBoundary } from './ui/ErrorBoundary';
import { registerServiceWorker } from './lib/sw-update';
import { useAppearance } from './lib/preferences';
import { captureInstallPrompt, countVisit } from './lib/install';
import './styles.css';

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

  useMemberConnection(viewer, queryClient);
  useAppearance();

  // Keep a per-person snapshot of the screens that must work offline.
  const owner = viewer ? ownerOf(viewer) : null;
  useEffect(() => {
    if (!owner) return;
    return startPersisting(queryClient, () => useSession.getState());
  }, [owner]);

  // Re-attach this phone's push subscription to the current session.
  useEffect(() => {
    if (owner && !useSession.getState().offlineStart) void refreshPushRegistration(owner);
  }, [owner]);

  // The server ended the session: go to sign-in, which explains and returns
  // the member to where they were.
  const sessionEnded = useSession((s) => s.sessionEnded);
  useEffect(() => {
    if (sessionEnded && status === 'signed-out') void router.navigate({ to: '/sign-in' });
  }, [sessionEnded, status]);

  // Opened offline from the snapshot: once the network is back, prove the
  // session with the server (a 401 there ends it properly).
  const offlineStart = useSession((s) => s.offlineStart);
  useEffect(() => {
    if (!offlineStart) return;
    const recheck = (): void => void bootstrap();
    window.addEventListener('online', recheck);
    return () => window.removeEventListener('online', recheck);
  }, [offlineStart, bootstrap]);

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

installGlobalErrorListeners();
captureInstallPrompt();
countVisit();
registerServiceWorker();
void purgeExpiredSnapshots();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Boot />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
