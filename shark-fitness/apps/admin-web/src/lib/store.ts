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
