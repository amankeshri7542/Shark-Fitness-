import { useMemo } from 'react';
import { create } from 'zustand';
import type { Branch, ImpersonationBanner, Viewer } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';
import { ApiError, api, auth } from './api';

interface AdminState {
  viewer: Viewer | null;
  /**
   * Set while this session is a platform operator working inside a customer's
   * account (PF-PLAT-004).
   *
   * It rides on `/me` rather than a call of its own, so there is no window
   * between the console booting and the banner appearing. A support session
   * that looks like an ordinary one, even for a moment, is the whole failure
   * the banner exists to prevent.
   */
  impersonation: ImpersonationBanner | null;
  branches: Branch[];
  activeBranchId: string | null;
  /** Comfortable by default; compact never shrinks a target below 44px. */
  density: 'comfortable' | 'compact';
  theme: 'dark' | 'light';
  status: 'loading' | 'signed-in' | 'signed-out';
  /**
   * Set when a signed-in console learns its session is over (idle, expired,
   * revoked). The console stays on screen behind a "Session expired" dialog
   * until the person signs in again, then returns to `returnTo`.
   */
  sessionEnded: { reason: string | null; message: string; returnTo: string } | null;
  /** The session still owes a TOTP code (`challenge`) or an enrolment. */
  mfaPending: 'challenge' | 'enrol' | null;
  paletteOpen: boolean;
  setViewer: (viewer: Viewer | null) => void;
  setActiveBranch: (branchId: string | null) => void;
  setDensity: (density: 'comfortable' | 'compact') => void;
  setTheme: (theme: 'dark' | 'light') => void;
  togglePalette: (open?: boolean) => void;
  bootstrap: () => Promise<void>;
  signOut: () => Promise<void>;
  endSession: (reason: string | null, message: string, returnTo: string) => void;
  setMfaPending: (state: 'challenge' | 'enrol' | null) => void;
}

const BRANCH_KEY = 'shark.branch';

export const useAdmin = create<AdminState>((set, get) => ({
  viewer: null,
  impersonation: null,
  branches: [],
  activeBranchId: null,
  density: (localStorage.getItem('shark.density') as 'compact') ?? 'comfortable',
  theme: (localStorage.getItem('shark.theme') as 'light') ?? 'dark',
  status: 'loading',
  sessionEnded: null,
  mfaPending: null,
  paletteOpen: false,

  setViewer: (viewer) => set({ viewer, status: viewer ? 'signed-in' : 'signed-out' }),

  endSession: (reason, message, returnTo) => {
    // Only a console that was signed in can have its session end; a failed
    // sign-in or a page that never booted is not "expired".
    if (get().status !== 'signed-in' || get().sessionEnded) return;
    auth.clear();
    set({ sessionEnded: { reason, message, returnTo } });
  },

  setMfaPending: (mfaPending) => set({ mfaPending }),

  setActiveBranch: (activeBranchId) => {
    // Remembered so a desk that reloads the console stays on its own branch
    // instead of falling back to "All branches" (where the till is closed).
    if (activeBranchId) localStorage.setItem(BRANCH_KEY, activeBranchId);
    else localStorage.removeItem(BRANCH_KEY);
    set({ activeBranchId });
  },

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
      const { viewer, impersonation } = await api<{ viewer: Viewer; impersonation?: ImpersonationBanner }>('/me');
      if (viewer.role === 'member') {
        // A member token is not a dashboard token. Say so rather than showing
        // an empty console.
        auth.clear();
        set({ viewer: null, impersonation: null, status: 'signed-out' });
        return;
      }
      const branches = await api<{ items: Branch[]; activeBranchId: string | null }>('/me/branches');
      set({
        viewer,
        impersonation: impersonation ?? null,
        status: 'signed-in',
        sessionEnded: null,
        mfaPending: null,
        branches: branches.items,
        // Null means "all branches I can see" — a regional view, not a default
        // to one location that quietly hides the rest.
        activeBranchId:
          branches.items.length === 1
            ? (branches.items[0]?.id ?? null)
            : (branches.items.find((b) => b.id === localStorage.getItem(BRANCH_KEY))?.id ?? null),
      });
    } catch (error) {
      // A reload in the middle of two-step sign-in: the session is real but
      // still owes a code or an enrolment, and sign-in picks up where it was.
      const pending = error instanceof ApiError && error.code === 'MFA_REQUIRED'
        ? ((error.details as { state?: 'challenge' | 'enrol' } | undefined)?.state ?? 'challenge')
        : null;
      if (!pending) auth.clear();
      set({ viewer: null, impersonation: null, status: 'signed-out', mfaPending: pending, sessionEnded: null });
    }
  },

  signOut: async () => {
    try {
      await api('/auth/sign-out', { method: 'POST' });
    } catch {
      /* local sign-out matters more than the round trip */
    }
    auth.clear();
    localStorage.removeItem(BRANCH_KEY);
    set({ viewer: null, impersonation: null, branches: [], activeBranchId: null, status: 'signed-out', sessionEnded: null, mfaPending: null });
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
