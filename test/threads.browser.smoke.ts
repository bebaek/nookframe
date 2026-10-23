import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium, type Page } from 'playwright';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import { ThreadStore } from '../server/threads.js';
import { Workspace } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { createApp } from '../server/http.js';

test('mobile threads: real RPC histories, tab-local selection, URL reload, per-thread drafts, stale client rejection', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-threads-browser-'));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  function seed(id: string, text: string) {
    const manager = SessionManager.create(dir, store.directory, { id });
    manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Reply to ${text}` }],
      api: 'openai-completions', provider: 'test', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return basename(manager.getSessionFile()!);
  }
  const first = seed('workspace', 'First conversation');
  const second = seed('second', 'Second conversation');
  const workspace = new Workspaces(store, first, (file, stateDir) => {
    const client = new RpcClient({
      cliPath: join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js'), cwd: dir,
      env: { PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      args: ['--session', file, '--session-dir', store.directory, '--no-extensions', '--no-approve'],
    });
    const controller = new Workspace(client, stateDir, undefined, store, true);
    return { workspace: controller, start: () => client.start() };
  });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 't'.repeat(64);
  const app = createApp(workspace, { origin, token, webDir: resolve('dist/web') });
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    await workspace.initialize();
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const a = await context.newPage(), b = await context.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    async function login(page: Page) {
      await page.goto(origin);
      await page.getByLabel('Access token').or(page.getByRole('button', { name: 'Workspace controls', exact: true })).first().waitFor();
      if (await page.getByLabel('Access token').isVisible()) {
        await page.getByLabel('Access token').fill(token);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
      }
      await page.getByLabel('Thread', { exact: true }).waitFor({ state: 'attached' });
    }
    async function selected(page: Page, id: string) {
      await page.waitForFunction(id => (document.querySelector('#thread') as HTMLSelectElement)?.value === id, id);
    }
    await login(a); await login(b); await selected(a, first);
    await a.getByText('Reply to First conversation', { exact: true }).waitFor();
    await a.getByLabel('Message', { exact: true }).fill('Draft for first');
    await b.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await b.getByLabel('Thread', { exact: true }).selectOption(second);
    await selected(b, second);
    await selected(a, first);
    await b.getByRole('button', { name: 'Close controls', exact: true }).click();
    await b.getByText('Reply to Second conversation', { exact: true }).waitFor();
    assert.equal(await a.getByLabel('Message', { exact: true }).inputValue(), 'Draft for first');
    await b.getByLabel('Message', { exact: true }).fill('Draft for second');
    await a.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await a.getByLabel('Thread', { exact: true }).selectOption(second);
    await selected(a, second);
    assert.equal(await a.getByLabel('Message', { exact: true }).inputValue(), '');
    await a.getByLabel('Thread', { exact: true }).selectOption(first);
    await selected(a, first);
    assert.equal(await a.getByLabel('Message', { exact: true }).inputValue(), 'Draft for first');
    await a.getByRole('button', { name: 'New thread', exact: true }).click();
    await a.getByRole('button', { name: 'Close controls', exact: true }).click();
    await a.waitForFunction(first => (document.querySelector('#thread') as HTMLSelectElement)?.value !== first, first);
    const empty = await a.getByLabel('Thread', { exact: true }).inputValue();
    await selected(b, second);
    assert.equal(await b.getByLabel('Message', { exact: true }).inputValue(), 'Draft for second');
    assert.equal(await a.locator('article.message').count(), 0);
    assert.equal(await a.getByLabel('Message', { exact: true }).inputValue(), '');
    assert.equal(await a.locator('#thread option').count(), 3);
    assert.equal(new URLSearchParams(new URL(a.url()).hash.slice(1)).get('thread'), empty);
    await a.reload(); await selected(a, empty);
    await selected(b, second);
    const stale = await a.evaluate(({ token, first, empty }) => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Stale request timeout')); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, threadId: empty }));
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') ws.send(JSON.stringify({ type: 'new_thread', id: 'stale', threadId: first }));
        else if (message.type === 'error') { clearTimeout(timer); ws.close(); resolve(message.message); }
      };
    }), { token, first, empty });
    assert.match(stale, /selected thread changed/);
    await a.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await a.getByLabel('Thread', { exact: true }).selectOption(second);
    await a.getByRole('button', { name: 'Close controls', exact: true }).click();
    await selected(a, second);
    await a.getByText('Reply to Second conversation', { exact: true }).waitFor();
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('.local', { recursive: true });
    await a.screenshot({ path: '.local/threads-mobile-smoke.png', fullPage: false });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
