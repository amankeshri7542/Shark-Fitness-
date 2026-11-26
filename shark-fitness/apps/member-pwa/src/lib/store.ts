import { create } from 'zustand';
import type { Branch, Viewer } from '@shark/contracts';
import { forgetPassCards } from './pass';
import { PREDATOR_COPY, type CopyKey, type CopySurface, type Register, registerFor } from '@shark/design-tokens';
import { ApiError, OfflineError, api, auth, onSessionExpired } from './api';
import { queryClient } from './query-client';
import {
  deleteSnapshot,
  lastOwner,
  loadSnapshot,
  ownerOf,
  rememberLastOwner,
  restoreSnapshot,
  saveSnapshot,
} from './persisted-cache';
import { hasMemberSessionHint } from './session-hint';

interface SessionState {
  viewer: Viewer | null;
  branches: Branch[];
  activeBranchId: string | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  /** Signed in from the saved snapshot because the network was down. */
  offlineStart: boolean;
  /** The server ended the session (401): sign-in says so and offers the way back. */
  sessionEnded: boolean;
  /** A deliberate sign-out is in progress; a 401 on the way out is expected. */
  leaving: boolean;
  /** One message for the sign-in screen after leaving (e.g. a deletion request). */
  notice: string | null;
  setViewer: (viewer: Viewer | null) => void;
  setBranches: (branches: Branch[], activeBranchId: string | null) => void;
  setActiveBranch: (branchId: string) => void;
  bootstrap: () => Promise<void>;
  /** Server-side sign-out only. The full wipe lives in lib/session.ts. */
  signOut: () => Promise<void>;
  /** The session ended under us. Keeps the outbox and any active workout. */
  expire: () => void;
  acknowledgeSessionEnded: () => void;
}

const RETURN_KEY = 'shark.member.return-to';

/** Where the member was when the session ended, so sign-in can put them back. */
export function rememberReturnRoute(owner: string, path: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ owner, path }));
  } catch {
    /* they land on Home instead */
  }
}

/** The route to return to after sign-in, only for the same person. Consumed. */
export function takeReturnRoute(owner: string): string | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { owner?: string; path?: string };
    return saved.owner === owner && typeof saved.path === 'string' && saved.path.startsWith('/') && !saved.path.startsWith('//')
      ? saved.path
      : null;
  } catch {
    return null;
  }
}

