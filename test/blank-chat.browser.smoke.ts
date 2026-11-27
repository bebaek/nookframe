import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ThreadStore } from '../server/threads.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { createApp } from '../server/http.js';
import { ModelOperations, newThreadModel } from '../server/model-operations.js';
import { persistSession } from './session-fixture.js';

for (const native of [false, true]) test(`blank ${native ? 'native' : 'managed'} chat: eager initialization, model picker, photos and deep links`, { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-blank-browser-'));
  const settings = join(dir, 'settings.json');
  if (native) await writeFile(settings, JSON.stringify({ defaultProvider: 'test', defaultModel: 'fixture' }));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const file = store.create(); persistSession(file, dir, 'Existing conversation');
  const existing = store.id(file);
  let agents = 0, prompts = 0, lastPrompt = '', promptModel = '';
  const pool = new Workspaces(store, existing, (file, stateDir) => {
    agents++;
    let emit: (event: unknown) => void = () => {};
    let model = { provider: 'test', id: 'fixture', input: ['text', 'image'] };
    const agent = {
      onEvent(fn: typeof emit) { emit = fn; return () => {}; },
      async getState() { return { sessionFile: file, model }; },
      async getAvailableModels() { return [model, { ...model, id: 'alternate' }]; },
      async setModel(provider: string, id: string) { model = { ...model, provider, id }; },
      async getEntries() { return { entries: [], leafId: null }; },
      async prompt(text: string) {
        prompts++; lastPrompt = text; promptModel = model.id;
        persistSession(file, dir, text || 'Photo message');
        emit({ type: 'message_end', message: { role: 'user', content: text } });
        emit({ type: 'agent_settled' });
      },
      async stop() {},
    } as unknown as Agent;
    return { workspace: new Workspace(agent, stateDir, undefined, store, true), async start() {} };
  }, 4, 5 * 60_000, undefined, () => native ? newThreadModel(dir, dir, {}, true) : { model: { provider: 'test', id: 'fixture' }, source: 'saved' }, native);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`, token = 'blank-fixture-'.repeat(4);
  const modelOperations = new ModelOperations(dir, dir, {}, id => pool.operationWorkspace(id), native);
  const app = createApp(pool, { modelOperations, origin, token, stateDir: join(dir, 'state'), webDir: resolve('dist/web') });
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
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    if (native) await page.locator('.conversation-context').getByText('fixture', { exact: true }).waitFor();
    const picker = page.getByRole('combobox', { name: 'Model', exact: true });
    assert.equal(await picker.inputValue(), 'test/fixture');
    assert.equal(agents, 1); assert.equal(prompts, 0);
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await composer.fill('My first message');
    assert.match(new URL(page.url()).hash, /^#thread=/);
    assert.equal(agents, 1);
    assert.equal((await store.list()).length, 1);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#thread=') && (document.querySelector('textarea') as HTMLTextAreaElement).value === '');
    const firstUrl = page.url();
    assert.equal(prompts, 1); assert.equal(agents, 1);
    await page.reload(); await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(page.url(), firstUrl); assert.equal(agents, 1);
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page.waitForFunction(first => location.hash.startsWith('#thread=') && location.href !== first, firstUrl);
    const secondUrl = page.url();
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    assert.equal(agents, 2);
    await page.reload(); await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(page.url(), secondUrl); assert.equal(agents, 2);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    await page.locator('input[type=file]').first().setInputFiles([
      { name: 'test.png', mimeType: 'image/png', buffer: png },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Draft attachment') },
    ]);
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Send') as HTMLButtonElement)?.disabled);
    assert.equal(agents, 2, 'photo upload must not allocate another agent');
    assert.equal(page.url(), secondUrl);
    await composer.fill('Keep this draft');
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    assert.equal(prompts, 1, 'choosing a model must not submit a prompt');
    assert.equal(agents, 2);
    assert.equal(await composer.inputValue(), 'Keep this draft');
    await page.locator('#model').selectOption('test/alternate');
    if (native) {
      const checkbox = page.getByRole('checkbox', { name: 'Also set as Pi default for new chats' });
      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      assert.equal(await checkbox.isChecked(), false);
      await page.locator('.conversation-context').getByText('fixture', { exact: true }).waitFor();
      await apply.click();
      await page.locator('.conversation-context').getByText('alternate', { exact: true }).waitFor();
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).defaultModel, 'fixture');
      await checkbox.check();
      await apply.click(); // Promote the already-active model.
      await page.waitForFunction(() => !(document.querySelector('.pi-default-controls input') as HTMLInputElement).disabled);
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).defaultModel, 'alternate');
    } else await page.getByText('Saved for this thread · choosing a model also sets the new-chat default', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value === '');
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.draft-photo'));
    assert.equal(prompts, 2); assert.equal(agents, 2);
    assert.equal(promptModel, 'alternate');
    assert.match(lastPrompt, /^Keep this draft/);
    assert.match(lastPrompt, /Attached file: notes.txt/);
    const attachment = page.getByRole('link', { name: /Attached file: notes.txt/ }).first();
    const download = await page.request.get(new URL((await attachment.getAttribute('href'))!, origin).href);
    assert.equal(await download.text(), 'Draft attachment');
    assert.notEqual(page.url(), firstUrl);
    // Force a full navigation so an in-flight snapshot cannot overwrite the link's hash.
    await page.goto('about:blank');
    await page.goto(`${origin}/#thread=${encodeURIComponent(existing)}`);
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await page.locator('#thread').inputValue(), existing);
    assert.equal(prompts, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await pool.close(); await rm(dir, { recursive: true, force: true }); }
});
