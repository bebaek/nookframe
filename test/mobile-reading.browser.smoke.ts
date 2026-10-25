import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

test('mobile reading chrome follows gestures, preserves the reading anchor, and stays accessible', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-mobile-reading-'));
  const model = { provider: 'test', id: 'fixture' };
  const workspace = new Workspace({
    onEvent() { return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return [model]; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt() {}, async stop() {},
  } as unknown as Agent, dir, undefined, undefined, false);
  await workspace.initialize();
  const { createServer } = await import('node:net');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 'reading-fixture-'.repeat(4);
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web') });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(origin);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    const transcript = page.locator('.transcript');
    const controls = page.getByRole('button', { name: 'Show chat controls' });
    const header = page.locator('.app > header');
    const footer = page.locator('.chat-pane > footer');
    const input = page.getByLabel('Message', { exact: true });
    const wheel = async (dy: number, dx = 0) => {
      await transcript.dispatchEvent('wheel', { deltaY: dy, deltaX: dx });
      await page.waitForTimeout(80);
    };
    const swipe = async (dx: number, dy: number) => {
      await transcript.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 200, clientY: 400 }] });
      await transcript.dispatchEvent('touchmove', { touches: [{ identifier: 0, clientX: 200 - dx, clientY: 400 - dy }] });
      await transcript.dispatchEvent('touchend', { touches: [] });
      await page.waitForTimeout(80);
    };
    const visible = async () => { assert.equal(await header.isVisible(), true); assert.equal(await footer.isVisible(), true); };
    const seed = async (page: Page) => {
      await page.locator('.transcript').evaluate(el => {
        const fixture = document.createElement('div');
        fixture.id = 'reading-fixture';
        fixture.innerHTML = '<div style="height: 1000px"></div><div id="reading-marker">Reading anchor</div><div style="height: 4000px"></div>';
        el.firstElementChild!.append(fixture);
      });
      await page.waitForTimeout(100);
      await page.locator('.transcript').evaluate(el => { el.scrollTop = 900; });
      await page.waitForTimeout(100);
    };
    await seed(page);
    await visible(); // Programmatic scrolling and layout growth cannot hide chrome.
    const markerY = () => page.locator('#reading-marker').evaluate(el => el.getBoundingClientRect().top);
    const before = await markerY();
    const height = await transcript.evaluate(el => el.clientHeight);
    await swipe(100, 8); // Horizontal table gestures must not hide controls.
    await visible();
    await swipe(0, 20); // Small motion does not cause flicker.
    await visible();
    await swipe(0, 80);
    assert.equal(await header.isVisible(), false);
    assert.equal(await footer.isVisible(), false);
    assert.ok(await transcript.evaluate(el => el.clientHeight) > height + 80);
    assert.ok(Math.abs(await markerY() - before) < 2, 'hiding preserves the screen-space reading anchor');
    await page.locator('#reading-fixture').evaluate(el => { el.style.paddingBottom = '400px'; });
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await markerY() - before) < 2, 'incoming layout growth does not resume auto-follow');
    await swipe(0, -30);
    await visible();
    assert.ok(Math.abs(await markerY() - before) < 2, 'revealing preserves the screen-space reading anchor');
    await wheel(80);
    await controls.click();
    await visible();
    assert.ok(Math.abs(await markerY() - before) < 2);
    await input.focus();
    await swipe(0, 80);
    await visible();
    await input.fill('draft pins the composer');
    await input.blur();
    await wheel(80);
    await visible();
    await input.fill('');
    await input.blur();
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await wheel(80);
    await visible();
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await wheel(80);
    assert.equal(await footer.isVisible(), false);
    // A keyboard-only user can always reveal the chrome.
    await controls.focus();
    await page.keyboard.press('Enter');
    await visible();
    // Expanding the viewport near the bottom may clamp scrollTop, but that
    // browser-generated scroll event must not silently resume auto-follow.
    await transcript.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 20; });
    await page.waitForTimeout(100);
    await wheel(80);
    assert.equal(await footer.isVisible(), false);
    const clampedTop = await transcript.evaluate(el => el.scrollTop);
    await page.locator('#reading-fixture').evaluate(el => { el.style.paddingBottom = '800px'; });
    await page.waitForTimeout(100);
    assert.equal(await transcript.evaluate(el => el.scrollTop), clampedTop);
    await controls.click();
    // Also exercise native touch scrolling, not only synthetic DOM events.
    await transcript.evaluate(el => { el.scrollTop = 900; });
    await page.waitForTimeout(100);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 500 }] });
    for (const y of [480, 450, 420, 390]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y }] });
      await page.waitForTimeout(40);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await controls.waitFor();
    assert.equal(await footer.isVisible(), false);
    await cdp.detach();
    await page.setViewportSize({ width: 900, height: 844 });
    await visible();
    await wheel(100);
    await visible(); // Desktop never hides controls.
    await page.setViewportSize({ width: 390, height: 844 });
    await visible();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    assert.equal(await header.isVisible(), true);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await visible();
    // Chrome stays visible when sending, rather than treating auto-follow as a gesture.
    await input.fill('a prompt');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
    await visible();
    await transcript.evaluate(el => { el.scrollTop = 900; });
    await page.waitForTimeout(100);
    await wheel(80);
    assert.equal(await footer.isVisible(), false, 'Send button focus must not pin the composer after sending');
    await controls.click();
    await page.close();
  } finally {
    await browser.close(); await app.close(); await workspace.close();
    await rm(dir, { recursive: true, force: true });
  }
});
