#!/usr/bin/env node
// Lists admin and member screens that no component test imports (P08
// acceptance 4). A screen is every .tsx file under apps/{admin-web,member-pwa}/src/screens,
// except test folders and the shared helper modules (`shared.tsx`, test
// `harness.tsx`), which render no screen of their own. A screen is tested when
// at least one *.test.tsx/ts file in the same app imports it directly.
//
//   node scripts/untested-screens.mjs        prints untested screens, exit 1 if any
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APPS = ['apps/admin-web', 'apps/member-pwa'];
const HELPERS = new Set(['shared.tsx', 'harness.tsx']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT = /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|import\s+)['"]([^'"]+)['"]/g;

let untested = 0;
let screens = 0;
for (const app of APPS) {
  const src = join(ROOT, app, 'src');
  const files = walk(src);
  const screenFiles = files.filter(
    (file) => file.startsWith(join(src, 'screens')) && file.endsWith('.tsx') && !file.includes('/__tests__/') && !file.endsWith('.test.tsx') && !HELPERS.has(file.split('/').pop()),
  );
  const imported = new Set();
  for (const test of files.filter((file) => /\.test\.tsx?$/.test(file))) {
    const source = readFileSync(test, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const target = resolveImport(test, match[1]);
      if (target) imported.add(target);
    }
  }
  for (const screen of screenFiles.sort()) {
    screens += 1;
    if (!imported.has(screen)) {
      untested += 1;
      console.log(relative(ROOT, screen));
    }
  }
}

if (untested > 0) {
  console.error(`\n${untested} of ${screens} screens have no component test importing them.`);
  process.exit(1);
}
console.error(`All ${screens} screens have a component test.`);
