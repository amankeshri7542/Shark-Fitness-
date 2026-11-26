import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** The app's one query cache. A module rather than a value created in
 *  main.tsx so the session code can clear it on sign-out and seed it from
 *  the persisted copy on an offline start. */
export const queryClient = new QueryClient({
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
