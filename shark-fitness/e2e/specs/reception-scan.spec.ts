import { expect, test } from '../support/fixtures';
import { DEMO, signInToConsole } from '../support/demo';
import { apiSession } from '../support/api';

/**
 * Reception scans a member's rotating pass (P05 acceptance 3; UX-A08).
 *
 * The member's code is fetched exactly as the phone fetches it, and typed into
 * the Floor's code box the way a USB keyboard-wedge scanner types it.
 */

interface PassPayload {
  branch: { id: string; name: string };
  openSession: unknown;
  code: { passes: Array<{ token: string; window: number }> } | null;
}

test('reception scans a member code from the code box: Admitted, then Already checked in; a blocked camera falls back to the box', async ({ page, baseURL }) => {
  // The browser refuses the camera, as when reception has said no to the prompt.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) },
    });
  });
  const member = await apiSession(baseURL!, DEMO.member.email);
  try {
    await signInToConsole(page);
    // The owner's own console session sets the scene: one sign-in, not two.
    const csrf = await page.evaluate(() => sessionStorage.getItem('shark.admin.csrf') ?? '');
    const ownerPatch = (path: string, data: unknown) =>
      page.request.fetch(path, { method: 'PATCH', data, headers: { 'x-csrf-token': csrf, origin: baseURL! } });

    let pass = await member.get<PassPayload>('/v1/member/pass');
    const branch = pass.branch;
    if (pass.openSession) await member.send('POST', '/v1/member/pass/check-out');

    // The run can happen at any hour: open the branch all day for it, so the
    // hours rule (which has its own tests) does not decide this one.
    const allDay = { opensAt: '00:00', closesAt: '23:59', hours: null, holidays: [] };
    let opened = await ownerPatch(`/v1/admin/settings/branches/${branch.id}`, allDay);
    if (opened.status() !== 200) {
      const { consequences } = (await opened.json()) as { consequences?: Array<{ code: string }> };
      opened = await ownerPatch(`/v1/admin/settings/branches/${branch.id}`, { ...allDay, acknowledge: (consequences ?? []).map((c) => c.code) });
    }
    expect(opened.status()).toBe(200);

    pass = await member.get<PassPayload>(`/v1/member/pass?branchId=${branch.id}`);
    expect(pass.code, 'an entry code for the member').not.toBeNull();

    await page.goto('/admin/floor');
    // The owner looks at all branches, so reception says which door this is.
    const scanning = page.getByLabel('Scanning at');
    await expect(scanning.locator(`option[value="${branch.id}"]`)).toHaveCount(1);
    await scanning.selectOption(branch.id);

    const codeBox = page.getByLabel('Pass code');
    await codeBox.fill(pass.code!.passes[0]!.token);
    await codeBox.press('Enter');
    await expect(page.getByRole('heading', { name: 'Admitted' })).toBeVisible();
    await expect(page.getByText(/Aman/).first()).toBeVisible();
    await expect(codeBox).toHaveValue('');

    // The member is inside now: a fresh code reads "Already checked in".
    const again = await member.get<PassPayload>(`/v1/member/pass?branchId=${branch.id}`);
    const next = again.code?.passes.find((p) => p.token !== pass.code!.passes[0]!.token) ?? again.code!.passes[0]!;
    await codeBox.fill(next.token);
    await codeBox.press('Enter');
    await expect(page.getByRole('heading', { name: 'Already checked in' })).toBeVisible();

    // Camera blocked: said plainly, and the code box takes over.
    await page.getByRole('button', { name: 'Scan with camera' }).click();
    await expect(page.getByText(/Camera access is blocked for this console/)).toBeVisible();
    await expect(codeBox).toBeFocused();

    await member.send('POST', '/v1/member/pass/check-out');
  } finally {
    await member.dispose();
  }
});

test('the camera is allowed for the console only', async ({ request }) => {
  const consoleDocument = await request.get('/admin/');
  expect(consoleDocument.headers()['permissions-policy']).toContain('camera=(self)');
  for (const path of ['/', '/billing', '/health']) {
    const response = await request.get(path);
    expect(response.headers()['permissions-policy'], path).toContain('camera=()');
  }
});
