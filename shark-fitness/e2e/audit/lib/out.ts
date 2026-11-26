import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { AUDIT_ROOT, DATA_DIR, SCREENS_DIR } from './paths.mjs';

export { AUDIT_ROOT, DATA_DIR, SCREENS_DIR };

/** Absolute path of a screenshot, creating its directory. */
export function screenshotPath(...parts: string[]): string {
  const file = resolve(SCREENS_DIR, ...parts);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/** How a screenshot is cited in the report and findings.json. */
export function citeScreenshot(file: string): string {
  return `phases/P10-screens/${relative(SCREENS_DIR, file)}`;
}

/** Compact, reviewable results committed under docs/ux-audit/data/. */
export function writeData(name: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(resolve(DATA_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export function readData<T>(name: string): T | null {
  const file = resolve(DATA_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/** Bulky raw output (full axe results, Lighthouse reports) beside the screenshots, not in git. */
export function writeRaw(name: string, value: unknown): string {
  const file = resolve(SCREENS_DIR, 'raw', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}
