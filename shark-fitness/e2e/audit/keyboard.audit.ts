import { test, type Page } from '@playwright/test';
import { DEMO } from '../support/demo';
import { nextOwnerCode } from '../support/totp';
import { citeScreenshot, screenshotPath, writeData } from './lib/out';
import { MEMBER_STATE } from './lib/session';
import { describeFocus, measureAnimations, type FocusStep } from './lib/measure';

/**
 * Keyboard-only walkthroughs (PRD 01 acceptance scenarios 17 and 18).
 *
 * Every control is reached with Tab / Shift+Tab and operated with Enter,
 * Space, arrows or typing; the mouse is never used. A step records the keys
 * pressed, how many Tab presses it took, every focus stop on the way (role,
 * accessible name, whether a focus indicator is drawn, whether it is hidden
 * behind other UI), what was expected and what happened, and a screenshot.
 * The walkthroughs do not stop at the first failure: a failing step is
 * recorded and the next step starts from a known place, so one defect does
 * not hide the rest.
 */

export interface WalkStep {
  scenario: string;
  id: string;
  task: string;
  keys: string;
  expected: string;
  result: 'pass' | 'fail';
  observed: string;
  tabs: number;
  focusTrail: FocusStep[];
  screenshot: string;
}

class Walk {
  steps: WalkStep[] = [];
  private trail: FocusStep[] = [];
  private keys: string[] = [];
  tabs = 0;
  constructor(
    private page: Page,
    private scenario: string,
    private slug: string,
  ) {}

  /** Tab (or Shift+Tab) until the focused element matches, up to `max` presses. */
  async tabTo(match: { name: RegExp; role?: RegExp }, max = 120, backwards = false): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      const current = await describeFocus(this.page, this.trail.length);
      if (i > 0 || current.selector !== 'body') {
        if (match.name.test(current.name) && (!match.role || match.role.test(current.role))) return true;
      }
      await this.page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
      this.tabs++;
      this.trail.push(await describeFocus(this.page, this.trail.length));
      const now = this.trail[this.trail.length - 1]!;
      if (match.name.test(now.name) && (!match.role || match.role.test(now.role))) {
        this.keys.push(`${backwards ? 'Shift+Tab' : 'Tab'}×${i + 1}`);
        return true;
      }
    }
    this.keys.push(`Tab×${max} (not reached)`);
    return false;
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    this.keys.push(key);
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 15 });
    this.keys.push(`type "${text}"`);
  }

  async focused(): Promise<FocusStep> {
    return describeFocus(this.page, this.trail.length);
  }

  async record(id: string, task: string, expected: string, ok: boolean, observed: string): Promise<boolean> {
    const file = screenshotPath('keyboard', this.slug, `${id}.png`);
    await this.page.screenshot({ path: file, animations: 'disabled' }).catch(() => undefined);
    this.steps.push({
      scenario: this.scenario,
      id,
      task,
      keys: this.keys.join(', '),
      expected,
      result: ok ? 'pass' : 'fail',
      observed,
      tabs: this.tabs,
      focusTrail: this.trail,
      screenshot: citeScreenshot(file),
    });
    this.trail = [];
    this.keys = [];
    this.tabs = 0;
    return ok;
  }
}

const visible = (page: Page, selector: string, timeout = 6_000) =>
  page
    .locator(selector)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

const heading = (page: Page, name: RegExp, timeout = 8_000) =>
  page
    .getByRole('heading', { level: 1, name })
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

