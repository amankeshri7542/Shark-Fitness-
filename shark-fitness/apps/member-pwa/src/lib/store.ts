import { create } from 'zustand';
import type { Branch, Viewer } from '@shark/contracts';
import { PREDATOR_COPY, type CopyKey, type Register, registerFor } from '@shark/design-tokens';
import { api, auth } from './api';

interface SessionState {
  viewer: Viewer | null;
  branches: Branch[];
  activeBranchId: string | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  setViewer: (viewer: Viewer | null) => void;
  setBranches: (branches: Branch[], activeBranchId: string | null) => void;
  setActiveBranch: (branchId: string) => void;
  bootstrap: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  viewer: null,
  branches: [],
  activeBranchId: null,
  status: 'loading',

  setViewer: (viewer) => set({ viewer, status: viewer ? 'signed-in' : 'signed-out' }),

  setBranches: (branches, activeBranchId) =>
    set({ branches, activeBranchId: activeBranchId ?? branches[0]?.id ?? null }),

  setActiveBranch: (branchId) => set({ activeBranchId: branchId }),

  bootstrap: async () => {
    if (!auth.get()) {
      set({ status: 'signed-out' });
      return;
    }
    try {
      const { viewer } = await api<{ viewer: Viewer }>('/me');
      set({ viewer, status: 'signed-in' });
      const branches = await api<{ items: Branch[]; activeBranchId: string | null }>('/me/branches');
      set({
        branches: branches.items,
        activeBranchId: branches.activeBranchId ?? branches.items[0]?.id ?? null,
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
      /* signing out locally matters more than the round trip succeeding */
    }
    auth.clear();
    set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out' });
    void get;
  },
}));

export const useViewer = (): Viewer | null => useSession((s) => s.viewer);

export function useActiveBranch(): Branch | null {
  return useSession((s) => s.branches.find((b) => b.id === s.activeBranchId) ?? s.branches[0] ?? null);
}

/**
 * Copy in the member's chosen register.
 *
 * Pass a `surface` when the screen is money-, safety- or privacy-related and
 * the plain register is forced regardless of preference. See the note in
 * packages/design-tokens/src/tone.ts.
 */
export function useCopy(surface?: string): (key: CopyKey) => string {
  const preference = (useSession((s) => s.viewer?.preferences.register) ?? 'predator') as Register;
  const register = registerFor(preference, surface);
  return (key: CopyKey) => PREDATOR_COPY[key][register];
}

/* — Active workout. Lives here rather than in server cache because it must
     survive a reload, a backgrounded tab and a dead network. ————— */

export interface ActiveSet {
  clientId: string;
  exerciseId: string;
  orderIndex: number;
  setIndex: number;
  weightKg: number;
  reps: number;
  rpe: number | null;
  done: boolean;
  doneAt: string | null;
}

interface WorkoutState {
  clientId: string | null;
  assignmentId: string | null;
  programDayId: string | null;
  title: string;
  startedAt: number | null;
  exerciseIndex: number;
  sets: ActiveSet[];
  restEndsAt: number | null;
  restTotalSec: number;
  notes: string;
  sessionRpe: number | null;
  start: (input: {
    clientId: string;
    assignmentId: string | null;
    programDayId: string | null;
    title: string;
    sets: ActiveSet[];
  }) => void;
  adjust: (clientId: string, field: 'weightKg' | 'reps', delta: number) => void;
  setValue: (clientId: string, field: 'weightKg' | 'reps' | 'rpe', value: number) => void;
  logSet: (clientId: string, restSec: number) => void;
  unlogSet: (clientId: string) => void;
  addSet: (afterClientId: string) => void;
  skipRest: () => void;
  goToExercise: (index: number) => void;
  setNotes: (notes: string) => void;
  setSessionRpe: (rpe: number) => void;
  reset: () => void;
}

const STORAGE_KEY = 'shark.workout';

function persist(state: Partial<WorkoutState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode; the in-memory session still works */
  }
}

function restore(): Partial<WorkoutState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<WorkoutState>) : null;
  } catch {
    return null;
  }
}

const EMPTY = {
  clientId: null,
  assignmentId: null,
  programDayId: null,
  title: '',
  startedAt: null,
  exerciseIndex: 0,
  sets: [] as ActiveSet[],
  restEndsAt: null,
  restTotalSec: 90,
  notes: '',
  sessionRpe: null,
};

export const useWorkout = create<WorkoutState>((set, get) => ({
  ...EMPTY,
  ...(restore() ?? {}),

  start: (input) => {
    const next = {
      ...EMPTY,
      clientId: input.clientId,
      assignmentId: input.assignmentId,
      programDayId: input.programDayId,
      title: input.title,
      startedAt: Date.now(),
      sets: input.sets,
    };
    set(next);
    persist(next);
  },

  adjust: (clientId, field, delta) => {
    const step = field === 'weightKg' ? 2.5 : 1;
    const floor = field === 'weightKg' ? 0 : 0;
    const sets = get().sets.map((s) =>
      s.clientId === clientId ? { ...s, [field]: Math.max(floor, Math.round((s[field] + delta * step) * 100) / 100) } : s,
    );
    set({ sets });
    persist({ ...get(), sets });
  },

  setValue: (clientId, field, value) => {
    const sets = get().sets.map((s) => (s.clientId === clientId ? { ...s, [field]: value } : s));
    set({ sets });
    persist({ ...get(), sets });
  },

  logSet: (clientId, restSec) => {
    const sets = get().sets.map((s) =>
      s.clientId === clientId ? { ...s, done: true, doneAt: new Date().toISOString() } : s,
    );
    const state = {
      ...get(),
      sets,
      restEndsAt: Date.now() + restSec * 1000,
      restTotalSec: restSec,
    };
    set(state);
    persist(state);
  },

  /** Undo. A mis-tap during a set must be recoverable without leaving the screen. */
  unlogSet: (clientId) => {
    const sets = get().sets.map((s) => (s.clientId === clientId ? { ...s, done: false, doneAt: null } : s));
    set({ sets, restEndsAt: null });
    persist({ ...get(), sets, restEndsAt: null });
  },

  addSet: (afterClientId) => {
    const current = get().sets;
    const source = current.find((s) => s.clientId === afterClientId);
    if (!source) return;
    const siblings = current.filter((s) => s.orderIndex === source.orderIndex);
    const next: ActiveSet = {
      clientId: crypto.randomUUID(),
      exerciseId: source.exerciseId,
      orderIndex: source.orderIndex,
      setIndex: siblings.length,
      weightKg: source.weightKg,
      reps: source.reps,
      rpe: null,
      done: false,
      doneAt: null,
    };
    const lastIndex = current.map((s) => s.orderIndex).lastIndexOf(source.orderIndex);
    const sets = [...current.slice(0, lastIndex + 1), next, ...current.slice(lastIndex + 1)];
    set({ sets });
    persist({ ...get(), sets });
  },

  skipRest: () => {
    set({ restEndsAt: null });
    persist({ ...get(), restEndsAt: null });
  },

  goToExercise: (index) => {
    set({ exerciseIndex: index });
    persist({ ...get(), exerciseIndex: index });
  },

  setNotes: (notes) => {
    set({ notes });
    persist({ ...get(), notes });
  },

  setSessionRpe: (sessionRpe) => {
    set({ sessionRpe });
    persist({ ...get(), sessionRpe });
  },

  reset: () => {
    set(EMPTY);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clean up */
    }
  },
}));

export const hasActiveWorkout = (): boolean => useWorkout.getState().clientId !== null;
