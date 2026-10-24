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
      const page = await browser.newPage({ isMobile: mobile, hasTouch: mobile, timezoneId: 'Asia/Seoul' });
      await page.goto(origin);
      await page.getByLabel('Access token').fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByText('Ready', { exact: true }).waitFor();
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
      await page.getByLabel('Timezone override (optional)').fill('Invalid/Place');
      assert.equal(await send.isDisabled(), true);
      await page.getByLabel('Timezone override (optional)').fill('');
      await page.getByLabel('Share approximate city').check();
      await page.getByLabel('City (optional)', { exact: true }).fill('Seoul');
      await page.reload();
      await page.getByText('Ready', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
      assert.equal(await page.getByLabel('City (optional)', { exact: true }).inputValue(), 'Seoul');
      await page.getByRole('button', { name: 'Close controls', exact: true }).click();
      await input.fill('hello\nworld');
      await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('textarea')!.value === '');
      assert.deepEqual(prompts, ['hello\nworld']);
      assert.deepEqual(contexts, [{ timezone: 'Asia/Seoul', timezoneSource: 'browser', city: 'Seoul' }]);
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
