import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { ThreadStore } from '../server/threads.js';
import { createApp } from '../server/http.js';
import { photoId } from '../server/photos.js';
import type { PublishedImage } from '../server/artifacts.js';

const exec = promisify(execFile);
test('public image browser: CLI publishing, inline preview, original download, threads and restart', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-public-image-browser-'));
  const cwd = join(dir, 'workspace'); await mkdir(cwd);
  const threads = new ThreadStore(join(dir, 'sessions'), cwd, dir);
  let sessionFile = await threads.initial();
  const history = new Map<string, any[]>();
  let event: (value: any) => void = () => {};
  let published: PublishedImage;
  const cli = (...args: string[]) => exec(process.execPath, ['dist/server/image-cli.js', ...args], { env: { ...process.env, NOOKFRAME_IMAGE_STATE_DIR: dir, NOOKFRAME_IMAGE_THREAD_ID: threads.id(sessionFile) } });
  const agent = {
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return { sessionFile }; }, async getAvailableModels() { return []; },
    async getEntries() { const messages = history.get(sessionFile) ?? []; return { entries: messages.map((message, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, message })), leafId: messages.length ? String(messages.length - 1) : null }; },
    async switchSession(path: string) { sessionFile = path; return {}; },
    async prompt(text: string) {
      const context = JSON.parse((await cli('context')).stdout);
      await copyFile('test/fixtures/images/apollo17-earth.jpg', join(context.directory, 'earth.jpg'));
      published = JSON.parse((await cli('publish', context.thread, join(context.directory, 'earth.jpg'), 'Earth — NASA / Apollo 17')).stdout);
      const messages = [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: published.markdown + '\n\nCredit: NASA / Apollo 17 (public domain).' }] }];
      history.set(sessionFile, messages);
      for (const message of messages) event({ type: 'message_end', message });
      event({ type: 'agent_settled' });
    },
    async stop() {},
  } as unknown as Agent;
  let workspace = new Workspace(agent, dir, { source: 'pi' }, threads);
  await workspace.initialize();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 'public-image-browser-'.repeat(4);
  const config = { token, origin, stateDir: dir, webDir: resolve('dist/web') };
  let app = createApp(workspace, config);
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByLabel('Message', { exact: true }).fill('Show the public NASA Apollo 17 image');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const loaded = () => page.waitForFunction(() => { const img = document.querySelector('.markdown img') as HTMLImageElement; return img?.complete && img.naturalWidth > 0; });
    await loaded();
    assert.equal(await page.locator('.markdown img').getAttribute('src'), published!.previewUrl);
    assert.equal(await page.locator('.markdown img').evaluate((img: HTMLImageElement) => Math.max(img.naturalWidth, img.naturalHeight)), 330);
    assert.equal(await page.getByRole('link', { name: 'Open full size: Earth — NASA / Apollo 17' }).getAttribute('href'), published!.fullUrl);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download full-resolution image (330 × 330)', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(photoId(await readFile((await download.path())!)), published!.id);
    const first = workspace.state.threadId;
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page.waitForFunction(first => (document.querySelector('#thread') as HTMLSelectElement).value !== first, first);
    assert.equal(await page.locator('.markdown img').count(), 0);
    await page.getByLabel('Thread', { exact: true }).selectOption(first);
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await loaded();
    await page.reload(); await loaded();
    await app.close(); await workspace.close();
    workspace = new Workspace(agent, dir, { source: 'pi' }, threads); await workspace.initialize();
    app = createApp(workspace, config); app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    await page.reload(); await loaded();
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.get(origin + published!.previewUrl)).status(), 401);
    assert.equal((await anonymous.request.get(origin + published!.downloadUrl)).status(), 401);
    await anonymous.close();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
