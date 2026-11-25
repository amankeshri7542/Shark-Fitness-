import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { runtimeConfig } from '../lib/config.js';

/** /.well-known/assetlinks.json for the Android TWA (ADR-002, PHASE-PLAN P04 criterion 9). */
const FINGERPRINT = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
const original = runtimeConfig.androidAppLinks;

afterEach(() => {
  runtimeConfig.androidAppLinks = original;
});

describe('Digital Asset Links', () => {
  it('does not exist until an Android app is configured', async () => {
    runtimeConfig.androidAppLinks = null;
    const response = await app.request('/.well-known/assetlinks.json');
    expect(response.status).toBe(404);
  });

  it('serves the statement Android verifies when it is', async () => {
    runtimeConfig.androidAppLinks = { packageName: 'in.sharkfitness.member', sha256CertFingerprints: [FINGERPRINT] };
    const response = await app.request('/.well-known/assetlinks.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'in.sharkfitness.member', sha256_cert_fingerprints: [FINGERPRINT] },
      },
    ]);
  });

  it('needs no session, cookie or CSRF token', async () => {
    runtimeConfig.androidAppLinks = { packageName: 'in.sharkfitness.member', sha256CertFingerprints: [FINGERPRINT] };
    const response = await app.request('/.well-known/assetlinks.json', { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(200);
  });
});
