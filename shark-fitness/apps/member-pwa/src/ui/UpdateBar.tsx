import { useServiceWorker, applyUpdate } from '../lib/sw-update';
import { useWorkout } from '../lib/store';
import { Button } from './primitives';

/**
 * "Update ready — Reload". Appears when a new build has installed and is
 * waiting, and never while a workout is running: a reload mid-set would throw
 * the member out of the logger. The bar shows up once the workout is finished
 * or discarded.
 */
export function UpdateBar() {
  const waiting = useServiceWorker((s) => s.waiting);
  const workoutActive = useWorkout((s) => s.clientId !== null);
  if (!waiting || workoutActive) return null;

  return (
    <div
      role="status"
      className="sf-safe-x flex flex-none items-center gap-3 border-b border-line-accent bg-wash-sonar px-4 py-1.5"
      data-testid="update-bar"
    >
      <p className="min-w-0 flex-1 text-[13px]">Update ready</p>
      <Button variant="ghost" onClick={() => applyUpdate(useWorkout.getState().clientId !== null)}>
        Reload
      </Button>
    </div>
  );
}
