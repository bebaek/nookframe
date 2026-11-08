import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import type { Snapshot } from '../shared/protocol.js';

test('attention notifications: opt-in, focused suppression, deduplication, click navigation, and disable', { timeout: 30000 }, async () => {
  // Only serve the built client; all auth and websocket data are isolated browser fixtures.
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' ? 'index.html' : req.url!.slice(1);
      if (path.includes('..')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(resolve('dist/web', path)));
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addInitScript(`(() => {
      const w = window;
      w.notifications = [];
      w.permissionRequests = 0;
      w.fixtureFocus = true;
      if (localStorage.getItem('fixtureRealWorker') !== 'true') {
        navigator.serviceWorker.register = async () => { throw new Error('Fixture: unavailable'); };
      }
      document.hasFocus = () => w.fixtureFocus;
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      w.Notification = class {
        static permission = 'default';
        static async requestPermission() { w.permissionRequests++; this.permission = 'granted'; return 'granted'; }
        closed = false;
        constructor(title, options) { this.title = title; this.options = options; w.notifications.push(this); }
        close() { this.closed = true; this.onclose?.(); }
      };
    })()`);
    // Exercise the basic fallback when service-worker registration is unavailable.
    await page.route('**/notification-worker.js', route => route.abort());
    await page.context().route('**/auth/session', route => route.fulfill({ json: { authenticated: true } }));
    // This fixture exercises local fallback, not a push-capable HTTPS server.
    await page.context().route('**/api/push', route => route.fulfill({ status: 503 }));
    const threads = [{ id: 'a', title: 'Private A', updatedAt: '2026-01-01', busy: false }, { id: 'b', title: 'Private B', updatedAt: '2026-01-01', busy: false, notificationSummary: 'Private result: tests pass.' }];
    const state: Snapshot = { threadId: 'a', threads, busy: false, available: true, messages: [], tools: {}, liveText: '', model: 'fixture', models: [], modelSource: 'pi', modelChanging: false, threadChanging: false, notice: '' };
    const focusReports: { threadId: string; focused: boolean }[] = [];
    let socket: WebSocketRoute;
    await page.routeWebSocket('**/ws', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'push_focus') focusReports.push(message);
        if (message.type === 'auth') ws.send(JSON.stringify({ type: 'snapshot', state, selected: true }));
        if (message.type === 'switch_thread') {
          state.threadId = message.targetId;
          ws.send(JSON.stringify({ type: 'snapshot', state, selected: true }));
          ws.send(JSON.stringify({ type: 'ack', id: message.id }));
        }
      });
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    const count = () => page.evaluate(() => (window as any).notifications.length);
    async function run(id: string) {
      for (const busy of [true, false, false]) {
        threads.find(thread => thread.id === id)!.busy = busy;
        socket.send(JSON.stringify({ type: 'threads', threads }));
        // A browser round trip ensures each catalog frame is consumed before assertions.
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(200); // Allow the bounded cross-tab focus query to complete.
    }
    await run('b'); assert.equal(await count(), 0, 'no notification before opt-in');
    assert.ok(focusReports.some(report => report.threadId === 'a' && report.focused), 'focused chat reported to server');
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).waitFor();
    await run('a'); assert.equal(await count(), 0, 'focused active conversation is silent');
    await run('b'); assert.equal(await count(), 1, 'other conversation notifies once');
    assert.equal(await page.evaluate(() => JSON.stringify((window as any).notifications).includes('Private')), false);
    await page.evaluate(() => (window as any).notifications[0].onclick());
    await page.waitForFunction(() => location.hash === '#thread=b');
    await page.evaluate(() => { (window as any).fixtureFocus = false; window.dispatchEvent(new Event('blur')); });
    const summaryToggle = page.getByRole('checkbox', { name: 'Include response summaries in notifications' });
    assert.equal(await summaryToggle.isChecked(), false);
    await summaryToggle.click();
    await page.waitForFunction(() => localStorage.getItem('nookframe.notificationSummaries') === 'true');
    await run('b'); assert.equal(await count(), 2, 'unfocused active conversation notifies');
    assert.equal(await page.evaluate(() => (window as any).notifications.at(-1).options.body), 'Private result: tests pass.');
    await summaryToggle.click();
    await page.waitForFunction(() => localStorage.getItem('nookframe.notificationSummaries') === 'false');

    const other = await page.context().newPage();
    await other.routeWebSocket('**/ws', ws => {
      ws.onMessage(raw => {
        if (JSON.parse(String(raw)).type === 'auth') {
          ws.send(JSON.stringify({ type: 'snapshot', state: { ...state, threadId: 'b' }, selected: true }));
        }
      });
    });
    await other.goto(`http://127.0.0.1:${address.port}/#thread=b`);
    await other.getByRole('button', { name: 'Workspace controls', exact: true }).waitFor();
    await run('b'); assert.equal(await count(), 2, 'another focused tab reading the same chat suppresses fallback notifications');
    await run('a'); assert.equal(await count(), 3, 'focused tab on a different chat does not suppress');
    await other.evaluate(() => { (window as any).fixtureFocus = false; });
    await run('b'); assert.equal(await count(), 4, 'unfocused matching tab does not suppress');
    assert.match(await page.evaluate(() => (window as any).notifications.at(-1).options.body), /An agent run has ended/);
    await other.close();
    await run('b'); assert.equal(await count(), 5, 'closed matching tab does not leave stale focus');
    assert.equal(focusReports.at(-1)?.focused, false, 'blur immediately clears foreground suppression');
    assert.equal(focusReports.at(-1)?.threadId, 'b');
    await page.evaluate(() => { (window as any).fixtureFocus = true; window.dispatchEvent(new Event('focus')); });
    await run('b'); assert.equal(await count(), 5, 'returning to focused chat is silent');
    assert.equal(focusReports.at(-1)?.focused, true);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(40);
    assert.equal(focusReports.at(-1)?.focused, false, 'page exit clears foreground suppression');
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await run('a'); assert.equal(await count(), 5);
    assert.equal(await page.evaluate(() => (window as any).notifications.every((n: any) => n.closed)), true);
    assert.deepEqual(errors, []);

    // Now exercise the actual registered worker and its exact-client activation path.
    await page.unroute('**/notification-worker.js');
    await page.context().grantPermissions(['notifications']);
    await page.evaluate(() => localStorage.setItem('fixtureRealWorker', 'true'));
    await page.reload();
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.evaluate(() => navigator.serviceWorker.ready);
    const worker = page.context().serviceWorkers()[0];
    assert.ok(worker);
    await page.evaluate(() => { (window as any).fixtureFocus = false; });
    const reader = await context.newPage();
    await reader.routeWebSocket('**/ws', ws => {
      ws.onMessage(raw => {
        if (JSON.parse(String(raw)).type === 'auth') {
          ws.send(JSON.stringify({ type: 'snapshot', state: { ...state, threadId: 'a' }, selected: true }));
        }
      });
    });
    await reader.goto(`http://127.0.0.1:${address.port}/#thread=a`);
    await reader.getByRole('button', { name: 'Workspace controls', exact: true }).waitFor();
    await run('a');
    assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length), 0,
      'another focused tab reading the same chat suppresses worker notifications');
    await reader.close();
    await run('a');
    await page.waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length === 1);
    assert.equal(await count(), 0, 'worker notification does not use the page Notification constructor');
    // OS notification clicks cannot be automated in headless Chromium. Dispatch the
    // equivalent event in the real worker and verify navigation without a page reload.
    await worker.evaluate(`(async () => {
      const [notification] = await self.registration.getNotifications();
      const work = [];
      const event = new Event('notificationclick');
      Object.assign(event, { notification, waitUntil: promise => work.push(promise) });
      self.dispatchEvent(event);
      await Promise.all(work);
    })()`);
    await page.waitForFunction(() => location.hash === '#thread=a');
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await page.waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length === 0);
    // Discovery must return live React selection even with notifications disabled
    // and the URL deliberately stale (SPA navigation may outpace client metadata).
    await page.evaluate(() => history.replaceState(null, '', '/#thread=stale'));
    const view = await worker.evaluate(`(async () => {
      const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      return await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('No live view response')); }, 2000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
        client.postMessage({ type: 'query-attention-view' }, [channel.port2]);
      });
    })()`);
    assert.deepEqual(view, { type: 'attention-view', threadId: 'a' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
