import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ThreadStore } from '../server/threads.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { createApp } from '../server/http.js';
import { persistSession } from './session-fixture.js';

test('blank chat: lazy first send, photos, reload, deep links and New thread', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-blank-browser-'));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const file = store.create(); persistSession(file, dir, 'Existing conversation');
  const existing = store.id(file);
  let agents = 0, prompts = 0;
  const pool = new Workspaces(store, existing, (file, stateDir) => {
    agents++;
    let emit: (event: unknown) => void = () => {};
    const model = { provider: 'test', id: 'fixture', input: ['text', 'image'] };
    const agent = {
      onEvent(fn: typeof emit) { emit = fn; return () => {}; },
      async getState() { return { sessionFile: file, model }; },
      async getAvailableModels() { return [model]; },
      async getEntries() { return { entries: [], leafId: null }; },
      async prompt(text: string) {
        prompts++;
        persistSession(file, dir, text || 'Photo message');
        emit({ type: 'message_end', message: { role: 'user', content: text } });
        emit({ type: 'agent_settled' });
      },
      async stop() {},
    } as unknown as Agent;
    return { workspace: new Workspace(agent, stateDir, undefined, store, true), async start() {} };
  });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`, token = 'blank-fixture-'.repeat(4);
  const app = createApp(pool, { origin, token, stateDir: join(dir, 'state'), webDir: resolve('dist/web') });
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    await pool.initialize();
    app.server.listen(address.port, '127.0.0.1'); await once(app.server, 'listening');
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('My first message');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(agents, 0);
    assert.equal((await store.list()).length, 1);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#thread=') && (document.querySelector('textarea') as HTMLTextAreaElement).value === '');
    const firstUrl = page.url();
    assert.equal(prompts, 1); assert.equal(agents, 1);
    await page.reload(); await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(page.url(), firstUrl); assert.equal(agents, 1);
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page.waitForFunction(() => !location.hash);
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    assert.equal(agents, 1);
    await page.reload(); await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, ''); assert.equal(agents, 1);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    await page.locator('input[type=file]').first().setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Send') as HTMLButtonElement)?.disabled);
    assert.equal(agents, 1, 'photo upload must not allocate a thread');
    assert.equal(new URL(page.url()).hash, '');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#thread='));
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.locator('.draft-photo').waitFor({ state: 'detached' });
    assert.equal(prompts, 2); assert.equal(agents, 2);
    assert.notEqual(page.url(), firstUrl);
    await page.goto(`${origin}/#thread=${encodeURIComponent(existing)}`);
    await page.reload(); // Load the explicit link, rather than a same-document hash change.
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await page.locator('#thread').inputValue(), existing);
    assert.equal(prompts, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await pool.close(); await rm(dir, { recursive: true, force: true }); }
});
