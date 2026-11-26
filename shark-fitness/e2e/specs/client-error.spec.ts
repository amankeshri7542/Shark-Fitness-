import { readFileSync } from 'node:fs';
import { expect, test } from '../support/fixtures';
import { signInToMemberApp } from '../support/demo';

/** JSON log lines the server wrote during this run (global setup captures them). */
function serverLog(): Array<Record<string, unknown>> {
  return readFileSync(process.env.SHARK_E2E_SERVER_LOG!, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * A real failure mode, forced: after a deploy, a phone still running the old
 * build asks for a screen's code chunk that is gone. The screen must turn
 * into the plain recovery screen, and the crash must reach the server once.
 */
test('a crashed screen shows the recovery screen and reports to /v1/client-errors', async ({ page }) => {
  await signInToMemberApp(page);
  // Blocked at the network layer rather than with page.route: Playwright's
  // request interception also swallows keepalive fetches, which is how the
  // app sends its report.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*/assets/Train-*.js'] });

  // By destination: the label follows the member's copy tone (Strike / Train).
  await page.getByRole('navigation', { name: 'Main' }).locator('a[href="/app/train"]').click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Something went wrong.');
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
  const reference = (await page.getByTestId('error-reference').textContent())?.trim() ?? '';
  expect(reference).toMatch(/^ERR-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  await page.screenshot({ path: test.info().outputPath('recovery-screen.png') });

  // Playwright does not surface keepalive requests as page events, so the
  // proof is the server's own record: one accepted POST and one report,
  // carrying the reference the member sees.
  await expect
    .poll(() => serverLog().filter((line) => line.event === 'client_error' && line.reference === reference).length)
    .toBe(1);
  const report = serverLog().find((line) => line.event === 'client_error' && line.reference === reference)!;
  expect(report).toMatchObject({ source: 'member', kind: 'boundary', route: '/app/train', errorName: 'TypeError' });
  expect(report.tenantId).toBe('ten_shark');
  expect(
    serverLog().filter((line) => line.event === 'http_request' && line.route === '/v1/client-errors' && line.status === 204),
  ).toHaveLength(1);

  // Reloading the same broken screen does not report the same bug twice.
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Something went wrong.');
  await expect(page.getByTestId('error-reference')).toHaveText(reference);
  await page.waitForTimeout(500);
  expect(serverLog().filter((line) => line.event === 'client_error')).toHaveLength(1);
});
