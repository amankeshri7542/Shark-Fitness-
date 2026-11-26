import { resolve } from 'node:path';

export const E2E_ROOT = resolve(import.meta.dirname, '..');
export const WORKSPACE_ROOT = resolve(E2E_ROOT, '..');
export const API_ROOT = resolve(WORKSPACE_ROOT, 'apps/api');
/** Where global setup records the server it started, for teardown. */
export const STATE_FILE = resolve(E2E_ROOT, '.state/run.json');

export interface RunState {
  pid: number;
  tempDir: string;
  baseURL: string;
  serverLog: string;
  database: string;
  ownerTotpSecret: string;
}
