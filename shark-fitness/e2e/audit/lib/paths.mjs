import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** e2e/audit */
export const AUDIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = resolve(AUDIT_ROOT, '../..');
/** docs/ux-audit: the committed deliverables. */
export const DOCS_DIR = resolve(WORKSPACE_ROOT, 'docs/ux-audit');
/** Compact machine-readable results the report is generated from (committed). */
export const DATA_DIR = resolve(DOCS_DIR, 'data');

/**
 * Screenshots and raw tool output are not committed (PNG and full axe /
 * Lighthouse reports are large). They go to the orchestration folder the
 * phase plan names when it exists on this machine, otherwise beside the
 * tooling (git-ignored). SHARK_AUDIT_SCREENS_DIR overrides both.
 */
const ORCHESTRATION_SCREENS = '/workspace/shark-fitness-orchestration/phases/P10-screens';
export const SCREENS_DIR = process.env.SHARK_AUDIT_SCREENS_DIR
  ? resolve(process.env.SHARK_AUDIT_SCREENS_DIR)
  : existsSync(dirname(ORCHESTRATION_SCREENS))
    ? ORCHESTRATION_SCREENS
    : resolve(AUDIT_ROOT, '.out/screens');
