import { Hono } from 'hono';
import { runtimeConfig } from '../lib/config.js';

/**
 * `/.well-known/assetlinks.json`: Digital Asset Links that let Android open
 * the member app's Trusted Web Activity full screen, without a browser bar,
 * and let the TWA show this site's notifications (ADR-002, docs/MOBILE-APP.md).
 *
 * Built from SHARK_ANDROID_PACKAGE and SHARK_ANDROID_CERT_SHA256 (validated
 * at boot in lib/config.ts). With either unset the file does not exist (404):
 * an empty or placeholder statement would be a false claim about an app.
 */
export const assetLinksRoutes = new Hono();

assetLinksRoutes.get('/', (c) => {
  const links = runtimeConfig.androidAppLinks;
  if (!links) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'No Android app is linked to this site.', requestId: c.get('requestId') ?? 'unknown' } },
      404,
    );
  }
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: links.packageName,
        sha256_cert_fingerprints: links.sha256CertFingerprints,
      },
    },
  ]);
});
