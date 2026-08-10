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

async function navigate(url) {
  await cdp('Page.navigate', { url });
  await retry(
    () => evaluate(`document.readyState === 'complete'`),
    `page load for ${url}`,
  );
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

await navigate(`${baseUrl}/admin/sign-in`);
await retry(
  () => evaluate(`document.body?.innerText.includes('Sign in')`),
  'Admin sign-in screen',
);

const signInScript = await evaluate(`document.querySelector('script[type="module"]')?.src ?? ''`);
if (!signInScript.includes('/admin/assets/')) {
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

await retry(
  () =>
    evaluate(`location.pathname === '/admin/' && /COMMAND/i.test(document.body?.innerText ?? '')`),
  'authenticated Admin command center',
  20_000,
);

// Give effects/realtime/query rendering enough time to expose render loops or
// asynchronous exceptions after the first successful paint.
await sleep(1_500);

const snapshot = await evaluate(`({
  path: location.pathname,
  title: document.title,
  text: (document.body?.innerText ?? '').slice(0, 600),
  script: document.querySelector('script[type="module"]')?.src ?? '',
})`);

const fatalConsoleErrors = consoleErrors.filter((message) =>
  /maximum update depth|minified react error|uncaught|something went wrong/i.test(message),
);
if (uncaught.length || fatalConsoleErrors.length) {
  throw new Error(
    `Browser runtime errors:\n${[...uncaught, ...fatalConsoleErrors].join('\n---\n')}`,
  );
}
if (/Something went wrong|Minified React error/i.test(snapshot.text)) {
  throw new Error(`Admin rendered its error boundary:\n${snapshot.text}`);
}

console.log(`[browser-smoke] Admin runtime OK at ${snapshot.path}`);
console.log(`[browser-smoke] bundle: ${snapshot.script}`);
console.log(`[browser-smoke] title: ${snapshot.title}`);
socket.close();
