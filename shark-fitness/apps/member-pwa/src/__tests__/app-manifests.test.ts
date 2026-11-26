// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMBER_MANIFEST, THEME } from '../../manifest.config';

/**
 * The web app manifest's source and the Android TWA definition (ADR-002).
 * The built manifest is checked again over HTTP by e2e/specs/pwa-manifest.
 */
const appRoot = resolve(import.meta.dirname, '../..');
const publicDir = resolve(appRoot, 'public');

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  throw new Error(`${file} has no JPEG frame header`);
}

describe('member web app manifest (source)', () => {
  it('declares every icon at the size its file really is', () => {
    const icons = MEMBER_MANIFEST.icons ?? [];
    expect(icons.map((icon) => icon.purpose)).toEqual(expect.arrayContaining(['any', 'maskable', 'monochrome']));
    for (const icon of icons) {
      const [width, height] = icon.sizes!.split('x').map(Number);
      expect(pngSize(resolve(publicDir, icon.src))).toEqual({ width, height });
    }
    expect(icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any')).toBe(true);
    expect(icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any')).toBe(true);
    expect(pngSize(resolve(publicDir, 'icons/apple-touch-icon-180.png'))).toEqual({ width: 180, height: 180 });
  });

  it('has shortcuts whose icons exist and whose URLs stay inside the app', () => {
    const shortcuts = MEMBER_MANIFEST.shortcuts ?? [];
    expect(shortcuts.map((s) => s.name)).toEqual(['Pass', "Today's workout", 'Book a class']);
    for (const shortcut of shortcuts) {
      expect(shortcut.url.startsWith('/app/')).toBe(true);
      for (const icon of shortcut.icons ?? []) expect(pngSize(resolve(publicDir, icon.src))).toEqual({ width: 96, height: 96 });
    }
  });

  it('has narrow and wide store screenshots at their declared sizes', () => {
    const shots = MEMBER_MANIFEST.screenshots ?? [];
    expect(shots.filter((s) => s.form_factor === 'narrow').length).toBeGreaterThanOrEqual(2);
    expect(shots.filter((s) => s.form_factor === 'wide').length).toBeGreaterThanOrEqual(1);
    for (const shot of shots) {
      const file = resolve(publicDir, shot.src);
      expect(existsSync(file), shot.src).toBe(true);
      const [width, height] = shot.sizes!.split('x').map(Number);
      expect(shot.type === 'image/png' ? pngSize(file) : jpegSize(file)).toEqual({ width, height });
      expect(shot.label).toBeTruthy();
    }
  });
});

const Hex = z.string().regex(/^#[0-9A-F]{6}$/i);
const HttpsUrl = z.string().url().startsWith('https://');
const TwaManifest = z.object({
  packageId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/),
  host: z.string().regex(/^[a-z0-9.-]+$/),
  name: z.string().min(1),
  launcherName: z.string().min(1).max(12),
  display: z.enum(['standalone', 'fullscreen', 'fullscreen-sticky']),
  orientation: z.string(),
  themeColor: Hex,
  themeColorDark: Hex,
  navigationColor: Hex,
  navigationColorDark: Hex,
  backgroundColor: Hex,
  enableNotifications: z.literal(true),
  startUrl: z.string().startsWith('/'),
  iconUrl: HttpsUrl,
  maskableIconUrl: HttpsUrl,
  monochromeIconUrl: HttpsUrl,
  signingKey: z.object({ path: z.string(), alias: z.string() }),
  appVersionName: z.string(),
  appVersionCode: z.number().int().positive(),
  shortcuts: z.array(z.object({ name: z.string(), shortName: z.string(), url: HttpsUrl, chosenIconUrl: HttpsUrl })),
  webManifestUrl: HttpsUrl,
  fallbackType: z.literal('customtabs'),
  fullScopeUrl: HttpsUrl,
  minSdkVersion: z.number().int().min(19),
  fingerprints: z.array(z.unknown()),
});

describe('Android TWA manifest', () => {
  const raw = JSON.parse(readFileSync(resolve(appRoot, 'android/twa-manifest.json'), 'utf8')) as unknown;
  const twa = TwaManifest.parse(raw);
  const origin = `https://${twa.host}`;

  it('is a valid Bubblewrap definition for in.sharkfitness.member launching /app/?source=twa', () => {
    expect(twa.packageId).toBe('in.sharkfitness.member');
    expect(twa.startUrl).toBe('/app/?source=twa');
    expect(twa.fallbackType).toBe('customtabs');
    expect(twa.enableNotifications).toBe(true);
  });

  it('agrees with the web manifest on colours, scope, icons and shortcuts', () => {
    expect(twa.themeColor.toLowerCase()).toBe(THEME.dark.theme);
    expect(twa.backgroundColor.toLowerCase()).toBe(THEME.dark.background);
    expect(twa.fullScopeUrl).toBe(`${origin}${MEMBER_MANIFEST.scope}`);
    expect(twa.webManifestUrl).toBe(`${origin}/app/manifest.webmanifest`);
    for (const url of [twa.iconUrl, twa.maskableIconUrl, twa.monochromeIconUrl]) {
      expect(url.startsWith(`${origin}/app/icons/`)).toBe(true);
      expect(existsSync(resolve(publicDir, url.slice(`${origin}/app/`.length)))).toBe(true);
    }
    expect(twa.shortcuts.map((s) => s.url)).toEqual((MEMBER_MANIFEST.shortcuts ?? []).map((s) => `${origin}${s.url}`));
  });

  it('uses the placeholder host the build workflow replaces', () => {
    const workflow = readFileSync(resolve(appRoot, '../../../.github/workflows/android-twa.yml'), 'utf8');
    expect(twa.host).toBe('app.sharkfitness.example');
    expect(workflow).toContain('app\\\\.sharkfitness\\\\.example');
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
  });
});
