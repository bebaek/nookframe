import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import type { PhotoContent } from '../server/photos.js';

test('photos browser: HEIC preview, image-only send, paste/drop, failure retains draft, mobile picker', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-photo-browser-'));
  let event: (value: any) => void = () => {};
  const prompts: { text: string; images?: PhotoContent[] }[] = [];
  const model = { provider: 'test', id: 'vision', input: ['text', 'image'] };
  const workspace = new Workspace({
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return [model]; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt(text: string, images?: PhotoContent[]) {
      prompts.push({ text, images });
      event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }, ...(images ?? [])] } });
      event({ type: 'agent_settled' });
    },
    async stop() {},
  } as unknown as Agent, dir);
  await workspace.initialize();
  const { createServer } = await import('node:net');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 'photo-browser-fixture-'.repeat(4);
  const app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web') });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    const picker = page.locator('input[type=file]').first();
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const input = page.getByLabel('Message', { exact: true });
    await picker.setInputFiles({ name: 'phone.heic', mimeType: 'image/heic', buffer: await readFile('test/fixtures/photos/red.heic') });
    await page.locator('.draft-photo img').waitFor();
    await send.click();
    await page.waitForFunction(() => !document.querySelector('.draft-photo'));
    assert.equal(prompts[0].text, ''); assert.equal(prompts[0].images?.length, 1);
    await page.locator('.message img').waitFor();
    assert.equal(await page.locator('.message img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true);
    await page.reload();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.locator('.message img').waitFor();
    const png = await sharp({ create: { width: 50, height: 40, channels: 3, background: 'blue' } }).png().toBuffer();
    await input.fill('look at these');
    for (const kind of ['paste', 'drop']) {
      await page.evaluate(({ data, kind }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], `${kind}.png`, { type: 'image/png' }));
        if (kind === 'paste') document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        else document.querySelector('footer')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, { data: [...png], kind });
      await page.getByText('Uploading and processing photos…', { exact: true }).waitFor({ state: 'hidden' });
    }
    assert.equal(await page.locator('.draft-photo img').count(), 2);
    await page.getByRole('button', { name: 'Remove paste.png', exact: true }).click();
    await picker.setInputFiles({ name: 'invalid.heic', mimeType: 'image/heic', buffer: Buffer.from('invalid') });
    await page.getByRole('button', { name: 'Retry uploads' }).waitFor();
    assert.equal(await input.inputValue(), 'look at these');
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('button', { name: 'Remove invalid.heic', exact: true }).click();
    workspace.state.models[0].images = false;
    await send.click();
    await page.getByText('This model cannot accept photos. Choose an image-capable model.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'look at these');
    assert.equal(await page.locator('.draft-photo img').count(), 1);
    workspace.state.models[0].images = true;
    await send.click();
    await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
    assert.equal(prompts[1].text, 'look at these'); assert.equal(prompts[1].images?.length, 1);
    const mobile = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    await mobile.goto(origin); await mobile.getByLabel('Access token').fill(token);
    await mobile.getByRole('button', { name: 'Connect', exact: true }).click();
    await mobile.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await mobile.getByRole('button', { name: 'Camera', exact: true }).isVisible(), true);
    assert.equal(await mobile.locator('input[capture]').getAttribute('capture'), 'environment');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true });
  }
});
