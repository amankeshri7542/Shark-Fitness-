import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { channels } from '@shark/contracts';
import { router } from './router';
import { useSession } from './lib/store';
import { connectRealtime, disconnectRealtime } from './lib/realtime';
import { startOutbox } from './lib/outbox';
import { ApiError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Realtime pushes what changed; polling on top of that is waste.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // A 4xx will not fix itself. Only retry transport and server faults.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

function Boot() {
  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  const viewer = useSession((s) => s.viewer);

  useEffect(() => {
    void bootstrap();
    startOutbox();
  }, [bootstrap]);

  useEffect(() => {
    if (!viewer) {
      disconnectRealtime();
      return;
    }
    const subscribe = [
      channels.tenant(viewer.tenantId),
      ...viewer.permittedBranchIds.map(channels.branch),
      ...(viewer.memberId ? [channels.member(viewer.memberId)] : []),
    ];
    connectRealtime(queryClient, subscribe);
    return () => disconnectRealtime();
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
