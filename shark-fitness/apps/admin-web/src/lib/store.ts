import { useMemo } from 'react';
import { create } from 'zustand';
import type { Branch, Viewer } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';
import { api, auth } from './api';

interface AdminState {
  viewer: Viewer | null;
  branches: Branch[];
  activeBranchId: string | null;
  /** Comfortable by default; compact never shrinks a target below 44px. */
  density: 'comfortable' | 'compact';
  theme: 'dark' | 'light';
  status: 'loading' | 'signed-in' | 'signed-out';
  paletteOpen: boolean;
  setViewer: (viewer: Viewer | null) => void;
  setActiveBranch: (branchId: string | null) => void;
  setDensity: (density: 'comfortable' | 'compact') => void;
  setTheme: (theme: 'dark' | 'light') => void;
  togglePalette: (open?: boolean) => void;
  bootstrap: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAdmin = create<AdminState>((set, get) => ({
  viewer: null,
  branches: [],
  activeBranchId: null,
  density: (localStorage.getItem('shark.density') as 'compact') ?? 'comfortable',
  theme: (localStorage.getItem('shark.theme') as 'light') ?? 'dark',
  status: 'loading',
  paletteOpen: false,

  setViewer: (viewer) => set({ viewer, status: viewer ? 'signed-in' : 'signed-out' }),

  setActiveBranch: (activeBranchId) => set({ activeBranchId }),

  setDensity: (density) => {
    localStorage.setItem('shark.density', density);
    document.documentElement.setAttribute('data-density', density);
    set({ density });
  },

  setTheme: (theme) => {
    localStorage.setItem('shark.theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  togglePalette: (open) => set({ paletteOpen: open ?? !get().paletteOpen }),

  bootstrap: async () => {
    document.documentElement.setAttribute('data-theme', get().theme);
    document.documentElement.setAttribute('data-density', get().density);

    if (!auth.get()) {
      set({ status: 'signed-out' });
      return;
    }
    try {
      const { viewer } = await api<{ viewer: Viewer }>('/me');
      if (viewer.role === 'member') {
        // A member token is not a dashboard token. Say so rather than showing
        // an empty console.
        auth.clear();
        set({ viewer: null, status: 'signed-out' });
        return;
      }
      const branches = await api<{ items: Branch[]; activeBranchId: string | null }>('/me/branches');
      set({
        viewer,
        status: 'signed-in',
        branches: branches.items,
        // Null means "all branches I can see" — a regional view, not a default
        // to one location that quietly hides the rest.
        activeBranchId: branches.items.length === 1 ? (branches.items[0]?.id ?? null) : null,
      });
    } catch {
      auth.clear();
      set({ viewer: null, status: 'signed-out' });
    }
  },

  signOut: async () => {
    try {
      await api('/auth/sign-out', { method: 'POST' });
    } catch {
      /* local sign-out matters more than the round trip */
    }
    auth.clear();
    set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out' });
  },
}));

export const useViewer = (): Viewer | null => useAdmin((s) => s.viewer);

export function usePermission(permission: Permission): boolean {
  const role = useAdmin((s) => s.viewer?.role);
  return role ? can(role, permission) : false;
}

/**
 * The zone the console reads business dates in.
 *
 * Stored timestamps are UTC and travel as ISO-8601; what a branch means by
 * "today" is its own clock (Engineering PRD: "Times stored in UTC; branch
 * timezone retained for presentation"). Formatting with the browser's zone
 * instead puts a sale on the wrong day for any operator working from a laptop
 * that is not set to the gym's city — including the owner of a chain, and
 * anyone reading a hosted demo.
 *
 * With one branch selected the answer is that branch. Across a multi-branch
 * scope there is no single right answer, and no tenant zone reaches the client,
 * so the first permitted branch stands for the scope: one consistent clock for
 * the whole table rather than rows silently read against different ones. Every
 * branch of one gym shares a zone in practice; where that stops being true,
 * selecting the branch gives the exact figure.
 */
export function useBranchTimeZone(): string {
  const branchId = useAdmin((s) => s.activeBranchId);
  const branches = useAdmin((s) => s.branches);
  const active = branchId ? branches.find((b) => b.id === branchId) : undefined;
  return active?.timezone ?? branches[0]?.timezone ?? 'Asia/Kolkata';
}

export function useBranchScope(): { branchId: string | null; branchName: string } {
  // Zustand 5 uses React's external-store subscription semantics. Returning a
  // fresh object directly from the selector makes every snapshot look changed
  // and can trigger React's maximum-update-depth guard. Select stable values
  // individually, then memoize the convenience object for consumers.
  const branchId = useAdmin((s) => s.activeBranchId);
  const branches = useAdmin((s) => s.branches);
  const branchName = branches.find((b) => b.id === branchId)?.name ?? `All branches (${branches.length})`;
  return useMemo(() => ({ branchId, branchName }), [branchId, branchName]);
}