async function text(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().innerText({ timeout: 2_000 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 240);
}

test.describe.configure({ mode: 'serial' });

test('scenario 17: keyboard-only admin tasks (find member, record payment, book class, export report)', async ({ browser }) => {
  const baseURL = process.env.SHARK_E2E_BASE_URL!;
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block', extraHTTPHeaders: { 'x-forwarded-for': '10.77.0.17' } });
  const page = await context.newPage();
  const walk = new Walk(page, 'PRD 01 scenario 17 (console, keyboard only)', 'scenario-17');

  // ——— 17.1 Sign in ————————————————————————————————————————————————
  await page.goto('/admin/sign-in');
  await page.waitForLoadState('networkidle');
  let ok = await walk.tabTo({ name: /gym code/i });
  if (ok) await walk.type(DEMO.gym);
  ok = ok && (await walk.tabTo({ name: /work email/i }));
  if (ok) await walk.type(DEMO.owner.email);
  ok = ok && (await walk.tabTo({ name: /^password/i }));
  if (ok) await walk.type(DEMO.owner.password);
  await walk.press('Enter');
  const codeShown = await heading(page, /enter your code/i);
  await walk.record('17.1a', 'Sign in: gym code, email, password, Enter submits', 'Enter in the password field submits; the two-step code screen opens', ok && codeShown, codeShown ? 'Code screen shown' : `Still on: ${await text(page, 'h1')}`);
  const codeFocused = /authenticator code/i.test((await walk.focused()).name);
  ok = codeFocused || (await walk.tabTo({ name: /authenticator code/i }));
  if (ok) await walk.type(await nextOwnerCode());
  await walk.press('Enter');
  const inConsole = await heading(page, /command/i, 12_000);
  await walk.record('17.1b', 'Sign in: authenticator code, Enter verifies', 'Code field focused on arrival; Enter verifies and Command Center opens', ok && inConsole, `${codeFocused ? 'Code field had focus on arrival' : 'Code field did NOT have focus on arrival'}; ${inConsole ? 'Command Center open' : 'not signed in'}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // ——— 17.2 Bypass blocks ————————————————————————————————————————
  await page.goto('/admin/');
  await heading(page, /command/i);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await walk.press('Tab');
  const first = await walk.focused();
  const reachedContent = await walk.tabTo({ name: /create task|open billing/i });
  await walk.record(
    '17.2',
    'Skip to content',
    'The first Tab stop is a "Skip to content" link (WCAG 2.4.1); content is reachable without walking the whole rail',
    /skip/i.test(first.name),
    `First Tab stop: ${first.role} "${first.name}". Reaching the first Command Center action took ${walk.tabs + 1} Tab presses${reachedContent ? '' : ' (not reached)'}.`,
  );

  // ——— 17.3 Find a member: command palette ———————————————————————————
  await walk.press('Control+k');
  const paletteFocus = await walk.focused();
  await walk.type('Rohit');
  await page.getByRole('option', { name: /rohit/i }).first().waitFor({ timeout: 6_000 }).catch(() => undefined);
  for (let i = 0; i < 8; i++) {
    const active = await page.evaluate(() => {
      const input = document.activeElement;
      const id = input?.getAttribute('aria-activedescendant');
      return id ? (document.getElementById(id)?.textContent ?? '') : '';
    });
    if (/rohit/i.test(active) && /member/i.test(active)) break;
    await walk.press('ArrowDown');
  }
  await walk.press('Enter');
  await page.waitForURL(/\/admin\/members\/mbr_/, { timeout: 8_000 }).catch(() => undefined);
  const memberOpen = /\/admin\/members\/mbr_/.test(page.url()) && (await heading(page, /rohit/i));
  await walk.record('17.3', 'Find a member with ⌘K / Ctrl+K', 'Ctrl+K focuses the search box; typing a name lists the member; Enter opens Member 360', /combobox/.test(paletteFocus.role) && memberOpen, `Focus after Ctrl+K: ${paletteFocus.role} "${paletteFocus.name}"; ${memberOpen ? 'Member 360 opened' : `URL ${new URL(page.url()).pathname}`}`);

  // ——— 17.4 Find a member: Members list ————————————————————————————
  await page.goto('/admin/');
  await heading(page, /command/i);
  ok = await walk.tabTo({ name: /^members$/i, role: /^a$|link/ });
  if (ok) await walk.press('Enter');
  ok = ok && (await heading(page, /members/i));
  ok = ok && (await walk.tabTo({ name: /search|name, phone|find/i, role: /input|searchbox|textbox/ }));
  if (ok) {
    await walk.type('Imran');
    await page.waitForTimeout(900);
  }
  const rowReached = ok && (await walk.tabTo({ name: /imran/i, role: /^a$|link|button|row/ }, 60));
  if (rowReached) await walk.press('Enter');
  const imranOpen = rowReached && (await page.waitForURL(/\/admin\/members\/mbr_/, { timeout: 6_000 }).then(() => true).catch(() => false));
  await walk.record('17.4', 'Find a member from Members: search box, then the row', 'The rail link, the search box and the result row are all reachable; Enter on the row opens Member 360', imranOpen, imranOpen ? 'Member 360 opened' : `Stopped at ${(await walk.focused()).role} "${(await walk.focused()).name}"`);

  // ——— 17.5 Record a payment ——————————————————————————————————————
  await page.goto('/admin/');
  await heading(page, /command/i);
  await walk.press('Control+k');
  await walk.type('Record payment');
  await page.waitForTimeout(400);
  await walk.press('Enter');
  const invoiceMode = /find the invoice/i.test((await walk.focused()).name);
  await walk.type('Rohit');
  await page.getByRole('option', { name: /rohit/i }).first().waitFor({ timeout: 6_000 }).catch(() => undefined);
  await walk.press('Enter');
  const dialogOpen = await visible(page, '[role="dialog"]:has-text("Record payment")', 8_000);
  const focusInDialog = dialogOpen && (await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))));
  await walk.record('17.5a', 'Record payment: palette action, then the invoice', 'The palette asks for the invoice, Enter opens the Record payment dialog with focus inside it', invoiceMode && dialogOpen && focusInDialog, `${invoiceMode ? 'Palette switched to "Find the invoice"' : 'Palette did not ask for the invoice'}; dialog ${dialogOpen ? 'open' : 'not open'}; focus ${focusInDialog ? 'inside' : 'outside'} the dialog`);
  let recorded = false;
  if (dialogOpen) {
    const amount = await page.getByLabel(/amount/i).first().inputValue().catch(() => '');
    if (!amount) {
      await walk.tabTo({ name: /amount/i }, 10);
      await walk.type('100');
    }
    const box = await walk.tabTo({ name: /independently verified/i, role: /input|checkbox/ }, 15);
    if (box) await walk.press('Space');
    const submit = box && (await walk.tabTo({ name: /^record payment$/i, role: /button/ }, 6));
    if (submit) await walk.press('Enter');
    recorded = submit && (await page.locator('[role="dialog"]:has-text("Record payment")').waitFor({ state: 'detached', timeout: 8_000 }).then(() => true).catch(() => false));
    const after = await text(page, '[role="status"], [role="alert"]');
    await walk.record('17.5b', 'Record payment: amount, method, verification, submit', 'Every field and the confirmation checkbox are reachable in order; Enter on "Record payment" records it, the dialog closes and the result is announced', recorded, `${recorded ? 'Recorded; dialog closed' : 'Not recorded'}${after ? `; live region: "${after}"` : '; no status/alert text announced after recording'}`);
  }

  // ——— 17.6 Book a member onto a class —————————————————————————————
  await page.goto('/admin/');
  await heading(page, /command/i);
  ok = await walk.tabTo({ name: /^schedule$/i, role: /^a$|link/ });
  if (ok) await walk.press('Enter');
  ok = ok && (await heading(page, /schedule/i));
  // Any class still open for booking today: its row toggles a detail panel.
  const opened = ok && (await walk.tabTo({ name: /\d{1,2}:\d{2}/, role: /button/ }, 80));
  if (opened) await walk.press('Enter');
  const bookField = opened && (await walk.tabTo({ name: /book a member on/i }, 40));
  let bookingObserved = 'No booking field reached';
  let booked = false;
  if (bookField) {
    // What reception knows about a member: the name and the member number.
    await walk.type('SF-40229');
    const bookButton = await walk.tabTo({ name: /book seat/i, role: /button/ }, 4);
    if (bookButton) await walk.press('Enter');
    await page.waitForTimeout(1_500);
    const alert = await text(page, '[role="alert"]');
    booked = bookButton && !alert && (await page.getByText(/SF-40229|Imran/).count()) > 0;
    bookingObserved = `Typed the member number SF-40229 into "Book a member on" (placeholder "Member ID") → ${alert ? `error: "${alert}"` : booked ? 'booked' : 'nothing visible happened'}. The field accepts only the internal record id (mbr_…), which the console never shows.`;
  }
  await walk.record('17.6', 'Book a member onto a class from Schedule', 'Open a class with the keyboard, find the member by name or member number, book a seat', booked, bookingObserved);

  // ——— 17.7 Export a report ———————————————————————————————————————
  await page.goto('/admin/');
  await heading(page, /command/i);
  ok = await walk.tabTo({ name: /^reports$/i, role: /^a$|link/ });
  if (ok) await walk.press('Enter');
  ok = ok && (await heading(page, /reports/i));
  const exportReached = ok && (await walk.tabTo({ name: /export csv/i, role: /button/ }, 80));
  const download = page.waitForEvent('download', { timeout: 10_000 }).then(() => true).catch(() => false);
  if (exportReached) await walk.press('Enter');
  if (await visible(page, '[role="dialog"]:has-text("Confirm")', 2_500)) {
    await walk.tabTo({ name: /password/i }, 10);
    await walk.type(DEMO.owner.password);
    await walk.press('Enter');
  }
  const gotFile = await download;
  const exportStatus = await text(page, '[role="status"], [role="alert"]');
  const exportLink = await page.getByRole('link', { name: /download/i }).count();
  await walk.record('17.7', 'Export a report as CSV', '"Export CSV" is reachable; Enter starts the export; the result (file or download link) is announced', exportReached && (gotFile || exportLink > 0), `${exportReached ? 'Export button reached' : 'Export button not reached'}; ${gotFile ? 'file downloaded' : exportLink ? 'download link shown' : 'no file and no download link'}${exportStatus ? `; live region: "${exportStatus}"` : ''}`);

  writeData('keyboard-scenario-17', walk.steps);
  await context.close();
});

test('scenario 18: member check-in, booking and workout with reduced motion, keyboard only', async ({ browser }) => {
  const baseURL = process.env.SHARK_E2E_BASE_URL!;
  const context = await browser.newContext({
    baseURL,
    storageState: MEMBER_STATE,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const walk = new Walk(page, 'PRD 01 scenario 18 (member app, reduced motion, keyboard only)', 'scenario-18');

  // ——— 18.1 Check-in pass ——————————————————————————————————————————
  await page.goto('/app/');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await walk.press('Tab');
  const first = await walk.focused();
  await walk.record('18.0', 'Skip to content / first stop', 'The first Tab stop is a skip link or the first control of the screen', /skip/i.test(first.name), `First Tab stop: ${first.role} "${first.name}"`);
  let ok = await walk.tabTo({ name: /entry code|^pass$|check.?in/i, role: /^a$|link|button/ });
  if (ok) await walk.press('Enter');
  const passOpen = ok && (await heading(page, /pass/i));
  await page.waitForTimeout(600);
  const motion = await measureAnimations(page);
  const looping = motion.running.filter((a) => a.iterations === 'infinite' || a.duration > 50);
  const countdown = await page.getByText(/changes in \d+/i).count();
  const memberNo = await page.getByText(/SF-\d{5}/).count();
  await walk.record(
    '18.1',
    'Open the check-in pass',
    'The pass opens; the code, member number and refresh countdown are shown as text; nothing keeps animating with reduced motion on',
    passOpen && countdown > 0 && memberNo > 0 && looping.length === 0,
    `${passOpen ? 'Pass open' : 'Pass not open'}; countdown text ${countdown ? 'present' : 'absent'}; member number ${memberNo ? 'shown' : 'absent'}; animations still running: ${looping.length ? looping.map((a) => `${a.name} on ${a.selector} (${a.duration} ms × ${a.iterations})`).join('; ') : 'none'}`,
  );
  ok = await walk.tabTo({ name: /close entry pass|close/i, role: /button|^a$|link/ }, 20);
  if (ok) await walk.press('Enter');
  const backHome = ok && (await page.waitForURL(/\/app\/?$/, { timeout: 5_000 }).then(() => true).catch(() => false));
  await walk.record('18.2', 'Close the pass', 'The close control is reachable and returns to Home', backHome, backHome ? 'Back on Home' : `URL ${new URL(page.url()).pathname}`);

  // ——— 18.3 Book a class ——————————————————————————————————————————
  ok = await walk.tabTo({ name: /book a class|open your bookings|^book$/i, role: /^a$|link|button/ });
  if (ok) await walk.press('Enter');
  ok = ok && (await heading(page, /^book$/i));
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const bookReached = ok && (await walk.tabTo({ name: /^book$/i, role: /button/ }, 80));
  const bookedBefore = await page.getByText(/^Booked\./).count();
  if (bookReached) await walk.press('Enter');
  await page.waitForTimeout(800);
  // A confirmation step, if the app asks for one.
  const dialog = await visible(page, '[role="dialog"], [role="alertdialog"]', 1_500);
  let dialogFocus = false;
  if (dialog) {
    dialogFocus = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')));
    const confirm = await walk.tabTo({ name: /confirm|book|join|pay/i, role: /button/ }, 12);
    if (confirm) await walk.press('Enter');
    await page.waitForTimeout(1_000);
  }
  const bookedAfter = await page.getByText(/^Booked\./).count();
  const live = await text(page, '[role="status"], [role="alert"]');
  await walk.record('18.3', 'Book a class', 'The class list and its Book button are reachable; booking completes in ≤ 3 actions; the result is shown as text and announced', bookedAfter > bookedBefore, `Book button ${bookReached ? 'reached' : 'not reached'}; ${dialog ? `confirmation dialog shown (focus ${dialogFocus ? 'inside' : 'NOT inside'})` : 'no confirmation step'}; booked classes ${bookedBefore} → ${bookedAfter}${live ? `; live region: "${live}"` : '; nothing announced in a live region'}`);

  // ——— 18.4 Workout ————————————————————————————————————————————————
  await page.goto('/app/');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  ok = await walk.tabTo({ name: /strike now|start session|back in|resume/i, role: /button|^a$|link/ });
  if (ok) await walk.press('Enter');
  const inWorkout = ok && (await page.waitForURL(/\/app\/workout/, { timeout: 6_000 }).then(() => true).catch(() => false));
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await walk.record('18.4', 'Start the planned workout', 'Start is reachable from Home and opens the set logger', inWorkout, inWorkout ? 'Workout open' : `URL ${new URL(page.url()).pathname}`);
  const before = await text(page, 'header, [role="banner"]');
  const logReached = await walk.tabTo({ name: /^log set 1$/i, role: /button/ }, 60);
  const started = Date.now();
  if (logReached) await walk.press('Enter');
  const confirmed = await page
    .waitForFunction((previous) => (document.querySelector('header, [role="banner"]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() !== previous, before.replace(/\s+/g, ' ').trim(), { timeout: 3_000 })
    .then(() => Date.now() - started)
    .catch(() => null);
  const after = await text(page, 'header, [role="banner"]');
  const announced = await text(page, '[role="status"], [aria-live]');
  await walk.record('18.5', 'Log a set with the keyboard', 'Enter on "Log set 1" logs it; the set count changes visibly (PRD 03: within 100 ms) and the change is announced', logReached && confirmed !== null, `${logReached ? '"Log set 1" reached' : '"Log set 1" not reached'}; header "${before}" → "${after}"${confirmed !== null ? ` after ~${confirmed} ms (includes automation overhead)` : ''}; live region: ${announced ? `"${announced}"` : 'none found'}`);
  const finish = await walk.tabTo({ name: /finish this session|log the strike|finish/i, role: /button/ }, 80, true);
  if (finish) await walk.press('Enter');
  const finishDialog = await visible(page, '[role="dialog"], [role="alertdialog"]', 2_000);
  if (finishDialog) {
    const confirm = await walk.tabTo({ name: /finish|end|save|log the strike/i, role: /button/ }, 15);
    if (confirm) await walk.press('Enter');
  }
  const summary = await page.waitForURL(/\/workout\/summary\//, { timeout: 8_000 }).then(() => true).catch(() => false);
  await walk.record('18.6', 'Finish the session', 'Finish is reachable; any confirmation keeps focus inside it; the summary opens', summary, `${finish ? 'Finish reached' : 'Finish not reached'}; ${finishDialog ? 'confirmation shown' : 'no confirmation'}; ${summary ? 'summary opened' : `URL ${new URL(page.url()).pathname}`}`);

  writeData('keyboard-scenario-18', walk.steps);
  await context.close();
});
