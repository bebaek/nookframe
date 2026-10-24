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
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`(() => {
      const w = window;
      w.notifications = [];
      w.permissionRequests = 0;
      w.fixtureFocus = true;
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
    await page.route('**/auth/session', route => route.fulfill({ json: { authenticated: true } }));
    const threads = [{ id: 'a', title: 'Private A', updatedAt: '2026-01-01', busy: false }, { id: 'b', title: 'Private B', updatedAt: '2026-01-01', busy: false }];
    const state: Snapshot = { threadId: 'a', threads, busy: false, available: true, messages: [], tools: {}, liveText: '', model: 'fixture', models: [], modelSource: 'pi', modelChanging: false, threadChanging: false, notice: '' };
    let socket: WebSocketRoute;
    await page.routeWebSocket('**/ws', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const message = JSON.parse(String(raw));
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
    }
    await run('b'); assert.equal(await count(), 0, 'no notification before opt-in');
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).waitFor();
    await run('a'); assert.equal(await count(), 0, 'focused active conversation is silent');
    await run('b'); assert.equal(await count(), 1, 'other conversation notifies once');
    assert.equal(await page.evaluate(() => JSON.stringify((window as any).notifications).includes('Private')), false);
    await page.evaluate(() => (window as any).notifications[0].onclick());
    await page.waitForFunction(() => location.hash === '#thread=b');
    await page.evaluate(() => { (window as any).fixtureFocus = false; });
    await run('b'); assert.equal(await count(), 2, 'unfocused active conversation notifies');
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await run('a'); assert.equal(await count(), 2);
    assert.equal(await page.evaluate(() => (window as any).notifications.every((n: any) => n.closed)), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
