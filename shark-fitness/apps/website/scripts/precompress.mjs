#!/usr/bin/env node
// Writes .br and .gz next to every compressible file in dist/, so the API's
// static server (serveStatic precompressed) answers with them and needs no
// compression work per request. Runs after `astro build`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = resolve(import.meta.dirname, '../dist');
const COMPRESSIBLE = /\.(html|css|js|mjs|json|svg|xml|txt|webmanifest)$/;
let files = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (COMPRESSIBLE.test(name)) {
      const body = readFileSync(path);
      if (body.length < 512) continue;
      writeFileSync(`${path}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      writeFileSync(`${path}.gz`, gzipSync(body, { level: 9 }));
      files += 1;
    }
  }
}

walk(dist);
console.log(`precompress: ${files} files`);
