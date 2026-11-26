import { expect, test } from '../support/fixtures';

/** The production server sends the enforced, per-surface policies (lib/csp.ts). */
test('each surface is served with its own enforced Content-Security-Policy', async ({ request }) => {
  // `/` is the public website (P03), the member app is at `/app/` (P03/P04).
  const admin = await request.get('/admin/');
  const member = await request.get('/app/');
  const website = await request.get('/');
  const apiResponse = await request.get('/v1/auth/tenants');
  for (const response of [admin, member, website, apiResponse]) {
    expect(response.headers()['content-security-policy-report-only']).toBeUndefined();
    expect(response.headers()['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  }
  expect(admin.headers()['content-security-policy']).toContain("script-src 'self';");
  expect(admin.headers()['permissions-policy']).toContain('camera=(self)');
  // The member app's one inline script (theme boot, P04) is allowed by its hash.
  expect(member.headers()['content-security-policy']).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/checkout\.razorpay\.com;/);
  expect(member.headers()['content-security-policy']).toContain('frame-src https://api.razorpay.com https://checkout.razorpay.com;');
  expect(member.headers()['permissions-policy']).toContain('camera=()');
  expect(member.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  // The website (P03) at /: its own hashed inline scripts and styles, no
  // payment origins, no sockets, nothing framed.
  const websitePolicy = website.headers()['content-security-policy'];
  expect(websitePolicy).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
  expect(websitePolicy).toContain("connect-src 'self';");
  expect(websitePolicy).toContain("frame-src 'none';");
  expect(websitePolicy).not.toContain('razorpay');
  expect(website.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(apiResponse.headers()['content-security-policy']).toContain("default-src 'none'");
  // Fonts come from the app itself.
  expect(await admin.text()).not.toContain('fonts.googleapis.com');
});