export const useSession = create<SessionState>((set, get) => ({
  viewer: null,
  branches: [],
  activeBranchId: null,
  status: 'loading',
  offlineStart: false,
  sessionEnded: false,
  leaving: false,
  notice: null,

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
      if (viewer.role !== 'member') {
        // A staff cookie is valid for the admin console, not the member app.
        // Refuse it before member-only queries render misleading network-error
        // states for an authenticated operator on the root URL.
        auth.clear();
        set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out' });
        return;
      }
      const owner = ownerOf(viewer);
      // A session that ended (401) leaves its owner's unfinished workout on
      // the phone so they can carry on after signing back in. Anyone else
      // signing in must neither see it nor finish it under their own name.
      const previous = lastOwner();
      if (previous && previous !== owner) {
        useWorkout.getState().reset();
        clearWorkoutStorage();
      }
      rememberLastOwner(owner);
      // Show the last-seen screens at once while fresh data loads.
      const snapshot = await loadSnapshot(owner);
      if (snapshot) restoreSnapshot(queryClient, snapshot);
      set({ viewer, status: 'signed-in', offlineStart: false, sessionEnded: false });
      const branches = await api<{ items: Branch[]; activeBranchId: string | null }>('/me/branches');
      const activeBranchId = branches.activeBranchId ?? viewer.homeBranchId ?? branches.items[0]?.id ?? null;
      set({
        branches: branches.items,
        // The member's own gym, not whichever branch the tenant lists first.
        // `activeBranchId` from the server means "a branch this request
        // selected", which for a fresh session is nothing at all.
        activeBranchId,
      });
      // Save who is signed in right away, not only once a screen's data has
      // loaded: an offline reload a moment after signing in must still open
      // the app (P05 D19, PF-WORK-005). Later saves add the screens' data.
      void saveSnapshot(queryClient, get()).catch(() => undefined);
    } catch (error) {
      // No network: open on the saved snapshot of whoever was signed in last.
      // The cookie is untouched; the next request online proves the session.
      if (error instanceof OfflineError) {
        const owner = lastOwner();
        const snapshot = owner ? await loadSnapshot(owner) : null;
        if (snapshot) {
          restoreSnapshot(queryClient, snapshot);
          set({
            viewer: snapshot.viewer,
            branches: snapshot.branches,
            activeBranchId: snapshot.activeBranchId,
            status: 'signed-in',
            offlineStart: true,
          });
          return;
        }
      }
      auth.clear();
      // A browser that was signed in and is not any more: say so on sign-in.
      const ended = error instanceof ApiError && error.status === 401 && hasMemberSessionHint();
      const owner = lastOwner();
      if (ended && owner) rememberReturnRoute(owner, currentAppRoute());
      // The server refused the session: its saved screens must not open the
      // app offline later (P05). The outbox and an active workout stay, as
      // in expire(), for the same person to send after signing back in.
      if (owner) await deleteSnapshot(owner);
      set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out', sessionEnded: ended });
    }
  },

  signOut: async () => {
    try {
      await api('/auth/sign-out', { method: 'POST' });
    } catch {
      /* signing out locally matters more than the round trip succeeding */
    }
    auth.clear();
    // Things this member left on the phone outside the query cache: the
    // reception card behind the pass, and the offline exercise library with
    // their own last weights and reps (P05).
    forgetPassCards();
    forgetExerciseLibrary();
    set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out', offlineStart: false, sessionEnded: false });
  },

  expire: () => {
    const { viewer, status, leaving } = get();
    if (status !== 'signed-in' || !viewer || leaving) return;
    const owner = ownerOf(viewer);
    rememberReturnRoute(owner, currentAppRoute());
    // The outbox (IndexedDB) and an active workout (localStorage) stay: they
    // belong to this person and go out after they sign in again. What leaves
    // is everything the next person at this phone could read.
    queryClient.clear();
    void deleteSnapshot(owner);
    (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => undefined);
    auth.clear();
    set({ viewer: null, branches: [], activeBranchId: null, status: 'signed-out', offlineStart: false, sessionEnded: true });
  },

  acknowledgeSessionEnded: () => set({ sessionEnded: false, notice: null }),
}));

/** The in-app route (without the /app prefix), with its query string. */
function currentAppRoute(): string {
  const { pathname, search } = window.location;
  const path = pathname === '/app' || pathname === '/app/' ? '/' : pathname.replace(/^\/app(?=\/)/, '');
  return `${path}${search}`;
}

onSessionExpired(() => useSession.getState().expire());

/** The offline exercise library (FreestylePicker) carries this member's own
 *  last weights and reps; the next person on this phone must not see them. */
function forgetExerciseLibrary(): void {
  try {
    localStorage.removeItem('shark.exercise.library');
  } catch {
    /* nothing stored */
  }
}

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
export function useCopy(surface: CopySurface): (key: CopyKey) => string {
  const preference = (useSession((s) => s.viewer?.preferences.register) ?? 'predator') as Register;
  return copyFor(preference, surface);
}

/** The pure half of `useCopy`, so the plain-only rule is testable without React. */
export function copyFor(preference: Register, surface: CopySurface): (key: CopyKey) => string {
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

/** Every `shark.workout*` key: the active session, its plan copy and the
 *  finished-session snapshots Summary reads. */
export function clearWorkoutStorage(): void {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key?.startsWith('shark.workout')) keys.push(key);
      }
      keys.forEach((key) => storage.removeItem(key));
    } catch {
      /* storage unavailable */
    }
  }
}

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
