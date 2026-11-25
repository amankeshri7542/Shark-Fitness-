import { rmSync } from 'node:fs';
import { stopRecordedServer } from './global-setup';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the server global setup started and deletes its temporary directory. */
export default async function globalTeardown(): Promise<void> {
  const state = stopRecordedServer();
  if (!state) return;
  const deadline = Date.now() + 10_000;
  while (alive(state.pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  if (alive(state.pid)) {
    try {
      process.kill(-state.pid, 'SIGKILL');
    } catch {
      // Exited between the check and the kill.
    }
  }
  rmSync(state.tempDir, { recursive: true, force: true });
}
