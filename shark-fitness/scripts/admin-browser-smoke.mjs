import { readFileSync } from 'node:fs';

const chromeDebugUrl = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222';
const baseUrl = process.env.SHARK_BASE_URL ?? 'http://localhost:8787';
const credentials = process.env.SHARK_BROWSER_CREDENTIALS_FILE
  ? JSON.parse(readFileSync(process.env.SHARK_BROWSER_CREDENTIALS_FILE, 'utf8'))
  : { tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' };
for (const field of ['tenantSlug', 'email', 'password']) {
  if (typeof credentials[field] !== 'string' || !credentials[field]) throw new Error(`Missing browser credential field: ${field}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const target = await retry(async () => {
  const response = await fetch(`${chromeDebugUrl}/json/list`);
  if (!response.ok) return null;
  return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
}, 'Chrome DevTools target');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10_000);
  socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
});

let nextId = 0;
const pending = new Map();
const uncaught = [];
const consoleErrors = [];
const responses = [];
const requests = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails;
    uncaught.push(details?.exception?.description ?? details?.text ?? 'Unknown browser exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').filter(Boolean).join(' '));
  }
  if (message.method === 'Network.requestWillBeSent') {
    const request = message.params?.request;
    if (request?.url) {
      requests.push(request.url);
      if (requests.length > 100) requests.shift();
    }
  }
  if (message.method === 'Network.responseReceived') {
    const response = message.params?.response;
    if (response?.url?.includes('/admin') || response?.url?.includes('/assets/')) {
      responses.push({
        url: response.url,
        status: response.status,
        mimeType: response.mimeType,
        fromServiceWorker: Boolean(response.fromServiceWorker),
        fromDiskCache: Boolean(response.fromDiskCache),
      });
      if (responses.length > 40) responses.shift();
    }
  }
});

function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}

async function navigate(url, expectedPath = null) {
  const result = await cdp('Page.navigate', { url });
  if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
  await sleep(300);
  return retry(
    () => evaluate(`document.readyState === 'complete'${expectedPath ? ` && location.pathname === ${JSON.stringify(expectedPath)}` : ''}`),
    `page load for ${url}`,
  );
}

async function pageSnapshot() {
  return evaluate(`(async () => ({
    href: location.href,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 1200),
    scripts: [...document.querySelectorAll('script[type="module"]')].map((node) => node.src),
    controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
    registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
      scope: registration.scope,
      active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
      waiting: registration.waiting?.scriptURL ?? null,
    })) : [],
  }))()`);
}

async function failWithDiagnostics(label, error) {
  let snapshot;
  try { snapshot = await pageSnapshot(); } catch (snapshotError) { snapshot = { error: String(snapshotError) }; }
  console.error(`[browser-smoke] ${label}: ${error?.message ?? error}`);
  console.error(JSON.stringify(snapshot, null, 2));
  console.error(`[browser-smoke] recent requests:\n${JSON.stringify(requests.slice(-30), null, 2)}`);
  console.error(`[browser-smoke] responses:\n${JSON.stringify(responses, null, 2)}`);
  console.error(`[browser-smoke] uncaught:\n${uncaught.join('\n---\n') || '(none)'}`);
  console.error(`[browser-smoke] console errors:\n${consoleErrors.join('\n---\n') || '(none)'}`);
  throw error;
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Network.enable');

// A brand-new browser has no member-session hint. It must reach sign-in without
// depending on /v1/me. This is important for the hosted demo because the PWA
// shell can be cached while a free backend is asleep.
await navigate(`${baseUrl}/`);
try {
  await retry(
    () => evaluate(`location.pathname === '/sign-in' && [...document.querySelectorAll('label')].some((node) => node.textContent?.trim() === 'Gym code') && Boolean(document.querySelector('input[autocomplete="username"]'))`),
    'fresh member sign-in screen',
    5_000,
  );
} catch (error) {
  await failWithDiagnostics('fresh member bootstrap got stuck', error);
}

const initialMeRequests = requests.filter((url) => url === `${baseUrl}/v1/me` || url === `${baseUrl}/v1/me/`);
if (initialMeRequests.length > 0) {
  await failWithDiagnostics(
    'fresh member bootstrap contacted /v1/me',
    new Error(`Fresh browser must not depend on session restore: ${initialMeRequests.join(', ')}`),
  );
}
console.log('[browser-smoke] fresh member browser reached sign-in without /v1/me');

async function checkActivationNavigation() {
  // Invalid display-only parameters: never submit a password or create an account.
  await evaluate(`location.hash = 'activationId=invalid-ui-probe&activationToken=invalid-ui-probe&gym=probe'`);
  await retry(() => evaluate(`/Activate account/i.test(document.body.innerText) && ![...document.querySelectorAll('label')].some(node => node.textContent?.trim() === 'Gym code')`), 'same-page activation form');
  await evaluate(`location.hash = ''`);
  await retry(() => evaluate(`[...document.querySelectorAll('label')].some(node => node.textContent?.trim() === 'Gym code')`), 'ordinary sign-in after removing activation fragment');
}
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await checkActivationNavigation();
console.log('[browser-smoke] phone member activation fragment navigation OK (no password submitted)');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Reproduce a returning member browser: install the root-scoped member worker,
// wait until it is fully activated, then start another same-origin navigation so
// the active worker becomes the controller before Admin is opened.
const memberWorker = await retry(
  () => evaluate(`(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state !== 'activated') return false;
    return { scope: registration.scope, scriptURL: registration.active.scriptURL };
  })()`),
  'activated member service worker',
  20_000,
);
console.log(`[browser-smoke] member worker activated: ${memberWorker.scriptURL}`);

let controlled = false;
for (let attempt = 1; attempt <= 4 && !controlled; attempt += 1) {
  const currentUrl = await evaluate('location.href');
  await navigate(currentUrl);
  controlled = Boolean(await evaluate('navigator.serviceWorker?.controller?.scriptURL'));
  if (!controlled) await sleep(500);
}
if (!controlled) {
  await failWithDiagnostics('member worker never controlled a returning page', new Error('member service worker controller unavailable'));
}
console.log(`[browser-smoke] member page controlled by: ${await evaluate('navigator.serviceWorker.controller.scriptURL')}`);

try {
  await navigate(`${baseUrl}/admin/sign-in`, '/admin/sign-in');
  await retry(() => evaluate(`/sign in/i.test(document.body?.innerText ?? '')`), 'Admin sign-in screen');
} catch (error) {
  await failWithDiagnostics('Admin sign-in failure', error);
}

const adminBundle = await evaluate(`document.querySelector('script[type="module"]')?.src ?? ''`);
if (!adminBundle.includes('/admin/assets/')) {
  await failWithDiagnostics('wrong app shell at Admin sign-in', new Error(`Unexpected Admin module: ${adminBundle || '(none)'}`));
}
await checkActivationNavigation();
console.log('[browser-smoke] desktop staff activation fragment navigation OK (no password submitted)');

// Production has no demo selectors or prefilled credentials.
const filled = await evaluate(`(() => {
  const values = ${JSON.stringify({ 'Gym code': credentials.tenantSlug, 'Work email': credentials.email, Password: credentials.password })};
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [label, value] of Object.entries(values)) {
    const labelNode = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === label);
    const input = labelNode?.htmlFor ? document.getElementById(labelNode.htmlFor) : null;
    if (!(input instanceof HTMLInputElement)) return false;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
if (!filled) await failWithDiagnostics('Admin sign-in fields missing', new Error('Could not fill gym code, work email and password'));
await retry(() => evaluate(`Boolean([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Sign in' && !node.disabled))`), 'enabled Admin sign-in button');
const clicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Sign in');
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!clicked) await failWithDiagnostics('Admin sign-in button missing', new Error('Could not find Sign in button'));

