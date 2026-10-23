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
    const imageBlock = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
    event({ type: 'tool_execution_end', toolCallId: 'image-preview', toolName: 'read', isError: false, result: { content: [imageBlock] } });
    const imageUrl = workspace.state.messages.at(-1)!.tool!.images![0].url;
    let externalRequests = 0;
    page.on('request', request => { if (request.url().includes('external.invalid')) externalRequests++; });
    const markdown = `**Image result**\n\n![Blue chart](${imageUrl})\n\n![Tracking](https://external.invalid/pixel.png)\n\n[unsafe](javascript:alert(1))\n\n<img src="https://external.invalid/raw.png" onerror="alert(1)">`;
    const tableMarkdown = '\n\n| Left | Center | Right | Empty | Unicode | Wide |\n| :--- | :---: | ---: | --- | --- | --- |\n| **Bold** | `code` | 456 | | 한글 🎉 | Long text that should wrap naturally in a table cell. |\n| Left \\| Right | [Example](https://example.com) | 23 | | 日本語 | More text |';
    const content = markdown + tableMarkdown;
    let releaseImage!: () => void;
    const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route(`**${imageUrl}`, async route => {
      await imageGate;
      await route.continue();
    });
    event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: content } });
    await page.locator('.markdown strong').filter({ hasText: 'Image result' }).waitFor();
    await page.getByRole('table').waitFor();
    const loading = page.locator('.markdown .image-loading');
    await loading.waitFor();
    assert.equal(await loading.evaluate(el => getComputedStyle(el).position), 'absolute');
    releaseImage();
    await loading.waitFor({ state: 'hidden' });
    const streamedImage = await page.locator('.markdown img').elementHandle();
    const tableY = await page.getByRole('table').evaluate(el => el.getBoundingClientRect().top - el.closest('.markdown')!.getBoundingClientRect().top);
    event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '\n\nImage rendering complete.' } });
    await page.getByText('Image rendering complete.', { exact: true }).waitFor();
    assert.equal(await page.locator('.markdown img').evaluate((el, original) => el === original, streamedImage), true);
    assert.equal(await loading.count(), 0);
    assert.equal(await page.getByRole('table').evaluate(el => el.getBoundingClientRect().top - el.closest('.markdown')!.getBoundingClientRect().top), tableY);
    event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: content + '\n\nImage rendering complete.\n\nFinal image result.' }] } });
    await page.getByText('Final image result.', { exact: true }).waitFor();
    const table = page.getByRole('table');
    assert.equal(await table.locator('th').count(), 6);
    assert.equal(await table.locator('tbody tr').count(), 2);
    assert.equal(await table.locator('tbody tr').first().locator('td').nth(3).textContent(), '');
    assert.equal(await table.getByText('Left | Right', { exact: true }).count(), 1);
    assert.equal(await table.locator('strong').textContent(), 'Bold');
    assert.equal(await table.locator('code').textContent(), 'code');
    assert.equal(await table.getByRole('link', { name: 'Example' }).getAttribute('href'), 'https://example.com');
    for (const [index, alignment] of ['left', 'center', 'right'].entries()) {
      for (const selector of ['th', 'tbody tr:first-child td']) {
        assert.equal(await table.locator(selector).nth(index).evaluate(el => getComputedStyle(el).textAlign), alignment);
      }
    }
    await page.waitForFunction(() => { const img = document.querySelector('.markdown img') as HTMLImageElement; return img?.complete && img.naturalWidth > 0; });
    assert.equal(await page.locator('.markdown img').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Tracking (external image)' }).count(), 1);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(externalRequests, 0);
    assert.equal(await page.getByRole('link', { name: 'Open full size: Blue chart' }).getAttribute('target'), '_blank');
    event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `![Missing](/response-images/${'0'.repeat(64)})` }] } });
    await page.getByText('Missing: image unavailable', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.waitForFunction(() => { const img = document.querySelector('.markdown img') as HTMLImageElement; return img?.complete && img.naturalWidth > 0; });
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
    assert.equal(await page.locator('.photo-picker small').textContent(), 'Photos are converted to JPEG and stripped of metadata. Originals are not retained. Unsent uploads expire after 24 hours.');
    const large = await sharp({ create: { width: 2400, height: 100, channels: 3, background: 'blue' } }).png().toBuffer();
    await picker.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: large });
    const resizeNotice = page.getByText('Resized to fit within 2048 × 2048 pixels.', { exact: true });
    await resizeNotice.waitFor();
    assert.equal(await resizeNotice.count(), 1);
    assert.equal(await page.locator('.draft-photo').filter({ has: resizeNotice }).locator('img').getAttribute('alt'), 'large.png');
    await page.getByRole('button', { name: 'Remove large.png', exact: true }).click();
    assert.equal(await resizeNotice.count(), 0);
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
    await mobile.getByRole('table').waitFor();
    assert.equal(await mobile.getByRole('table').getByText('한글 🎉', { exact: true }).count(), 1);
    const scrollRegion = mobile.getByRole('region', { name: 'Markdown table' });
    assert.equal(await scrollRegion.evaluate(el => el.scrollWidth > el.clientWidth), true);
    assert.equal(await scrollRegion.evaluate(el => { el.scrollLeft = 100; return el.scrollLeft > 0; }), true);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true });
  }
});
