import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

test('mobile browser: authenticate, send, reload/reconnect during run, stop', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-browser-'));
  let event: (value: unknown) => void = () => {};
  let prompts = 0;
  let model = { provider: 'test', id: 'first' };
  const agent = {
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
    async setModel(provider: string, id: string) { model = { provider, id }; return model; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt(text: string) {
      prompts++;
      event({ type: 'message_end', message: { role: 'user', content: text } });
      event({ type: 'message_start', message: { role: 'assistant', content: [] } });
      event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Creating your first workspace file…' } });
      event({ type: 'tool_execution_start', toolCallId: '1', toolName: 'write', args: { path: 'hello.txt', content: 'hello from pi' } });
    },
    async clearQueue() { return { steering: [], followUp: [] }; },
    async abort() { event({ type: 'agent_settled' }); },
    async stop() {},
  } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  await workspace.initialize();
  const token = 'a'.repeat(64);
  // Reserve an ephemeral port before setting the exact browser origin.
  const { createServer } = await import('node:net');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web') });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByLabel('Model', { exact: true }).selectOption('test/second');
    await page.getByText('Saved for future sessions and restarts', { exact: true }).waitFor();
    assert.equal(model.id, 'second');
    await page.getByLabel('Message', { exact: true }).fill('Create hello.txt containing hello from pi.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Creating your first workspace file…', { exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value === '');
    assert.equal(prompts, 1);
    await page.reload();
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Working', { exact: true }).waitFor();
    await page.getByText('Creating your first workspace file…', { exact: true }).waitFor();
    assert.equal(prompts, 1);
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'test/second');
    assert.equal(await page.getByLabel('Model', { exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: '.local/mobile-smoke.png', fullPage: false });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true });
  }
});