try {
  await retry(
    () => evaluate(`location.pathname === '/admin/' && /COMMAND/i.test(document.body?.innerText ?? '')`),
    'authenticated Admin command center',
    20_000,
  );
} catch (error) {
  await failWithDiagnostics('authenticated Admin failure', error);
}

await sleep(1_500);
const finalSnapshot = await pageSnapshot();
const fatalConsoleErrors = consoleErrors.filter((message) => /maximum update depth|minified react error|uncaught|something went wrong/i.test(message));
if (uncaught.length || fatalConsoleErrors.length || /Something went wrong|Minified React error/i.test(finalSnapshot.text)) {
  await failWithDiagnostics('Admin runtime exception', new Error([...uncaught, ...fatalConsoleErrors, finalSnapshot.text].filter(Boolean).join('\n---\n')));
}

if (!finalSnapshot.scripts.some((src) => src.includes('/admin/assets/'))) {
  await failWithDiagnostics('Admin bundle disappeared after sign-in', new Error('Authenticated Admin is not running the Admin bundle'));
}

console.log(`[browser-smoke] Admin runtime OK at ${finalSnapshot.href}`);
console.log(`[browser-smoke] Admin bundle: ${finalSnapshot.scripts.join(', ')}`);
console.log(`[browser-smoke] controller at Admin: ${finalSnapshot.controller ?? 'none'}`);
await navigate(`${baseUrl}/admin/members`, '/admin/members');
await retry(() => evaluate(`Boolean(document.querySelector('nav[aria-label="Member directory pages"]'))`), 'member directory pagination');
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await retry(() => evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'phone directory fits viewport');
console.log('[browser-smoke] authenticated member directory and phone layout OK');
socket.close();
