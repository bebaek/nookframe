import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import type { ClientContext } from '../shared/client-context.js';

test('composer: desktop Enter, multiline, IME, repeat, busy, and mobile', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-composer-'));
  const prompts: string[] = [];
  const contexts: (ClientContext | undefined)[] = [];
  const model = { provider: 'test', id: 'fixture' };
  const workspace = new Workspace({
    onEvent() { return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return [model]; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt(text: string) { prompts.push(text); },
    async stop() {},
  } as unknown as Agent, dir, undefined, undefined, false, async context => { contexts.push(context); });
  await workspace.initialize();
  const { createServer } = await import('node:net');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 'composer-fixture-'.repeat(4);
  const example = 'Summarize my unread mail <safely>.';
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web'), promptExamples: [example] });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    for (const mobile of [true, false]) {
      const page = await browser.newPage({ isMobile: mobile, hasTouch: mobile, timezoneId: 'Asia/Seoul', permissions: ['geolocation'], geolocation: { latitude: 37.566535, longitude: 126.977969 } });
      await page.goto(origin);
      await page.getByLabel('Access token').fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByText('Ready', { exact: true }).waitFor();
      // Simulate delayed media/tool layout without a new server snapshot.
      const transcript = page.locator('.transcript');
      await transcript.evaluate(el => {
        const fixture = document.createElement('div');
        fixture.id = 'scroll-fixture';
        fixture.style.height = '2000px';
        el.firstElementChild!.append(fixture);
      });
      const atBottom = () => page.waitForFunction(() => {
        const el = document.querySelector('.transcript')!;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      });
      await atBottom();
      await page.locator('#scroll-fixture').evaluate(el => { el.style.height = '3000px'; });
      await atBottom();
      await page.setViewportSize({ width: 900, height: 500 });
      await atBottom();
      // Small reading adjustments inside the old 120px follow threshold
      // must survive React renders, redundant scroll events and layout growth.
      await transcript.evaluate(el => { el.scrollTop -= 40; });
      await page.waitForTimeout(100);
      const slightlyUp = await transcript.evaluate(el => el.scrollTop);
      await page.getByLabel('Message', { exact: true }).fill('reading');
      await page.waitForTimeout(100);
      assert.equal(await transcript.evaluate(el => el.scrollTop), slightlyUp, 'renders must preserve a small upward scroll');
      await transcript.dispatchEvent('scroll');
      await transcript.evaluate(el => { el.scrollTop += 10; });
      await page.waitForTimeout(100);
      const readingTop = await transcript.evaluate(el => el.scrollTop);
      await page.locator('#scroll-fixture').evaluate(el => { el.style.height = '4000px'; });
      await page.waitForTimeout(100);
      assert.equal(await transcript.evaluate(el => el.scrollTop), readingTop, 'layout growth must not pull a reader down');
      await page.getByLabel('Message', { exact: true }).fill('');
      await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(100);
      await page.locator('#scroll-fixture').evaluate(el => { el.style.height = '5000px'; });
      await atBottom();
      await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
      await page.locator('#scroll-fixture').evaluate(el => { el.style.height = '6000px'; });
      await page.getByRole('tab', { name: 'Chat', exact: true }).click();
      await atBottom();
      await page.locator('#scroll-fixture').evaluate(el => el.remove());
      await page.setViewportSize({ width: 1280, height: 720 });
      const input = page.getByLabel('Message', { exact: true });
      const send = page.getByRole('button', { name: 'Send', exact: true });
      const exampleButton = page.getByRole('button', { name: example, exact: true });
      await exampleButton.click();
      assert.equal(await input.inputValue(), example);
      assert.equal(await input.evaluate(el => el === document.activeElement), true);
      assert.equal(await exampleButton.isDisabled(), true);
      assert.deepEqual(prompts, []);
      await input.fill('hello');
      if (mobile) {
        await input.press('Enter');
        assert.equal(await input.inputValue(), 'hello\n');
        assert.deepEqual(prompts, []);
        await page.close();
        continue;
      }
      await input.press('Shift+Enter');
      assert.equal(await input.inputValue(), 'hello\n');
      for (const properties of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
        await input.dispatchEvent('keydown', { key: 'Enter', ...properties });
      }
      await page.waitForTimeout(100);
      assert.deepEqual(prompts, []);
      await input.fill('   ');
      await input.press('Enter');
      assert.equal(await send.isDisabled(), true);
      await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
      await page.getByText('Approximate location available for your next message.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Share approximate browser location').isChecked(), true);
      // Drive browser failures without waiting for real geolocation timeouts.
      await page.evaluate(() => {
        const requests: { success: PositionCallback; error: PositionErrorCallback | null; options?: PositionOptions }[] = [];
        Object.assign(window, { locationRequests: requests });
        navigator.geolocation.getCurrentPosition = (success, error = null, options) => {
          requests.push({ success, error, options });
        };
      });
      await page.getByLabel('Share approximate browser location').uncheck();
      await page.getByLabel('Share approximate browser location').check();
      const retry = page.getByRole('button', { name: 'Retry location', exact: true });
      await page.getByText('Requesting browser location… This may take up to 60 seconds.', { exact: true }).waitFor();
      assert.equal(await retry.isDisabled(), true);
      await input.fill('chat remains available');
      assert.equal(await send.isDisabled(), false);
      assert.deepEqual(await page.evaluate(() => (window as any).locationRequests[0].options), {
        enableHighAccuracy: false, timeout: 60000, maximumAge: 300000,
      });
      for (const [code, message] of [
        [3, 'Location lookup timed out after 60 seconds. Retry or use a manual city.'],
        [1, 'Location permission denied. Check browser and device permissions, then retry or use a manual city.'],
        [2, 'Browser could not determine your location. Check device location services, then retry or use a manual city.'],
      ] as const) {
        await page.evaluate(code => (window as any).locationRequests.at(-1).error({ code }), code);
        await page.getByText(message, { exact: true }).waitFor();
        assert.equal(await retry.isDisabled(), false);
        await retry.click();
        await page.getByText('Requesting browser location… This may take up to 60 seconds.', { exact: true }).waitFor();
      }
      // A callback arriving after sharing is turned off must not restore location.
      await page.getByLabel('Share approximate browser location').uncheck();
      await page.evaluate(() => (window as any).locationRequests.at(-1).success({ coords: { latitude: 1, longitude: 2 } }));
      await page.getByLabel('Share approximate browser location').check();
      await page.getByText('Requesting browser location… This may take up to 60 seconds.', { exact: true }).waitFor();
      await page.evaluate(() => (window as any).locationRequests.at(-1).success({ coords: { latitude: 37.566535, longitude: 126.977969 } }));
      await page.getByText('Approximate location available for your next message.', { exact: true }).waitFor();
      assert.equal(await retry.isDisabled(), false);
      await page.getByLabel('Timezone override (optional)').fill('Invalid/Place');
      assert.equal(await send.isDisabled(), true);
      await page.getByLabel('Timezone override (optional)').fill('');
      await page.getByLabel('Share approximate city').check();
      await page.getByLabel('City (optional)', { exact: true }).fill('Seoul');
      await page.reload();
      await page.getByText('Ready', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
      assert.equal(await page.getByLabel('City (optional)', { exact: true }).inputValue(), 'Seoul');
      await page.getByText('Approximate location available for your next message.', { exact: true }).waitFor();
      assert.doesNotMatch(await page.evaluate(() => localStorage.getItem('nookframe.client-context')!), /latitude|longitude/);
      await page.getByRole('button', { name: 'Close controls', exact: true }).click();
      await input.fill('hello\nworld');
      await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
      assert.deepEqual(prompts, ['hello\nworld']);
      assert.deepEqual(contexts, [{ timezone: 'Asia/Seoul', timezoneSource: 'browser', city: 'Seoul', location: { latitude: 37.57, longitude: 126.98, source: 'browser' } }]);
      await input.fill('keep while busy');
      await input.press('Enter');
      assert.equal(await send.isDisabled(), true);
      assert.equal(await input.inputValue(), 'keep while busy');
      await page.waitForTimeout(100);
      assert.equal(prompts.length, 1);
      // A subsequent browser request must replace, not inherit, shared hints.
      workspace.state.busy = false;
      await page.reload();
      await page.getByText('Ready', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
      await page.getByLabel('Share approximate city').uncheck();
      await page.getByLabel('Share approximate browser location').uncheck();
      await page.getByLabel('Timezone override (optional)').fill('America/New_York');
      await page.getByRole('button', { name: 'Close controls', exact: true }).click();
      await input.fill('manual timezone');
      await send.click();
      await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
      assert.deepEqual(contexts[1], { timezone: 'America/New_York', timezoneSource: 'manual' });
      workspace.state.busy = false;
      await page.reload();
      await page.getByText('Ready', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
      assert.equal(await page.getByLabel('Share approximate browser location').isChecked(), false);
      await page.getByLabel('Share timezone', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Close controls', exact: true }).click();
      await input.fill('nothing shared');
      await send.click();
      await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
      assert.equal(contexts.length, 3);
      assert.equal(contexts[2], undefined);
      await page.close();
    }
  } finally {
    await browser.close(); await app.close(); await workspace.close();
    await rm(dir, { recursive: true, force: true });
  }
});
