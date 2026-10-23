import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import { TerminalSession } from '../server/terminal.js';

test('mobile browser: chat, independent terminal, reconnect, and real pi TUI', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-browser-'));
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
    async abort() { event({ type: 'agent_settled', aborted: true }); },
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
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web'),
    terminal: new TerminalSession(dir, { PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}`, HOME: dir,
      PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' }),
  });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    assert.equal(await page.title(), 'Nookframe');
    assert.equal(await page.locator('h1').innerText(), 'Nookframe');
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await page.locator('h1 span').isVisible(), true, 'Workspace title remains visible on phones');
    assert.equal(await page.locator('h1 span').evaluate(el => getComputedStyle(el).color), 'rgb(220, 231, 243)');
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('h1 span').isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByLabel('Model', { exact: true }).isVisible(), false);
    const readingHeight = await page.locator('.transcript').evaluate(el => el.clientHeight);
    assert.ok(readingHeight > 650, `Phone reading area should exceed 650px, got ${readingHeight}`);
    await page.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await page.getByLabel('Model', { exact: true }).selectOption('test/second');
    await page.getByText('Saved for this thread and restarts', { exact: true }).waitFor();
    assert.equal(model.id, 'second');
    await page.screenshot({ path: '.local/controls-mobile-smoke.png', fullPage: false });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Model', { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Workspace controls', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByLabel('Message', { exact: true }).fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
    await page.waitForFunction(() => document.querySelector('textarea')!.clientHeight >= 120);
    assert.ok(await page.getByLabel('Message', { exact: true }).evaluate(el => el.clientHeight <= 144));
    await page.getByLabel('Message', { exact: true }).fill('Create hello.txt containing hello from pi.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Creating your first workspace file…', { exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value === '');
    assert.equal(prompts, 1);
    await page.getByRole('article', { name: 'write running', exact: true }).waitFor();
    assert.equal(await page.getByText('Write hello.txt', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.tool-preview').innerText(), 'hello from pi\n');
    assert.equal(await page.locator('.tool-card').count(), 1);
    await page.reload();
    await page.getByText('Working', { exact: true }).waitFor();
    await page.getByText('Creating your first workspace file…', { exact: true }).waitFor();
    assert.equal(prompts, 1);
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'test/second');
    assert.equal(await page.getByLabel('Model', { exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: '.local/mobile-smoke.png', fullPage: false });
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('export TUI_TEST=terminal_survived; printf "terminal_%s\\n" ready');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('terminal_ready'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('printf "paste_%s\\n" works'));
    await page.getByRole('button', { name: 'Paste', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('paste_%s'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('paste_works'));
    // Capture actual PTY input in both normal and application-cursor mode.
    for (const mode of ['normal', 'application']) {
      const script = `process.stdin.setRawMode(true);process.stdout.write(String.fromCharCode(27)+"[?1${mode === 'application' ? 'h' : 'l'}"+"KEY_"+"READY_${mode}");let s="";process.stdin.on("data",b=>{s+=b;if(s.length>=12){process.stdout.write(String.fromCharCode(27)+"[?1l"+"KEY_"+"RESULT="+Buffer.from(s).toString("hex"));process.exit();}})`;
      await page.keyboard.type(`node -e '${script}'`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(marker => document.querySelector('.xterm-screen')?.textContent?.includes(marker), `KEY_READY_${mode}`);
      for (const direction of ['up', 'down', 'left', 'right']) await page.getByRole('button', { name: `Arrow ${direction}`, exact: true }).click();
      const prefix = mode === 'application' ? '1b4f' : '1b5b';
      const expected = 'KEY_RESULT=' + ['41', '42', '44', '43'].map(suffix => prefix + suffix).join('');
      await page.waitForFunction(marker => document.querySelector('.xterm-screen')?.textContent?.includes(marker), expected);
    }
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    assert.equal(workspace.state.messages.length, 2, 'Only the user message and tool operation are in history; terminal commands never become chat messages');
    assert.equal((await page.locator('.transcript').textContent())?.includes('terminal_ready'), false);
    assert.equal(workspace.state.busy, true, 'Opening the terminal must not stop chat work');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.reload();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "%s\\n" "$TUI_TEST"');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('terminal_survived'));
    await page.keyboard.type('pi --no-session --no-extensions --no-approve');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('No models available'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '.local/terminal-mobile-smoke.png', fullPage: false });
    await page.reload();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('(auto)'));
    await page.getByRole('button', { name: 'Ctrl+D', exact: true }).click();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('article', { name: 'write interrupted', exact: true }).waitFor();
    const edits = { path: 'example.ts', edits: [{ oldText: 'const old = 1;', newText: 'const updated = 2;' }, { oldText: 'before', newText: 'after' }] };
    event({ type: 'tool_execution_start', toolCallId: 'edit-preview', toolName: 'edit', args: edits });
    const editCard = page.getByRole('article', { name: 'edit running', exact: true });
    await editCard.waitFor();
    assert.equal(await editCard.locator('.diff-add').count(), 2);
    assert.equal(await editCard.locator('.diff-remove').count(), 2);
    event({ type: 'tool_execution_end', toolCallId: 'edit-preview', toolName: 'edit', isError: true, result: { content: [{ type: 'text', text: 'Replacement did not match' }] } });
    event({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'edit-preview', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'Replacement did not match' }] } });
    await page.getByRole('article', { name: 'edit failed', exact: true }).waitFor();
    assert.equal(await page.getByText('Replacement did not match', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.tool-card').count(), 2);
    await page.screenshot({ path: '.local/tool-cards-mobile.png', fullPage: false });
    event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading view\n\n' + Array.from({ length: 12 }, (_, i) => `Section ${i + 1}\nThis is a synthetic long reply for checking comfortable reading. Workspace controls stay out of the way, and tool details can be opened when needed.`).join('\n\n') }] } });
    await page.getByText('Reading view', { exact: false }).waitFor();
    await page.locator('.transcript').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(100);
    event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Another update while reading earlier text.' } });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.transcript').evaluate(el => el.scrollTop), 0, 'Updates must not pull a reader back to the bottom');
    await page.screenshot({ path: '.local/compact-reading-mobile.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 430 });
    assert.ok(await page.locator('.transcript').evaluate(el => el.clientHeight > 250));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '.local/compact-reading-short.png', fullPage: false });
    await page.setViewportSize({ width: 1200, height: 900 });
    assert.ok(await page.locator('.transcript').evaluate(el => el.clientHeight > 700));
    await page.screenshot({ path: '.local/compact-reading-desktop.png', fullPage: false });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true });
  }
});
