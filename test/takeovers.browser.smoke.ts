import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type Page } from 'playwright';
import { ThreadStore } from '../server/threads.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { createApp } from '../server/http.js';

async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

test('cross-slot takeover: focused owner approval, denial, timer, explicit force, and moved-thread link', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-takeover-browser-'));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const first = store.id(store.create());
  let stops = 0;
  const factory = (file: string, stateDir: string) => {
    let emit: (event: unknown) => void = () => {};
    const agent = {
      onEvent(fn: typeof emit) { emit = fn; return () => {}; },
      async getState() { return { sessionFile: file, model: { provider: 'test', id: 'fixture' } }; },
      async getAvailableModels() { return [{ provider: 'test', id: 'fixture' }]; },
      async getEntries() { return { entries: [], leafId: null }; },
      async clearQueue() {}, async abort() { emit({ type: 'agent_settled' }); },
      async prompt() {}, async stop() { stops++; },
    } as unknown as Agent;
    return { workspace: new Workspace(agent, stateDir, undefined, store, true), async start() {} };
  };
  const owner = new Workspaces(store, first, factory), requester = new Workspaces(store, first, factory);
  const p1 = await port(), p2 = await port();
  const origins = [`http://127.0.0.1:${p1}`, `http://127.0.0.1:${p2}`];
  const token = 't'.repeat(64);
  const apps = [owner, requester].map((pool, index) => createApp(pool, { token, origin: origins[index], webDir: resolve('dist/web') }));
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    await owner.initialize(); await requester.initialize();
    for (let i = 0; i < apps.length; i++) { apps[i].server.listen([p1, p2][i], '127.0.0.1'); await once(apps[i].server, 'listening'); }
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 390, height: 844 } }), browser.newContext({ viewport: { width: 390, height: 844 } })]);
    const a = await contexts[0].newPage(), b = await contexts[1].newPage();
    await b.addInitScript(() => {
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          (window as unknown as { takeoverSocket: WebSocket }).takeoverSocket = this;
        }
      };
    });
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    async function login(page: Page, origin: string) {
      await page.goto(`${origin}/#thread=${encodeURIComponent(first)}`);
      await page.getByLabel('Access token').fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByLabel('Thread', { exact: true }).waitFor({ state: 'attached' });
    }
    async function request() {
      b.once('dialog', dialog => void dialog.accept());
      await b.getByRole('button', { name: 'Take over on this slot', exact: true }).click();
    }
    await login(a, origins[0]); await login(b, origins[1]);
    assert.equal(stops, 0);
    const panel = b.getByRole('region', { name: 'Thread takeover' });
    // A legacy owner still holds its session lock but has no takeover metadata.
    const record = join(store.directory, '.nookframe-takeovers', `${createHash('sha256').update(first).digest('hex')}.json`);
    await rename(record, join(dir, 'owner-record.json'));
    const originalRequest = requester.takeovers.request.bind(requester.takeovers);
    let releaseRequest!: () => void;
    const gate = new Promise<void>(resolve => { releaseRequest = resolve; });
    let attempts = 0;
    requester.takeovers.request = async id => { attempts++; await gate; return originalRequest(id); };
    await request();
    await panel.getByText('Requesting takeover…', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Take over on this slot', exact: true }).isDisabled(), true);
    releaseRequest();
    await panel.getByRole('alert').filter({ hasText: 'may need updating or may be unavailable' }).waitFor();
    assert.equal(attempts, 1);
    assert.equal(stops, 0);
    const box = await panel.getByRole('alert').boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height < 844, 'failure is visible beside the takeover button on mobile');
    await rename(join(dir, 'owner-record.json'), record);
    await panel.getByRole('button', { name: 'Check thread', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'owned by another server' }).waitFor();
    await request(); await a.bringToFront();
    const originalStatus = requester.takeovers.status.bind(requester.takeovers);
    requester.takeovers.status = async () => { throw new Error('fixture storage unavailable'); };
    await panel.getByRole('alert').filter({ hasText: 'Takeover status could not be verified' }).waitFor();
    requester.takeovers.status = originalStatus;
    await panel.getByRole('alert').waitFor({ state: 'hidden' });
    const modal = a.getByRole('dialog', { name: 'Allow thread takeover?' });
    await modal.waitFor();
    await modal.getByRole('button', { name: 'Keep here', exact: true }).click();
    await b.getByText('The other user chose to keep the thread there.', { exact: true }).waitFor();
    assert.equal(stops, 0);
    await request();
    await modal.waitFor();
    const attemptsBeforeDisconnect = attempts;
    await b.evaluate(() => (window as unknown as { takeoverSocket: WebSocket }).takeoverSocket.close());
    await panel.getByRole('alert').filter({ hasText: 'outcome is unknown' }).waitFor();
    await b.waitForFunction(() => document.querySelector('.badge.online') !== null);
    assert.equal(attempts, attemptsBeforeDisconnect, 'reconnect must not replay a takeover command');
    await modal.getByRole('button', { name: 'Keep here', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    await panel.getByRole('button', { name: 'Check thread', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'owned by another server' }).waitFor();
    await request();
    await modal.waitFor();
    await modal.getByRole('button', { name: 'Allow takeover', exact: true }).click();
    await b.waitForFunction(id => (document.querySelector('#thread') as HTMLSelectElement)?.value === id, first).catch(async error => {
      console.log({ stops, requesterPanel: await panel.innerText(), ownerPanel: await a.getByRole('region', { name: 'Thread takeover' }).innerText() });
      throw error;
    });
    await a.getByRole('link', { name: /Open on slot/ }).waitFor();
    assert.equal(stops, 1);
    assert.equal(await a.getByLabel('Message', { exact: true }).isDisabled(), true);
    assert.equal(await a.getByRole('link', { name: /Open on slot/ }).getAttribute('href'), `${origins[1]}/#thread=${encodeURIComponent(first)}`);
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // Reverse the direction to exercise the real server-enforced 30-second timer.
    await a.reload();
    await a.getByRole('button', { name: 'Take over on this slot', exact: true }).waitFor();
    a.once('dialog', dialog => void dialog.accept());
    await a.getByRole('button', { name: 'Take over on this slot', exact: true }).click();
    await a.getByRole('button', { name: 'Take over anyway', exact: true }).waitFor({ timeout: 35000 });
    assert.equal(stops, 1, 'deadline never automatically interrupts the owner');
    a.once('dialog', dialog => void dialog.dismiss());
    await a.getByRole('button', { name: 'Take over anyway', exact: true }).click();
    assert.equal(stops, 1, 'dismissing confirmation never authorizes force');
    a.once('dialog', dialog => void dialog.accept());
    await a.getByRole('button', { name: 'Take over anyway', exact: true }).click();
    await a.waitForFunction(id => (document.querySelector('#thread') as HTMLSelectElement)?.value === id, first);
    await b.getByRole('link', { name: /Open on slot/ }).waitFor();
    assert.equal(stops, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const app of apps) await app.close();
    await owner.close(); await requester.close(); await rm(dir, { recursive: true, force: true });
  }
});
