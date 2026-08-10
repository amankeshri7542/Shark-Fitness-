const chromeDebugUrl = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222';
const baseUrl = process.env.SHARK_BASE_URL ?? 'http://localhost:8787';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const targets = await retry(async () => {
  const response = await fetch(`${chromeDebugUrl}/json/list`);
  if (!response.ok) return null;
  const list = await response.json();
  return list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null;
}, 'Chrome DevTools target');

const socket = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP websocket connection timed out')), 10_000);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new Error('CDP websocket connection failed'));
  }, { once: true });
});

let commandId = 0;
const pending = new Map();
const uncaught = [];
const consoleErrors = [];
const responses = [];

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
    consoleErrors.push(
      (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .filter(Boolean)
        .join(' '),
    );
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
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function navigate(url, expectedPath = null) {
  const result = await cdp('Page.navigate', { url });
  if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
  // Give the new document a moment to replace the old `complete` document,
  // then require only the route that matters. Member `/` legitimately redirects
  // unauthenticated users to its own sign-in page.
  await sleep(250);
  await retry(
    () =>
      evaluate(
        `document.readyState === 'complete'${
          expectedPath ? ` && location.pathname === ${JSON.stringify(expectedPath)}` : ''
        }`,
      ),
    `page load for ${url}`,
  );
}

async function reloadCurrentPage() {
  await cdp('Page.reload', { ignoreCache: true });
  await sleep(250);
  await retry(
    () => evaluate(`document.readyState === 'complete'`),
    'page reload',
  );
}

async function snapshot(label) {
  let page = null;
  try {
    page = await evaluate(`(async () => ({
      href: location.href,
      path: location.pathname,
      title: document.title,
      readyState: document.readyState,
      text: (document.body?.innerText ?? '').slice(0, 1200),
      moduleScripts: [...document.querySelectorAll('script[type="module"]')].map((node) => node.src),
      controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
      registrations: 'serviceWorker' in navigator
        ? (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
            scope: registration.scope,
            active: registration.active?.scriptURL ?? null,
            waiting: registration.waiting?.scriptURL ?? null,
            installing: registration.installing?.scriptURL ?? null,
          }))
        : [],
      directAdminFetch: await fetch('/admin/sign-in', { cache: 'no-store' })
        .then(async (response) => ({
          status: response.status,
          contentType: response.headers.get('content-type'),
          cacheControl: response.headers.get('cache-control'),
          release: response.headers.get('x-shark-release'),
          head: (await response.text()).slice(0, 240),
        }))
        .catch((error) => ({ error: String(error) })),
    }))()`);
  } catch (error) {
    page = { snapshotError: String(error) };
  }
  console.error(`[browser-smoke] ${label} snapshot:\n${JSON.stringify(page, null, 2)}`);
  console.error(`[browser-smoke] recent responses:\n${JSON.stringify(responses, null, 2)}`);
  console.error(`[browser-smoke] uncaught:\n${uncaught.join('\n---\n') || '(none)'}`);
  console.error(`[browser-smoke] console errors:\n${consoleErrors.join('\n---\n') || '(none)'}`);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Network.enable');

// First open the member app and activate its root-scoped service worker. The
// following Admin navigation is then a real regression test for cross-SPA PWA
// interception, not merely an Admin page opened in a clean profile.
await navigate(`${baseUrl}/`);
const memberWorkerScope = await retry(
  () =>
    evaluate(`(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      return registration?.scope ?? false;
    })()`),
  'member service worker activation',
  20_000,
);
console.log(`[browser-smoke] member worker active: ${memberWorkerScope}`);

// Reload whatever member route the app settled on so the freshly installed root
// worker becomes the active controller. This reproduces a returning user's tab.
await reloadCurrentPage();
await retry(
  () => evaluate(`Boolean(navigator.serviceWorker?.controller)`),
  'member service worker controller',
  10_000,
);

await navigate(`${baseUrl}/admin/sign-in`, '/admin/sign-in');
try {
  await retry(
    () => evaluate(`document.body?.innerText.includes('Sign in')`),
    'Admin sign-in screen',
  );
} catch (error) {
  await snapshot('Admin sign-in failure');
  throw error;
}

const signInScript = await evaluate(`document.querySelector('script[type="module"]')?.src ?? ''`);
if (!signInScript.includes('/admin/assets/')) {
  await snapshot('wrong Admin shell');
  throw new Error(`Admin navigation loaded the wrong app shell: ${signInScript || 'no module script'}`);
}

const clicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((node) => node.textContent?.trim() === 'Sign in');
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!clicked) throw new Error('Could not find the Admin Sign in button');

try {
  await retry(
    () =>
      evaluate(`location.pathname === '/admin/' && /COMMAND/i.test(document.body?.innerText ?? '')`),
    'authenticated Admin command center',
    20_000,
  );
} catch (error) {
  await snapshot('authenticated Admin failure');
  throw error;
}

// Give effects/realtime/query rendering enough time to expose render loops or
// asynchronous exceptions after the first successful paint.
await sleep(1_500);

const finalSnapshot = await evaluate(`({
  path: location.pathname,
  title: document.title,
  text: (document.body?.innerText ?? '').slice(0, 600),
  script: document.querySelector('script[type="module"]')?.src ?? '',
  controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
})`);

const fatalConsoleErrors = consoleErrors.filter((message) =>
  /maximum update depth|minified react error|uncaught|something went wrong/i.test(message),
);
if (uncaught.length || fatalConsoleErrors.length) {
  await snapshot('runtime exception');
  throw new Error(
    `Browser runtime errors:\n${[...uncaught, ...fatalConsoleErrors].join('\n---\n')}`,
  );
}
if (/Something went wrong|Minified React error/i.test(finalSnapshot.text)) {
  await snapshot('error boundary');
  throw new Error(`Admin rendered its error boundary:\n${finalSnapshot.text}`);
}

console.log(`[browser-smoke] Admin runtime OK at ${finalSnapshot.path}`);
console.log(`[browser-smoke] bundle: ${finalSnapshot.script}`);
console.log(`[browser-smoke] service-worker controller: ${finalSnapshot.controller ?? 'none'}`);
console.log(`[browser-smoke] title: ${finalSnapshot.title}`);
socket.close();
