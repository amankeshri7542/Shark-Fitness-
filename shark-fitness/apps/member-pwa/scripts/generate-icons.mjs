#!/usr/bin/env node
/**
 * Renders every app icon from icons/source.svg.
 *
 *   pnpm -F @shark/member-pwa icons
 *
 * The outputs are committed (public/icons/ in both apps), so a normal build
 * never needs this script or its renderer. Rerun it after editing the source.
 *
 * Platform rules applied here:
 * - "any" icons: the mark fills most of the square on the abyss background.
 * - "maskable": the launcher may crop to a circle of 80 % diameter, so the
 *   mark stays inside the central 60 % (well within the safe zone).
 * - "monochrome": Android tints the alpha channel; the mark is drawn in pure
 *   white on transparency and nothing else.
 * - apple-touch-icon: iOS ignores transparency and rounds the corners itself,
 *   so it is opaque and unrounded.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const source = readFileSync(join(appRoot, 'icons/source.svg'), 'utf8');
const defs = source.match(/<defs>[\s\S]*<\/defs>/)?.[0];
if (!defs) throw new Error('icons/source.svg has no <defs> block');

const ABYSS = '#04080b';
const SONAR = '#46c8dd';
const LINE = 'rgba(120,190,215,0.3)';

/** One canvas: background, optional frame, a symbol scaled to `fill` of the side. */
function compose({ size, symbol, fill, colour = SONAR, background = ABYSS, frame = false }) {
  const side = size * fill;
  const offset = (size - side) / 2;
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '';
  const border = frame
    ? `<rect x="${size * 0.06}" y="${size * 0.06}" width="${size * 0.88}" height="${size * 0.88}" fill="none" stroke="${LINE}" stroke-width="${Math.max(1, size / 96)}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}${bg}${border}<use href="#${symbol}" xlink:href="#${symbol}" x="${offset}" y="${offset}" width="${side}" height="${side}" style="color:${colour}"/></svg>`;
}

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

const MEMBER = [
  { file: 'icon-192.png', size: 192, symbol: 'mark', fill: 0.72 },
  { file: 'icon-512.png', size: 512, symbol: 'mark', fill: 0.72 },
  { file: 'icon-96.png', size: 96, symbol: 'mark', fill: 0.72 },
  { file: 'maskable-512.png', size: 512, symbol: 'mark', fill: 0.6 },
  { file: 'monochrome-96.png', size: 96, symbol: 'mark', fill: 0.72, colour: '#ffffff', background: null },
  { file: 'apple-touch-icon-180.png', size: 180, symbol: 'mark', fill: 0.66 },
  { file: 'shortcut-pass-96.png', size: 96, symbol: 'pass', fill: 0.62 },
  { file: 'shortcut-train-96.png', size: 96, symbol: 'train', fill: 0.62 },
  { file: 'shortcut-book-96.png', size: 96, symbol: 'book', fill: 0.62 },
];

/* The console gets the same mark inside a hairline frame, so a reception
   tablet with both installed can tell them apart at a glance. */
const ADMIN = [
  { file: 'icon-192.png', size: 192, symbol: 'mark', fill: 0.56, frame: true },
  { file: 'icon-512.png', size: 512, symbol: 'mark', fill: 0.56, frame: true },
  { file: 'maskable-512.png', size: 512, symbol: 'mark', fill: 0.5 },
  { file: 'apple-touch-icon-180.png', size: 180, symbol: 'mark', fill: 0.56, frame: true },
];

function write(targetDir, specs) {
  mkdirSync(targetDir, { recursive: true });
  for (const spec of specs) {
    const png = render(compose(spec), spec.size);
    writeFileSync(join(targetDir, spec.file), png);
    console.log(`${targetDir.replace(`${resolve(appRoot, '../..')}/`, '')}/${spec.file}  ${spec.size}×${spec.size}  ${png.length} B`);
  }
}

write(join(appRoot, 'public/icons'), MEMBER);
write(resolve(appRoot, '../admin-web/public/icons'), ADMIN);

// The browser-tab favicon is the same mark as SVG, so it stays crisp.
const favicon = compose({ size: 32, symbol: 'mark', fill: 0.8 });
writeFileSync(join(appRoot, 'public/favicon.svg'), `${favicon}\n`);
writeFileSync(resolve(appRoot, '../admin-web/public/favicon.svg'), `${favicon}\n`);
console.log('favicon.svg (both apps)');
