#!/usr/bin/env node
// Renders public/og.png (1200×630), the Open Graph / Twitter card image.
//
//   pnpm -F @shark/website og-image
//
// Drawn in the Sonar language (abyss canvas, hairline contours, Anton) with
// the self-hosted fonts, by headless Chromium — the same browser the E2E
// suite installs (`pnpm -F @shark/e2e exec playwright install chromium`).
// The output is committed; rerun only when the brand line changes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const font = (spec) => `data:font/woff2;base64,${readFileSync(require.resolve(spec)).toString('base64')}`;
const snapshot = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/content/snapshot.json'), 'utf8'));
const areas = { koramangala: 'Koramangala', indiranagar: 'Indiranagar', hsr: 'HSR Layout' };
const places = snapshot.site.branches.map((b) => areas[b.slug] ?? b.name).join(' · ');
const rings = [70, 120, 172, 226, 282, 340, 400]
  .map((r, i) => `<ellipse cx="960" cy="300" rx="${r * 1.12}" ry="${r}" fill="none" stroke="rgba(120,190,215,.22)" stroke-width="1.5" transform="rotate(${-12 + i * 3} 960 300)"/>`)
  .join('');

const html = `<!doctype html><html><head><style>
@font-face{font-family:Anton;src:url(${font('@fontsource/anton/files/anton-latin-400-normal.woff2')}) format('woff2')}
@font-face{font-family:Archivo;font-weight:500;src:url(${font('@fontsource/archivo/files/archivo-latin-500-normal.woff2')}) format('woff2')}
@font-face{font-family:'Archivo Narrow';font-weight:600;src:url(${font('@fontsource/archivo-narrow/files/archivo-narrow-latin-600-normal.woff2')}) format('woff2')}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:linear-gradient(180deg,#0b2331 0%,#061119 60%,#04080b 100%);color:#e8f1f5;font-family:Archivo}
svg.bg{position:absolute;inset:0}
.frame{position:absolute;inset:40px;border:1px solid rgba(120,190,215,.3);padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between}
.mark{display:flex;align-items:center;gap:14px;font-family:Anton;font-size:36px;text-transform:uppercase;letter-spacing:.02em}
.mark svg{width:44px;height:44px;color:#46c8dd}
h1{font-family:Anton;font-weight:400;font-size:104px;line-height:.92;text-transform:uppercase;max-width:760px}
.foot{display:flex;gap:32px;justify-content:space-between;align-items:flex-end;white-space:nowrap;font-family:'Archivo Narrow';font-weight:600;font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:rgba(232,241,245,.8)}
.cta{background:#46c8dd;color:#04080b;padding:16px 40px 16px 24px;clip-path:polygon(0 0,100% 0,100% 72%,calc(100% - 14px) 100%,0 100%)}
</style></head><body>
<svg class="bg" viewBox="0 0 1200 630">${rings}</svg>
<div class="frame">
  <div class="mark"><svg viewBox="0 0 32 32"><path d="M4 20 L16 6 L28 20 L16 15 Z" fill="currentColor"/><rect x="4" y="24" width="24" height="2" fill="currentColor" opacity=".5"/></svg>${snapshot.site.tenant.displayName}</div>
  <h1>Train where someone notices.</h1>
  <div class="foot"><span>${places}, Bengaluru</span><span class="cta">Free trial week</span></div>
</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate('document.fonts.ready');
  const out = resolve(import.meta.dirname, '../public/og.png');
  await page.screenshot({ path: out, type: 'png' });
  console.log(`og-image: wrote ${out}`);
} finally {
  await browser.close();
}
