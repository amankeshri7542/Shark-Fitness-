import { api } from './api';
import { describeUnsynced, discardAllFor, pendingFor, stopOutbox } from './outbox';
import { deleteSnapshot, ownerOf, rememberLastOwner } from './persisted-cache';
import { forgetPushOnSignOut } from './push';
import { queryClient } from './query-client';
import { setMemberSessionHint } from './session-hint';
import { clearWorkoutStorage, takeReturnRoute, useSession, useWorkout } from './store';

/**
 * Signing out on a phone someone else may pick up next (PRD 04 shared-device
 * edge cases). After this, nothing of the member's is readable on the device:
 * not the query cache, not the persisted snapshot, not their queued writes,
 * not an unfinished workout, and the phone no longer receives their pushes.
 */
export async function signOutAndWipe(options: { notice?: string } = {}): Promise<void> {
  const viewer = useSession.getState().viewer;
  if (!viewer) return;
  const owner = ownerOf(viewer);
  useSession.setState({ leaving: true });
  try {
    // Needs the session, so it goes first.
    await forgetPushOnSignOut(owner);
    stopOutbox();
    await useSession.getState().signOut();

    queryClient.clear();
    await deleteSnapshot(owner);
    rememberLastOwner(null);
    await discardAllFor(owner).catch(() => undefined);
    useWorkout.getState().reset();
    clearWorkoutStorage();
    takeReturnRoute(owner);
    setMemberSessionHint(false);
    // The home-screen icon must not keep showing this member's unread count.
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    void nav.clearAppBadge?.().catch(() => undefined);
  } finally {
    useSession.setState({ leaving: false, notice: options.notice ?? null });
  }
}

/**
 * "Request deletion": the server locks the account and revokes every session,
 * and the copy says this phone is signed out, so it is, with the same wipe.
 * Push goes first, while the session can still remove it. From the request on
 * the session counts as leaving: a 401 from any other request racing the
 * wipe must not turn this into "Your session ended" and skip the wipe.
 */
export async function requestDeletionAndSignOut(): Promise<void> {
  const viewer = useSession.getState().viewer;
  if (!viewer) return;
  await forgetPushOnSignOut(ownerOf(viewer));
  useSession.setState({ leaving: true });
  let message: string;
  try {
    ({ message } = await api<{ message: string }>('/me/deletion-request', { method: 'POST', body: {} }));
  } catch (error) {
    useSession.setState({ leaving: false });
    throw error;
  }
  await signOutAndWipe({ notice: message });
}

/** What signing out now would throw away, in words, or null. */
export async function unsyncedWarning(): Promise<string | null> {
  const viewer = useSession.getState().viewer;
  if (!viewer) return null;
  try {
    return describeUnsynced(await pendingFor(ownerOf(viewer)));
  } catch {
    return null;
  }
}
