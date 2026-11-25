import { expect, test } from '../support/fixtures';

/** The production server sends the enforced, per-surface policies (lib/csp.ts). */
test('each surface is served with its own enforced Content-Security-Policy', async ({ request }) => {
  const admin = await request.get('/admin/');
  const member = await request.get('/');
  const apiResponse = await request.get('/v1/auth/tenants');
  for (const response of [admin, member, apiResponse]) {
    expect(response.headers()['content-security-policy-report-only']).toBeUndefined();
    expect(response.headers()['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  }
  expect(admin.headers()['content-security-policy']).toContain("script-src 'self';");
  expect(admin.headers()['permissions-policy']).toContain('camera=(self)');
  expect(member.headers()['content-security-policy']).toContain("script-src 'self' https://checkout.razorpay.com;");
  expect(member.headers()['content-security-policy']).toContain('frame-src https://api.razorpay.com https://checkout.razorpay.com;');
  expect(member.headers()['permissions-policy']).toContain('camera=()');
  expect(apiResponse.headers()['content-security-policy']).toContain("default-src 'none'");
  // Fonts come from the app itself.
  expect(await admin.text()).not.toContain('fonts.googleapis.com');
});
